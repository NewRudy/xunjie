// 园区设备状态模块（P1 为 mock：结构按 semantic-tree.md 状态机五态）。
// P2 引擎接入后替换数据来源，接口保持不变。
import { reactive } from 'vue'
import { fixture } from '../fixture'

/** 设备状态五态（contracts/semantic-tree.md §3） */
export type DeviceStatus = 'normal' | 'degraded' | 'fault' | 'offline' | 'maintenance'

const states = reactive<Record<string, DeviceStatus>>({})

type Listener = (id: string, status: DeviceStatus) => void
const listeners = new Set<Listener>()

export function getStatus(id: string): DeviceStatus {
  return states[id] ?? 'normal'
}

export function setStatus(id: string, status: DeviceStatus): void {
  if (getStatus(id) === status) return
  states[id] = status
  for (const fn of listeners) fn(id, status)
}

/** 3D 场景订阅状态变化以更新着色 */
export function onStatusChange(fn: Listener): void {
  listeners.add(fn)
}

// ---- mock 初始化 ----
// 演示异常（fixture demoAnomaly）：组串 STR-B2-07 电流偏低 18%，
// 其所属逆变器 INV-B-02 默认置为 fault 红。
const anomalyTarget = fixture.strings.find((s) => s.id === fixture.demoAnomaly.targetStringId)

/** 演示复位：后端 /api/debug/reset 成功后调用，恢复演示异常为 fault */
export function markDemoAnomalyFault(): void {
  if (!anomalyTarget) return
  setStatus(anomalyTarget.inverterId, 'fault')
  setStatus(anomalyTarget.id, 'fault')
}

/** 闭环恢复：仅由后端闭环回执（anomalyStatus=resolved）驱动，维修特效不得直接调用 */
export function markDemoAnomalyResolved(): void {
  if (!anomalyTarget) return
  setStatus(anomalyTarget.inverterId, 'normal')
  setStatus(anomalyTarget.id, 'normal')
}

markDemoAnomalyFault()
