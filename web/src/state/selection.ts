// 当前选中设备（点击语义卡的数据源）
import { reactive } from 'vue'

export const selection = reactive<{ id: string | null }>({ id: null })

export function select(id: string): void {
  selection.id = id
}

export function clearSelection(): void {
  selection.id = null
}
