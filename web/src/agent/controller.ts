// 任务闭环控制器：创建任务 → 审批 → 消费场景命令 → 到达/证据事件。
// 审批只走 /approval 接口（approvalId + contextVersion + planHash 严格匹配），
// 不用自然语言绕过审批；前端不本地推进任务阶段。
import type * as Cesium from 'cesium'
import { agentApi, AgentApiError } from './client'
import { applyResponse, log, missionStore, resetMission, setEngineOffline } from './missionStore'
import { emitAssetFocused, emitEvidenceCaptured, emitSceneEntered, flushBufferedEvents } from './bridge'
import { runSceneCommands } from './commands'
import { PatrolExecutor } from './executor'
import { CpcAvatarActor, avatarStore } from './avatar'
import { executeAvatarCommands } from './avatarCommands'
import { SCENE_ID, SCENE_REVISION, type AvatarCommand, type AvatarInterpretResult, type ResultEnvelope } from './types'
import { fixture } from '../fixture'
import { markDemoAnomalyFault } from '../state/parkState'

let viewer: Cesium.Viewer | null = null
let executor: PatrolExecutor | null = null
let actor: CpcAvatarActor | null = null
let avatarCommandGeneration = 0

/** 场景初始化后调用：建数字运维员与执行器并发送一次 scene_entered */
export function initAgent(v: Cesium.Viewer): void {
  viewer = v
  actor?.destroy()
  actor = new CpcAvatarActor(v)
  executor = new PatrolExecutor(v, actor)
  // 初始化异步进行；所有动作会等待同一个 ready promise，失败状态直接显示在面板。
  void actor.init().catch(() => undefined)
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

/** 演示入口：检查 B2 屋顶异常（异常引用来自 fixture.demoAnomaly）。
 *  先显式复位后端演示状态、取消当前执行、数字人回运维点，
 *  避免重复演示带上一次 resolved 的历史 warning；通用 createMission 不复位。
 */
export async function createDemoMission(): Promise<void> {
  executor?.cancel()
  actor?.resetToOpsPoint()
  const reset = await guard(() => agentApi.resetDemo())
  if (!reset) return
  markDemoAnomalyFault()
  log('演示复位完成：后端任务/异常/agent 数据已清空')
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
  const commandGeneration = ++avatarCommandGeneration
  avatarStore.lastText = input
  avatarStore.reply = ''
  avatarStore.error = ''
  avatarStore.lastCommands = []
  avatarStore.interpretPlanner = null
  log(`数字运维员指令：「${input}」→ POST /api/agent/avatar/interpret`)
  let resp: AvatarInterpretResult | ResultEnvelope<AvatarInterpretResult>
  try {
    resp = await agentApi.interpretAvatar({ text: input, sceneId: SCENE_ID, sceneRevision: SCENE_REVISION })
  } catch (e) {
    if (commandGeneration !== avatarCommandGeneration) return
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

  // 较新的文字已经进入解释流程时，丢弃迟到响应，避免旧命令反向接管人物。
  if (commandGeneration !== avatarCommandGeneration) return

  // 兼容直出与统一结果外壳两种返回
  const outer = resp as ResultEnvelope<AvatarInterpretResult>
  const data = (typeof outer?.status === 'string' && outer.data ? outer.data : resp) as AvatarInterpretResult
  missionStore.engine = 'online'
  const warnings = Array.isArray(outer?.warnings) ? outer.warnings : []
  const truth = outer?.truth
  const planner = outer?.planner
  avatarStore.interpretPlanner =
    planner?.mode === 'llm' || planner?.mode === 'deterministic-fallback'
      ? {
          mode: planner.mode,
          modelAvailable: Boolean(planner.modelAvailable),
          ...(planner.reason ? { reason: planner.reason } : {}),
        }
      : null
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
  // 按合同 §3 分流：任务闭环命令复用既有任务/审批/证据链路，
  // 不进纯场景执行器；移动/维修等纯场景命令仍走 executeAvatarCommands。
  const sceneCommands = commands.filter((c) => !isClosedLoopCommand(c))
  if (sceneCommands.length > 0) {
    actor.stop()
    avatarStore.repair = null
  }
  for (const cmd of commands) {
    if (commandGeneration !== avatarCommandGeneration) return
    if (isClosedLoopCommand(cmd)) {
      await runClosedLoopCommand(cmd)
    } else {
      await executeAvatarCommands(viewer, actor, [cmd])
    }
  }
}

/** 任务闭环语言命令（合同 §3 新增三类） */
function isClosedLoopCommand(
  cmd: AvatarCommand,
): cmd is Extract<AvatarCommand, { kind: 'start_inspection' | 'decide_pending' | 'capture_evidence' }> {
  return cmd.kind === 'start_inspection' || cmd.kind === 'decide_pending' || cmd.kind === 'capture_evidence'
}

/** 闭环命令执行：每一步缺少前置状态时给出明确原因，不猜、不静默跳过 */
async function runClosedLoopCommand(
  cmd: Extract<AvatarCommand, { kind: 'start_inspection' | 'decide_pending' | 'capture_evidence' }>,
): Promise<void> {
  switch (cmd.kind) {
    case 'start_inspection':
      if (cmd.anomalyId !== fixture.demoAnomaly.id) {
        avatarStore.error = `拒绝执行：异常 ${cmd.anomalyId} 未在 fixture 登记`
        log(avatarStore.error)
        return
      }
      log('指令：启动检查任务（复用既有任务创建链路）')
      await createDemoMission()
      return
    case 'decide_pending':
      if (!missionStore.mission || !missionStore.pendingApproval) {
        avatarStore.error = '拒绝执行：当前没有待审批项，请先创建任务并等待提案'
        log(avatarStore.error)
        return
      }
      await decide(cmd.decision)
      return
    case 'capture_evidence': {
      if (!missionStore.mission) {
        avatarStore.error = '拒绝执行：当前没有任务，无法采集证据'
        log(avatarStore.error)
        return
      }
      const checkpoint = fixture.checkpoints.find((c) => c.id === missionStore.arrivedCheckpointId)
      if (checkpoint?.kind !== 'roof') {
        avatarStore.error = '拒绝执行：数字运维员尚未到达屋面检查点'
        log(avatarStore.error)
        return
      }
      if (missionStore.mission.phase !== 'awaiting-evidence') {
        avatarStore.error = `拒绝执行：任务当前阶段为 ${missionStore.mission.phase}，不允许提交证据`
        log(avatarStore.error)
        return
      }
      await submitRoofEvidence()
      return
    }
  }
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
