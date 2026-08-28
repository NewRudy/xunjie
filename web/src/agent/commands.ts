// 高层场景命令消费（scene-events.md §2）。
// 只处理 focus_asset / navigate_to_checkpoint / switch_form / show_component；
// 绝不把模型输出映射为按键、逐帧速度、任意坐标或任意 GLTF 节点名。
import type * as Cesium from 'cesium'
import { entityRegistry, flyToEntity } from '../cesium/parkScene'
import { select } from '../state/selection'
import { fixture } from '../fixture'
import type { SceneCommand } from './types'
import type { PatrolExecutor } from './executor'
import { log, missionStore } from './missionStore'
import { emitAssetFocused, emitComponentFocused } from './bridge'

/** fixture 未登记任何可切换数字形态；仅此处显式登记后才允许 switch_form */
const REGISTERED_FORMS = new Set<string>()

function highlight(viewer: Cesium.Viewer, targetId: string): boolean {
  const entities = entityRegistry.get(targetId)
  if (!entities || entities.length === 0) return false
  select(targetId)
  flyToEntity(viewer, entities[0])
  return true
}

/** 依序执行后端返回的高层场景命令 */
export async function runSceneCommands(
  viewer: Cesium.Viewer,
  executor: PatrolExecutor,
  commands: SceneCommand[],
): Promise<void> {
  missionStore.executing = true
  for (const cmd of commands) {
    // 只消费属于当前任务的命令
    if (missionStore.mission && cmd.missionId !== missionStore.mission.missionId) {
      log(`跳过命令 ${cmd.commandId}：missionId 不匹配`)
      continue
    }
    log(`执行场景命令：${cmd.kind} → ${cmd.targetId}${cmd.reason ? `（${cmd.reason}）` : ''}`)
    switch (cmd.kind) {
      case 'focus_asset':
        if (!highlight(viewer, cmd.targetId)) {
          log(`focus_asset：${cmd.targetId} 不在场景语义树中，忽略`)
        } else {
          await emitAssetFocused(cmd.targetId, '场景命令已执行：聚焦设备')
        }
        break
      case 'show_component':
        // 首版：高亮已登记部件实体；未登记则不伪造拆解视图
        if (!highlight(viewer, cmd.targetId)) {
          log(`show_component：${cmd.targetId} 未登记，无法展示，忽略`)
        } else {
          await emitComponentFocused(cmd.targetId)
        }
        break
      case 'navigate_to_checkpoint':
        try {
          await executor.navigateTo(cmd.targetId)
        } catch {
          // 失败已由 executor 上报 navigation_failed
        }
        break
      case 'switch_form':
        if (REGISTERED_FORMS.has(cmd.targetId)) {
          log(`switch_form：切换到已登记形态 ${cmd.targetId}（仿真）`)
        } else {
          log(`switch_form：${cmd.targetId} 非场景包登记形态，忽略（fixture 共 ${fixture.checkpoints.length} 个检查点、无形态登记）`)
        }
        break
    }
  }
  missionStore.executing = false
}
