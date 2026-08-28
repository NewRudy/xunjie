// 运行配置：底图模式开关。
// VITE_BASEMAP=offline 时默认离线（纯色地面 + 网格，无任何外部请求）；
// 其他情况默认在线 OSM 瓦片。关于面板里可运行时切换。
import { reactive } from 'vue'

export type BasemapMode = 'online' | 'offline'

export const basemapConfig = reactive<{ mode: BasemapMode }>({
  mode: import.meta.env.VITE_BASEMAP === 'offline' ? 'offline' : 'online',
})
