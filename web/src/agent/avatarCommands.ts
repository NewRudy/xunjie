// 数字运维员命令执行（contracts/avatar-command.md §3）。
// 只消费合同登记的受控命令；repair_simulation 为 SIMULATED 数字现场演示：
// 报警高亮 → 部件拆解/展开 → 维修进度 → 恢复完成，全程不触碰真实设备。
// 纯 avatar 控制不发送任何 mission 事件，不推进 MissionState。
import * as Cesium from 'cesium'
import { entityRegistry, flyToEntity } from '../cesium/parkScene'
import { select } from '../state/selection'
import { enuToWorld } from '../cesium/coords'
import { fixture, type Vec3 } from '../fixture'
import { planRoute } from './router'
import {
  avatarStore,
  FLY_CRUISE_ALT_M,
  FLY_SPEED_MPS,
  RUN_SPEED_MPS,
  WALK_SPEED_MPS,
  type AvatarActor,
} from './avatar'
import { log } from './missionStore'
import type { AvatarCommand, AvatarMovement } from './types'

/** 合同登记的导航目标：检查点 + 运维点（坐标全部来自 fixture） */
const NAV_TARGETS = new Map<string, Vec3>([
  ...fixture.checkpoints.map((c): [string, Vec3] => [c.id, c.position]),
  [fixture.opsPoint.id, fixture.opsPoint.position],
])

const SPEED: Record<AvatarMovement, number> = {
  walk: WALK_SPEED_MPS,
  run: RUN_SPEED_MPS,
  fly: FLY_SPEED_MPS,
}
const MOTION: Record<AvatarMovement, 'WALK' | 'RUN' | 'FLY'> = {
  walk: 'WALK',
  run: 'RUN',
  fly: 'FLY',
}

/** 维修仿真各阶段展示时长（演示节奏，非业务数字） */
const REPAIR_TIMING_MS = { locate: 1000, disassemble: 1500, work: 5200, restore: 1200 }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 导航到登记目标：walk/run 沿登记道路；fly 先抬升到巡航高度再平飞、到位后下降 */
async function navigateAvatar(actor: AvatarActor, targetId: string, movement: AvatarMovement): Promise<void> {
  const target = NAV_TARGETS.get(targetId)
  if (!target) {
    log(`导航取消：${targetId} 未在合同登记目标内`)
    return
  }
  const from = actor.pos
  let waypoints: Vec3[]
  if (movement === 'fly') {
    const cruise = Math.max(from[2], target[2], 0) + FLY_CRUISE_ALT_M
    waypoints = [
      [from[0], from[1], from[2]],
      [from[0], from[1], cruise],
      [target[0], target[1], cruise],
      [...target] as Vec3,
    ]
  } else {
    const route2d = planRoute([from[0], from[1]], [target[0], target[1]])
    if (route2d.length === 0) {
      log(`导航失败：${targetId} 不在登记道路网络可达范围`)
      avatarStore.error = `目标 ${targetId} 不在登记道路网络可达范围`
      return
    }
    waypoints = route2d.map(([x, y]): Vec3 => [x, y, 0])
    if (target[2] > 0.5) waypoints.push([...target] as Vec3)
  }
  log(`数字运维员${movement === 'run' ? '跑' : movement === 'fly' ? '飞' : '走'}向 ${targetId}（仿真动作）`)
  await actor.travel(waypoints, SPEED[movement], MOTION[movement])
}

/** 合同 §3：up/down 必须使用 fly */
function relativeDelta(actor: AvatarActor, direction: string, dist: number): Vec3 {
  const rad = (actor.headingDeg * Math.PI) / 180
  const fx = Math.cos(rad)
  const fy = Math.sin(rad)
  switch (direction) {
    case 'forward':
      return [fx * dist, fy * dist, 0]
    case 'backward':
      return [-fx * dist, -fy * dist, 0]
    case 'left':
      return [-fy * dist, fx * dist, 0]
    case 'right':
      return [fy * dist, -fx * dist, 0]
    case 'up':
      return [0, 0, dist]
    case 'down':
      return [0, 0, -dist]
    default:
      return [0, 0, 0]
  }
}

/** 报警高亮：目标实体红色脉冲 + 放大；返回恢复函数 */
function alarmHighlight(targetId: string): () => void {
  const entities = entityRegistry.get(targetId) ?? []
  const originals: Array<{ e: Cesium.Entity; color: Cesium.Color | undefined; size: number | undefined }> = []
  for (const e of entities) {
    if (e.point) {
      originals.push({
        e,
        color: e.point.color?.getValue() as Cesium.Color | undefined,
        size: e.point.pixelSize?.getValue() as number | undefined,
      })
      e.point.color = new Cesium.CallbackProperty(
        (time) => {
          const ms = time ? Cesium.JulianDate.toDate(time).getTime() : Date.now()
          return Cesium.Color.RED.withAlpha(0.55 + 0.45 * Math.abs(Math.sin(ms / 220)))
        },
        false,
      ) as unknown as Cesium.ConstantProperty
      e.point.pixelSize = new Cesium.CallbackProperty(
        (time) => {
          const ms = time ? Cesium.JulianDate.toDate(time).getTime() : Date.now()
          return 16 + 6 * Math.abs(Math.sin(ms / 220))
        },
        false,
      ) as unknown as Cesium.ConstantProperty
    }
  }
  return () => {
    for (const o of originals) {
      if (!o.e.point) continue
      if (o.color) o.e.point.color = new Cesium.ConstantProperty(o.color)
      if (o.size !== undefined) o.e.point.pixelSize = new Cesium.ConstantProperty(o.size)
    }
  }
}

/** 部件拆解/展开：在目标周围生成临时展开的部件盒（仿真示意），返回清理函数 */
function explodedView(viewer: Cesium.Viewer, anchor: Vec3): () => void {
  const parts: Array<{ name: string; off: Vec3; size: [number, number, number]; color: string }> = [
    { name: '组串连接端子', off: [2.4, 0, 0.4], size: [0.7, 0.4, 0.3], color: '#ffb300' },
    { name: '旁路二极管模块', off: [-2.4, 0, 0.4], size: [0.6, 0.5, 0.35], color: '#ff7043' },
    { name: '直流线缆段', off: [0, 2.4, 0.2], size: [2.6, 0.25, 0.25], color: '#4fc3f7' },
  ]
  const added: Cesium.Entity[] = []
  for (const p of parts) {
    added.push(
      viewer.entities.add({
        name: `${p.name}（拆解示意·仿真）`,
        position: enuToWorld(anchor[0] + p.off[0], anchor[1] + p.off[1], anchor[2] + p.off[2] + 2.2),
        box: {
          dimensions: new Cesium.Cartesian3(...p.size),
          material: Cesium.Color.fromCssColorString(p.color).withAlpha(0.85),
          outline: true,
          outlineColor: Cesium.Color.WHITE,
        },
        label: {
          text: p.name + '（仿真）',
          font: '11px "PingFang SC", "Microsoft YaHei", sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -14),
        },
      }),
    )
  }
  return () => {
    for (const e of added) viewer.entities.remove(e)
  }
}

/**
 * 维修仿真（SIMULATED）：合同要求先确认人物在检查点附近，否则先自动导航；
 * 之后聚焦目标，报警高亮 → 部件拆解/展开 → 维修进度 → 恢复完成。
 */
async function repairSimulation(
  viewer: Cesium.Viewer,
  actor: AvatarActor,
  targetId: string,
  checkpointId: string,
): Promise<void> {
  const cp = NAV_TARGETS.get(checkpointId)
  if (!cp) {
    log(`维修仿真取消：检查点 ${checkpointId} 未登记`)
    return
  }
  const d = Math.hypot(actor.pos[0] - cp[0], actor.pos[1] - cp[1], actor.pos[2] - cp[2])
  if (d > 10) {
    log(`数字运维员距 ${checkpointId} 约 ${Math.round(d)}m，先自动导航到位（仿真动作）`)
    await navigateAvatar(actor, checkpointId, 'fly')
  }
  // 导航可能被打断；到位校验
  const d2 = Math.hypot(actor.pos[0] - cp[0], actor.pos[1] - cp[1], actor.pos[2] - cp[2])
  if (d2 > 10) {
    log('维修仿真中止：数字运维员未到达检查点附近')
    return
  }

  const entities = entityRegistry.get(targetId)
  if (!entities || entities.length === 0) {
    log(`维修仿真取消：${targetId} 不在场景语义树中`)
    return
  }
  select(targetId)
  viewer.trackedEntity = undefined
  flyToEntity(viewer, entities[0])
  avatarStore.motion = 'REPAIR'
  const endRepair = (): void => {
    if (avatarStore.motion === 'REPAIR') avatarStore.motion = 'IDLE'
  }

  const targetPos = cp // 组串标记位于其登记逆变器上方，检查点即设备旁
  avatarStore.repair = { targetId, phase: '报警定位', progress: 5 }
  const restoreAlarm = alarmHighlight(targetId)
  const abort = (): void => {
    restoreAlarm()
    endRepair()
  }
  log(`维修仿真开始：${targetId} 报警高亮（数字现场仿真，不控制真实设备）`)
  await sleep(REPAIR_TIMING_MS.locate)
  if (!avatarStore.repair) return abort()

  avatarStore.repair = { targetId, phase: '部件拆解/展开', progress: 20 }
  const cleanupExploded = explodedView(viewer, targetPos)
  await sleep(REPAIR_TIMING_MS.disassemble)
  if (!avatarStore.repair) {
    cleanupExploded()
    return abort()
  }

  avatarStore.repair = { targetId, phase: '维修中（更换旁路二极管模块·仿真）', progress: 30 }
  const steps = 14
  for (let i = 1; i <= steps; i++) {
    await sleep(REPAIR_TIMING_MS.work / steps)
    if (!avatarStore.repair) {
      cleanupExploded()
      return abort()
    }
    avatarStore.repair = {
      targetId,
      phase: '维修中（更换旁路二极管模块·仿真）',
      progress: 30 + Math.round((65 * i) / steps),
    }
  }

  avatarStore.repair = { targetId, phase: '恢复部件与外观', progress: 97 }
  cleanupExploded()
  await sleep(REPAIR_TIMING_MS.restore)
  restoreAlarm()
  endRepair()
  avatarStore.repair = { targetId, phase: '维修仿真完成', progress: 100 }
  log(`维修仿真完成：${targetId} 已恢复外观（数字现场仿真，未触碰真实设备）`)
  await sleep(1500)
  if (avatarStore.repair?.progress === 100) avatarStore.repair = null
}

/** 依序执行后端签发的受控命令；新一批命令进入前由调用方先打断旧动作 */
export async function executeAvatarCommands(
  viewer: Cesium.Viewer,
  actor: AvatarActor,
  commands: AvatarCommand[],
): Promise<void> {
  for (const cmd of commands) {
    log(`执行指令：${cmd.kind}${'targetId' in cmd ? ` → ${cmd.targetId}` : ''}（#${cmd.commandId}）`)
    switch (cmd.kind) {
      case 'navigate':
        await navigateAvatar(actor, cmd.targetId, cmd.movement)
        break
      case 'move_relative': {
        const dist = Math.max(1, Math.min(50, cmd.distanceMeters || 10))
        const movement = cmd.direction === 'up' || cmd.direction === 'down' ? 'fly' : cmd.movement
        const delta = relativeDelta(actor, cmd.direction, dist)
        const from = actor.pos
        const to: Vec3 = [from[0] + delta[0], from[1] + delta[1], Math.max(0, from[2] + delta[2])]
        await actor.travel([from, to], SPEED[movement], MOTION[movement])
        break
      }
      case 'turn':
        await actor.turn(cmd.degrees)
        break
      case 'jump':
        await actor.jump()
        break
      case 'stop':
        actor.stop()
        avatarStore.repair = null
        log('数字运维员已停止（仿真动作中断）')
        break
      case 'focus_asset': {
        const entities = entityRegistry.get(cmd.targetId)
        if (!entities || entities.length === 0) {
          log(`focus_asset：${cmd.targetId} 不在场景语义树中，忽略`)
        } else {
          select(cmd.targetId)
          viewer.trackedEntity = undefined
          flyToEntity(viewer, entities[0])
        }
        break
      }
      case 'repair_simulation':
        await repairSimulation(viewer, actor, cmd.targetId, cmd.checkpointId)
        break
    }
  }
}
