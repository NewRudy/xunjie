// 巡界数字运维员执行层：cesium-player-controller 可见人物 + 受控高层动作。
// 业务层只依赖 AvatarMotionController；人物包不理解任务、审批或设备状态。
// 登记路线仍由确定性插值保证 Demo 稳定，人物渲染、动画、视角、输入与基础胶囊体由上游包承担。
import * as Cesium from 'cesium'
import { playerController } from 'cesium-player-controller'
import { reactive } from 'vue'
import { fixture, type Vec3 } from '../fixture'
import { enuToWorld } from '../cesium/coords'
import { log } from './missionStore'
import type { AvatarInterpretPlanner } from './types'

/** 数字现场演示速度档（m/s，非业务数字） */
export const WALK_SPEED_MPS = 5
export const RUN_SPEED_MPS = 18
export const FLY_SPEED_MPS = 14
export const FLY_CRUISE_ALT_M = 18

/** UAL1 模型缩放 0.01 后的胶囊中心离脚底约 1.1m。 */
const CAPSULE_CENTER_M = 1.1
const MODEL_URI = '/vendor/models/XunjieOperator.glb'

export type AvatarMotion = 'IDLE' | 'WALK' | 'RUN' | 'FLY' | 'JUMP' | 'REPAIR'
/** 面板可见状态；不写 MissionState。 */
export const avatarStore = reactive({
  motion: 'IDLE' as AvatarMotion,
  reply: '',
  lastText: '',
  lastCommands: [] as string[],
  error: '',
  repair: null as { targetId: string; phase: string; progress: number } | null,
  controllerMode: 'loading' as 'loading' | 'cesium-player-controller' | 'unavailable',
  controllerError: '',
  collisionNote: '最小本地平面碰撞；未接 3D Tiles 工程碰撞体',
  interpretPlanner: null as AvatarInterpretPlanner | null,
})

export interface AvatarMotionController {
  readonly pos: Vec3
  readonly headingDeg: number
  stop(): void
  travel(waypoints: Vec3[], speedMps: number, motion: 'WALK' | 'RUN' | 'FLY'): Promise<void>
  jump(): Promise<void>
  turn(degrees: number): Promise<void>
}

/**
 * 上游包适配器。
 *
 * 为保证比赛现场路径稳定，travel 继续按登记折线计算 ENU 插值，再通过 player.reset
 * 同步包内胶囊体/可见模型；setInput 驱动包内动作状态。未实现完整建筑/3D Tiles 碰撞。
 */
export class CpcAvatarActor implements AvatarMotionController {
  private player: playerController | null = null
  private readyPromise: Promise<void> | null = null
  private tickRemove: (() => void) | null = null
  private tickResolve: (() => void) | null = null
  private updateRemove: (() => void) | null = null
  private labelEntity: Cesium.Entity | null = null
  private generation = 0
  private _pos: Vec3 = [...fixture.opsPoint.position]
  private _headingDeg = 0

  constructor(private viewer: Cesium.Viewer) {
    this.ensureLabel()
  }

  get pos(): Vec3 {
    return [...this._pos] as Vec3
  }

  get headingDeg(): number {
    return this._headingDeg
  }

  /** 幂等异步初始化；失败会明确进入 unavailable，所有动作保持拒绝执行。 */
  init(): Promise<void> {
    if (!this.readyPromise) this.readyPromise = this.initialize()
    return this.readyPromise
  }

  private async initialize(): Promise<void> {
    avatarStore.controllerMode = 'loading'
    avatarStore.controllerError = ''
    try {
      const player = new playerController()
      await player.init({
        viewer: this.viewer,
        initPos: this.worldPosition(),
        playerModelConfig: {
          url: MODEL_URI,
          scale: 0.01,
          idleAnim: 'Idle_Loop',
          walkAnim: 'Walk_Loop',
          runAnim: 'Sprint_Loop',
          jumpAnim: ['Jump_Start', 'Jump_Loop', 'Jump_Land'],
          flyAnim: 'fly',
          flyIdleAnim: 'flyIdle',
          flyHoverForwardAnim: 'flyHoverForward',
          flyHoverBackAnim: 'flyHoverBack',
          flyHoverLeftAnim: 'flyHoverLeft',
          flyHoverRightAnim: 'flyHoverRight',
          flyHoverUpAnim: 'flyHoverUp',
          flyHoverDownAnim: 'flyHoverDown',
          rotateY: -Math.PI / 2,
          facingOffset: Math.PI / 2,
        },
        minCamDistance: 1000,
        maxCamDistance: 4500,
        camLookAtHeightRatio: 0.72,
        thirdMouseMode: 3,
        enableZoom: true,
        enableSpringCamera: true,
        springCameraTime: 0.08,
        isShowMobileControls: false,
        // 文字对话是主入口；禁用全局键位可避免在输入框打字时误移动人物。
        keyMap: {
          forward: null,
          backward: null,
          left: null,
          right: null,
          sprint: null,
          jump: null,
          toggleView: null,
          toggleFly: null,
          toggleVehicle: null,
        },
      })

      // 使用上游公开碰撞接口加载本地 z=0 平面；不访问 Rapier 私有字段。
      // 这是 Demo 最小碰撞，不代表厂房、屋面或 3D Tiles 工程碰撞已接入。
      await player.physics.addStaticColliders(this.viewer, {
        type: 'gltf',
        url: '/vendor/models/XunjieGroundCollider.gltf',
        position: enuToWorld(0, 0, 0),
      })

      this.player = player
      this.updateRemove = this.viewer.scene.preUpdate.addEventListener(() => {
        this.player?.update()
        this.applyHeading()
      })
      avatarStore.controllerMode = 'cesium-player-controller'
      avatarStore.collisionNote = '最小本地平面碰撞；未接屋面/建筑/3D Tiles 工程碰撞体'
      this.applyPlayerPose('IDLE')
      log('人物执行器已就绪：cesium-player-controller 0.2.0（最小本地平面碰撞）')
    } catch (error) {
      avatarStore.controllerMode = 'unavailable'
      avatarStore.controllerError = error instanceof Error ? error.message : String(error)
      avatarStore.error = `人物控制器初始化失败：${avatarStore.controllerError}`
      log(avatarStore.error)
      throw error
    }
  }

  private ensureLabel(): void {
    this.labelEntity = this.viewer.entities.add({
      position: new Cesium.CallbackPositionProperty(() => this.worldPosition(), false),
      label: {
        text: new Cesium.CallbackProperty(() => `数字运维员（仿真）· ${avatarStore.motion}`, false),
        font: '12px "PingFang SC", "Microsoft YaHei", sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#00e5ff'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -34),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  }

  private worldPosition(): Cesium.Cartesian3 {
    return enuToWorld(this._pos[0], this._pos[1], this._pos[2] + CAPSULE_CENTER_M)
  }

  private async ready(): Promise<boolean> {
    try {
      await this.init()
      return Boolean(this.player) && avatarStore.controllerMode === 'cesium-player-controller'
    } catch {
      return false
    }
  }

  private applyHeading(): void {
    if (!this.player) return
    // 业务 heading: 0°=东、90°=北；上游 yaw: 0=北、+90°=东。
    const targetYaw = Math.PI / 2 - Cesium.Math.toRadians(this._headingDeg)
    const delta = Cesium.Math.negativePiToPi(targetYaw - this.player.getYaw())
    this.player.addYaw(delta)
  }

  private setFlying(shouldFly: boolean): void {
    if (!this.player || this.player.getIsFlying() === shouldFly) return
    this.player.setInput({ toggleFly: true })
  }

  private applyPlayerPose(motion: AvatarMotion): void {
    if (!this.player) return
    this.player.reset(this.worldPosition())
    this.setFlying(motion === 'FLY' || this._pos[2] > 0.5)
    const moving = motion === 'WALK' || motion === 'RUN' || motion === 'FLY'
    this.player.setInput({
      moveX: 0,
      moveY: moving ? 1 : 0,
      jump: false,
      shift: motion === 'RUN',
    })
    this.applyHeading()
  }

  stop(): void {
    this.generation += 1
    this.tickRemove?.()
    this.tickRemove = null
    this.tickResolve?.()
    this.tickResolve = null
    this.player?.setInput({ moveX: 0, moveY: 0, jump: false, shift: false })
    if (avatarStore.motion !== 'REPAIR') avatarStore.motion = 'IDLE'
    this.applyPlayerPose('IDLE')
  }

  resetToOpsPoint(): void {
    if (avatarStore.motion === 'REPAIR') avatarStore.motion = 'IDLE'
    this.stop()
    this._pos = [...fixture.opsPoint.position]
    this._headingDeg = 0
    avatarStore.repair = null
    void this.ready().then((ok) => {
      if (ok) this.applyPlayerPose('IDLE')
    })
  }

  private async drive(
    update: (dt: number, elapsed: number) => { done: boolean },
    motion: AvatarMotion,
  ): Promise<void> {
    if (!(await this.ready())) return
    this.stop()
    const gen = this.generation
    avatarStore.motion = motion
    this.applyPlayerPose(motion)
    await new Promise<void>((resolve) => {
      this.tickResolve = resolve
      let lastTs: number | null = null
      let elapsed = 0
      const finish = (): void => {
        if (this.generation === gen) {
          this.tickRemove = null
          this.tickResolve = null
          if (avatarStore.motion === motion) avatarStore.motion = 'IDLE'
          this.applyPlayerPose('IDLE')
        }
        resolve()
      }
      const onTick = (): void => {
        if (this.generation !== gen) {
          this.tickResolve = null
          resolve()
          return
        }
        const now = performance.now()
        const dt = lastTs === null ? 0 : Math.min((now - lastTs) / 1000, 0.1)
        lastTs = now
        elapsed += dt
        const { done } = update(dt, elapsed)
        this.applyPlayerPose(motion)
        if (done) {
          this.viewer.clock.onTick.removeEventListener(onTick)
          finish()
        }
      }
      this.tickRemove = () => this.viewer.clock.onTick.removeEventListener(onTick)
      this.viewer.clock.onTick.addEventListener(onTick)
    })
  }

  async travel(waypoints: Vec3[], speedMps: number, motion: 'WALK' | 'RUN' | 'FLY'): Promise<void> {
    if (waypoints.length < 2) return
    const segLen: number[] = []
    let total = 0
    for (let i = 0; i < waypoints.length - 1; i++) {
      const len = Math.hypot(
        waypoints[i + 1][0] - waypoints[i][0],
        waypoints[i + 1][1] - waypoints[i][1],
        waypoints[i + 1][2] - waypoints[i][2],
      )
      segLen.push(len)
      total += len
    }
    let travelled = 0
    await this.drive((dt) => {
      travelled += dt * speedMps
      if (travelled >= total) {
        this._pos = [...waypoints[waypoints.length - 1]] as Vec3
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

  async jump(): Promise<void> {
    if (!(await this.ready())) return
    this.player?.setInput({ jump: true })
    const baseZ = this._pos[2]
    await this.drive((_dt, elapsed) => {
      const k = Math.min(elapsed / 0.9, 1)
      this._pos = [this._pos[0], this._pos[1], baseZ + Math.sin(k * Math.PI) * 1.6]
      if (k >= 1) {
        this._pos = [this._pos[0], this._pos[1], baseZ]
        return { done: true }
      }
      return { done: false }
    }, 'JUMP')
  }

  async turn(degrees: number): Promise<void> {
    const clamped = Math.max(-180, Math.min(180, degrees))
    const from = this._headingDeg
    await this.drive((_dt, elapsed) => {
      const k = Math.min(elapsed / 0.5, 1)
      this._headingDeg = from + clamped * k
      if (k >= 1) {
        log(`数字运维员转向 ${clamped}°（仿真动作）`)
        return { done: true }
      }
      return { done: false }
    }, 'IDLE')
  }

  destroy(): void {
    this.stop()
    this.updateRemove?.()
    this.updateRemove = null
    this.player?.destroy()
    this.player = null
    if (this.labelEntity) this.viewer.entities.remove(this.labelEntity)
    this.labelEntity = null
  }
}
