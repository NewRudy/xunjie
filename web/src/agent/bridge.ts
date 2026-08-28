// 语义场景事件桥（contracts/scene-events.md）。
// 只发送语义事实（assetId/checkpointId/原因），绝不发送每帧相机/按键状态。
// 事件必须带 sceneId、sceneRevision、reason、clientTs、idempotencyKey；
// 无活动任务时先在本地缓冲，任务创建后按原 clientTs 补发；重复 key 不重复发送。
import { agentApi, AgentApiError } from './client'
import { applyResponse, log, missionStore, setEngineOffline } from './missionStore'
import { SCENE_ID, SCENE_REVISION, type SceneEvent, type SceneEventType } from './types'

const sentKeys = new Set<string>()
/** 任务创建前缓冲的事件（scene_entered / asset_focused），创建后补发 */
const buffered: Array<Omit<SceneEvent, 'missionId'>> = []

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function build(
  type: SceneEventType,
  reason: string,
  ids: { assetId?: string; componentId?: string; checkpointId?: string } = {},
  payload?: Record<string, unknown>,
): Omit<SceneEvent, 'missionId'> {
  return {
    eventId: newKey(),
    idempotencyKey: newKey(),
    type,
    sceneId: SCENE_ID,
    sceneRevision: SCENE_REVISION,
    reason,
    clientTs: new Date().toISOString(),
    ...ids,
    ...(payload ? { payload } : {}),
  }
}

async function dispatch(event: SceneEvent): Promise<void> {
  if (sentKeys.has(event.idempotencyKey)) return
  sentKeys.add(event.idempotencyKey)
  try {
    const resp = await agentApi.postEvent(event.missionId, event)
    applyResponse(resp)
    if (event.type === 'evidence_captured') missionStore.lastEvidenceResult = resp
    log(`事件已上报：${event.type}${event.assetId ? ` ${event.assetId}` : ''}${event.checkpointId ? ` ${event.checkpointId}` : ''}`)
  } catch (e) {
    sentKeys.delete(event.idempotencyKey) // 发送失败允许重试
    if (e instanceof AgentApiError && e.status === null) {
      setEngineOffline('引擎不可达，事件待重试')
      log(`事件发送失败（引擎离线）：${event.type}`)
    } else {
      log(`事件被拒绝：${event.type} — ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

function emit(event: Omit<SceneEvent, 'missionId'>): Promise<void> {
  const missionId = missionStore.mission?.missionId
  if (!missionId) {
    buffered.push(event)
    log(`事件已缓冲（尚无任务）：${event.type}`)
    return Promise.resolve()
  }
  return dispatch({ ...event, missionId })
}

/** 任务创建后补发缓冲事件（保留原 clientTs 与幂等键） */
export function flushBufferedEvents(): void {
  const missionId = missionStore.mission?.missionId
  if (!missionId) return
  while (buffered.length > 0) {
    const ev = buffered.shift()!
    // 创建任务请求已经把 sceneId/sceneRevision 纳入上下文；不再补发创建前的 scene_entered，
    // 避免刚生成的审批因一个初始化事件发生无意义的 contextVersion 刷新。
    if (ev.type === 'scene_entered') {
      log('场景初始化已纳入任务上下文，跳过创建前的 scene_entered 补发')
      continue
    }
    void dispatch({ ...ev, missionId })
  }
}

/** 场景初始化完成后发送一次 scene_entered（无任务时缓冲） */
export function emitSceneEntered(): void {
  emit(build('scene_entered', '场景初始化完成，操作员进入园区三维场景'))
}

/** 设备点击：只发语义 ID，不发屏幕坐标/相机 */
export function emitAssetFocused(assetId: string, reason = '用户在场景中点击设备'): Promise<void> {
  return emit(build('asset_focused', reason, { assetId }))
}

/** 场景命令 show_component 执行成功后的语义回执。 */
export function emitComponentFocused(componentId: string): Promise<void> {
  return emit(build('component_focused', '场景命令已执行：显示部件', { componentId }))
}

/** 数字运维人员真正到达登记检查点后调用（开始移动不得冒充到达） */
export function emitCheckpointArrived(checkpointId: string): Promise<void> {
  return emit(build('checkpoint_arrived', '数字运维人员（仿真）到达登记检查点', { checkpointId }))
}

/** 导航失败：带原因与可选替代检查点，由后端决定 blocked/重新提案 */
export function emitNavigationFailed(checkpointId: string, reason: string, alternatives?: string[]): void {
  emit(
    build('navigation_failed', reason, { checkpointId }, alternatives ? { alternatives } : undefined),
  )
}

/**
 * 证据采集：只发送结构化的仿真证据引用（类型 + 检查点），
 * 证据值与状态以后端响应为准，前端不编造媒体事实。
 */
export function emitEvidenceCaptured(checkpointId: string, kinds: Array<'photo' | 'thermal' | 'reading'>): Promise<void> {
  const evidence = kinds.map((kind) => ({
    kind,
    checkpointId,
    value: `sim://${checkpointId}/${kind}`,
    ts: new Date().toISOString(),
  }))
  return emit({
    ...build('evidence_captured', '用户在检查点提交仿真证据', { checkpointId }, {
      simulated: true,
      evidenceRefs: evidence.map((item) => item.value),
    }),
    evidence,
  })
}
