// 巡界 Agent 前端类型：严格对应 contracts/agent-tools.md、agent-state.md、
// agent-context.md、scene-events.md。后端未返回的字段一律可选，不猜测默认值。
import type { TruthTag } from '../constants/truth'

/** 场景语义标识（contracts/agent-tools.md 示例值；非业务数字） */
export const SCENE_ID = 'PECC-PARK-01'
export const SCENE_REVISION = 'fixture-v1'

// ---- 场景事件（scene-events.md §1） ----

export type SceneEventType =
  | 'scene_entered'
  | 'asset_focused'
  | 'component_focused'
  | 'checkpoint_arrived'
  | 'environment_changed'
  | 'evidence_captured'
  | 'navigation_failed'

export interface SceneEvent {
  eventId: string
  idempotencyKey: string
  missionId: string
  type: SceneEventType
  sceneId: string
  sceneRevision: string
  assetId?: string
  componentId?: string
  checkpointId?: string
  reason: string
  clientTs: string
  payload?: Record<string, unknown>
  evidence?: { checkpointId?: string; kind?: 'photo' | 'thermal' | 'reading' | 'note'; value?: string; ts?: string } | Array<{ checkpointId?: string; kind?: 'photo' | 'thermal' | 'reading' | 'note'; value?: string; ts?: string }>
}

// ---- 后端场景命令（scene-events.md §2）：只处理高层命令 ----

export type SceneCommandKind =
  | 'focus_asset'
  | 'navigate_to_checkpoint'
  | 'switch_form'
  | 'show_component'

export interface SceneCommand {
  commandId: string
  kind: SceneCommandKind
  targetId: string
  missionId: string
  issuedAt?: string
  reason?: string
}

// ---- 任务状态（agent-state.md §2/§3） ----

export interface PlanStep {
  id: string
  kind: 'navigate' | 'focus' | 'inspect' | 'capture-evidence' | 'request-confirmation' | 'verify'
  title: string
  targetId?: string
  requiredEvidence?: string[]
  status: 'pending' | 'active' | 'done' | 'blocked'
}

export interface Plan {
  planHash: string
  summary: string
  steps: PlanStep[]
  basisRefs: string[]
}

export interface Approval {
  approvalId: string
  missionId: string
  contextVersion: string
  planHash: string
  requestedActions: string[]
  reason: string
  impact: 'digital-simulation-only'
  expiresAt: string
}

export interface MissionState {
  missionId: string
  conversationId?: string
  sceneId: string
  sceneRevision: string
  objective: string
  trigger: 'user' | 'anomaly' | 'system'
  operator: string
  phase: string
  focus?: { assetId?: string; componentId?: string; checkpointId?: string }
  inspectionTaskId?: string
  contextVersion: string
  plan?: Plan
  pendingApproval?: Approval
  observationRefs: string[]
  evidenceRefs: string[]
  sourceRefs: string[]
  warnings: string[]
  createdAt?: string
  updatedAt?: string
}

// ---- 上下文项（agent-context.md §2） ----

export type ContextAvailability = 'available' | 'partial' | 'stale' | 'unavailable'

export interface ContextItem {
  key: string
  scope: 'mission' | 'scene' | 'asset' | 'component' | 'environment' | 'anomaly' | 'sop' | 'evidence'
  availability: ContextAvailability
  data: unknown
  sourceRefs: string[]
  truth?: TruthTag
  observedAt?: string
  validUntil?: string
  reasonIncluded: string
}

// ---- 结构化提案（agent-tools.md：目标/原因/证据要求，字段以后端返回为准） ----

export interface MissionProposal {
  summary?: string
  targetId?: string
  reason?: string
  requiredEvidence?: string[]
  steps?: PlanStep[]
  [key: string]: unknown
}

// ---- 统一结果外壳（agent-tools.md §3） ----

export type EnvelopeStatus = 'available' | 'partial' | 'stale' | 'unavailable' | 'rejected'

export interface ResultEnvelope<T = unknown> {
  status: EnvelopeStatus
  data: T
  sourceRefs: string[]
  truth?: TruthTag
  observedAt?: string
  validUntil?: string
  warnings: string[]
  nextAllowedActions?: string[]
  /** avatar interpret 端点显式声明本轮由模型还是确定性回退生成。 */
  planner?: AvatarInterpretPlanner
}

// ---- 巡检任务与闭环回执（后端快照顶层字段；缺失即不显示，前端不猜） ----

export interface InspectionEvidenceView {
  id?: string
  checkpointId?: string
  kind?: string
  value?: string
  ts?: string
}

export interface InspectionTaskView {
  id?: string
  anomalyId?: string
  nodeId?: string
  status?: string
  createdAt?: string
  closedAt?: string | null
  evidence?: InspectionEvidenceView[]
}

export interface MissionReceipt {
  kind?: string
  taskId?: string
  taskStatus?: string
  closedAt?: string
  anomalyId?: string
  anomalyStatus?: string
  lossKwhTotal?: number
  truth?: string
  sourceRefs?: string[]
}

// ---- 任务接口响应（直出或包一层外壳，两种都兼容） ----

export interface MissionResponse {
  mission?: MissionState
  context?: ContextItem[] | { items?: ContextItem[]; contextVersion?: string; contextHash?: string; generatedAt?: string }
  proposal?: MissionProposal
  plan?: Plan | null
  pendingApproval?: Approval
  sceneCommands?: SceneCommand[]
  pendingCommands?: SceneCommand[]
  receipt?: MissionReceipt
  inspectionTask?: InspectionTaskView | null
  /** 模型在线/回退状态由后端显式给出，前端不得伪造 */
  model?: { mode?: string; online?: boolean; note?: string }
  planner?: { mode?: string; modelAvailable?: boolean; reason?: string }
  warnings?: string[]
  [key: string]: unknown
}

// ---- 数字运维员指令（contracts/avatar-command.md §3，展示控制面，不篡改 MissionState） ----

export type AvatarMovement = 'walk' | 'run' | 'fly'

export type AvatarCommand =
  | {
      commandId: string
      kind: 'navigate'
      targetId: 'OPS-01' | 'CP-B02-FRONT' | 'CP-B02-ROOF' | 'CP-INV-B02'
      movement: AvatarMovement
    }
  | {
      commandId: string
      kind: 'move_relative'
      direction: 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down'
      distanceMeters: number
      movement: AvatarMovement
    }
  | { commandId: string; kind: 'turn'; degrees: number }
  | { commandId: string; kind: 'jump' }
  | { commandId: string; kind: 'stop' }
  | { commandId: string; kind: 'focus_asset'; targetId: 'STR-B2-07' | 'INV-B-02' }
  | { commandId: string; kind: 'repair_simulation'; targetId: 'STR-B2-07'; checkpointId: 'CP-INV-B02' }
  // 任务闭环命令（§3/§7）：不进纯场景执行器，由 controller 复用既有任务/审批/证据链路
  | { commandId: string; kind: 'start_inspection'; anomalyId: 'ANOM-DEMO-01' }
  | { commandId: string; kind: 'decide_pending'; decision: 'approve' | 'reject' }
  | { commandId: string; kind: 'capture_evidence'; evidenceKinds: ['photo', 'thermal', 'reading'] }

export interface AvatarInterpretInput {
  text: string
  sceneId: string
  sceneRevision: string
}

export interface AvatarInterpretResult {
  normalizedText: string
  reply: string
  commands: AvatarCommand[]
}

export interface AvatarInterpretPlanner {
  mode: 'llm' | 'deterministic-fallback'
  modelAvailable: boolean
  reason?: string
}

export interface CreateMissionInput {
  objective: string
  sceneId: string
  sceneRevision: string
  operator: string
  trigger: 'user' | 'anomaly' | 'system'
  anomalyId?: string
}

export interface ApprovalInput {
  approvalId: string
  decision: 'approve' | 'reject'
  contextVersion: string
  planHash: string
}
