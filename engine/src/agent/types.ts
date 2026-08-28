// Agent 合同类型（contracts/agent-state.md / agent-context.md / scene-events.md / agent-tools.md）
// MissionState 是唯一业务状态；长 prompt、思维链、密钥一律不落库。

export type TruthTag = 'MEASURED' | 'MODELED' | 'SIMULATED' | 'POLICY';
export type ContextAvailability = 'available' | 'partial' | 'stale' | 'unavailable';

export interface ContextItem {
  key: string;
  scope: 'mission' | 'scene' | 'asset' | 'component' | 'environment' | 'anomaly' | 'sop' | 'evidence';
  availability: ContextAvailability;
  data: unknown;
  sourceRefs: string[];
  truth?: TruthTag;
  observedAt?: string;
  validUntil?: string;
  reasonIncluded: string;
}

export type PlanStepKind = 'navigate' | 'focus' | 'inspect' | 'capture-evidence' | 'request-confirmation' | 'verify';

export interface PlanStep {
  id: string;
  kind: PlanStepKind;
  title: string;
  targetId?: string;
  requiredEvidence?: string[];
  status: 'pending' | 'active' | 'done' | 'blocked';
}

export interface Plan {
  planHash: string;
  summary: string;
  steps: PlanStep[];
  basisRefs: string[];
}

export interface Approval {
  approvalId: string;
  missionId: string;
  contextVersion: string;
  planHash: string;
  requestedActions: string[];
  reason: string;
  impact: 'digital-simulation-only';
  expiresAt: string;
  /** 扩展：plan=执行计划审批；close=闭环确认（mission.close_or_escalate） */
  purpose: 'plan' | 'close';
}

export interface SceneCommand {
  commandId: string;
  kind: 'focus_asset' | 'navigate_to_checkpoint' | 'switch_form' | 'show_component';
  targetId: string;
  missionId: string;
  issuedAt: string;
  reason: string;
}

export interface MissionFocus {
  assetId?: string;
  componentId?: string;
  checkpointId?: string;
}

export type MissionPhase =
  | 'created' | 'context-ready' | 'proposed' | 'awaiting-approval'
  | 'executing' | 'awaiting-evidence' | 'awaiting-confirmation'
  | 'resolved' | 'escalated' | 'cancelled';

export interface BufferedEvidence {
  checkpointId: string;
  kind: 'photo' | 'thermal' | 'reading' | 'note';
  value: string;
  ts: string;
}

/** 合同 MissionState + 演示编排所需的确定性扩展字段（不含 prompt/思维链/密钥） */
export interface MissionState {
  missionId: string;
  conversationId: string;
  sceneId: string;
  sceneRevision: string;
  objective: string;
  trigger: 'user' | 'anomaly' | 'system';
  operator: string;
  phase: MissionPhase;
  focus: MissionFocus;
  anomalyId: string;
  nodeId: string;
  inspectionTaskId?: string;
  contextVersion: string;
  contextHash?: string;
  /** 最近一次装配的 LLM 上下文（有界预算，含来源与时效；供重启恢复与前端展示） */
  contextItems: ContextItem[];
  plan?: Plan;
  pendingApproval?: Approval;
  observationRefs: string[];
  evidenceRefs: string[];
  sourceRefs: string[];
  lastEvent?: StoredSceneEvent;
  warnings: string[];
  /** 扩展：已下发未确认的场景命令（前端按 commandId 幂等执行） */
  pendingCommands: SceneCommand[];
  /** 扩展：巡检任务未到可收证据状态时暂存的证据（onsite 前不能 addEvidence） */
  bufferedEvidence: BufferedEvidence[];
  /** 扩展：阶段迁移历史（created 起，含时间） */
  phaseHistory: Array<{ phase: MissionPhase; ts: string }>;
  /** 扩展：提案来源信息（确定性回退/LLM 与 fallback 原因） */
  planner: PlannerInfo;
  /** 扩展：由装配上下文推导的已登记路线检查点（运行期映射 checkpoint_arrived → 巡检事件） */
  route: { frontCheckpointId: string | null; roofCheckpointId: string | null };
  /** 扩展：闭环回执（closeTask 成功后固化） */
  receipt?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// —— 场景事件（scene-events.md §1） ——

export type SceneEventType =
  | 'scene_entered'
  | 'asset_focused'
  | 'component_focused'
  | 'checkpoint_arrived'
  | 'environment_changed'
  | 'evidence_captured'
  | 'navigation_failed';

export interface SceneEventInput {
  eventId: string;
  idempotencyKey: string;
  type: SceneEventType;
  sceneId?: string;
  sceneRevision?: string;
  assetId?: string;
  componentId?: string;
  checkpointId?: string;
  reason: string;
  clientTs: string;
  payload?: Record<string, unknown>;
  evidence?: EvidenceInput | EvidenceInput[];
}

export interface EvidenceInput {
  checkpointId?: string;
  kind?: string;
  value?: string;
  ts?: string;
}

export interface StoredSceneEvent {
  eventId: string;
  idempotencyKey: string;
  missionId: string;
  type: SceneEventType;
  sceneId: string;
  sceneRevision: string;
  assetId?: string;
  componentId?: string;
  checkpointId?: string;
  reason: string;
  clientTs: string;
  serverTs: string;
  payload?: Record<string, unknown>;
}

// —— 统一结果外壳（agent-tools.md §3） ——

export interface ResultEnvelope<T> {
  status: 'available' | 'partial' | 'stale' | 'unavailable' | 'rejected';
  data: T;
  sourceRefs: string[];
  truth: TruthTag;
  observedAt?: string;
  validUntil?: string;
  warnings: string[];
  nextAllowedActions: string[];
  planner: PlannerInfo;
}

export interface PlannerInfo {
  mode: 'deterministic-fallback' | 'llm';
  modelAvailable: boolean;
  reason?: string;
}

/** 模型适配器可返回的原始提案（进入 runtime 前必须过确定性校验） */
export interface RawProposal {
  summary: string;
  steps: Array<{ kind: string; title: string; targetId?: string; requiredEvidence?: string[] }>;
  basisRefs?: string[];
}
