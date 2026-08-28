// 数字现场仿真执行器（明确标注“数字现场/仿真动作”，无真实机器人接入）。
// 消费高层命令 navigate_to_checkpoint：数字运维人员沿 fixture 登记道路折线
// 移动到检查点，真正到达后才由 bridge 发送 checkpoint_arrived。
import * as Cesium from 'cesium'
import { fixture } from '../fixture'
import { enuToWorld } from '../cesium/coords'
import { planRoute } from './router'
import { emitCheckpointArrived, emitNavigationFailed } from './bridge'
import { log, missionStore } from './missionStore'

/** 数字现场演示加速档（m/s，非业务数字，不代表真实人员行走速度） */
const SIMULATION_SPEED_MPS = 18

const checkpointById = new Map(fixture.checkpoints.map((c) => [c.id, c]))

export class PatrolExecutor {
  private marker: Cesium.Entity | null = null
  private tickRemove: (() => void) | null = null
  /** 当前所在 ENU 位置（初始为运维点） */
  private pos: [number, number, number] = [...fixture.opsPoint.position]

  constructor(private viewer: Cesium.Viewer) {}

  private ensureMarker(): Cesium.Entity {
    if (this.marker) return this.marker
    this.marker = this.viewer.entities.add({
      position: enuToWorld(this.pos[0], this.pos[1], this.pos[2]),
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString('#00e5ff'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: '数字运维员（仿真）',
        font: '12px "PingFang SC", "Microsoft YaHei", sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#00e5ff'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
    return this.marker
  }

  /** 中断当前移动（拒绝/新任务时调用）；不发送到达事件 */
  cancel(): void {
    if (this.tickRemove) {
      this.tickRemove()
      this.tickRemove = null
    }
    if (missionStore.executorState === 'moving') missionStore.executorState = 'idle'
  }

  /**
   * 沿登记道路走到检查点；到达后发送 checkpoint_arrived。
   * 未知/不可达检查点发送 navigation_failed，不自动跳过。
   */
  navigateTo(checkpointId: string): Promise<void> {
    this.cancel()
    const cp = checkpointById.get(checkpointId)
    if (!cp) {
      missionStore.executorState = 'failed'
      log(`导航失败：未登记的检查点 ${checkpointId}`)
      emitNavigationFailed(checkpointId, `检查点 ${checkpointId} 未在 fixture 登记`)
      return Promise.reject(new Error(`unknown checkpoint ${checkpointId}`))
    }

    const target = cp.position
    const route2d = planRoute([this.pos[0], this.pos[1]], [target[0], target[1]])
    if (route2d.length === 0) {
      missionStore.executorState = 'failed'
      log(`导航失败：${checkpointId} 不在登记道路网络可达范围`)
      emitNavigationFailed(
        checkpointId,
        '目标检查点不在登记道路网络可达范围',
        fixture.checkpoints.filter((c) => c.nodeId === cp.nodeId && c.id !== cp.id).map((c) => c.id),
      )
      return Promise.reject(new Error('unreachable'))
    }

    // 屋面检查点：水平到位后垂直上升到检查点高度（仿真动作，不宣称真实爬楼）
    const waypoints: [number, number, number][] = route2d.map(([x, y]) => [x, y, 0])
    if (target[2] > 0.5) waypoints.push([target[0], target[1], target[2]])

    const marker = this.ensureMarker()
    missionStore.executorState = 'moving'
    missionStore.arrivedCheckpointId = null
    log(`数字运维员出发（仿真动作）→ ${checkpointId}，途经 ${waypoints.length - 1} 段路`)

    return new Promise((resolve) => {
      // 预计算各段长度与累计距离
      const segLen: number[] = []
      let total = 0
      for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i]
        const b = waypoints[i + 1]
        const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
        segLen.push(l)
        total += l
      }
      let travelled = 0
      let lastTs: number | null = null

      const onTick = (_clock: Cesium.Clock): void => {
        const now = performance.now()
        const dt = lastTs === null ? 0 : (now - lastTs) / 1000
        lastTs = now
        travelled += dt * SIMULATION_SPEED_MPS
        if (travelled >= total) {
          this.tickRemove?.()
          this.tickRemove = null
          this.pos = [...target]
          marker.position = new Cesium.ConstantPositionProperty(enuToWorld(target[0], target[1], target[2]))
          missionStore.executorState = 'arrived'
          missionStore.arrivedCheckpointId = checkpointId
          log(`数字运维员到达 ${checkpointId}（仿真），上报 checkpoint_arrived`)
          // 等后端确认到达事件后再结束本次导航，保证下一跳命令已进入前端队列。
          void emitCheckpointArrived(checkpointId).finally(() => resolve())
          return
        }
        // 定位当前段并插值
        let acc = 0
        for (let i = 0; i < segLen.length; i++) {
          if (travelled <= acc + segLen[i]) {
            const t = segLen[i] === 0 ? 0 : (travelled - acc) / segLen[i]
            const a = waypoints[i]
            const b = waypoints[i + 1]
            const x = a[0] + (b[0] - a[0]) * t
            const y = a[1] + (b[1] - a[1]) * t
            const z = a[2] + (b[2] - a[2]) * t
            this.pos = [x, y, z]
            marker.position = new Cesium.ConstantPositionProperty(enuToWorld(x, y, z))
            break
          }
          acc += segLen[i]
        }
      }
      this.tickRemove = () => this.viewer.clock.onTick.removeEventListener(onTick)
      this.viewer.clock.onTick.addEventListener(onTick)
    })
  }
}
