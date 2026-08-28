// 颜色常量：状态机五态 + 真值标签四色。
// UI（CSS）与 3D（Cesium.Color）共用同一份定义，禁止各处另写色值。
import * as Cesium from 'cesium'
import type { DeviceStatus } from '../state/parkState'
import type { TruthTag } from './truth'

export interface StatusMeta {
  label: string
  /** 十六进制色值，UI 直接使用 */
  css: string
}

/** 设备状态五态（contracts/semantic-tree.md §3） */
export const STATUS_META: Record<DeviceStatus, StatusMeta> = {
  normal: { label: '正常', css: '#7fb069' },
  degraded: { label: '性能偏低', css: '#ff9800' },
  fault: { label: '故障', css: '#e53935' },
  offline: { label: '离线', css: '#9e9e9e' },
  maintenance: { label: '检修中', css: '#1e88e5' },
}

/** 真值标签四色（contracts/data-contracts.md §1） */
export const TRUTH_META: Record<TruthTag, { label: string; css: string }> = {
  MEASURED: { label: '实测', css: '#43a047' },
  MODELED: { label: '模型', css: '#1e88e5' },
  SIMULATED: { label: '仿真', css: '#f9a825' },
  POLICY: { label: '政策', css: '#8d8d8d' },
}

export function statusColor(status: DeviceStatus): Cesium.Color {
  return Cesium.Color.fromCssColorString(STATUS_META[status].css)
}

/**
 * 按状态计算实体颜色：normal 用设备基础色，其余四态用状态色覆盖。
 */
export function tintedColor(status: DeviceStatus, baseCss: string): Cesium.Color {
  if (status === 'normal') return Cesium.Color.fromCssColorString(baseCss)
  return statusColor(status)
}

// ---- 场景基础色（非状态色） ----
export const SCENE_COLORS = {
  buildingBody: '#d9d5cc', // 楼体浅灰米白
  buildingRoof: '#a8a49a', // 屋顶略深
  groundPlate: '#b7b3a8', // 场地地坪
  road: '#4a4a4a', // 道路深灰
  ess: '#f2f2f0', // 储能白色集装箱
  charger: '#e8c832', // 充电桩黄色立柱
  transformer: '#7d8f69', // 箱变灰绿
  meter: '#5b7a99', // 电表
  inverter: '#c3cfd6', // 逆变器浅钢色
  junctionBox: '#b0bec5', // 并网箱
  checkpoint: '#ffd54f', // 检查点醒目黄
  ops: '#ab47bc', // 运维点紫
  weather: '#4db6ac', // 气象仪青
  anomalyTarget: '#ff7043', // 异常目标组串（由状态着色覆盖）
  offlineGround: '#23282e', // 离线模式地面纯色
  offlineGrid: '#3d4854', // 离线模式网格线
}
