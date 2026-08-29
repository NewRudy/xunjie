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
import { createMission, handleSceneEvent, submitApproval, type Clarification } from './runtime';
import { latestMissionId, loadMission, nextSeq, recentTurns, recordTrace, recordTurn, resetAgentData } from './store';
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

export async function dispatchAvatarText(input: DispatchInput): Promise<DispatchResult> {
  const conversationId = input.conversationId?.trim() || DEFAULT_CONVERSATION_ID;
  const trace: TraceStep[] = [];
  const t0 = Date.now();

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
