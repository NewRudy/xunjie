// Cesium Viewer 初始化与交互绑定。
// 不设置 Cesium.Ion.defaultAccessToken，baseLayer 显式指定，全程无 ion 请求。
import * as Cesium from 'cesium'
import { buildParkScene, setInitialCamera, flyToEntity } from './parkScene'
import { applyBasemap } from './basemap'
import { basemapConfig } from '../config'
import { select, clearSelection } from '../state/selection'
import { notifyAssetClicked } from '../agent/controller'

export function initViewer(container: HTMLElement): Cesium.Viewer {
  const viewer = new Cesium.Viewer(container, {
    // 显式指定底图（离线时为纯色+网格），避免默认 ion 底图请求
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    creditContainer: document.createElement('div'), // 隐藏默认 credit 容器（来源在"关于"面板列明）
  })

  basemapConfig.mode = applyBasemap(viewer, basemapConfig.mode)

  buildParkScene(viewer)
  setInitialCamera(viewer)

  // 左键：点设备弹语义卡；点空白关闭
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
  handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    const picked = viewer.scene.pick(e.position)
    const entity = picked?.id
    const semanticId =
      entity instanceof Cesium.Entity
        ? (entity.properties?.semanticId?.getValue() as string | undefined)
        : undefined
    if (semanticId) {
      select(semanticId)
      // 语义事件桥：设备点击 → asset_focused（只发语义 ID，无任务时缓冲）
      notifyAssetClicked(semanticId)
    } else {
      clearSelection()
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

  // 双击：飞到对象附近（先移除默认的 trackedEntity 行为）
  viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
  handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    const picked = viewer.scene.pick(e.position)
    const entity = picked?.id
    if (entity instanceof Cesium.Entity && entity.properties?.semanticId) {
      select(entity.properties.semanticId.getValue() as string)
      flyToEntity(viewer, entity)
    }
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)

  return viewer
}

/** 运行时切换底图（关于面板调用） */
export function switchBasemap(viewer: Cesium.Viewer): void {
  basemapConfig.mode = applyBasemap(viewer, basemapConfig.mode === 'online' ? 'offline' : 'online')
}
