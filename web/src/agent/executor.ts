// 数字现场仿真执行器（明确标注“数字现场/仿真动作”，无真实机器人接入）。
// 消费高层命令 navigate_to_checkpoint：数字运维人员沿 fixture 登记道路折线
// 移动到检查点，真正到达后才由 bridge 发送 checkpoint_arrived。
// 人物本体由 cesium-player-controller 适配器承载；纯 avatar 控制可传
// reportMissionEvent: false，此时只移动人物，不伪造任何 mission 到达事件。
import * as Cesium from 'cesium'
import { fixture, type Vec3 } from '../fixture'
import { planRoute } from './router'
import { emitCheckpointArrived, emitNavigationFailed } from './bridge'
import { log, missionStore } from './missionStore'
import { RUN_SPEED_MPS, type AvatarMotionController } from './avatar'

const checkpointById = new Map(fixture.checkpoints.map((c) => [c.id, c]))

export interface NavigateOptions {
  /** 是否上报 mission 事件/写入 missionStore 执行状态；纯 avatar 控制必须为 false */
  reportMissionEvent?: boolean
}

export class PatrolExecutor {
  constructor(
    private viewer: Cesium.Viewer,
    private actor: AvatarMotionController,
  ) {}

  /** 中断当前移动（拒绝/新任务时调用）；不发送到达事件 */
  cancel(): void {
    this.actor.stop()
    if (missionStore.executorState === 'moving') missionStore.executorState = 'idle'
  }

  /**
   * 沿登记道路走到检查点；到达后（reportMissionEvent 为 true 时）发送 checkpoint_arrived。
   * 未知/不可达检查点发送 navigation_failed，不自动跳过。
   */
  navigateTo(checkpointId: string, opts: NavigateOptions = {}): Promise<void> {
    const report = opts.reportMissionEvent ?? true
    this.cancel()
    const cp = checkpointById.get(checkpointId)
    if (!cp) {
      if (report) {
        missionStore.executorState = 'failed'
        emitNavigationFailed(checkpointId, `检查点 ${checkpointId} 未在 fixture 登记`)
      }
      log(`导航失败：未登记的检查点 ${checkpointId}`)
      return Promise.reject(new Error(`unknown checkpoint ${checkpointId}`))
    }

    const target: Vec3 = cp.position
    const from = this.actor.pos
    const route2d = planRoute([from[0], from[1]], [target[0], target[1]])
    if (route2d.length === 0) {
      if (report) {
        missionStore.executorState = 'failed'
        emitNavigationFailed(
          checkpointId,
          '目标检查点不在登记道路网络可达范围',
          fixture.checkpoints.filter((c) => c.nodeId === cp.nodeId && c.id !== cp.id).map((c) => c.id),
        )
      }
      log(`导航失败：${checkpointId} 不在登记道路网络可达范围`)
      return Promise.reject(new Error('unreachable'))
    }

    // 屋面检查点：水平到位后垂直上升到检查点高度（仿真动作，不宣称真实爬楼）
    const waypoints: Vec3[] = route2d.map(([x, y]): Vec3 => [x, y, 0])
    if (target[2] > 0.5) waypoints.push([...target] as Vec3)

    if (report) {
      missionStore.executorState = 'moving'
      missionStore.arrivedCheckpointId = null
    }
    log(`数字运维员出发（仿真动作）→ ${checkpointId}，途经 ${waypoints.length - 1} 段路`)

    return this.actor.travel(waypoints, RUN_SPEED_MPS, 'RUN').then(() => {
      // 被打断（stop/新动作）时不视为到达
      const p = this.actor.pos
      if (Math.hypot(p[0] - target[0], p[1] - target[1], p[2] - target[2]) > 0.5) return
      if (!report) {
        log(`数字运维员到达 ${checkpointId}（纯 avatar 控制，不上报 mission 事件）`)
        return
      }
      missionStore.executorState = 'arrived'
      missionStore.arrivedCheckpointId = checkpointId
      log(`数字运维员到达 ${checkpointId}（仿真），上报 checkpoint_arrived`)
      // 等后端确认到达事件后再结束本次导航，保证下一跳命令已进入前端队列。
      return emitCheckpointArrived(checkpointId)
    })
  }
}
