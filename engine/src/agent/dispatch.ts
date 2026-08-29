// 服务端受控编排（P1 编排收权 + P2 会话与 trace，contracts/avatar-command.md §0 / agent-state.md）
// 一句中文 → 解释（LLM-first，复用 interpretAvatar，人物路径行为不变）→ 命令分流：
//   闭环命令（start_inspection / decide_pending / capture_evidence）由服务端直接执行：
//     - start_inspection：演示复位 + 建任务原子化（重复演示不带脏状态）；
//     - decide_pending：服务端绑定当前 pendingApproval 的 approvalId/contextVersion/planHash
//       （"我同意"不再由前端读取状态后选择接口，语义与 /missions/:id/approval 完全一致）；
//     - capture_evidence：走既有状态机（过早取证自动暂存、缺 ROOF 证据保持阻塞），前端不再自行判断阶段；
//   场景命令（navigate/focus_asset/repair_simulation/运动类）原样返回前端执行（渲染层职责）。
// 会话（P2）：conversationId 聚合轮次摘要（有界窗口注入 prompt）与逐节点 trace（入库并随响应返回）。
// 本接口只加不减：/avatar/interpret 合同不变（风电页继续可用）。
import { resetAnomaly } from '../anomalyState';
import { resetTasks } from '../inspection';
import { nowIsoShanghai } from '../util';
import type { AvatarCommand } from './avatar';
import { interpretAvatar } from './avatar-llm';
import { SCENE_ID, SCENE_REVISION } from './context';
import { activeAdapter } from './model';
import { createMission, handleSceneEvent, submitApproval, type Clarification } from './runtime';
import { latestMissionId, loadMission, nextSeq, recentTurns, recordTrace, recordTurn, resetAgentData } from './store';
import { windFarm, WIND_REPAIR, WIND_SCENE_ID, WIND_SCENE_REVISION } from './windFarm';
import type { MissionState, PlannerInfo } from './types';

const CLOSED_LOOP_KINDS = ['start_inspection', 'decide_pending', 'capture_evidence'] as const;
type ClosedLoopKind = (typeof CLOSED_LOOP_KINDS)[number];

const isClosedLoop = (kind: string): kind is ClosedLoopKind => (CLOSED_LOOP_KINDS as readonly string[]).includes(kind);

export const DEFAULT_CONVERSATION_ID = 'CONV-DEMO';

export interface DispatchInput {
  text: string;
  sceneId: string;
  sceneRevision: string;
  scene: 'pecc' | 'wind';
  /** 缺省时自动定位最近创建的任务 */
  missionId?: string;
  /** start_inspection 前是否演示复位（默认 true，与页面"演示：检查 B2 屋顶异常"语义一致） */
  reset?: boolean;
  /** 会话 id（缺省 CONV-DEMO）：轮次摘要与 trace 按会话聚合 */
  conversationId?: string;
}

/** 逐节点 trace（agent-tools.md §3 精神：只含 label/status/耗时/错误类型，不含模型原文与密钥） */
export interface TraceStep {
  label: string;
  status: 'ok' | 'warn' | 'error';
  durationMs: number;
  detail?: string;
}

export type DispatchOutcome =
  | { kind: ClosedLoopKind; status: 'available'; detail: Record<string, unknown> }
  | { kind: ClosedLoopKind; status: 'rejected'; code: string; message: string };

export type DispatchResult =
  | {
      kind: 'ok';
      status: 'available' | 'partial' | 'rejected';
      conversationId: string;
      trace: TraceStep[];
      /** 上下文问答时携带结构化场景信息（identity/scene/mission） */
      sceneBrief?: Record<string, unknown>;
      normalizedText: string;
      reply: string;
      commands: AvatarCommand[];
      outcomes: DispatchOutcome[];
      mission: MissionState | null;
      planner: PlannerInfo;
    }
  | { kind: 'clarification'; conversationId: string; trace: TraceStep[]; clarification: Clarification; planner: PlannerInfo };

/** 与 /api/debug/reset 完全一致的三段复位（演示原子性：复位+建任务之间不留脏状态） */
function resetDemo(): void {
  resetTasks();
  resetAnomaly();
  resetAgentData();
}

type MissionResolve = { ok: true; m: MissionState } | { ok: false; code: string; message: string };

// —— 上下文问答门控（确定性，先于 LLM）：「你是谁」「当前啥场景」「当前任务」等场景元问题 ——
const IDENTITY_QA_RE = /你是谁|你叫什么|自我介绍|介绍(?:一下|下)?你自己/;
const SCENE_QA_RE = /什么场景|啥场景|当前场景|这是(?:哪里|什么地方)|场景信息|现在是哪里|哪个场站|什么站|当前模式|什么模式/;
const MISSION_QA_RE = /当前任务|任务状态|什么任务|啥任务|任务进展/;

interface ContextAnswer {
  reply: string;
  brief: Record<string, unknown>;
}

function sceneMeta(scene: 'pecc' | 'wind') {
  return scene === 'wind'
    ? {
        sceneId: WIND_SCENE_ID,
        sceneRevision: WIND_SCENE_REVISION,
        name: `${windFarm.name}（风电场站·演示仿真）`,
        registered: `10 台风机组 HS-WTG-01..10 + 塔下检查点 CP-WT-01..10 + 运维点 OPS-WIND-01；维修登记：${WIND_REPAIR.targetId}（${WIND_REPAIR.componentLabel}）`,
      }
    : {
        sceneId: SCENE_ID,
        sceneRevision: SCENE_REVISION,
        name: '光伏园区（演示仿真）',
        registered: '运维点 OPS-01、B2 楼前/屋面与逆变器检查点、组串 STR-B2-07、逆变器 INV-B-02；登记异常 ANOM-DEMO-01',
      };
}

function answerContextQuestion(text: string, scene: 'pecc' | 'wind'): ContextAnswer | null {
  const meta = sceneMeta(scene);
  const m = (() => {
    const id = latestMissionId();
    return id ? loadMission(id) : null;
  })();
  const missionLine = m ? `当前任务 ${m.missionId}，阶段 ${m.phase}${m.receipt ? '（已闭环）' : ''}` : '当前没有进行中的任务';
  if (IDENTITY_QA_RE.test(text)) {
    return {
      reply: `我是「巡界」数字运维员，在${meta.name}的三维现场执行空间作业（SIMULATED 仿真，不控制任何真实设备）。${missionLine}。你可以用中文指挥我移动、巡检与维修推演；闭环动作需经你授权。`,
      brief: { kind: 'identity', ...meta, missionId: m?.missionId ?? null, missionPhase: m?.phase ?? null },
    };
  }
  if (SCENE_QA_RE.test(text)) {
    const adapter = activeAdapter();
    return {
      reply: `当前场景：${meta.name}（${meta.sceneId}@${meta.sceneRevision}）。已登记对象：${meta.registered}。${missionLine}。指令解释方式：${adapter ? '大模型在线（白名单校验）' : '确定性解析'}。`,
      brief: { kind: 'scene', ...meta, missionId: m?.missionId ?? null, missionPhase: m?.phase ?? null, plannerMode: adapter ? 'llm' : 'deterministic-fallback' },
    };
  }
  if (MISSION_QA_RE.test(text)) {
    return {
      reply: m
        ? `${missionLine}；巡检任务 ${m.inspectionTaskId ?? '未创建'}；待审批：${m.pendingApproval ? (m.pendingApproval.purpose === 'close' ? '闭环确认' : '执行计划') : '无'}。`
        : '当前没有进行中的任务。说「检查 B2 屋顶异常」即可创建巡检任务（光伏场景）。',
      brief: { kind: 'mission', sceneId: meta.sceneId, missionId: m?.missionId ?? null, phase: m?.phase ?? null, inspectionTaskId: m?.inspectionTaskId ?? null },
    };
  }
  return null;
}

export async function dispatchAvatarText(input: DispatchInput): Promise<DispatchResult> {
  const conversationId = input.conversationId?.trim() || DEFAULT_CONVERSATION_ID;
  const trace: TraceStep[] = [];
  const t0 = Date.now();

  // 上下文问答门控：元问题确定性作答，不消耗 LLM、不产生命令
  const qa = answerContextQuestion(input.text, input.scene);
  if (qa) {
    const adapter = activeAdapter();
    trace.push({ label: '解释', status: 'ok', durationMs: Date.now() - t0, detail: 'context-qa' });
    trace.push({ label: '总计', status: 'ok', durationMs: Date.now() - t0 });
    recordTrace(`TRC-${nextSeq('trace')}`, conversationId, trace);
    recordTurn(conversationId, { text: input.text, scene: input.scene, commands: [], outcomeSummary: 'context-qa', ts: nowIsoShanghai() });
    return {
      kind: 'ok',
      status: 'available',
      conversationId,
      trace,
      sceneBrief: qa.brief,
      normalizedText: input.text,
      reply: qa.reply,
      commands: [],
      outcomes: [],
      mission: null,
      planner: adapter ? { mode: 'llm', modelAvailable: true } : { mode: 'deterministic-fallback', modelAvailable: false, reason: 'NO_CREDENTIALS' },
    };
  }

  const tInterpret = Date.now();
  const history = recentTurns(conversationId, 2).map((t) => ({ text: t.text, commands: t.commands }));
  const { normalizedText, reply, commands, planner } = await interpretAvatar(input.text, input.scene, history);
  trace.push({ label: '解释', status: 'ok', durationMs: Date.now() - tInterpret, detail: planner.mode });

  const outcomes: DispatchOutcome[] = [];
  let mission: MissionState | null = null;

  const resolveMission = (): MissionResolve => {
    const id = input.missionId ?? latestMissionId();
    const m = id ? loadMission(id) : null;
    if (!m) return { ok: false, code: 'NO_ACTIVE_MISSION', message: '当前没有活动任务：请先说「检查 B2 屋顶异常」创建任务' };
    return { ok: true, m };
  };

  for (const cmd of commands) {
    if (!isClosedLoop(cmd.kind)) continue; // 场景命令原样透传，服务端不执行
    const tCmd = Date.now();
    let outcome: DispatchOutcome;
    if (input.scene !== 'pecc') {
      outcome = { kind: cmd.kind, status: 'rejected', code: 'UNSUPPORTED_IN_SCENE', message: '风电场景暂未接任务闭环（仅 PECC-PARK-01 支持 start_inspection/decide_pending/capture_evidence）' };
    } else {
      switch (cmd.kind) {
        case 'start_inspection': {
          if (input.reset !== false) resetDemo();
          const res = await createMission({
            objective: normalizedText,
            sceneId: input.sceneId,
            sceneRevision: input.sceneRevision,
            anomalyId: cmd.anomalyId,
            trigger: 'user',
          });
          if ('clarification' in res) {
            trace.push({ label: `执行:${cmd.kind}`, status: 'warn', durationMs: Date.now() - tCmd, detail: 'CLARIFICATION_NEEDED' });
            trace.push({ label: '总计', status: 'warn', durationMs: Date.now() - t0 });
            recordTrace(`TRC-${nextSeq('trace')}`, conversationId, trace);
            return { kind: 'clarification', conversationId, trace, clarification: res.clarification, planner };
          }
          mission = res.mission;
          outcome = {
            kind: 'start_inspection',
            status: 'available',
            detail: { missionId: mission.missionId, phase: mission.phase, pendingApprovalId: mission.pendingApproval?.approvalId ?? null },
          };
          break;
        }
        case 'decide_pending': {
          const r = resolveMission();
          if (!r.ok) {
            outcome = { kind: 'decide_pending', status: 'rejected', code: r.code, message: r.message };
            break;
          }
          const pa = r.m.pendingApproval;
          if (!pa) {
            outcome = { kind: 'decide_pending', status: 'rejected', code: 'NO_PENDING_APPROVAL', message: `任务 ${r.m.missionId} 阶段 ${r.m.phase} 无挂起审批` };
            break;
          }
          // 语义统一：服务端用当前待审批项补全四重绑定，前端不再读取/回传审批三元组
          const res = await submitApproval(r.m.missionId, { approvalId: pa.approvalId, decision: cmd.decision, contextVersion: pa.contextVersion, planHash: pa.planHash });
          if (!res.ok) {
            outcome = { kind: 'decide_pending', status: 'rejected', code: res.code, message: res.message };
            break;
          }
          mission = res.mission;
          outcome = { kind: 'decide_pending', status: 'available', detail: { missionId: mission.missionId, phase: mission.phase, decision: cmd.decision } };
          break;
        }
        case 'capture_evidence': {
          const r = resolveMission();
          if (!r.ok) {
            outcome = { kind: 'capture_evidence', status: 'rejected', code: r.code, message: r.message };
            break;
          }
          const m = r.m;
          const roof = m.route.roofCheckpointId;
          if (!roof) {
            outcome = { kind: 'capture_evidence', status: 'rejected', code: 'NO_ROOF_CHECKPOINT', message: `任务 ${m.missionId} 路线上没有已登记屋面检查点` };
            break;
          }
          const seq = nextSeq('dispatch');
          const res = await handleSceneEvent(m.missionId, {
            eventId: `EVT-DISP-${seq}`,
            idempotencyKey: `dispatch-capture-${m.missionId}-${seq}`,
            type: 'evidence_captured',
            sceneId: m.sceneId,
            sceneRevision: m.sceneRevision,
            checkpointId: roof,
            reason: `语言指令：采集证据（${normalizedText}）`,
            clientTs: nowIsoShanghai(),
            evidence: (['photo', 'thermal', 'reading'] as const).map((kind) => ({ checkpointId: roof, kind, value: `语言指令取证（${kind}）`, ts: nowIsoShanghai() })),
          });
          if (!res.ok) {
            outcome = { kind: 'capture_evidence', status: 'rejected', code: res.code, message: res.message };
            break;
          }
          mission = res.mission;
          outcome = { kind: 'capture_evidence', status: 'available', detail: res.extra ?? {} };
          break;
        }
      }
    }
    outcomes.push(outcome);
    trace.push({
      label: `执行:${cmd.kind}`,
      status: outcome.status === 'available' ? 'ok' : 'error',
      durationMs: Date.now() - tCmd,
      ...(outcome.status === 'rejected' ? { detail: outcome.code } : {}),
    });
  }

  const anyOk = outcomes.some((o) => o.status === 'available');
  const anyRejected = outcomes.some((o) => o.status === 'rejected');
  const status = outcomes.length === 0 ? 'available' : anyRejected ? (anyOk ? 'partial' : 'rejected') : 'available';

  // 轮次摘要入库（进 prompt 的只有结构化字段）；trace 入库并随响应返回
  recordTurn(conversationId, {
    text: normalizedText,
    scene: input.scene,
    commands: commands.map((c) => ({ kind: c.kind, targetId: 'targetId' in c ? c.targetId : undefined })),
    missionId: mission?.missionId,
    outcomeSummary: outcomes.length ? outcomes.map((o) => `${o.kind}:${o.status}`).join(',') : 'scene-only',
    ts: nowIsoShanghai(),
  });
  trace.push({ label: '总计', status: anyRejected ? (anyOk ? 'warn' : 'error') : 'ok', durationMs: Date.now() - t0 });
  recordTrace(`TRC-${nextSeq('trace')}`, conversationId, trace);

  return { kind: 'ok', status, conversationId, trace, normalizedText, reply, commands, outcomes, mission, planner };
}
