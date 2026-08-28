// 负荷仿真器（SIMULATED，合同 data-contracts.md §3）
// - 输入：fixture loadProfile + loadType + 日历（calendar.ts，2026 国务院安排）
// - 输出：15 分钟级曲线（96 点/日）；种子 seed = hash(nodeId + date)，同日同节点一致
// - 各 loadType 逐时基线系数按合同 §3；分表峰值 kW 为引擎侧仿真参数（fixture 未给出，取值可解释：
//   园区最大需量约 1500kW、年用电约 520 万 kWh 两口径回推，见本文件底部注释）
// - 充电桩 EV-01..04 是可调负荷：9-17 窗口随机到车（车队 4 辆，单车 60kW）；
//   策略卡可平移窗口到谷段（window='shifted'），平移前后曲线都可查
import { dayType, type DayType } from './calendar';
import { fixture } from './fixture';
import { getWeatherDay } from './weather';
import { r2, r3, seededRng } from './util';

/** 分表（楼栋）峰值 kW：仿真参数（SIMULATED），单一事实源 = fixture subMeters[].peakKw。
 *  取值依据：max ≈ 1070×0.9 + 82.5 + 13.5 + 12 + 240(EV) ≈ 1311kW（≤1500 合同需量上限）；
 *  年用电 ≈ 工作日 16.4MWh×250 + 周末 8.5MWh×115 ≈ 510 万 kWh ≈ fixture 的"约 520 万"。 */
const METER_PEAK_KW: Record<string, number> = Object.fromEntries(
  fixture.subMeters.map((m) => [m.id, m.peakKw ?? 0]),
);

/** 各 loadType 逐时基线系数（0~1，合同 §3 原文取值；"其余"时段按合同兜底值） */
const HOURLY_COEFF: Record<string, number[]> = {
  // 两班制生产：00-07≈0.15；08-12≈0.85；12-13≈0.5（午休）；13-18≈0.9；18-20≈0.7；20-24≈0.6；其余 0.2（即 7 时接班爬坡）
  production_2shift: [0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.2, 0.85, 0.85, 0.85, 0.85, 0.5, 0.9, 0.9, 0.9, 0.9, 0.9, 0.7, 0.7, 0.6, 0.6, 0.6, 0.6],
  // 办公：00-07≈0.05；08-12≈0.7；12-14≈0.3；14-18≈0.75；18-20≈0.2；其余≈0.05
  office: [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.7, 0.7, 0.7, 0.7, 0.3, 0.3, 0.75, 0.75, 0.75, 0.75, 0.2, 0.2, 0.05, 0.05, 0.05, 0.05],
  // 宿舍：早峰 06-08≈0.6；白天≈0.15；晚峰 18-23≈0.8；夜间≈0.25
  dormitory: [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.6, 0.6, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.8, 0.8, 0.8, 0.8, 0.8, 0.25],
  // 食堂：三餐峰 07-08/11-13/17-19≈0.9；其余≈0.1（fixture 暂无楼栋使用，合同系数表保留）
  canteen: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.9, 0.1, 0.1, 0.1, 0.9, 0.9, 0.1, 0.1, 0.1, 0.1, 0.9, 0.9, 0.1, 0.1, 0.1, 0.1, 0.1],
  // 配电房小动力（park-fixture §3 对 B06 的 distribution 定义）：日间动力+照明较高、夜间基载
  distribution: [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.35, 0.35, 0.3, 0.3, 0.25, 0.25],
};

/** 日历修正系数（合同仅规定 office 周末 ×0.15；生产/EV 的修正为引擎细化，可解释：两班制周末减产、节假日最低） */
function dayFactor(loadType: string, dt: DayType): number {
  switch (loadType) {
    case 'production_2shift':
      return dt === 'workday' ? 1 : dt === 'weekend' ? 0.5 : 0.3;
    case 'office':
      return dt === 'workday' ? 1 : 0.15; // 合同：周末 ×0.15（节假日同周末）
    default:
      return 1; // 宿舍/食堂/配电房：住人值班负荷，日历不敏感
  }
}

export interface LoadPoint {
  ts: string; // "YYYY-MM-DDTHH:MM"
  kw: number;
}

function bucketTs(date: string, bucket: number): string {
  const h = Math.floor(bucket / 4);
  const m = (bucket % 4) * 15;
  return `${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 分表（楼栋）15 分钟级曲线：基线系数 × 日历系数 × ±3% 种子抖动 */
function meterProfile15(meterId: string, date: string): LoadPoint[] {
  const meter = fixture.subMeters.find((m) => m.id === meterId);
  const building = fixture.buildings.find((b) => b.id === meter?.buildingId);
  const loadType = building?.loadType ?? 'distribution';
  const peak = METER_PEAK_KW[meterId];
  if (!peak) throw new Error(`未知分表 ${meterId}`);
  const dt = dayType(date);
  const coeff = HOURLY_COEFF[loadType];
  const df = dayFactor(loadType, dt);
  const rng = seededRng(`${meterId}|${date}`); // 合同种子规则
  const out: LoadPoint[] = [];
  for (let b = 0; b < 96; b++) {
    const jitter = 1 + (rng() * 2 - 1) * 0.03; // ±3% 15 分钟抖动，种子确定
    const kw = peak * coeff[Math.floor(b / 4)] * df * jitter;
    out.push({ ts: bucketTs(date, b), kw: r3(kw) });
  }
  return out;
}

/** 充电桩单日车辆计划：先抽需求电量（40~80kWh），再抽到车时刻；
 *  base 窗口 9-17（fixture evFleet），shifted 窗口 0-8（谷段）；
 *  同一充电桩同一日期两种窗口下需求电量相同（抽取顺序一致），仅时刻平移。 */
function chargerProfile15(chargerId: string, date: string, window: 'base' | 'shifted'): LoadPoint[] {
  const ratedKw = fixture.chargers.find((c) => c.id === chargerId)?.ratedKw ?? 60;
  const dt = dayType(date);
  const carIndex = Number(chargerId.slice(-1)) - 1; // EV-0i ↔ 车队第 i 辆（确定性对应）
  const carCount = dt === 'workday' ? fixture.loadProfile.evFleet.count : dt === 'weekend' ? 2 : 1;
  const buckets = new Array(96).fill(0);
  if (carIndex < carCount) {
    const rng = seededRng(`${chargerId}|${date}`);
    const [lo, hi] = fixture.loadProfile.evFleet.dailyDemandKwhEach; // [40, 80] kWh
    const demandKwh = lo + rng() * (hi - lo); // ① 需求电量
    const durationH = demandKwh / ratedKw;
    const [w0, w1] = window === 'base' ? [fixture.loadProfile.evFleet.arrivalHour, fixture.loadProfile.evFleet.departureHour] : [0, 8];
    const startH = w0 + rng() * (w1 - w0 - durationH); // ② 到车时刻（窗口内随机）
    const endH = startH + durationH;
    for (let b = 0; b < 96; b++) {
      const b0 = b * 0.25;
      const overlap = Math.max(0, Math.min(b0 + 0.25, endH) - Math.max(b0, startH));
      buckets[b] = ratedKw * (overlap / 0.25); // 按时间占比分摊到 15 分钟桶
    }
  }
  return buckets.map((kw, b) => ({ ts: bucketTs(date, b), kw: r3(kw) }));
}

export type LoadWindow = 'base' | 'shifted';

/** 节点 15 分钟级负荷：MT-B01..06 / EV-01..04 / PARK-01（园区汇总） */
export function loadProfile15(nodeId: string, date: string, window: LoadWindow = 'base'): LoadPoint[] {
  if (nodeId === 'PARK-01') {
    const total = new Array(96).fill(0);
    for (const m of fixture.subMeters) meterProfile15(m.id, date).forEach((p, b) => (total[b] += p.kw));
    for (const c of fixture.chargers) chargerProfile15(c.id, date, window).forEach((p, b) => (total[b] += p.kw));
    return total.map((kw, b) => ({ ts: bucketTs(date, b), kw: r3(kw) }));
  }
  if (fixture.subMeters.some((m) => m.id === nodeId)) return meterProfile15(nodeId, date);
  if (fixture.chargers.some((c) => c.id === nodeId)) return chargerProfile15(nodeId, date, window);
  throw new Error(`节点 ${nodeId} 无负荷曲线`);
}

/** 15 分钟曲线 → 逐时平均功率（kW） */
export function hourlyFromProfile(profile: LoadPoint[]): number[] {
  const out: number[] = [];
  for (let h = 0; h < 24; h++) {
    const slice = profile.slice(h * 4, h * 4 + 4);
    out.push(r3(slice.reduce((s, p) => s + p.kw, 0) / 4));
  }
  return out;
}

/** 园区逐时负荷（平衡/策略用） */
export const parkLoadHourly = (date: string, window: LoadWindow = 'base'): number[] => hourlyFromProfile(loadProfile15('PARK-01', date, window));

/** 园区当日最大需量（kW，15 分钟口径） */
export const parkMaxDemandKw = (date: string): number => Math.max(...loadProfile15('PARK-01', date).map((p) => p.kw));

/** 园区当日 EV 充电总量（kWh）与原窗口加权均价计算用逐时能量 */
export function evDailyEnergyKwh(date: string, window: LoadWindow = 'base'): { totalKwh: number; hourlyKwh: number[] } {
  const total = new Array(96).fill(0);
  for (const c of fixture.chargers) chargerProfile15(c.id, date, window).forEach((p, b) => (total[b] += p.kw));
  const totalKwh = total.reduce((s, kw) => s + kw * 0.25, 0);
  const hourlyKwh: number[] = [];
  for (let h = 0; h < 24; h++) hourlyKwh.push(r3(total.slice(h * 4, h * 4 + 4).reduce((s, kw) => s + kw * 0.25, 0)));
  return { totalKwh: r3(totalKwh), hourlyKwh };
}

/** 负荷预测（MODELED）：规则基线——无抖动基线 × 日历系数 + 温度修正；
 *  温度修正：非 EV 部分按空调敏感性 1 + 0.008×(T-26℃)，限幅 [0.9, 1.1]；
 *  EV 部分按车队期望（4 辆 × 均值 60kWh，9-17 均匀分布）。 */
export async function loadForecastHourly(date: string): Promise<number[]> {
  const dt = dayType(date);
  const weather = await getWeatherDay(date);
  const out = new Array(24).fill(0);
  for (const m of fixture.subMeters) {
    const building = fixture.buildings.find((b) => b.id === m.buildingId);
    const loadType = building?.loadType ?? 'distribution';
    const peak = METER_PEAK_KW[m.id] ?? 0;
    const df = dayFactor(loadType, dt);
    for (let h = 0; h < 24; h++) {
      const tempFactor = Math.min(1.1, Math.max(0.9, 1 + 0.008 * (weather.hours[h].temp - 26)));
      out[h] += peak * HOURLY_COEFF[loadType][h] * df * tempFactor;
    }
  }
  // EV 期望：车辆数 × 期望 60kWh ÷ 8h 窗口均匀分布
  const cars = dt === 'workday' ? fixture.loadProfile.evFleet.count : dt === 'weekend' ? 2 : 1;
  const evPerHour = (cars * 60) / 8;
  for (let h = 9; h < 17; h++) out[h] += evPerHour;
  return out.map((v) => r3(v));
}

/** 当日 EV 车队的需求电量明细（策略卡 calc 可复核用） */
export function evFleetPlan(date: string): { chargerId: string; demandKwh: number }[] {
  const dt = dayType(date);
  const carCount = dt === 'workday' ? fixture.loadProfile.evFleet.count : dt === 'weekend' ? 2 : 1;
  const out: { chargerId: string; demandKwh: number }[] = [];
  for (let i = 0; i < carCount; i++) {
    const chargerId = `EV-0${i + 1}`;
    const rng = seededRng(`${chargerId}|${date}`);
    const [lo, hi] = fixture.loadProfile.evFleet.dailyDemandKwhEach;
    out.push({ chargerId, demandKwh: r2(lo + rng() * (hi - lo)) });
  }
  return out;
}
