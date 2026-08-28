// 发电模型（合同 data-contracts.md §4 + engine-io.md §3）
// 应发（MODELED）：expectedKwh(h) = capacityKwp × (ghi(h)/1000) × tempDerate(h) × systemLoss × pvgisCalibration
//   - systemLoss 默认 0.82；pvgisCalibration 使年累计收敛到 955 kWh/kWp（PVGIS 贵阳锚点）
//   - 交流侧按子阵逆变器额定功率之和截顶（容配比 >1 的物理约束）
// 实发（SIMULATED）：应发 × (1 ± 2% 噪声)，种子 = hash(nodeId + date)，逐时顺序抽取
// 异常注入：demoAnomaly（STR-B2-07 在 ghi>200 时 -18%），连带 INV-B-02 / PV-B02-A / 园区汇总可见
import { fixture, getNode, pvArrayOfNode } from './fixture';
import { kvGet, kvSet } from './db';
import { anomalyActive, getAnomalyState } from './anomalyState';
import { getWeatherRange, getWeatherYear, type WeatherHour } from './weather';
import { clamp, r2, r3, r4, seededRng } from './util';

const SYSTEM_LOSS = 0.82; // 合同默认系统损失
export const PVGIS_ANCHOR_KWH_KWP = 955; // PVGIS 贵阳锚点 E_y=955.45
const TEMP_COEFF = 0.004; // 晶硅组件功率温度系数（1/℃）
const NOCT_FACTOR = 25 / 800; // NOCT 45℃ 近似：Tcell = Tair + (NOCT-20)/800 × GHI
const NOISE_PCT = 0.02; // 实发 ±2% 噪声

/** 温度降额：Tcell 用 NOCT 近似，降额系数限幅 [0.75, 1.06] */
export function tempDerate(ghi: number, temp: number): number {
  const tcell = temp + NOCT_FACTOR * ghi;
  return clamp(1 - TEMP_COEFF * (tcell - 25), 0.75, 1.06);
}

/** 子阵逆变器额定功率之和（交流截顶用） */
function inverterRatedSum(pvArray: any): number {
  return pvArray.inverterIds.reduce((s: number, id: string) => s + (getNode(id)?.raw.ratedKw ?? 0), 0);
}

// —— PVGIS 标定常数 ——
interface Calibration {
  value: number;
  source: 'open-meteo-2025' | 'synthetic-2025';
  note: string;
}

let calibrationCache: Calibration | null = null;

/** 未标定的园区年应发（kWh）：cal=1，供标定与自检共用同一管线 */
async function rawAnnualParkKwh(year: number): Promise<{ rawKwh: number; source: string }> {
  const weather = await getWeatherYear(year);
  let total = 0;
  for (let d = 0; d < weather.hours.length / 24; d++) {
    const dayHours = weather.hours.slice(d * 24, d * 24 + 24);
    for (const arr of fixture.pvArrays) {
      const clip = inverterRatedSum(arr);
      for (const h of dayHours) {
        const dc = arr.peakKwp * (h.ghi / 1000) * tempDerate(h.ghi, h.temp) * SYSTEM_LOSS;
        total += Math.min(dc, clip); // 截顶后再乘标定（与 expectedHourly 同序）
      }
    }
  }
  return { rawKwh: total, source: weather.meta.source };
}

/** 启动时确保标定常数存在：优先读持久化值；否则用 2025 整年气象标定到 955 kWh/kWp */
export async function ensureCalibration(): Promise<Calibration> {
  if (calibrationCache) return calibrationCache;
  const persisted = kvGet('pvgisCalibration');
  if (persisted) {
    calibrationCache = JSON.parse(persisted) as Calibration;
    return calibrationCache;
  }
  const { rawKwh, source } = await rawAnnualParkKwh(2025);
  const rawPerKwp = rawKwh / totalParkKwp();
  const value = PVGIS_ANCHOR_KWH_KWP / rawPerKwp;
  calibrationCache = {
    value,
    source: source === 'synthetic' ? 'synthetic-2025' : 'open-meteo-2025',
    note: `2025 年未标定值 ${r2(rawPerKwp)} kWh/kWp，标定到 PVGIS 锚点 ${PVGIS_ANCHOR_KWH_KWP} kWh/kWp`,
  };
  kvSet('pvgisCalibration', JSON.stringify(calibrationCache));
  console.warn(`[generation] PVGIS 标定常数 = ${r4(value)}（来源 ${calibrationCache.source}）`);
  return calibrationCache;
}

export const totalParkKwp = (): number => fixture.pvArrays.reduce((s, a) => s + a.peakKwp, 0);

/** 发电节点解析：返回 { arrays: [{ array, scale }], capacityKwp }；不支持发电的节点返回 null */
function resolvePvScope(nodeId: string): { arrays: { array: any; scale: number }[]; capacityKwp: number } | null {
  const node = getNode(nodeId);
  if (!node) return null;
  if (node.type === 'park') {
    return { arrays: fixture.pvArrays.map((a) => ({ array: a, scale: 1 })), capacityKwp: totalParkKwp() };
  }
  if (node.type === 'pvArray' || node.type === 'roof' || node.type === 'building') {
    const arr = pvArrayOfNode(nodeId);
    return arr ? { arrays: [{ array: arr, scale: 1 }], capacityKwp: arr.peakKwp } : null;
  }
  if (node.type === 'inverter') {
    const arr = fixture.pvArrays.find((a) => a.id === node.raw.pvArrayId);
    if (!arr) return null;
    const ratedSum = arr.inverterIds.reduce((s: number, id: string) => s + (getNode(id)?.raw.ratedKw ?? 0), 0);
    const scale = node.raw.ratedKw / ratedSum; // 按额定功率分摊子阵出力
    return { arrays: [{ array: arr, scale }], capacityKwp: arr.peakKwp * scale };
  }
  if (node.type === 'string') {
    const inv = getNode(node.raw.inverterId);
    if (!inv) return null;
    const arr = fixture.pvArrays.find((a) => a.id === inv.raw.pvArrayId);
    if (!arr) return null;
    const ratedSum = arr.inverterIds.reduce((s: number, id: string) => s + (getNode(id)?.raw.ratedKw ?? 0), 0);
    const scale = inv.raw.ratedKw / ratedSum / inv.raw.stringCount; // 组串 = 逆变器份额 / 组串数
    return { arrays: [{ array: arr, scale }], capacityKwp: arr.peakKwp * scale };
  }
  return null;
}

/** 子阵级应发逐时（kWh）：截顶后乘标定 */
function arrayExpectedHourly(arr: any, hours: WeatherHour[], calibration: number): number[] {
  const clip = inverterRatedSum(arr);
  return hours.map((h) => {
    const dc = arr.peakKwp * (h.ghi / 1000) * tempDerate(h.ghi, h.temp) * SYSTEM_LOSS;
    return Math.min(dc, clip) * calibration;
  });
}

export interface GenHourly {
  ts: string;
  expectedKwh: number;
  ghi: number;
  temp: number;
}

/** 应发（MODELED）：逐时 expectedKwh + 当日合计 */
export async function expectedSeries(nodeId: string, date: string): Promise<{ hourly: GenHourly[]; totalKwh: number; capacityKwp: number } | null> {
  const scope = resolvePvScope(nodeId);
  if (!scope) return null;
  const cal = await ensureCalibration();
  const weather = await getWeatherRange(date, date);
  const sums = new Array(24).fill(0);
  for (const { array, scale } of scope.arrays) {
    const hourly = arrayExpectedHourly(array, weather.hours, cal.value);
    for (let h = 0; h < 24; h++) sums[h] += hourly[h] * scale;
  }
  const hourly: GenHourly[] = sums.map((v, h) => ({
    ts: weather.hours[h].ts,
    expectedKwh: r3(v),
    ghi: weather.hours[h].ghi,
    temp: weather.hours[h].temp,
  }));
  return { hourly, totalKwh: r3(sums.reduce((a, b) => a + b, 0)), capacityKwp: r3(scope.capacityKwp) };
}

export interface ActHourly extends GenHourly {
  actualKwh: number;
  anomalyInjected: boolean; // 该小时是否被异常注入
}

/** 实发（SIMULATED）：应发 × 异常因子 × (1 ± 2% 噪声)。
 *  一致性设计（月报分账依赖）：
 *  - 噪声种子 = hash(子阵ID + date)，挂在子阵级（测量噪声的物理载体）；
 *  - 异常因子按层级份额：STR-B2-07=0.82、INV-B-02=1-0.18/18、PV-B02-A=1-0.18/36，
 *    园区=Σ子阵（子阵各自带因子），因此 园区=Σ子阵=Σ逆变器 精确成立。 */
export async function actualSeries(nodeId: string, date: string): Promise<{ hourly: ActHourly[]; totalKwh: number; expectedTotalKwh: number; capacityKwp: number } | null> {
  const node = getNode(nodeId);
  const scope = node ? resolvePvScope(nodeId) : null;
  if (!node || !scope) return null;
  const exp = await expectedSeries(nodeId, date);
  if (!exp) return null;
  const active = anomalyActive();
  const state = getAnomalyState();
  const targetKwp = resolvePvScope(state.nodeId)?.capacityKwp ?? 0;
  // 本节点（或其子阵）对异常目标组串的层级因子
  const factorFor = (arr: any): number => {
    if (!active) return 1;
    if (node.type === 'string') return nodeId === state.nodeId ? 1 + state.magnitude : 1;
    if (node.type === 'inverter') return nodeId === 'INV-B-02' ? 1 + state.magnitude / node.raw.stringCount : 1;
    // 子阵/屋顶/楼栋/园区：按组串占该子阵容量份额
    return arr.id === 'PV-B02-A' ? 1 + (state.magnitude * targetKwp) / arr.peakKwp : 1;
  };
  const weather = await getWeatherRange(date, date);
  const hourly: ActHourly[] = [];
  for (let h = 0; h < 24; h++) {
    let actual = 0;
    let injected = false;
    for (const { array, scale } of scope.arrays) {
      const rng = seededRng(`${array.id}|${date}`); // 子阵级噪声种子
      let noise = 0;
      for (let k = 0; k <= h; k++) noise = (rng() * 2 - 1) * NOISE_PCT; // 顺序抽取到第 h 小时，保证任意切片一致
      const f = weather.hours[h].ghi > 200 ? factorFor(array) : 1; // 合同：ghi>200 W/m² 时段注入
      if (f !== 1) injected = true;
      const arrExp = arrayExpectedHourly(array, [weather.hours[h]], (await ensureCalibration()).value)[0];
      actual += arrExp * scale * f * (1 + noise);
    }
    const eh = exp.hourly[h];
    hourly.push({ ts: eh.ts, expectedKwh: eh.expectedKwh, ghi: eh.ghi, temp: eh.temp, actualKwh: r3(actual), anomalyInjected: injected });
  }
  return {
    hourly,
    totalKwh: r3(hourly.reduce((s, h) => s + h.actualKwh, 0)),
    expectedTotalKwh: exp.totalKwh,
    capacityKwp: exp.capacityKwp,
  };
}

/** 年产自检（验收 P2-2 用）：指定年份园区应发合计 ÷ 装机 → kWh/kWp，应对标 955 ±5% */
export async function annualYieldCheck(year: number): Promise<{
  year: number;
  kwhPerKwp: number;
  totalKwh: number;
  capacityKwp: number;
  anchorKwhKwp: number;
  tolerancePct: number;
  deviationPct: number;
  pass: boolean;
  weatherSource: string;
}> {
  const cal = await ensureCalibration();
  const { rawKwh, source } = await rawAnnualParkKwh(year);
  const totalKwh = rawKwh * cal.value;
  const kwhPerKwp = totalKwh / totalParkKwp();
  const deviationPct = ((kwhPerKwp - PVGIS_ANCHOR_KWH_KWP) / PVGIS_ANCHOR_KWH_KWP) * 100;
  return {
    year,
    kwhPerKwp: r2(kwhPerKwp),
    totalKwh: r2(totalKwh),
    capacityKwp: totalParkKwp(),
    anchorKwhKwp: PVGIS_ANCHOR_KWH_KWP,
    tolerancePct: 5,
    deviationPct: r2(deviationPct),
    pass: Math.abs(deviationPct) <= 5,
    weatherSource: source,
  };
}
