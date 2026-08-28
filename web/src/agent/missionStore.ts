// 前端任务状态 store：MissionState 的唯一前端镜像（后端状态机是唯一写入方，
// 前端只展示后端返回值，不在本地推进任务阶段）。
import { reactive } from 'vue'
import type {
  Approval,
  ContextItem,
  MissionProposal,
  MissionResponse,
  MissionState,
  ResultEnvelope,
  SceneCommand,
} from './types'

export type EngineStatus = 'unknown' | 'online' | 'offline'
/** 模型状态只来自后端显式字段；未知时显示“未知”，绝不伪称在线 */
export type ModelMode = 'unknown' | 'online' | 'fallback'

export interface LogEntry {
  ts: string
  text: string
}

export const missionStore = reactive({
  engine: 'unknown' as EngineStatus,
  modelMode: 'unknown' as ModelMode,
  modelNote: '',
  mission: null as MissionState | null,
  context: [] as ContextItem[],
  proposal: null as MissionProposal | null,
  pendingApproval: null as Approval | null,
  /** 待消费的高层场景命令（来自审批通过响应） */
  sceneCommands: [] as SceneCommand[],
  executing: false,
  executorState: 'idle' as 'idle' | 'moving' | 'arrived' | 'failed',
  arrivedCheckpointId: null as string | null,
  /** 最近一次 evidence_captured 的后端响应（证据值/状态以后端为准） */
  lastEvidenceResult: null as unknown,
  error: '',
 log: [] as LogEntry[],
})

const loggedWarnings = new Set<string>()

export function log(text: string): void {
  missionStore.log.push({ ts: new Date().toLocaleTimeString('zh-CN', { hour12: false }), text })
  if (missionStore.log.length > 200) missionStore.log.splice(0, missionStore.log.length - 200)
}

/** 判断响应是否包了一层统一结果外壳，并把后端 snapshot 归一化为前端视图模型。 */
function unwrap(resp: MissionResponse | ResultEnvelope<MissionResponse>): MissionResponse {
  const outer = resp as ResultEnvelope<MissionResponse>
  if (typeof outer?.status !== 'string' || !outer.data || typeof outer.data !== 'object') {
    return resp as MissionResponse
  }

  // 后端 data 是 MissionSnapshot：context.items、pendingCommands、plan 位于 snapshot 层。
  // 这里仅做结构归一化，不生成业务数字或设备事实。
  const inner = outer.data as unknown as Record<string, unknown>
  const mission = inner.mission as MissionState | undefined
  const contextRaw = inner.context as ContextItem[] | { items?: ContextItem[] } | undefined
  const context = Array.isArray(contextRaw) ? contextRaw : contextRaw?.items ?? []
  const plan = (inner.plan as MissionState['plan'] | null | undefined) ?? mission?.plan
  const steps = plan?.steps ?? []
  const proposal =
    (inner.proposal as MissionProposal | undefined) ??
    (plan
      ? {
          summary: plan.summary,
          reason: plan.summary,
          targetId: steps.find((step) => step.targetId)?.targetId,
          requiredEvidence: [...new Set(steps.flatMap((step) => step.requiredEvidence ?? []))],
          steps,
        }
      : undefined)
  const pendingApproval = (inner.pendingApproval as MissionState['pendingApproval'] | null | undefined) ??
    mission?.pendingApproval ??
    null
  const sceneCommands = Array.isArray(inner.sceneCommands)
    ? (inner.sceneCommands as SceneCommand[])
    : Array.isArray(inner.pendingCommands)
      ? (inner.pendingCommands as SceneCommand[])
      : undefined
  const planner =
    (inner.planner as MissionResponse['planner'] | undefined) ??
    ((mission as (MissionState & { planner?: MissionResponse['planner'] }) | undefined)?.planner)
  const model =
    (inner.model as MissionResponse['model'] | undefined) ??
    (planner
      ? {
          mode: planner.mode === 'llm' ? 'online' : 'fallback',
          online: planner.modelAvailable,
          note: planner.reason,
        }
      : undefined)
  return {
    ...(inner as MissionResponse),
    mission: mission
      ? { ...mission, plan: mission.plan ?? plan ?? undefined, pendingApproval: pendingApproval ?? undefined }
      : undefined,
    context,
    plan,
    proposal,
    pendingApproval: pendingApproval ?? undefined,
    sceneCommands,
    model,
    planner,
    warnings: [
      ...((inner.warnings as string[] | undefined) ?? []),
      ...(outer.warnings ?? []),
    ],
  }
}

/** 应用后端响应：只搬运后端字段，缺失即清空/保留为空，不本地编造 */
export function applyResponse(resp: MissionResponse | ResultEnvelope<MissionResponse>): void {
  const r = unwrap(resp)
 missionStore.engine = 'online'
 missionStore.error = ''
 if (r.mission) missionStore.mission = r.mission
  if (Array.isArray(r.context)) missionStore.context = r.context
 if (r.proposal !== undefined) missionStore.proposal = r.proposal
 // pendingApproval 以后端为准；审批通过后后端应清空
 missionStore.pendingApproval = r.pendingApproval ?? r.mission?.pendingApproval ?? null
 if (Array.isArray(r.sceneCommands)) missionStore.sceneCommands = r.sceneCommands
  // 模型在线/回退状态：只认后端显式声明
  const mode = r.model?.mode
  if (mode === 'online' || r.model?.online === true) {
    missionStore.modelMode = 'online'
    missionStore.modelNote = r.model?.note ?? ''
  } else if (mode === 'fallback' || mode === 'deterministic' || r.model?.online === false) {
    missionStore.modelMode = 'fallback'
    missionStore.modelNote = r.model?.note ?? '模型不可用，使用确定性回退'
  }
  for (const w of r.warnings ?? r.mission?.warnings ?? []) {
    if (loggedWarnings.has(w)) continue
    loggedWarnings.add(w)
    log(`警告：${w}`)
  }
}

export function setEngineOffline(message: string): void {
  missionStore.engine = 'offline'
  missionStore.error = message
}

export function resetMission(): void {
  missionStore.mission = null
  missionStore.context = []
  missionStore.proposal = null
  missionStore.pendingApproval = null
  missionStore.sceneCommands = []
  missionStore.arrivedCheckpointId = null
 missionStore.lastEvidenceResult = null
 missionStore.executorState = 'idle'
  missionStore.log.splice(0)
  loggedWarnings.clear()
}
