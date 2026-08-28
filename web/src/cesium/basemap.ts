// 底图管理：在线 OSM 瓦片 / 离线纯色地面 + 网格。
// 不使用 Cesium ion（不设置 Ion token，Viewer 显式传入 baseLayer）。
import * as Cesium from 'cesium'
import { SCENE_COLORS } from '../constants/colors'
import type { BasemapMode } from '../config'

/** 在线：OpenStreetMap 瓦片（© OpenStreetMap contributors, ODbL） */
function createOsmLayer(): Cesium.ImageryLayer {
  return new Cesium.ImageryLayer(
    new Cesium.OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/',
      credit: '© OpenStreetMap contributors',
    }),
  )
}

/** 离线：无瓦片请求，地球纯色 + 网格线 */
function createOfflineLayer(): Cesium.ImageryLayer {
  return new Cesium.ImageryLayer(
    new Cesium.GridImageryProvider({
      cells: 8,
      color: Cesium.Color.fromCssColorString(SCENE_COLORS.offlineGrid),
      glowColor: Cesium.Color.TRANSPARENT,
      backgroundColor: Cesium.Color.fromCssColorString(SCENE_COLORS.offlineGround),
    }),
  )
}

/**
 * 切换底图。在线加载失败（如断网）时降级为离线模式，不崩。
 * 返回实际生效的模式。
 */
export function applyBasemap(viewer: Cesium.Viewer, mode: BasemapMode): BasemapMode {
  const layers = viewer.imageryLayers
  layers.removeAll()
  if (mode === 'online') {
    try {
      layers.add(createOsmLayer())
      return 'online'
    } catch (e) {
      console.warn('[底图] OSM 加载失败，降级为离线模式', e)
    }
  }
  layers.add(createOfflineLayer())
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString(SCENE_COLORS.offlineGround)
  return 'offline'
}

export const BASEMAP_SOURCE_TEXT = [
  '在线底图：OpenStreetMap 瓦片（tile.openstreetmap.org，© OpenStreetMap contributors，ODbL）',
  '离线底图：纯色地面 + 经纬网格（Cesium 内置 GridImageryProvider，无外部请求）',
  '地形：无外部地形服务；以 fixture 锚点海拔 1280m 为基准的平面（WGS84 椭球）',
  '坐标系：fixture ENU 局部坐标（锚点 26.4085, 106.5225，贵安新区，示意坐标）',
  '声明：未使用任何受控地理数据（如"实景三维贵阳贵安"）；未接入 Cesium ion',
]
