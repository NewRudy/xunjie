# 巡界 Agent 任务状态合同

> MissionState 是可恢复的业务状态，不保存长 prompt、不保存隐式思维链、不保存密钥。后端状态机是唯一写入方。

## 1. 阶段

~~~text
created
  -> context-ready
  -> proposed
  -> awaiting-approval
  -> executing
  -> awaiting-evidence
  -> awaiting-confirmation
  -> resolved
  -> escalated | cancelled
~~~

允许的回退只有重新取上下文后回到 proposed；环境/告警变化会使旧建议失效，不得沿用旧批准直接执行。

## 2. MissionState

~~~ts
interface MissionState {
  missionId: string
  conversationId: string
  sceneId: string
  sceneRevision: string
  objective: string
  trigger: 'user' | 'anomaly' | 'system'
  operator: string
  phase: string
  focus: { assetId?: string; componentId?: string; checkpointId?: string }
  inspectionTaskId?: string
  contextVersion: string
  plan?: Plan
  pendingApproval?: Approval
  observationRefs: string[]
  evidenceRefs: string[]
  sourceRefs: string[]
  lastEvent?: AgentEvent
  warnings: string[]
  createdAt: string
  updatedAt: string
}
~~~

## 3. 提案、审批与命令

模型只能返回结构化提案；数字和 ID 必须引用已装配上下文或工具结果。

~~~ts
interface Plan {
  planHash: string
  summary: string
  steps: Array<{
    id: string
    kind: 'navigate' | 'focus' | 'inspect' | 'capture-evidence' | 'request-confirmation' | 'verify'
    title: string
    targetId?: string
    requiredEvidence?: string[]
    status: 'pending' | 'active' | 'done' | 'blocked'
  }>
  basisRefs: string[]
}

interface Approval {
  approvalId: string
  missionId: string
  contextVersion: string
  planHash: string
  requestedActions: string[]
  reason: string
  impact: 'digital-simulation-only'
  expiresAt: string
}

interface SceneCommand {
  commandId: string
  kind: 'focus_asset' | 'navigate_to_checkpoint' | 'switch_form' | 'show_component'
  targetId: string
  missionId: string
}
~~~

审批必须同时匹配 approvalId + contextVersion + planHash，并检查 expiresAt。拒绝、过期、版本不匹配都不得创建或推进真实/模拟巡检任务。

## 4. 与现有巡检状态机的关系

MissionState 负责“理解、建议、审批、编排”；engine/src/inspection.ts 继续负责 created → dispatched → enroute → onsite → inspecting → evidence-submitted → resolved/escalated 的业务迁移、证据门槛和异常恢复。

Agent 不得绕过 createTask、pushEvent、addEvidence、closeTask。所有重复请求必须幂等；非法迁移返回稳定错误，屋面异常没有 *-ROOF 证据不能闭环。

## 5. 事件回放

每个事件至少有：eventId、missionId、type、sceneId、sceneRevision、clientTs、serverTs、语义 ID（若有）、reason、idempotencyKey。重复 eventId/idempotencyKey 不得重复副作用。
