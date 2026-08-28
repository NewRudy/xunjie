// 园区场景程序化生成：全部对象由 fixture JSON 驱动，不手写第二份坐标。
import * as Cesium from 'cesium'
import {
  fixture,
  buildingById,
  roofById,
  type Building,
  type PvArray,
  inverterById,
} from '../fixture'
import { enuToWorld, enuToWorldArray, rectCorners } from './coords'
import { makePvPanelCanvas } from './textures'
import { SCENE_COLORS, tintedColor } from '../constants/colors'
import { getStatus, onStatusChange, type DeviceStatus } from '../state/parkState'

/** 语义 ID → 场景实体（供 P4 巡检等后续阶段复用） */
export const entityRegistry = new Map<string, Cesium.Entity[]>()

type StatusApply = (status: DeviceStatus) => void
const statusBindings: { id: string; apply: StatusApply }[] = []

function register(id: string, entity: Cesium.Entity): void {
  const list = entityRegistry.get(id) ?? []
  list.push(entity)
  entityRegistry.set(id, list)
}

function semanticProps(id: string): { semanticId: string } {
  return { semanticId: id }
}

// ---- 状态着色绑定 ----

function bindBox(id: string, entity: Cesium.Entity, baseCss: string): void {
  const apply: StatusApply = (s) => {
    entity.box!.material = new Cesium.ColorMaterialProperty(tintedColor(s, baseCss))
  }
  apply(getStatus(id))
  statusBindings.push({ id, apply })
}

function bindImage(id: string, entity: Cesium.Entity, image: Cesium.ImageMaterialProperty): void {
  const apply: StatusApply = (s) => {
    entity.polygon!.material = s === 'normal' ? image : new Cesium.ColorMaterialProperty(tintedColor(s, '#000000'))
  }
  apply(getStatus(id))
  statusBindings.push({ id, apply })
}

function bindPoint(id: string, entity: Cesium.Entity, baseCss: string): void {
  const apply: StatusApply = (s) => {
    entity.point!.color = new Cesium.ConstantProperty(tintedColor(s, baseCss))
  }
  apply(getStatus(id))
  statusBindings.push({ id, apply })
}

/** 状态变化时刷新所有绑定 */
function wireStatusChanges(): void {
  onStatusChange((id, status) => {
    for (const b of statusBindings) if (b.id === id) b.apply(status)
  })
}

// ---- 公共小部件 ----

function addLabel(
  entities: Cesium.EntityCollection,
  id: string,
  text: string,
  x: number,
  y: number,
  z: number,
  fontSize = 14,
): void {
  entities.add({
    position: enuToWorld(x, y, z),
    label: {
      text,
      font: `${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`,
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new Cesium.NearFarScalar(300, 1.0, 1200, 0.5),
    },
    properties: semanticProps(id),
  })
}

function addPointMarker(
  entities: Cesium.EntityCollection,
  id: string,
  x: number,
  y: number,
  z: number,
  baseCss: string,
  pixelSize = 8,
): Cesium.Entity {
  const e = entities.add({
    position: enuToWorld(x, y, z),
    point: {
      pixelSize,
      color: Cesium.Color.fromCssColorString(baseCss),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 1.5,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    properties: semanticProps(id),
  })
  register(id, e)
  bindPoint(id, e, baseCss)
  return e
}

function addBox(
  entities: Cesium.EntityCollection,
  id: string,
  x: number,
  y: number,
  zBottom: number,
  dims: [number, number, number],
  baseCss: string,
  outline = true,
): Cesium.Entity {
  const e = entities.add({
    position: enuToWorld(x, y, zBottom + dims[2] / 2),
    box: {
      dimensions: new Cesium.Cartesian3(dims[0], dims[1], dims[2]),
      material: new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString(baseCss)),
      outline,
      outlineColor: Cesium.Color.fromCssColorString(baseCss).darken(0.4, new Cesium.Color()),
    },
    properties: semanticProps(id),
  })
  register(id, e)
  bindBox(id, e, baseCss)
  return e
}

// ---- 各对象生成 ----

function buildGround(entities: Cesium.EntityCollection): void {
  // 场地地坪：覆盖园区范围的一块浅色多边形（无状态、不可点）
  const corners = rectCorners(122, 72, 290, 165)
  entities.add({
    polygon: {
      hierarchy: new Cesium.PolygonHierarchy(enuToWorldArray(corners, 0.02)),
      perPositionHeight: true, // 位置已含锚点海拔，按每点高度贴地
      material: Cesium.Color.fromCssColorString(SCENE_COLORS.groundPlate).withAlpha(0.9),
    },
  })
}

function buildRoads(entities: Cesium.EntityCollection): void {
  for (const road of fixture.roads) {
    const e = entities.add({
      corridor: {
        positions: enuToWorldArray(road.polyline, 0),
        width: 6,
        // 园区为平面（锚点海拔 1280m），corridor 用恒定高度贴地
        height: fixture.anchor.altM + 0.1,
        material: Cesium.Color.fromCssColorString(SCENE_COLORS.road),
        cornerType: Cesium.CornerType.MITERED,
      },
      properties: semanticProps(road.id),
    })
    register(road.id, e)
  }
}

function buildBuildings(entities: Cesium.EntityCollection): void {
  for (const b of fixture.buildings) {
    const [cx, cy] = [b.center[0], b.center[1]]
    const [w, d] = b.size
    const h = b.height
    addBox(entities, b.id, cx, cy, 0, [w, d, h], SCENE_COLORS.buildingBody)
    // 楼号标签（Entity label，浮于楼顶）
    addLabel(entities, b.id, `${b.id.replace('BLDG-', '')} ${b.name}`, cx, cy, h + 2.5)
    // 屋顶板（略深一号的薄板，独立屋顶对象 RF-*）
    const roof = roofById.get(b.roofId)
    if (roof) {
      const e = entities.add({
        position: enuToWorld(cx, cy, h + 0.15),
        box: {
          dimensions: new Cesium.Cartesian3(w, d, 0.3),
          material: new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString(SCENE_COLORS.buildingRoof)),
        },
        properties: semanticProps(roof.id),
      })
      register(roof.id, e)
      bindBox(roof.id, e, SCENE_COLORS.buildingRoof)
    }
  }
}

/** 光伏纹理材质（按可用面积估算组件排布重复数） */
function pvMaterial(canvas: HTMLCanvasElement, w: number, d: number): Cesium.ImageMaterialProperty {
  return new Cesium.ImageMaterialProperty({
    image: canvas,
    // 每块纹理约代表 2.2m × 1.4m 的组件组，面积感与可用率一致
    repeat: new Cesium.Cartesian2(Math.max(1, Math.round(w / 2.2)), Math.max(1, Math.round(d / 1.4))),
  })
}

/** 朝南坡面高度：北缘（y 大）抬高 tan(倾角)×(ymax-y) */
function tiltedZ(baseZ: number, tiltDeg: number, y: number, yMax: number): number {
  return baseZ + Math.tan(Cesium.Math.toRadians(tiltDeg)) * (yMax - y)
}

function buildRoofPvArray(
  entities: Cesium.EntityCollection,
  p: PvArray,
  building: Building,
  canvas: HTMLCanvasElement,
): void {
  const roof = roofById.get(p.roofId!)!
  const ratio = Math.sqrt(roof.usableRatio)
  const uw = building.size[0] * ratio
  const ud = building.size[1] * ratio
  const [cx, cy] = [building.center[0], building.center[1]]
  const baseZ = building.height + 0.45
  const yMax = cy + ud / 2
  const corners = rectCorners(cx, cy, uw, ud).map(([x, y]) => enuToWorld(x, y, tiltedZ(baseZ, p.tiltDeg, y, yMax)))
  const e = entities.add({
    polygon: {
      hierarchy: new Cesium.PolygonHierarchy(corners),
      perPositionHeight: true,
      material: pvMaterial(canvas, uw, ud),
    },
    properties: semanticProps(p.id),
  })
  register(p.id, e)
  bindImage(p.id, e, pvMaterial(canvas, uw, ud))
}

function buildCarport(entities: Cesium.EntityCollection, p: PvArray, canvas: HTMLCanvasElement): void {
  const [cx, cy] = [p.center![0], p.center![1]]
  const [w, d] = p.size!
  const baseZ = 3 // 车棚棚顶离地 3m
  const yMax = cy + d / 2
  const corners = rectCorners(cx, cy, w, d)
  // 棚顶（带 8° 倾角）
  const canopy = entities.add({
    polygon: {
      hierarchy: new Cesium.PolygonHierarchy(
        corners.map(([x, y]) => enuToWorld(x, y, tiltedZ(baseZ, p.tiltDeg, y, yMax))),
      ),
      perPositionHeight: true,
      material: pvMaterial(canvas, w, d),
    },
    properties: semanticProps(p.id),
  })
  register(p.id, canopy)
  bindImage(p.id, canopy, pvMaterial(canvas, w, d))
  // 四根支柱
  for (const [x, y] of corners) {
    const leg = entities.add({
      position: enuToWorld(x * 0.98 + cx * 0.02, y * 0.98 + cy * 0.02, baseZ / 2),
      box: {
        dimensions: new Cesium.Cartesian3(0.25, 0.25, baseZ),
        material: Cesium.Color.fromCssColorString('#666666'),
      },
    })
    register(p.id, leg)
  }
}

function buildPvArrays(entities: Cesium.EntityCollection): void {
  const canvas = makePvPanelCanvas()
  for (const p of fixture.pvArrays) {
    if (p.carport) {
      buildCarport(entities, p, canvas)
    } else {
      const roof = roofById.get(p.roofId!)
      const building = roof ? buildingById.get(roof.buildingId) : undefined
      if (building) buildRoofPvArray(entities, p, building, canvas)
    }
  }
}

function buildInverters(entities: Cesium.EntityCollection): void {
  for (const inv of fixture.inverters) {
    const [x, y, z] = inv.position
    addBox(entities, inv.id, x, y, z, [1.4, 0.7, 0.9], SCENE_COLORS.inverter)
    addPointMarker(entities, inv.id, x, y, z + 1.6, SCENE_COLORS.inverter, 7)
  }
}

function buildStringTargets(entities: Cesium.EntityCollection): void {
  // 组串没有独立几何模型；以其登记逆变器位置生成目标组串语义标记。位置只作场景定位示意。
  for (const stringAsset of fixture.strings) {
    const inverter = inverterById.get(stringAsset.inverterId)
    if (!inverter) continue
    const [x, y, z] = inverter.position
    addPointMarker(entities, stringAsset.id, x, y, z + 2.7, SCENE_COLORS.anomalyTarget, 12)
    addLabel(entities, stringAsset.id, stringAsset.id + ' · 组串目标（位置示意）', x, y, z + 4.1, 11)
  }
}

function buildJunctionBoxes(entities: Cesium.EntityCollection): void {
  for (const jb of fixture.junctionBoxes) {
    const [x, y, z] = jb.position
    addBox(entities, jb.id, x, y, z, [0.8, 0.5, 0.6], SCENE_COLORS.junctionBox)
  }
}

function buildEss(entities: Cesium.EntityCollection): void {
  for (const cab of fixture.ess.cabinets) {
    const [x, y, z] = cab.position
    addBox(entities, cab.id, x, y, z, [3.5, 2.2, 2.6], SCENE_COLORS.ess)
  }
}

function buildChargers(entities: Cesium.EntityCollection): void {
  for (const ch of fixture.chargers) {
    const [x, y, z] = ch.position
    addBox(entities, ch.id, x, y, z, [0.5, 0.5, 1.6], SCENE_COLORS.charger)
    addPointMarker(entities, ch.id, x, y, z + 2.1, SCENE_COLORS.charger, 7)
  }
}

function buildTransformer(entities: Cesium.EntityCollection): void {
  // TR-01 为 2×1000kVA，单对象双箱体并排
  const [x, y, z] = fixture.transformer.position
  addBox(entities, fixture.transformer.id, x, y, z, [2.6, 1.6, 2.0], SCENE_COLORS.transformer)
  addBox(entities, fixture.transformer.id, x + 3.2, y, z, [2.6, 1.6, 2.0], SCENE_COLORS.transformer)
}

function buildMeters(entities: Cesium.EntityCollection): void {
  const mm = fixture.mainMeter
  addBox(entities, mm.id, mm.position[0], mm.position[1], mm.position[2], [0.8, 0.4, 1.2], SCENE_COLORS.meter)
  addPointMarker(entities, mm.id, mm.position[0], mm.position[1], mm.position[2] + 1.7, SCENE_COLORS.meter, 7)
  // 分表挂在所属楼栋南侧墙边（位置由楼栋 footprint 推导，不另写坐标）
  for (const sm of fixture.subMeters) {
    const b = buildingById.get(sm.buildingId)
    if (!b) continue
    const x = b.center[0] + b.size[0] / 2 - 1
    const y = b.center[1] - b.size[1] / 2 - 1.2
    addBox(entities, sm.id, x, y, 0, [0.6, 0.35, 1.0], SCENE_COLORS.meter)
    addPointMarker(entities, sm.id, x, y, 1.5, SCENE_COLORS.meter, 6)
  }
}

function buildWeatherStation(entities: Cesium.EntityCollection): void {
  const ws = fixture.weatherStation
  const [x, y, z] = ws.position
  addBox(entities, ws.id, x, y, z, [0.15, 0.15, 3.0], SCENE_COLORS.weather)
  addBox(entities, ws.id, x, y, z + 3.0, [0.6, 0.6, 0.3], SCENE_COLORS.weather)
  addPointMarker(entities, ws.id, x, y, z + 3.8, SCENE_COLORS.weather, 7)
}

function buildOpsPoint(entities: Cesium.EntityCollection): void {
  const ops = fixture.opsPoint
  const [x, y, z] = ops.position
  addBox(entities, ops.id, x, y, z, [0.15, 0.15, 3.0], SCENE_COLORS.ops)
  addPointMarker(entities, ops.id, x, y, z + 3.4, SCENE_COLORS.ops, 10)
  addLabel(entities, ops.id, `${ops.id} ${ops.name}`, x, y, z + 4.5, 13)
}

function buildCheckpoints(entities: Cesium.EntityCollection): void {
  const kindLabel: Record<string, string> = {
    'building-front': '楼前',
    roof: '屋面',
    device: '设备',
  }
  for (const cp of fixture.checkpoints) {
    const [x, y, z] = cp.position
    // 旗杆 + 醒目旗点，巡检检查点
    const pole = entities.add({
      position: enuToWorld(x, y, z + 1.25),
      box: {
        dimensions: new Cesium.Cartesian3(0.12, 0.12, 2.5),
        material: Cesium.Color.fromCssColorString(SCENE_COLORS.checkpoint),
      },
      properties: semanticProps(cp.id),
    })
    register(cp.id, pole)
    addPointMarker(entities, cp.id, x, y, z + 2.9, SCENE_COLORS.checkpoint, 14)
    addLabel(entities, cp.id, `CP·${kindLabel[cp.kind] ?? cp.kind}`, x, y, z + 4, 13)
  }
}

// ---- 入口 ----

export function buildParkScene(viewer: Cesium.Viewer): void {
  const entities = viewer.entities
  buildGround(entities)
  buildRoads(entities)
  buildBuildings(entities)
  buildPvArrays(entities)
  buildInverters(entities)
  buildStringTargets(entities)
  buildJunctionBoxes(entities)
  buildEss(entities)
  buildChargers(entities)
  buildTransformer(entities)
  buildMeters(entities)
  buildWeatherStation(entities)
  buildOpsPoint(entities)
  buildCheckpoints(entities)
  wireStatusChanges()
}

/** 初始相机：南偏东俯瞰全园区，俯视约 45° */
export function setInitialCamera(viewer: Cesium.Viewer): void {
  // 园区中心由楼栋中心平均得出（fixture 驱动）
  const n = fixture.buildings.length
  const cx = fixture.buildings.reduce((s, b) => s + b.center[0], 0) / n
  const cy = fixture.buildings.reduce((s, b) => s + b.center[1], 0) / n
  const offset = { x: 220, y: -240, z: 280 } // 南偏东
  viewer.camera.setView({
    destination: enuToWorld(cx + offset.x, cy + offset.y, offset.z),
    orientation: {
      heading: Cesium.Math.toRadians((Math.atan2(-offset.x, -offset.y) * 180) / Math.PI),
      pitch: Cesium.Math.toRadians(-42),
      roll: 0,
    },
  })
}

/** 双击飞到目标附近 */
export function flyToEntity(viewer: Cesium.Viewer, entity: Cesium.Entity): void {
  viewer.flyTo(entity, {
    duration: 1.2,
    offset: new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(150),
      Cesium.Math.toRadians(-35),
      120,
    ),
  })
}
