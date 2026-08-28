// MissionRuntime：受控任务编排（contracts/agent-state.md 全部阶段与绑定规则）
// 职责边界：
//   - 理解/建议/审批/编排在这里；业务巡检状态机只在 engine/src/inspection.ts。
//   - Agent 层绝不绕过 createTask/pushEvent/addEvidence/closeTask，也绝不生成数字/ID。
//   - 每次上下文装配产生新 contextVersion，旧审批随之失效（唯一允许回退：重新取上下文回到 proposed）。
//   - 所有写路径先落 MissionState 再持久化；进程内零缓存 → 重启后按 SQLite 原样恢复。
import { addEvidence, closeTask, createTask, getTask, pushEvent, TransitionError, type InspectionTask } from '../inspection';
import { getAnomalyState } from '../anomalyState';
import { listAnomalies } from '../anomalies';
import { fixture, hasNode } from '../fixture';
import { nowIsoShanghai, todayShanghai } from '../util';
import { assembleContext, SCENE_ID, SCENE_REVISION, type ContextBundle } from './context';
import { activeAdapter, fallbackReason } from './model';
import { fallbackFacts, fallbackProposal, validateProposal } from './planner';
import { findEventById, findEventByIdempotencyKey, loadMission, newApprovalId, newCommandId, newMissionId, recordEvent, saveMission, type EventRecord } from './store';
import type { Approval, ContextItem, EvidenceInput, MissionPhase, MissionState, Plan, PlannerInfo, RawProposal, SceneCommand, SceneEventInput, SceneEventType, StoredSceneEvent } from './types';

const approvalTtlMs = (): number => {
  const v = Number(process.env.PECC_APPROVAL_TTL_MS ?? 15 * 60_000);
  return Number.isFinite(v) && v > 0 ? v : 15 * 60_000;
};

// —— 错误类型：路由层映射语义化 HTTP 状态码 ——

export class RuntimeHttpError extends Error {
  constructor(
    public http: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// —— 快照（统一结果外壳 data 部分，agent-tools.md §3） ——

export interface MissionSnapshot {
  mission: Record<string, unknown>;
  context: { contextVersion: string; contextHash: string; generatedAt: string; items: ContextItem[] };
  plan: Plan | null;
  pendingApproval: Approval | null;
  pendingCommands: SceneCommand[];
  inspectionTask: InspectionTask | null;
  receipt?: Record<string, unknown>;
}

function snapshotOf(m: MissionState): MissionSnapshot {
  const task = m.inspectionTaskId ? getTask(m.inspectionTaskId) : null;
  return {
    mission: {
      missionId: m.missionId, conversationId: m.conversationId, sceneId: m.sceneId, sceneRevision: m.sceneRevision,
      objective: m.objective, trigger: m.trigger, operator: m.operator, phase: m.phase, focus: m.focus,
      anomalyId: m.anomalyId, nodeId: m.nodeId, inspectionTaskId: m.inspectionTaskId ?? null,
      contextVersion: m.contextVersion, contextHash: m.contextHash ?? null, warnings: m.warnings,
      planner: m.planner, route: m.route, lastEvent: m.lastEvent ?? null, createdAt: m.createdAt, updatedAt: m.updatedAt,
    },
    context: { contextVersion: m.contextVersion, contextHash: m.contextHash ?? '', generatedAt: m.updatedAt, items: m.contextItems ?? [] },
    plan: m.plan ?? null,
    pendingApproval: m.pendingApproval ?? null,
    pendingCommands: m.pendingCommands,
    inspectionTask: task,
    ...(m.receipt ? { receipt: m.receipt } : {}),
  };
}

export function envelope(m: MissionState, opts?: { status?: 'available' | 'partial' | 'rejected'; extra?: Record<string, unknown> }) {
  const extra = opts?.extra ?? {};
  const snapshot = snapshotOf(m);
  return {
    status: opts?.status ?? 'available',
    data: { ...snapshot, ...extra },
    sourceRefs: [`/api/agent/missions/${m.missionId}`, `POST /api/agent/missions/${m.missionId}/events`],
    truth: 'SIMULATED' as const,
    observedAt: m.updatedAt,
    warnings: [...m.warnings],
    nextAllowedActions: nextActions(m),
    planner: m.planner,
    ...extra,
  };
}

function nextActions(m: MissionState): string[] {
  const base = `/api/agent/missions/${m.missionId}`;
  switch (m.phase) {
    case 'proposed':
    case 'awaiting-approval':
      return [`POST ${base}/approval {"approvalId","decision":"approve|reject","contextVersion","planHash"}`];
    case 'executing':
      return [`POST ${base}/events {"type":"checkpoint_arrived","checkpointId":"<已登记检查点>"}`];
    case 'awaiting-evidence':
      return [
        `POST ${base}/events {"type":"checkpoint_arrived","checkpointId":"${m.route.roofCheckpointId ?? '<已登记检查点>'}"}`,
        `POST ${base}/events {"type":"evidence_captured","evidence":{"checkpointId","kind":"photo|thermal|reading|note","value"}}`,
      ];
    case 'awaiting-confirmation':
      return [`POST ${base}/approval {"approvalId","decision":"approve","contextVersion","planHash"}（闭环确认）`];
    default:
      return [];
  }
}

// —— 内部工具 ——

function setPhase(m: MissionState, phase: MissionPhase, ts = nowIsoShanghai()): void {
  m.phase = phase;
  m.phaseHistory.push({ phase, ts });
  m.updatedAt = ts;
}

function warn(m: MissionState, message: string): void {
  if (!m.warnings.includes(message)) m.warnings.push(message);
}

function makeApproval(m: MissionState, purpose: Approval['purpose'], requestedActions: string[], reason: string): Approval {
  const expires = new Date(Date.now() + approvalTtlMs()).toISOString();
  return {
    approvalId: newApprovalId(),
    missionId: m.missionId,
    contextVersion: m.contextVersion,
    planHash: m.plan!.planHash,
    requestedActions,
    reason,
    impact: 'digital-simulation-only',
    expiresAt: expires,
    purpose,
  };
}

async function plannerInfoFor(): Promise<PlannerInfo> {
  const adapter = activeAdapter();
  return adapter ? { mode: 'llm', modelAvailable: true } : { mode: 'deterministic-fallback', modelAvailable: false, reason: fallbackReason() };
}

/** 提案生成：LLM 适配器（若配置凭据）→ 确定性校验；失败/未配置 → 确定性回退 planner */
async function proposePlan(m: MissionState, bundle: ContextBundle, objective: string): Promise<void> {
  let raw: RawProposal | null = null;
  let planner: PlannerInfo = { mode: 'deterministic-fallback', modelAvailable: false, reason: fallbackReason() };
  const adapter = activeAdapter();
  if (adapter) {
    const res = await adapter.propose({ objective, bundle });
    if ('proposal' in res) {
      const v = validateProposal(res.proposal, bundle);
      if (v.ok) {
        raw = res.proposal;
        planner = { mode: 'llm', modelAvailable: true };
      } else {
        warn(m, `MODEL_PROPOSAL_REJECTED: ${v.reason}（已回退确定性 planner）`);
      }
    } else {
      warn(m, `MODEL_UNAVAILABLE: ${res.error}（已回退确定性 planner）`);
    }
  }
  if (!raw) raw = fallbackProposal(bundle);
  const validated = validateProposal(raw, bundle);
  if (!validated.ok) throw new RuntimeHttpError(500, 'PLANNER_BROKEN', `确定性 planner 输出未通过校验: ${validated.reason}`);
  m.plan = validated.plan;
  m.planner = planner;
  setPhase(m, 'proposed');
  m.pendingApproval = makeApproval(m, 'plan', ['create_inspection_task', 'dispatch', 'navigate_checkpoints', 'capture_evidence', 'close_task'], '按提案执行数字现场巡检并取证闭环');
  setPhase(m, 'awaiting-approval');
}

/** 刷新上下文并按合同使旧审批失效（环境/焦点变化 → 唯一允许回退：重新提案） */
async function refreshContext(m: MissionState, reason: string): Promise<void> {
  const bundle = await assembleContext(m);
  m.contextItems = bundle.items;
  m.contextVersion = bundle.contextVersion;
  m.contextHash = bundle.contextHash;
  if (m.pendingApproval) {
    m.pendingApproval = undefined;
    warn(m, `CONTEXT_REFRESHED(${reason}): 旧审批已失效，绑定 contextVersion=${m.contextVersion}`);
    if (m.phase === 'awaiting-approval') {
      await proposePlan(m, bundle, m.objective);
    } else if (m.phase === 'awaiting-confirmation') {
      m.pendingApproval = makeApproval(m, 'close', ['close_task'], '证据齐备，确认闭环并撤销异常注入');
    }
  }
  m.updatedAt = nowIsoShanghai();
}

// —— 创建任务 ——

export interface CreateMissionInput {
  objective: string;
  sceneId: string;
  sceneRevision: string;
  operator?: string;
  trigger?: 'user' | 'anomaly' | 'system';
  anomalyId?: string;
}

export interface Clarification {
  field: string;
  message: string;
  options: Array<Record<string, unknown>>;
}

export async function createMission(input: CreateMissionInput): Promise<{ mission: MissionState } | { clarification: Clarification }> {
  // 场景必须已登记；修订号必须匹配（不猜场景）
  if (input.sceneId !== SCENE_ID) {
    return { clarification: { field: 'sceneId', message: `未登记场景 ${input.sceneId}（已登记: ${SCENE_ID}）`, options: [{ sceneId: SCENE_ID, sceneRevision: SCENE_REVISION }] } };
 }
 if (input.sceneRevision !== SCENE_REVISION) {
    return { clarification: { field: 'sceneRevision', message: `场景修订号须为 ${SCENE_REVISION}，收到: ${input.sceneRevision}`, options: [{ sceneId: SCENE_ID, sceneRevision: SCENE_REVISION }] } };
  }
  // 异常引用：只能用明确已登记 ID；缺失或不明确 → clarification，不猜 ID
  const today = todayShanghai();
  const registered = (await listAnomalies(today, 'all')).map((a) => ({ id: a.id, nodeId: a.nodeId, status: a.status }));
  if (!input.anomalyId) {
    return { clarification: { field: 'anomalyId', message: '缺少 anomalyId：目标异常不明确，请从已登记异常中选择，不猜测 ID', options: registered } };
  }
  const anomaly = registered.find((a) => a.id === input.anomalyId);
  if (!anomaly) {
    return { clarification: { field: 'anomalyId', message: `anomalyId ${input.anomalyId} 未登记（不猜测 ID）`, options: registered } };
  }

  const ts = nowIsoShanghai();
  const missionId = newMissionId();
  const m: MissionState = {
    missionId,
    conversationId: `CONV-${missionId}`,
    sceneId: input.sceneId,
    sceneRevision: input.sceneRevision,
    objective: input.objective,
    trigger: input.trigger ?? 'user',
    operator: input.operator?.trim() || '运维员-演示',
    phase: 'created',
    focus: {},
    anomalyId: anomaly.id,
    nodeId: anomaly.nodeId,
    contextVersion: '',
    contextItems: [],
    observationRefs: [],
    evidenceRefs: [],
    sourceRefs: [`/api/anomalies?date=${today}&status=all`, `POST /api/agent/missions`],
    warnings: [],
    pendingCommands: [],
    bufferedEvidence: [],
    phaseHistory: [],
    planner: { mode: 'deterministic-fallback', modelAvailable: false },
    route: { frontCheckpointId: null, roofCheckpointId: null },
    createdAt: ts,
    updatedAt: ts,
  };
  m.phaseHistory.push({ phase: 'created', ts });
  if (anomaly.status !== 'open') warn(m, `ANOMALY_NOT_OPEN: 异常 ${anomaly.id} 状态为 ${anomaly.status}`);

  // 装配最小上下文（context-ready）
  const bundle = await assembleContext(m);
  m.contextItems = bundle.items;
  m.contextVersion = bundle.contextVersion;
  m.contextHash = bundle.contextHash;
  m.route = { frontCheckpointId: fallbackFacts(bundle).frontCheckpointId, roofCheckpointId: fallbackFacts(bundle).roofCheckpointId };
  setPhase(m, 'context-ready');

  // 提案 + 待审批
  await proposePlan(m, bundle, m.objective);
  saveMission(m);
  return { mission: m };
}

export async function getMission(missionId: string): Promise<MissionState | null> {
  return loadMission(missionId);
}

// —— 审批（approvalId + contextVersion + planHash + TTL 四重绑定） ——

export interface ApprovalInput {
  approvalId?: string;
  decision?: string;
  contextVersion?: string;
  planHash?: string;
}

export async function submitApproval(missionId: string, input: ApprovalInput): Promise<{ ok: true; mission: MissionState; extra?: Record<string, unknown>; status?: 'available' | 'rejected' } | { ok: false; http: number; code: string; message: string }> {
  const m = loadMission(missionId);
  if (!m) return { ok: false, http: 404, code: 'NOT_FOUND', message: `任务 ${missionId} 不存在` };
  if (input.decision !== 'approve' && input.decision !== 'reject') {
    return { ok: false, http: 400, code: 'BAD_DECISION', message: 'decision 仅允许 approve|reject' };
  }
  const pa = m.pendingApproval;
  if (!pa) {
    return { ok: false, http: 409, code: 'NO_PENDING_APPROVAL', message: `当前阶段 ${m.phase} 无挂起审批（拒绝/过期/已用审批不再可用）` };
  }
 if (input.contextVersion !== pa.contextVersion) return { ok: false, http: 403, code: 'CONTEXT_VERSION_MISMATCH', message: `contextVersion 不匹配（当前 ${pa.contextVersion}，收到 ${input.contextVersion}）` };
 if (input.planHash !== pa.planHash) return { ok: false, http: 403, code: 'PLAN_HASH_MISMATCH', message: `planHash 不匹配（期望 ${pa.planHash}）` };
  if (input.approvalId !== pa.approvalId) return { ok: false, http: 403, code: 'APPROVAL_MISMATCH', message: `approvalId 不匹配（期望 ${pa.approvalId}）` };
  if (Date.parse(pa.expiresAt) <= Date.now()) {
    // 过期：清审批，不沿用旧批准；plan 审批重走提案，close 审批重发确认
    m.pendingApproval = undefined;
    if (pa.purpose === 'close') {
      setPhase(m, 'awaiting-confirmation');
      m.pendingApproval = makeApproval(m, 'close', ['close_task'], '屋面证据齐备：确认闭环并撤销异常注入');
    } else {
      const bundle = await assembleContext(m);
      m.contextItems = bundle.items;
      m.contextVersion = bundle.contextVersion;
      m.contextHash = bundle.contextHash;
      setPhase(m, 'proposed');
      await proposePlan(m, bundle, m.objective);
    }
    saveMission(m);
    return { ok: false, http: 410, code: 'APPROVAL_EXPIRED', message: `审批已于 ${pa.expiresAt} 过期，已重新提案（新 approvalId 见 pendingApproval）` };
  }

  if (input.decision === 'reject') {
    m.pendingApproval = undefined;
    if (pa.purpose === 'plan') {
      setPhase(m, 'cancelled');
      saveMission(m);
      return { ok: true, mission: m, status: 'rejected' };
    }
    warn(m, 'CLOSE_REJECTED: 用户拒绝闭环确认，保持 awaiting-confirmation（提交新证据后可再次确认）');
    setPhase(m, 'awaiting-confirmation');
    saveMission(m);
    return { ok: true, mission: m, status: 'rejected' };
  }

  // approve
  if (pa.purpose === 'plan') return approvePlan(m);
  return approveClose(m);
}

/** 批准执行：复用现有 createTask + pushEvent，签发场景命令 */
async function approvePlan(m: MissionState): Promise<{ ok: true; mission: MissionState; extra: Record<string, unknown> }> {
  m.pendingApproval = undefined;
  setPhase(m, 'executing');
  const created = createTask({ anomalyId: m.anomalyId, nodeId: m.nodeId, assignee: m.operator });
  if ('error' in created) throw new RuntimeHttpError(created.code === 404 ? 404 : 409, 'INSPECTION_CREATE_FAILED', created.error);
  const task = created.task;
  m.inspectionTaskId = task.id;
  m.observationRefs.push(`inspection-task:${task.id}`);
  warn(m, created.existed ? `INSPECTION_TASK_REUSED: 复用既有未结任务 ${task.id}` : `INSPECTION_TASK_CREATED: ${task.id}`);

  // dispatch（既有任务已过 created 状态时忽略重复派发的 ILLEGAL_TRANSITION）
  try {
    pushEvent(task.id, 'dispatch', { operator: m.operator });
  } catch (e) {
    if (!(e instanceof TransitionError) || e.code !== 'ILLEGAL_TRANSITION') throw e;
  }

  const ts = nowIsoShanghai();
  const commands: SceneCommand[] = [];
  commands.push({ commandId: newCommandId(), kind: 'focus_asset', targetId: m.nodeId, missionId: m.missionId, issuedAt: ts, reason: `提案 ${m.plan!.planHash}：聚焦目标异常组串` });
  if (m.route.frontCheckpointId) {
    commands.push({ commandId: newCommandId(), kind: 'navigate_to_checkpoint', targetId: m.route.frontCheckpointId, missionId: m.missionId, issuedAt: ts, reason: '提案：先到楼前检查点' });
  }
  m.pendingCommands = commands;
  syncPlanProgress(m, 'focus', m.nodeId);
  saveMission(m);
  return { ok: true, mission: m, extra: { sceneCommands: commands } };
}

/** 批准闭环：复用现有 pushEvent(resolve) + closeTask（引擎撤销异常注入） */
async function approveClose(m: MissionState): Promise<{ ok: true; mission: MissionState } | { ok: false; http: number; code: string; message: string }> {
  const task = getTask(m.inspectionTaskId!);
  if (!task) return { ok: false, http: 404, code: 'NOT_FOUND', message: `巡检任务 ${m.inspectionTaskId} 不存在` };
  const hasRoof = task.evidence.some((e) => e.checkpointId.endsWith('-ROOF'));
  if (!hasRoof) {
    // 不消费审批：补证据后可原审批重试（未过期时）
    return { ok: false, http: 409, code: 'EVIDENCE_MISSING', message: '屋面类异常必须提交 CP-xxx-ROOF 检查点证据才能闭环（当前缺少 ROOF 证据）' };
  }
  if (task.status === 'inspecting' && task.evidence.length > 0) {
    pushEvent(task.id, 'submit_evidence', { operator: m.operator });
  }
  if (task.status === 'evidence-submitted') {
    pushEvent(task.id, 'resolve', { operator: m.operator });
  }
  await closeTask(task.id);
  m.pendingApproval = undefined;
  syncPlanProgress(m, 'request-confirmation', undefined);
  syncPlanProgress(m, 'verify', undefined);
  const after = getTask(task.id)!;
  const anomaly = getAnomalyState();
  m.receipt = {
    kind: 'mission_closed',
    taskId: after.id,
    taskStatus: after.status,
    closedAt: after.closedAt,
    anomalyId: anomaly.id,
    anomalyStatus: anomaly.status,
    lossKwhTotal: anomaly.lossKwhTotal,
    truth: 'SIMULATED',
    sourceRefs: [`/api/inspection/tasks/${after.id}`, `/api/generation/actual?nodeId=${m.nodeId}`],
  };
  setPhase(m, 'resolved');
  saveMission(m);
  return { ok: true, mission: m };
}

// —— 场景事件（scene-events.md：只接受高层语义事件；重复 eventId/idempotencyKey 零副作用） ——

const EVENT_TYPES: SceneEventType[] = ['scene_entered', 'asset_focused', 'component_focused', 'checkpoint_arrived', 'environment_changed', 'evidence_captured', 'navigation_failed'];

export async function handleSceneEvent(missionId: string, input: SceneEventInput): Promise<{ ok: true; mission: MissionState; extra?: Record<string, unknown>; duplicate?: boolean } | { ok: false; http: number; code: string; message: string }> {
  const m = loadMission(missionId);
  if (!m) return { ok: false, http: 404, code: 'NOT_FOUND', message: `任务 ${missionId} 不存在` };

  if (!EVENT_TYPES.includes(input.type)) return { ok: false, http: 400, code: 'UNKNOWN_EVENT_TYPE', message: `未知事件类型 ${input.type}（允许 ${EVENT_TYPES.join('|')}）` };
  if (input.sceneId && input.sceneId !== m.sceneId) return { ok: false, http: 400, code: 'SCENE_MISMATCH', message: `sceneId ${input.sceneId} 与任务场景 ${m.sceneId} 不一致` };
  if (input.sceneRevision && input.sceneRevision !== m.sceneRevision) return { ok: false, http: 400, code: 'SCENE_MISMATCH', message: `sceneRevision ${input.sceneRevision} 与任务 ${m.sceneRevision} 不一致` };
  if (Number.isNaN(Date.parse(input.clientTs))) return { ok: false, http: 400, code: 'BAD_CLIENT_TS', message: `clientTs 不是可解析时间: ${input.clientTs}` };

  // 幂等：重复 eventId / idempotencyKey 直接返回原结果，不产生任何副作用
  const seen = findEventById(input.eventId) ?? findEventByIdempotencyKey(input.idempotencyKey);
  if (seen) {
    return { ok: true, mission: m, duplicate: true, extra: { duplicate: true, eventId: seen.eventId, firstServerTs: seen.serverTs } };
  }

  try {
    const extra = await applyEvent(m, input);
    const serverTs = nowIsoShanghai();
    const stored: StoredSceneEvent = {
      eventId: input.eventId, idempotencyKey: input.idempotencyKey, missionId: m.missionId, type: input.type,
      sceneId: m.sceneId, sceneRevision: m.sceneRevision, assetId: input.assetId, componentId: input.componentId,
      checkpointId: input.checkpointId, reason: input.reason, clientTs: input.clientTs, serverTs, payload: input.payload,
    };
    m.lastEvent = stored;
    m.updatedAt = serverTs;
    const rec: EventRecord = { ...stored, resultSummary: { phase: m.phase, inspectionTaskStatus: m.inspectionTaskId ? getTask(m.inspectionTaskId)?.status ?? null : null } };
    saveMission(m);
    recordEvent(rec);
    return { ok: true, mission: m, extra };
  } catch (e) {
    if (e instanceof RuntimeHttpError) return { ok: false, http: e.http, code: e.code, message: e.message, ...{} };
    if (e instanceof TransitionError) {
      const http = e.code === 'NOT_FOUND' ? 404 : e.code.startsWith('UNKNOWN') ? 400 : 409;
      return { ok: false, http, code: e.code, message: e.message };
    }
    throw e;
  }
}

async function applyEvent(m: MissionState, input: SceneEventInput): Promise<Record<string, unknown>> {
  switch (input.type) {
    case 'scene_entered':
      await refreshContext(m, 'scene_entered');
      saveMission(m);
      return { contextRefreshed: true };

    case 'asset_focused': {
      if (!input.assetId || !hasNode(input.assetId)) throw new RuntimeHttpError(400, 'UNKNOWN_ASSET', `未登记 assetId: ${input.assetId}`);
      m.pendingCommands = m.pendingCommands.filter((c) => !(c.kind === 'focus_asset' && c.targetId === input.assetId));
      m.focus = { assetId: input.assetId };
      syncPlanProgress(m, 'focus', input.assetId);
      await refreshContext(m, 'asset_focused');
      saveMission(m);
      return { focus: m.focus, contextVersion: m.contextVersion };
    }

    case 'component_focused': {
      if (!input.componentId || !hasNode(input.componentId)) throw new RuntimeHttpError(400, 'UNKNOWN_COMPONENT', `未登记 componentId: ${input.componentId}`);
      m.pendingCommands = m.pendingCommands.filter((c) => !(c.kind === 'show_component' && c.targetId === input.componentId));
      m.focus = { ...m.focus, componentId: input.componentId };
      await refreshContext(m, 'component_focused');
      saveMission(m);
      return { focus: m.focus, contextVersion: m.contextVersion };
    }

    case 'environment_changed':
      await refreshContext(m, 'environment_changed');
      saveMission(m);
      return { contextVersion: m.contextVersion };

    case 'checkpoint_arrived': {
      if (!input.checkpointId || !fixture.checkpoints.some((c: any) => c.id === input.checkpointId)) {
        throw new RuntimeHttpError(400, 'UNKNOWN_CHECKPOINT', `未登记检查点 ${input.checkpointId}`);
      }
      if (!m.inspectionTaskId || !getTask(m.inspectionTaskId)) throw new RuntimeHttpError(409, 'NO_INSPECTION_TASK', '尚无巡检任务（需先批准提案）');
      // 命中的导航命令视为已执行
      m.pendingCommands = m.pendingCommands.filter((c) => !(c.kind === 'navigate_to_checkpoint' && c.targetId === input.checkpointId));
      const cp = fixture.checkpoints.find((c: any) => c.id === input.checkpointId)! as { id: string; nodeId: string; kind: string };
      const effects: Record<string, unknown> = { checkpointId: cp.id };
      if (input.checkpointId === m.route.frontCheckpointId) {
        pushEvent(m.inspectionTaskId, 'arrive_front', { operator: m.operator });
        syncPlanProgress(m, 'navigate', input.checkpointId);
        setPhase(m, 'awaiting-evidence');
        await refreshContext(m, 'approaching_checkpoint');
        effects.taskEvent = 'arrive_front';
        effects.taskStatus = getTask(m.inspectionTaskId)!.status;
        // 下一跳：屋面检查点命令（尚未到达时）
        if (m.route.roofCheckpointId && !m.pendingCommands.some((c) => c.targetId === m.route.roofCheckpointId)) {
          m.pendingCommands.push({ commandId: newCommandId(), kind: 'navigate_to_checkpoint', targetId: m.route.roofCheckpointId, missionId: m.missionId, issuedAt: nowIsoShanghai(), reason: '楼前已到达：沿登记路线前往屋面' });
        }
      } else if (input.checkpointId === m.route.roofCheckpointId) {
        pushEvent(m.inspectionTaskId, 'arrive_roof', { operator: m.operator });
        syncPlanProgress(m, 'navigate', input.checkpointId);
        effects.taskEvent = 'arrive_roof';
        // 屋面到达：刷新上下文（approaching_checkpoint 规则）+ 冲洗暂存证据并尝试推进
        await refreshContext(m, 'approaching_checkpoint');
        Object.assign(effects, postEvidenceAdvance(m));
        const task = getTask(m.inspectionTaskId)!;
        if (task.status === 'inspecting') {
          m.pendingCommands.push({ commandId: newCommandId(), kind: 'show_component', targetId: m.nodeId, missionId: m.missionId, issuedAt: nowIsoShanghai(), reason: '屋面到达：显示目标组串拆解视图' });
        }
        effects.taskStatus = task.status;
      } else {
        m.focus = { ...m.focus, checkpointId: input.checkpointId };
        await refreshContext(m, 'approaching_checkpoint');
        effects.note = `检查点 ${cp.id} 不在任务路线上，仅记录焦点（不推进巡检状态机）`;
      }
      saveMission(m);
      return effects;
    }

    case 'evidence_captured': {
      const evidenceItems: EvidenceInput[] = input.evidence
        ? Array.isArray(input.evidence) ? input.evidence : [input.evidence]
        : [];
      if (evidenceItems.length === 0) {
        throw new RuntimeHttpError(400, 'BAD_EVIDENCE', 'evidence_captured 须提供至少一条 evidence');
      }
      if (!m.inspectionTaskId || !getTask(m.inspectionTaskId)) throw new RuntimeHttpError(409, 'NO_INSPECTION_TASK', '尚无巡检任务（需先批准提案）');
      for (const ev of evidenceItems) {
        const checkpointId = ev.checkpointId ?? input.checkpointId;
        if (!checkpointId || !fixture.checkpoints.some((c: any) => c.id === checkpointId)) {
          throw new RuntimeHttpError(400, 'UNKNOWN_CHECKPOINT', `未登记证据检查点 ${checkpointId}`);
        }
        if (!['photo', 'thermal', 'reading', 'note'].includes(ev.kind ?? '')) {
          throw new RuntimeHttpError(400, 'UNKNOWN_KIND', `未知证据类型 ${ev.kind}（允许 photo|thermal|reading|note）`);
        }
        m.bufferedEvidence.push({ checkpointId, kind: ev.kind as 'photo' | 'thermal' | 'reading' | 'note', value: String(ev.value ?? ''), ts: ev.ts ?? nowIsoShanghai() });
      }
      const effects = postEvidenceAdvance(m);
      saveMission(m);
      return effects;
    }

    case 'navigation_failed': {
      // 安全语义：记录 blocked + warning，绝不自动跳过或改道未登记路线
      warn(m, `NAVIGATION_FAILED: ${input.reason}（保持阻塞，不自动跳过）`);
      const step = m.plan?.steps.find((s) => s.kind === 'navigate' && (!input.checkpointId || s.targetId === input.checkpointId));
      if (step) step.status = 'blocked';
      saveMission(m);
      return { blocked: true, checkpointId: input.checkpointId ?? null };
    }
  }
}

/**
 * 证据推进（确定性，幂等）：把暂存/新增证据写入巡检任务（addEvidence）→ 需要时 submit_evidence →
 * 屋面证据齐备才 resolve；缺 ROOF 证据时保持 awaiting-evidence 阻塞并记录 EVIDENCE_MISSING（不自动跳过）。
 */
function postEvidenceAdvance(m: MissionState): Record<string, unknown> {
  const effects: Record<string, unknown> = {};
  const task = getTask(m.inspectionTaskId!)!;

  // 冲洗暂存证据（任务只有 inspecting/evidence-submitted 才能收证据；此前一律暂存）
  const stillBuffered: typeof m.bufferedEvidence = [];
  for (const b of m.bufferedEvidence) {
    try {
      const ev = addEvidenceSafe(m, task.id, b);
      m.evidenceRefs.push(ev.id);
      syncPlanProgress(m, 'capture-evidence', b.checkpointId);
      effects.addedEvidence = [...((effects.addedEvidence as string[]) ?? []), ev.id];
    } catch (e) {
      if (e instanceof TransitionError && (e.code === 'ILLEGAL_STATE' || e.code === 'ALREADY_CLOSED')) stillBuffered.push(b);
      else throw e;
    }
  }
  m.bufferedEvidence = stillBuffered;
  if (stillBuffered.length > 0) effects.buffered = stillBuffered.length;

  const t1 = getTask(task.id)!;
  if (t1.status === 'inspecting' && t1.evidence.length > 0) {
    pushEvent(t1.id, 'submit_evidence', { operator: m.operator });
    effects.taskEvent = 'submit_evidence';
  }

  const t2 = getTask(task.id)!;
  if (t2.status === 'evidence-submitted') {
    const hasRoof = t2.evidence.some((e) => e.checkpointId.endsWith('-ROOF'));
    if (hasRoof) {
      pushEvent(t2.id, 'resolve', { operator: m.operator });
      setPhase(m, 'awaiting-confirmation');
      m.pendingApproval = makeApproval(m, 'close', ['close_task'], '屋面证据齐备：确认闭环并撤销异常注入');
      effects.taskEvent = 'resolve';
      effects.awaitingConfirmation = true;
    } else {
      try {
        pushEvent(t2.id, 'resolve', { operator: m.operator });
      } catch (e) {
        if (!(e instanceof TransitionError && e.code === 'EVIDENCE_MISSING')) throw e;
      }
      const step = m.plan?.steps.find((s) => s.kind === 'request-confirmation');
      if (step) step.status = 'blocked';
      warn(m, `EVIDENCE_MISSING: 缺少 ${m.route.roofCheckpointId ?? 'CP-xxx-ROOF'} 检查点证据，闭环保持阻塞（不自动跳过）`);
      effects.blocked = 'EVIDENCE_MISSING';
      effects.taskStatus = getTask(task.id)!.status;
    }
  }
  const t3 = getTask(task.id)!;
  effects.taskStatus = t3.status;
  effects.phase = m.phase;
  return effects;
}

function addEvidenceSafe(m: MissionState, taskId: string, b: { checkpointId: string; kind: 'photo' | 'thermal' | 'reading' | 'note'; value: string; ts: string }) {
  // 演示证据一律显式标 SIMULATED（不得伪称真实媒体事实）
  return addEvidence(taskId, { checkpointId: b.checkpointId, kind: b.kind, value: `[SIMULATED] ${b.value}`.trim(), ts: b.ts });
}

/** 计划步骤状态同步（只做确定性标注，不改变语义） */
function syncPlanProgress(m: MissionState, kind: Plan['steps'][number]['kind'], targetId?: string): void {
  if (!m.plan) return;
  const step = m.plan.steps.find((s) => s.kind === kind && s.status !== 'done' && (targetId === undefined || s.targetId === targetId));
  if (step) step.status = 'done';
}
