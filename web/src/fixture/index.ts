// 园区 fixture 类型与导入（唯一数据来源：data/fixtures/park-pecc-01.json）
// 场景内所有坐标/参数均由这里读出，不允许在代码里另写第二份。
import raw from '../../../data/fixtures/park-pecc-01.json'

export type Vec3 = [number, number, number]

export interface Building {
  id: string
  name: string
  center: Vec3
  size: [number, number]
  height: number
  floors: number
  kind: string
  roofId: string
  subMeterId: string
  loadType: string
}

export interface Roof {
  id: string
  buildingId: string
  tiltDeg: number
  azimuthDeg: number
  usableRatio: number
  pvArrayId: string | null
  expansionCandidate?: boolean
}

export interface PvArray {
  id: string
  roofId?: string
  carport?: boolean
  center?: Vec3
  size?: [number, number]
  peakKwp: number
  panelCount: number
  tiltDeg: number
  azimuthDeg: number
  inverterIds: string[]
}

export interface Inverter {
  id: string
  pvArrayId: string
  model: string
  ratedKw: number
  stringCount: number
  position: Vec3
}

export interface StringAsset {
  id: string
  inverterId: string
  panelCount: number
  note: string
  ratedCurrentA?: number
  ratedVoltageV?: number
}

export interface JunctionBox {
  id: string
  pvArrayId: string
  position: Vec3
}

export interface EssCabinet {
  id: string
  ratedKw: number
  capacityKwh: number
  position: Vec3
}

export interface Charger {
  id: string
  ratedKw: number
  position: Vec3
}

export interface Road {
  id: string
  polyline: [number, number][]
}

export interface Checkpoint {
  id: string
  nodeId: string
  kind: string
  position: Vec3
}

export interface ParkFixture {
  id: string
  name: string
  fictional: boolean
  prototypeNote: string
  anchor: { lat: number; lon: number; altM: number }
  gridConnection: { voltageKv: number; mode: string; policyBasis: string }
  buildings: Building[]
  roofs: Roof[]
  pvArrays: PvArray[]
  inverters: Inverter[]
  strings: StringAsset[]
  junctionBoxes: JunctionBox[]
  ess: {
    id: string
    cabinets: EssCabinet[]
    totalRatedKw: number
    totalCapacityKwh: number
  }
  chargers: Charger[]
  transformer: { id: string; capacityKva: number; note: string; position: Vec3 }
  mainMeter: { id: string; position: Vec3; note: string }
  subMeters: { id: string; buildingId: string }[]
  weatherStation: { id: string; position: Vec3 }
  opsPoint: { id: string; name: string; position: Vec3 }
  roads: Road[]
  checkpoints: Checkpoint[]
  demoAnomaly: {
    id: string
    targetStringId: string
    type: string
    magnitude: number
    suspected: string
    taskId: string
    note: string
  }
}

export const fixture = raw as unknown as ParkFixture

export const buildingById = new Map(fixture.buildings.map((b) => [b.id, b]))
export const roofById = new Map(fixture.roofs.map((r) => [r.id, r]))
export const pvArrayById = new Map(fixture.pvArrays.map((p) => [p.id, p]))
export const inverterById = new Map(fixture.inverters.map((i) => [i.id, i]))
