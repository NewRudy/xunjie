// 数字运维员（仿真角色）：本地 GLB 人物模型 + 受控运动原语。
// 只消费 contracts/avatar-command.md 登记的命令；所有运动为数字现场仿真，
// 不连接任何真实设备。模型资产已本地化到 web/public/vendor（见该目录 NOTICE.md）。
//
// 预留 controller adapter 接口：后续若接入 cesium-player-controller（物理碰撞版），
// 实现同一 AvatarMotionController 接口即可替换 AvatarActor，上层命令执行不变。
import * as Cesium from 'cesium'
import { reactive } from 'vue'
import { fixture, type Vec3 } from '../fixture'
import { enuToWorld } from '../cesium/coords'
import { log } from './missionStore'

/** 数字现场演示速度档（m/s，非业务数字；走/跑/飞有明显区分） */
export const WALK_SPEED_MPS = 5
export const RUN_SPEED_MPS = 18
export const FLY_SPEED_MPS = 14
/** 飞行巡航高度（仿真动作，可见抬升轨迹） */
export const FLY_CRUISE_ALT_M = 18

export type AvatarMotion = 'IDLE' | 'WALK' | 'RUN' | 'FLY' | 'JUMP' | 'REPAIR'

/** 面板可见的数字人状态（纯前端展示，不写入 MissionState） */
export const avatarStore = reactive({
  motion: 'IDLE' as AvatarMotion,
  /** 后端 interpret 回复原文 */
  reply: '',
  lastText: '',
  /** 本轮消费的后端命令摘要（kind + target） */
  lastCommands: [] as string[],
  error: '',
  /** 维修仿真进度；null 表示无维修仿真进行中 */
  repair: null as { targetId: string; phase: string; progress: number } | null,
})

/**
 * 数字人控制器接口（adapter 预留）：命令执行层只依赖本接口，
 * 后续可替换为基于 cesium-player-controller 的物理碰撞实现。
 */
export interface AvatarMotionController {
  readonly pos: Vec3
  readonly headingDeg: number
  /** 立即停止当前运动，状态回到 IDLE */
  stop(): void
  /** 沿 ENU 折线以指定速度与状态标签移动，到达或被打断后 resolve */
  travel(waypoints: Vec3[], speedMps: number, motion: 'WALK' | 'RUN' | 'FLY'): Promise<void>
  jump(): Promise<void>
  turn(degrees: number): Promise<void>
}

const MODEL_URI = 'vendor/models/CesiumMan.glb'

export class AvatarActor implements AvatarMotionController {
  private entity: Cesium.Entity | null = null
  private tickRemove: (() => void) | null = null
  /** 打断代际：每次新动作 +1，旧 tick 发现代际过期即自行退出 */
  private generation = 0
  private _pos: Vec3 = [...fixture.opsPoint.position]
  private _headingDeg = 0

  constructor(private viewer: Cesium.Viewer) {}

  get pos(): Vec3 {
    return [...this._pos] as Vec3
  }

  get headingDeg(): number {
    return this._headingDeg
  }

  /** 创建人物实体（本地 GLB）；加载失败时退化为原有光点标记，不阻塞演示 */
  ensureEntity(): Cesium.Entity {
    if (this.entity) return this.entity
    const position = new Cesium.ConstantPositionProperty(enuToWorld(this._pos[0], this._pos[1], this._pos[2]))
    this.entity = this.viewer.entities.add({
      position,
      orientation: new Cesium.ConstantProperty(this.orientation()),
      // 第三人称展演视距：既能看清人物，也保留周围厂房/道路作为工程语境。
      viewFrom: new Cesium.Cartesian3(-24, -24, 14),
      model: {
        uri: MODEL_URI,
        scale: 3,
        minimumPixelSize: 48,
        runAnimations: true,
        clampAnimations: false,
      },
      // 光点兜底：若 GLB 因任何原因未渲染，仍有一个可见标记
      point: {
        pixelSize: 4,
        color: Cesium.Color.fromCssColorString('#00e5ff').withAlpha(0.6),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: new Cesium.CallbackProperty(() => `数字运维员（仿真）· ${avatarStore.motion}`, false),
        font: '12px "PingFang SC", "Microsoft YaHei", sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#00e5ff'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -30),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
    return this.entity
  }

  private orientation(): Cesium.Quaternion {
    // CesiumMan 模型前向为 +Z，绕 Z 轴额外转 -90° 使其朝向 heading 方向
    const heading = Cesium.Math.toRadians(this._headingDeg - 90)
    return Cesium.Transforms.headingPitchRollQuaternion(
      enuToWorld(this._pos[0], this._pos[1], this._pos[2]),
      new Cesium.HeadingPitchRoll(heading, 0, 0),
    )
  }

  private applyPose(): void {
    if (!this.entity) return
    this.entity.position = new Cesium.ConstantPositionProperty(
      enuToWorld(this._pos[0], this._pos[1], this._pos[2]),
    )
    this.entity.orientation = new Cesium.ConstantProperty(this.orientation())
  }

  stop(): void {
    this.generation += 1
    if (this.tickRemove) {
      this.tickRemove()
      this.tickRemove = null
    }
    if (avatarStore.motion !== 'REPAIR') avatarStore.motion = 'IDLE'
  }

  /** 演示复位：回运维点、停止跟随与维修特效，保证每次演示从统一位置开始 */
  resetToOpsPoint(): void {
    if (avatarStore.motion === 'REPAIR') avatarStore.motion = 'IDLE'
    this.stop()
    this._pos = [...fixture.opsPoint.position]
    this._headingDeg = 0
    avatarStore.repair = null
    if (this.viewer.trackedEntity === this.entity) this.viewer.trackedEntity = undefined
    this.applyPose()
  }

  /** 通用插值移动：travel/jump/turn 共用的逐帧驱动；被打断时静默 resolve */
  private drive(
    durationHint: (dt: number, t: number) => { done: boolean },
    motion: AvatarMotion,
  ): Promise<void> {
    this.stop()
    const gen = this.generation
    avatarStore.motion = motion
    this.ensureEntity()
    return new Promise((resolve) => {
      let lastTs: number | null = null
      let t = 0
      const finish = (): void => {
        if (this.generation === gen) {
          this.tickRemove = null
          if (avatarStore.motion === motion) avatarStore.motion = 'IDLE'
        }
        resolve()
      }
      const onTick = (): void => {
        if (this.generation !== gen) {
          // 已被新动作打断；新动作已接管 tick
          resolve()
          return
        }
        const now = performance.now()
        const dt = lastTs === null ? 0 : Math.min((now - lastTs) / 1000, 0.1)
        lastTs = now
        t += dt
        const { done } = durationHint(dt, t)
        this.applyPose()
        if (done) {
          this.viewer.clock.onTick.removeEventListener(onTick)
          finish()
        }
      }
      this.tickRemove = () => this.viewer.clock.onTick.removeEventListener(onTick)
      this.viewer.clock.onTick.addEventListener(onTick)
    })
  }

  travel(waypoints: Vec3[], speedMps: number, motion: 'WALK' | 'RUN' | 'FLY'): Promise<void> {
    if (waypoints.length < 2) return Promise.resolve()
    // 展演默认跟随数字人，确保观众能看见人物动作；维修阶段会切回设备聚焦。
    this.viewer.trackedEntity = this.ensureEntity()
    const segLen: number[] = []
    let total = 0
    for (let i = 0; i < waypoints.length - 1; i++) {
      const l = Math.hypot(
        waypoints[i + 1][0] - waypoints[i][0],
        waypoints[i + 1][1] - waypoints[i][1],
        waypoints[i + 1][2] - waypoints[i][2],
      )
      segLen.push(l)
      total += l
    }
    let travelled = 0
    return this.drive((dt) => {
      travelled += dt * speedMps
      if (travelled >= total) {
        const end = waypoints[waypoints.length - 1]
        this._pos = [...end] as Vec3
        return { done: true }
      }
      let acc = 0
      for (let i = 0; i < segLen.length; i++) {
        if (travelled <= acc + segLen[i]) {
          const k = segLen[i] === 0 ? 0 : (travelled - acc) / segLen[i]
          const a = waypoints[i]
          const b = waypoints[i + 1]
          this._pos = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
          const dx = b[0] - a[0]
          const dy = b[1] - a[1]
          if (Math.hypot(dx, dy) > 0.05) this._headingDeg = Cesium.Math.toDegrees(Math.atan2(dy, dx))
          break
        }
        acc += segLen[i]
      }
      return { done: false }
    }, motion)
  }

  jump(): Promise<void> {
    const baseZ = this._pos[2]
    const DURATION_S = 0.9
    const HEIGHT_M = 1.6
    return this.drive((_dt, t) => {
      const k = Math.min(t / DURATION_S, 1)
      this._pos = [this._pos[0], this._pos[1], baseZ + Math.sin(k * Math.PI) * HEIGHT_M]
      if (k >= 1) {
        this._pos = [this._pos[0], this._pos[1], baseZ]
        return { done: true }
      }
      return { done: false }
    }, 'JUMP')
  }

  turn(degrees: number): Promise<void> {
    const clamped = Math.max(-180, Math.min(180, degrees))
    const from = this._headingDeg
    const DURATION_S = 0.5
    return this.drive((_dt, t) => {
      const k = Math.min(t / DURATION_S, 1)
      this._headingDeg = from + clamped * k
      if (k >= 1) {
        log(`数字运维员转向 ${clamped}°（仿真动作）`)
        return { done: true }
      }
      return { done: false }
    }, 'IDLE')
  }
}
