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

// —— 上下文问答门控（确定性，先于 LLM）：身份 / 场景 / 任务 / 对象（状态·参数·位置） ——
// 原则：回答只讲人话——关键事实组织成自然语句；ID/来源/编码留在 sceneBrief 结构化字段给前端使用。
const IDENTITY_QA_RE = /你是谁|你叫什么|自我介绍|介绍(?:一下|下)?你自己/;
const SCENE_QA_RE = /什么场景|啥场景|当前场景|这是(?:哪里|什么地方)|场景信息|现在是哪里|哪个场站|什么站/;
const MISSION_QA_RE = /当前任务|任务状态|什么任务|啥任务|任务进展/;

const OBJ_CMD_VERB_RE = /飞到|跑到|走到|前往|赶去|回去|回到|运维点|维修|修复|消缺|检修|查看|看看|聚焦|对准|停下|停止|站住|暂停|别动|左转|右转|转身|掉头|跳|采集|提交|取证|拍照|检查|巡检|排查|同意|批准|赞同|执行|拒绝|取消|证据|起飞|降落|落地|着陆|悬停|上升|下降|升高|降低|爬升/;
const OBJ_REFERENT_RE = /它|这个设备|该设备|当前对象|当前设备|这台|该机组/;
const OBJ_TURBINE_RE = /([0-9]{1,2}|[一二两三四五六七八九十])\s*号\s*(?:风机|机组)?|HS-WTG-(\d{2})/i;
const OBJ_STATUS_RE = /状态|风险|情况|严重|怎么样|怎样|正常|告警|健康|预警|毛病|问题/;
const OBJ_SPEC_RE = /参数|尺寸|长宽高|多高|多大|规格|功率|高度|直径|型号|机型|多少米|叶片|齿轮箱|发电机|基础|多少千瓦/;
const OBJ_POS_RE = /位置|坐标|在哪|朝向|多远|海拔|标高|方位/;

interface ContextAnswer {
  reply: string;
  brief: Record<string, unknown>;
}

interface WindTurbineMeta {
  id: string;
  label: string;
  no: number;
  checkpointId: string;
  offset?: { east: number; north: number; up: number };
  headingDeg?: number;
  riskLevel?: 'normal' | 'warning' | 'critical';
  stateNote?: string;
}

const RISK_LABEL_CN: Record<string, string> = { normal: '正常', warning: '预警', critical: '严重' };

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function turbineByNo(no: number): WindTurbineMeta | undefined {
  return windFarm.turbines.find((t) => t.no === no) as WindTurbineMeta | undefined;
}

function parseTurbineNo(raw: string): number {
  if (/^[0-9]+$/.test(raw)) return Number.parseInt(raw, 10);
  return CN_NUM[raw] ?? Number.NaN;
}

/** 指代解析：显式「N 号风机」优先；否则回看最近几轮命令里最后指向的机组（「它」） */
function resolveTurbine(text: string, conversationId: string): WindTurbineMeta | null {
  const m = text.match(OBJ_TURBINE_RE);
  if (m) {
    const no = m[1] !== undefined ? parseTurbineNo(m[1]) : Number.parseInt(m[2] ?? '', 10);
    return turbineByNo(no) ?? null;
  }
  if (OBJ_REFERENT_RE.test(text)) {
    for (const turn of recentTurns(conversationId, 3)) {
      for (const c of [...turn.commands].reverse()) {
        const tm = String(c.targetId ?? '').match(/^(?:HS-WTG|CP-WT)-(\d{2})$/);
        if (tm) return turbineByNo(Number(tm[1])) ?? null;
      }
    }
  }
  return null;
}

function humanPhase(phase: string): string {
  return (
    (
      {
        created: '刚建立',
        'context-ready': '正在汇总现场信息',
        proposed: '已给出处理建议',
        'awaiting-approval': '正在等你批准',
        executing: '正在现场执行',
        'awaiting-evidence': '正在等现场证据',
        'awaiting-confirmation': '证据齐了，等你确认闭环',
        resolved: '已完成闭环',
        escalated: '已升级处理',
        cancelled: '已取消',
      } as Record<string, string>
    )[phase] ?? phase
  );
}

function missionHumanLine(): string {
  const id = latestMissionId();
  const m = id ? loadMission(id) : null;
  return m ? `当前有一个巡检任务，${humanPhase(m.phase)}。` : '当前没有进行中的任务。';
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

function turbineAnswer(t: WindTurbineMeta, text: string): ContextAnswer {
  const specs = windFarm.specs ?? {};
  if (OBJ_SPEC_RE.test(text)) {
    let keys: string[];
    if (/长宽高|机舱/.test(text)) keys = ['机型', '机舱尺寸'];
    else if (/高/.test(text)) keys = ['机型', '轮毂高度', '塔筒高度'];
    else if (/直径|叶轮|叶片/.test(text)) keys = ['机型', '叶轮直径', '叶片长度'];
    else if (/功率|千瓦|多大/.test(text)) keys = ['机型', '额定功率'];
    else if (/齿轮箱|发电机|基础/.test(text)) keys = [text.match(/齿轮箱|发电机|基础/)![0]];
    else keys = ['机型', '额定功率', '轮毂高度', '叶轮直径', '塔筒高度', '机舱尺寸'];
    const parts = keys.filter((k) => specs[k]).map((k) => `${k} ${specs[k]}`);
    return { reply: `${t.label}是${specs['机型'] ?? '风电机组'}：${parts.join('；')}。`, brief: { kind: 'object', object: t.id, aspect: 'specs' } };
  }
  if (OBJ_POS_RE.test(text)) {
    const o = t.offset;
    const where = o ? `在场地${(o.north ?? 0) >= 0 ? '北' : '南'}侧偏${(o.east ?? 0) >= 0 ? '东' : '西'}方向，场地高程约 ${o.up} 米` : '沿山脊布置';
    return { reply: `${t.label}${where}，机舱朝向约 ${t.headingDeg ?? '—'} 度。`, brief: { kind: 'object', object: t.id, aspect: 'position' } };
  }
  const level = RISK_LABEL_CN[t.riskLevel ?? 'normal'];
  const note = t.stateNote?.trim();
  const statusLine = level === '正常' ? `${t.label}状态正常` : `${t.label}状态${level}——${note ?? '需要现场关注'}`;
  return {
    reply: `${statusLine}。机组是${specs['机型'] ?? '风电机组'}，轮毂高度${specs['轮毂高度'] ?? '—'}，叶轮直径${specs['叶轮直径'] ?? '—'}。想看详细参数可以问我「它的参数」。`,
    brief: { kind: 'object', object: t.id, aspect: OBJ_STATUS_RE.test(text) ? 'status' : 'overview', riskLevel: t.riskLevel ?? 'normal', stateNote: note ?? null },
  };
}

function answerContextQuestion(text: string, scene: 'pecc' | 'wind', conversationId: string): ContextAnswer | null {
  const meta = sceneMeta(scene);
  if (IDENTITY_QA_RE.test(text)) {
    return {
      reply: `我是「巡界」数字运维员，在${meta.name}的三维现场干活：移动巡检、设备查看、维修推演都可以交给我，重要的动作会先请你授权。${missionHumanLine()}`,
      brief: { kind: 'identity', missionPhase: (latestMissionId() ? loadMission(latestMissionId()!)?.phase : null) ?? null },
    };
  }
  if (SCENE_QA_RE.test(text)) {
    if (scene === 'wind') {
      const turbines = windFarm.turbines as WindTurbineMeta[];
      const crit = turbines.filter((t) => t.riskLevel === 'critical');
      const warn = turbines.filter((t) => t.riskLevel === 'warning');
      const lines = [`当前是${windFarm.name}，山脊上共有 ${turbines.length} 台${windFarm.specs?.['机型'] ?? '风电机组'}`];
      if (crit.length) lines.push(`其中${crit.map((t) => t.label).join('、')}问题比较严重——${crit.map((t) => t.stateNote ?? '需要处理').join('；')}`);
      if (warn.length) lines.push(`${warn.map((t) => t.label).join('、')}有预警`);
      lines.push(`其余机组运行正常，场内还有一个运维点。${missionHumanLine()}`);
      return { reply: lines.join('；'), brief: { kind: 'scene', ...meta } };
    }
    return {
      reply: `当前是光伏园区（演示仿真）：B2 屋顶的光伏阵列里登记了 7 号组串的发电异常，逆变器和楼前、屋面检查点都已入图。${missionHumanLine()}`,
      brief: { kind: 'scene', ...meta },
    };
  }
  if (MISSION_QA_RE.test(text)) {
    const id = latestMissionId();
    const m = id ? loadMission(id) : null;
    return {
      reply: m
        ? `${missionHumanLine()}${m.pendingApproval ? (m.pendingApproval.purpose === 'close' ? '证据已经齐了，就等你一句「我同意」确认闭环。' : '有一份处理建议正等你批准。') : ''}`
        : '当前没有进行中的任务。说「检查 B2 屋顶异常」就能建一个巡检任务（光伏场景）。',
      brief: { kind: 'mission', sceneId: meta.sceneId, missionId: m?.missionId ?? null, phase: m?.phase ?? null, inspectionTaskId: m?.inspectionTaskId ?? null },
    };
  }
  // 对象问答（风电：机组状态/参数/位置；「它」指代最近一轮命令指向的机组）
  if (scene === 'wind' && !OBJ_CMD_VERB_RE.test(text)) {
    const t = resolveTurbine(text, conversationId);
    if (t) return turbineAnswer(t, text);
  }
  return null;
}

export async function dispatchAvatarText(input: DispatchInput): Promise<DispatchResult> {
  const conversationId = input.conversationId?.trim() || DEFAULT_CONVERSATION_ID;
  const trace: TraceStep[] = [];
  const t0 = Date.now();

  // 上下文问答门控：元问题确定性作答，不消耗 LLM、不产生命令
  const qa = answerContextQuestion(input.text, input.scene, conversationId);
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
