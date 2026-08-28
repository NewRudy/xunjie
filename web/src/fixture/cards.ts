// 点击语义卡数据：按语义树 ID 从 fixture 提取卡片字段。
// 数字一律来自 fixture（静态参数）；运行期数字（发电量等）P2 引擎接入前显示"引擎未接入"。
import { fixture, buildingById, roofById, inverterById } from './index'

export interface CardField {
  label: string
  value: string
}

export interface CardInfo {
  id: string
  title: string
  typeLabel: string
  fields: CardField[]
  note?: string
}

const LOAD_TYPE_LABEL: Record<string, string> = {
  production_2shift: '两班制生产',
  office: '办公',
  dormitory: '宿舍',
  canteen: '食堂',
  distribution: '配电',
}

const KIND_LABEL: Record<string, string> = {
  factory: '厂房',
  office: '办公楼',
  dormitory: '宿舍食堂',
  utility: '配电房',
}

function buildingCard(id: string): CardInfo | null {
  const b = buildingById.get(id)
  if (!b) return null
  return {
    id,
    title: `${b.name}（${KIND_LABEL[b.kind] ?? b.kind}）`,
    typeLabel: '楼栋',
    fields: [
      { label: '楼层 / 高度', value: `${b.floors} 层 / ${b.height} m` },
      { label: '占地尺寸', value: `${b.size[0]} × ${b.size[1]} m` },
      { label: '负荷类型', value: LOAD_TYPE_LABEL[b.loadType] ?? b.loadType },
      { label: '分项电表', value: b.subMeterId },
      { label: '屋顶对象', value: b.roofId },
    ],
  }
}

function roofCard(id: string): CardInfo | null {
  const r = roofById.get(id)
  if (!r) return null
  return {
    id,
    title: `屋顶 ${id}`,
    typeLabel: '屋顶',
    fields: [
      { label: '所属楼栋', value: r.buildingId },
      { label: '倾角 / 方位角', value: `${r.tiltDeg}° / ${r.azimuthDeg}°` },
      { label: '可用率', value: `${Math.round(r.usableRatio * 100)}%` },
      { label: '光伏子阵', value: r.pvArrayId ?? '未安装（"去哪装"预留扩建点）' },
    ],
  }
}

function pvCard(id: string): CardInfo | null {
  const p = fixture.pvArrays.find((v) => v.id === id)
  if (!p) return null
  return {
    id,
    title: p.carport ? `光伏车棚 ${id}` : `屋顶光伏子阵 ${id}`,
    typeLabel: '光伏子阵',
    fields: [
      { label: '装机容量', value: `${p.peakKwp} kWp` },
      { label: '组件数', value: `${p.panelCount} 块` },
      { label: '倾角 / 方位角', value: `${p.tiltDeg}° / ${p.azimuthDeg}°` },
      { label: '逆变器', value: p.inverterIds.join('、') },
    ],
  }
}

function stringCard(id: string): CardInfo | null {
  const s = fixture.strings.find((v) => v.id === id)
  if (!s) return null
  const inv = inverterById.get(s.inverterId)
  const fields: CardField[] = [
    { label: '所属逆变器', value: s.inverterId },
    { label: '组件数', value: `${s.panelCount} 块` },
  ]
  if (s.ratedCurrentA !== undefined && s.ratedVoltageV !== undefined) {
    fields.push({ label: '额定电流 / 电压', value: `${s.ratedCurrentA} A / ${s.ratedVoltageV} V` })
  }
  if (inv) fields.push({ label: '所属子阵', value: inv.pvArrayId })
  const isDemoTarget = id === fixture.demoAnomaly.targetStringId
  return {
    id,
    title: `光伏组串 ${id}`,
    typeLabel: '光伏组串',
    fields,
    note: isDemoTarget
      ? `演示异常 ${fixture.demoAnomaly.id}：电流偏低 ${Math.abs(fixture.demoAnomaly.magnitude) * 100}%，疑似${fixture.demoAnomaly.suspected}（仿真注入）；三维位置为所属逆变器附近的定位示意。`
      : s.note,
  }
}

function inverterCard(id: string): CardInfo | null {
  const inv = fixture.inverters.find((i) => i.id === id)
  if (!inv) return null
  const linkedString = fixture.strings.find((s) => s.inverterId === id)
  const fields: CardField[] = [
    { label: '型号', value: inv.model },
    { label: '额定功率', value: `${inv.ratedKw} kW` },
    { label: '组串数', value: `${inv.stringCount}` },
    { label: '所属子阵', value: inv.pvArrayId },
  ]
  let note: string | undefined
  if (linkedString && linkedString.id === fixture.demoAnomaly.targetStringId) {
    fields.push({ label: '演示组串', value: `${linkedString.id}（${linkedString.panelCount} 块组件）` })
    note = `演示异常 ${fixture.demoAnomaly.id}：${linkedString.id} 电流偏低 ${Math.abs(fixture.demoAnomaly.magnitude) * 100}%，疑似${fixture.demoAnomaly.suspected}（仿真注入）`
  }
  return { id, title: `逆变器 ${id}`, typeLabel: '逆变器', fields, note }
}

function junctionBoxCard(id: string): CardInfo | null {
  const jb = fixture.junctionBoxes.find((j) => j.id === id)
  if (!jb) return null
  return {
    id,
    title: `并网箱 ${id}`,
    typeLabel: '并网箱',
    fields: [{ label: '所属子阵', value: jb.pvArrayId }],
  }
}

function essCard(id: string): CardInfo | null {
  const cab = fixture.ess.cabinets.find((c) => c.id === id)
  if (!cab) return null
  return {
    id,
    title: `储能柜 ${id}`,
    typeLabel: '储能',
    fields: [
      { label: '额定功率', value: `${cab.ratedKw} kW` },
      { label: '容量', value: `${cab.capacityKwh} kWh` },
      { label: '所属系统', value: `${fixture.ess.id}（共 ${fixture.ess.totalRatedKw} kW / ${fixture.ess.totalCapacityKwh} kWh）` },
    ],
  }
}

function chargerCard(id: string): CardInfo | null {
  const ch = fixture.chargers.find((c) => c.id === id)
  if (!ch) return null
  return {
    id,
    title: `充电桩 ${id}`,
    typeLabel: '充电桩',
    fields: [
      { label: '额定功率', value: `${ch.ratedKw} kW` },
      { label: '负荷属性', value: '可调负荷（光伏富余优先充、谷价补电）' },
    ],
  }
}

function transformerCard(id: string): CardInfo | null {
  if (id !== fixture.transformer.id) return null
  return {
    id,
    title: `箱变 ${id}`,
    typeLabel: '箱变',
    fields: [
      { label: '容量', value: `${fixture.transformer.capacityKva} kVA` },
      { label: '说明', value: fixture.transformer.note },
      { label: '并网电压', value: `${fixture.gridConnection.voltageKv} kV` },
    ],
  }
}

function meterCard(id: string): CardInfo | null {
  if (id === fixture.mainMeter.id) {
    return {
      id,
      title: `园区总电表 ${id}`,
      typeLabel: '电表',
      fields: [
        { label: '说明', value: fixture.mainMeter.note },
        { label: '并网模式', value: fixture.gridConnection.mode },
      ],
    }
  }
  const sm = fixture.subMeters.find((m) => m.id === id)
  if (!sm) return null
  const b = buildingById.get(sm.buildingId)
  return {
    id,
    title: `分项电表 ${id}`,
    typeLabel: '电表',
    fields: [
      { label: '所属楼栋', value: b ? `${b.name}（${b.id}）` : sm.buildingId },
      { label: '负荷类型', value: b ? LOAD_TYPE_LABEL[b.loadType] ?? b.loadType : '-' },
    ],
  }
}

function checkpointCard(id: string): CardInfo | null {
  const cp = fixture.checkpoints.find((c) => c.id === id)
  if (!cp) return null
  const kindLabel: Record<string, string> = { 'building-front': '楼前点', roof: '屋面点', device: '设备点' }
  return {
    id,
    title: `检查点 ${id}`,
    typeLabel: '巡检检查点',
    fields: [
      { label: '类型', value: kindLabel[cp.kind] ?? cp.kind },
      { label: '关联对象', value: cp.nodeId },
    ],
  }
}

function roadCard(id: string): CardInfo | null {
  const road = fixture.roads.find((r) => r.id === id)
  if (!road) return null
  return {
    id,
    title: `道路 ${id}`,
    typeLabel: '道路',
    fields: [{ label: '折线点数', value: `${road.polyline.length}` }],
    note: '巡检寻路与场景渲染共用此折线',
  }
}

export function getCardInfo(id: string): CardInfo | null {
  if (id === fixture.weatherStation.id) {
    return {
      id,
      title: `环境监测仪 ${id}`,
      typeLabel: '气象仪',
      fields: [{ label: '数据源', value: 'Open-Meteo（P2 接入）' }],
    }
  }
  if (id === fixture.opsPoint.id) {
    return {
      id,
      title: `${fixture.opsPoint.name} ${id}`,
      typeLabel: '运维点',
      fields: [{ label: '用途', value: '巡检小人出发点（P4）' }],
    }
  }
  return (
    buildingCard(id) ??
    roofCard(id) ??
    pvCard(id) ??
    stringCard(id) ??
    inverterCard(id) ??
    junctionBoxCard(id) ??
    essCard(id) ??
    chargerCard(id) ??
    transformerCard(id) ??
    meterCard(id) ??
    checkpointCard(id) ??
    roadCard(id)
  )
}
