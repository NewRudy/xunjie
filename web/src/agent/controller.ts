// 任务闭环控制器：创建任务 → 审批 → 消费场景命令 → 到达/证据事件。
// 审批只走 /approval 接口（approvalId + contextVersion + planHash 严格匹配），
// 不用自然语言绕过审批；前端不本地推进任务阶段。
import type * as Cesium from 'cesium'
import { agentApi, AgentApiError } from './client'
import { applyResponse, log, missionStore, resetMission, setEngineOffline } from './missionStore'
import { emitAssetFocused, emitEvidenceCaptured, emitSceneEntered, flushBufferedEvents } from './bridge'
import { runSceneCommands } from './commands'
import { PatrolExecutor } from './executor'
import { AvatarActor, avatarStore } from './avatar'
import { executeAvatarCommands } from './avatarCommands'
import { SCENE_ID, SCENE_REVISION, type AvatarInterpretResult, type ResultEnvelope } from './types'
import { fixture } from '../fixture'

let viewer: Cesium.Viewer | null = null
let executor: PatrolExecutor | null = null
let actor: AvatarActor | null = null

/** 场景初始化后调用：建数字运维员与执行器并发送一次 scene_entered */
export function initAgent(v: Cesium.Viewer): void {
  viewer = v
  actor = new AvatarActor(v)
  actor.ensureEntity()
  executor = new PatrolExecutor(v, actor)
  emitSceneEntered()
}

/** 调试挂钩：无头验证脚本用 */
export function getExecutor(): PatrolExecutor | null {
  return executor
}

/** 设备点击（viewer.ts 调用）：发送 asset_focused 语义事件 */
export function notifyAssetClicked(assetId: string): void {
  emitAssetFocused(assetId)
}

/** 消费一轮命令后继续接收后端根据到达事件签发的下一跳命令。 */
async function consumeSceneCommands(): Promise<void> {
  if (!viewer || !executor) return
  let rounds = 0
  while (missionStore.sceneCommands.length > 0 && rounds < 8) {
    const cmds = missionStore.sceneCommands
    missionStore.sceneCommands = []
    await runSceneCommands(viewer, executor, cmds)
    rounds += 1
  }
  if (missionStore.sceneCommands.length > 0) {
    log('场景命令超过单次安全消费上限，剩余命令保留在任务队列')
  }
}

async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof AgentApiError && e.status === null) {
      setEngineOffline(`引擎不可达（${agentApi.baseUrl}）`)
    } else {
      missionStore.error = e instanceof Error ? e.message : String(e)
    }
    log(`请求失败：${missionStore.error}`)
    return undefined
  }
}

/** 创建任务（通用入口） */
export async function createMission(objective: string, anomalyId?: string): Promise<void> {
  executor?.cancel()
  resetMission()
  log(`创建任务：${objective}`)
  const resp = await guard(() =>
    agentApi.createMission({
      objective,
      sceneId: SCENE_ID,
      sceneRevision: SCENE_REVISION,
      operator: '运维员-演示',
      trigger: anomalyId ? 'anomaly' : 'user',
      ...(anomalyId ? { anomalyId } : {}),
    }),
  )
  if (!resp) return
  applyResponse(resp)
  flushBufferedEvents()
  log(`任务已创建：${missionStore.mission?.missionId ?? '?'}，阶段 ${missionStore.mission?.phase ?? '?'}`)
}

/** 演示入口：检查 B2 屋顶异常（异常引用来自 fixture.demoAnomaly） */
export function createDemoMission(): Promise<void> {
  return createMission('去看一下 B2 屋顶这个异常', fixture.demoAnomaly.id)
}

/** 审批：严格调用审批接口；拒绝时中断任何进行中的仿真动作 */
export async function decide(decision: 'approve' | 'reject'): Promise<void> {
  const mission = missionStore.mission
  const approval = missionStore.pendingApproval
  if (!mission || !approval) return
  log(decision === 'approve' ? '用户同意提案，提交审批…' : '用户拒绝提案')
  const resp = await guard(() =>
    agentApi.postApproval(mission.missionId, {
      approvalId: approval.approvalId,
      decision,
      contextVersion: approval.contextVersion,
      planHash: approval.planHash,
    }),
  )
  if (!resp) return
  applyResponse(resp)
  if (decision === 'reject') {
    executor?.cancel()
    missionStore.sceneCommands = []
    log('已拒绝：不创建/推进任何巡检动作')
    return
  }
  // 审批通过：消费后端返回的高层场景命令
  if (missionStore.sceneCommands.length > 0 && viewer && executor) {
    await consumeSceneCommands()
  } else {
    log('审批通过，后端未返回场景命令')
  }
}

/**
 * 数字运维员自然语言入口（contracts/avatar-command.md §2）。
 * 只调用后端 /api/agent/avatar/interpret；前端不做任何本地自然语言猜测。
 * 纯 avatar 控制：消费命令移动人物，但不创建/推进任何 mission，不上报到达事件。
 */
export async function sendAvatarText(text: string): Promise<void> {
  if (!viewer || !actor) return
  const input = text.trim()
  if (!input) return
  avatarStore.lastText = input
  avatarStore.reply = ''
  avatarStore.error = ''
  avatarStore.lastCommands = []
  log(`数字运维员指令：「${input}」→ POST /api/agent/avatar/interpret`)
  let resp: AvatarInterpretResult | ResultEnvelope<AvatarInterpretResult>
  try {
    resp = await agentApi.interpretAvatar({ text: input, sceneId: SCENE_ID, sceneRevision: SCENE_REVISION })
  } catch (e) {
    if (e instanceof AgentApiError && e.status === null) {
      avatarStore.error = `引擎不可达（${agentApi.baseUrl}），无法解释自然语言指令`
      setEngineOffline(avatarStore.error)
    } else if (e instanceof AgentApiError && e.status === 400) {
      // CLARIFICATION_NEEDED：后端无法唯一理解，不猜目标
      avatarStore.error = `需要澄清：${e.message}`
    } else {
      avatarStore.error = e instanceof Error ? e.message : String(e)
    }
    log(`指令失败：${avatarStore.error}`)
    return
  }

  // 兼容直出与统一结果外壳两种返回
  const outer = resp as ResultEnvelope<AvatarInterpretResult>
  const data = (typeof outer?.status === 'string' && outer.data ? outer.data : resp) as AvatarInterpretResult
  missionStore.engine = 'online'
  const warnings = Array.isArray(outer?.warnings) ? outer.warnings : []
  const truth = outer?.truth
  avatarStore.reply = data?.reply ?? ''
  if (truth && truth !== 'SIMULATED') {
    log(`警告：interpret 响应 truth=${truth}，合同要求 SIMULATED`)
  }
  for (const w of warnings) log(`警告：${w}`)
  const commands = Array.isArray(data?.commands) ? data.commands : []
  avatarStore.lastCommands = commands.map((c) =>
    'targetId' in c ? `${c.kind} → ${c.targetId}` : c.kind,
  )
  if (avatarStore.reply) log(`后端回复：${avatarStore.reply}`)
  if (commands.length === 0) {
    log('后端未签发任何命令')
    return
  }
  // 新指令中断当前纯数字移动
  actor.stop()
  avatarStore.repair = null
  await executeAvatarCommands(viewer, actor, commands)
}

/** 提交屋面证据：只发送结构化仿真证据引用（photo/thermal/reading），
 * 证据值与任务状态以后端响应为准；前端不把任务标为已闭环。
 */
export async function submitRoofEvidence(): Promise<void> {
  const cpId = missionStore.arrivedCheckpointId
  if (!cpId) {
    log('尚未到达任何检查点，不能提交证据')
    return
  }
  log(`在 ${cpId} 提交仿真证据（photo/thermal/reading）…`)
  emitEvidenceCaptured(cpId, ['photo', 'thermal', 'reading'])
}
