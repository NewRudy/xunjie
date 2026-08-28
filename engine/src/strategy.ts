// 策略卡（合同 engine-io.md §5）：四种 mode，deltaYuan 全部由确定性代码算出，
// basis.calc 必须能让人手算复核；basis.inputs 给出全部输入数字（带 dataRef），程序可重算。
// 每张卡 deltaYuan 单位统一为 元/日（需量卡另注明元/月口径）。
import { balanceDaily } from './balance';
import { evDailyEnergyKwh, evFleetPlan, parkMaxDemandKw } from './load';
import { DEMAND_PRICE, FEED_IN_PRICE, FLAT_PRICE, PEAK_PRICE, policyPack, tariffSegments, VALLEY_PRICE } from './tariff';
import { fixture } from './fixture';
import { r2, r3 } from './util';

export interface StrategyCard {
  id: string;
  mode: 'ess_arbitrage' | 'ev_shift' | 'demand_control' | 'curtailment_guard';
  title: string;
  description: string;
  window: { from: string; to: string; action: string }[];
  deltaYuan: number; // 元/日
  basis: {
    calc: string;
    inputs: Record<string, number>; // 全部输入数字（程序重算用）
    policyRef: string[];
    dataRef: string[];
    packVersion: string;
  };
  truth: 'MODELED';
}

const REF_481 = '黔发改价格〔2023〕481号';
const REF_421 = '黔发改价格〔2026〕421号';

/** 卡 1：储能套利——谷充峰放，每日一充一放 */
function essArbitrageCard(date: string): StrategyCard {
  const cap = fixture.ess.totalCapacityKwh as number; // 860
  const eff = 0.9; // 往返效率（策略测算口径）
  const delta = r2(cap * (PEAK_PRICE - VALLEY_PRICE) * eff);
  return {
    id: `STRATEGY-${date.replaceAll('-', '')}-01`,
    mode: 'ess_arbitrage',
    title: '谷段充电、峰段放电',
    description: `谷段 0-8 时以 ≤400kW 充满 860kWh，峰段（10-13、17-22 时）放出，赚取峰谷价差，日收益约 ${delta} 元。`,
    window: [
      { from: '00:00', to: '08:00', action: 'charge 400kW' },
      { from: '10:00', to: '13:00', action: 'discharge 400kW' },
      { from: '17:00', to: '22:00', action: 'discharge 400kW' },
    ],
    deltaYuan: delta,
    basis: {
      calc: `${cap}kWh × (${PEAK_PRICE} - ${VALLEY_PRICE}) 元/kWh × 效率${eff} = ${delta} 元/日`,
      inputs: { capacityKwh: cap, peakPriceYuanKwh: PEAK_PRICE, valleyPriceYuanKwh: VALLEY_PRICE, roundTripEfficiency: eff },
      policyRef: [REF_481],
      dataRef: [`/api/tariff?date=${date}`],
      packVersion: policyPack.id,
    },
    truth: 'MODELED',
  };
}

/** 卡 2：充电桩转移——9-17 窗口整体平移到谷段 0-8 */
function evShiftCard(date: string): StrategyCard {
  const base = evDailyEnergyKwh(date, 'base');
  const shifted = evDailyEnergyKwh(date, 'shifted');
  const segments = tariffSegments();
  // 原窗口能量加权均价（逐时充电能量 × 逐时到户价）
  const weighted = base.hourlyKwh.reduce((s, kwh, h) => s + kwh * segments[h].priceYuanKwh, 0);
  const origAvg = base.totalKwh > 0 ? weighted / base.totalKwh : FLAT_PRICE;
  const delta = r2(shifted.totalKwh * (r3(origAvg) - VALLEY_PRICE));
  const fleet = evFleetPlan(date);
  const fleetStr = fleet.map((f) => `${f.chargerId} ${f.demandKwh}kWh`).join(' + ');
  return {
    id: `STRATEGY-${date.replaceAll('-', '')}-02`,
    mode: 'ev_shift',
    title: '充电负荷转移到谷段',
    description: `今日 ${fleet.length} 辆车共需 ${shifted.totalKwh}kWh，从 9-17 时窗口（加权均价 ${r3(origAvg)} 元/kWh）平移到谷段 0-8 时（${VALLEY_PRICE} 元/kWh），日省约 ${delta} 元。`,
    window: [{ from: '00:00', to: '08:00', action: `charge ${shifted.totalKwh}kWh（原 9-17 窗口平移）` }],
    deltaYuan: delta,
    basis: {
      calc: `充电量 ${shifted.totalKwh}kWh（${fleetStr}）× (原窗口加权均价 ${r3(origAvg)} - 谷段 ${VALLEY_PRICE}) 元/kWh = ${delta} 元/日`,
      inputs: { energyKwh: shifted.totalKwh, originalAvgPriceYuanKwh: r3(origAvg), shiftedPriceYuanKwh: VALLEY_PRICE },
      policyRef: [REF_481],
      dataRef: [
        `/api/tariff?date=${date}`,
        `/api/load/profile?nodeId=EV-01&date=${date}`,
        `/api/load/profile?nodeId=EV-01&date=${date}&window=shifted`,
        `/api/load/forecast?date=${date}`,
      ],
      packVersion: policyPack.id,
    },
    truth: 'MODELED',
  };
}

/** 卡 3：需量控制——储能削峰 3%，降低两部制需量电费 */
function demandControlCard(date: string): StrategyCard {
  const maxDemand = r3(parkMaxDemandKw(date));
  const target = r3(maxDemand * 0.97); // 削峰目标：-3%（储能 400kW 足以覆盖）
  const shaved = r3(maxDemand - target);
  const monthly = r2(shaved * DEMAND_PRICE);
  const daily = r2(monthly / 30);
  return {
    id: `STRATEGY-${date.replaceAll('-', '')}-03`,
    mode: 'demand_control',
    title: '最大需量削减',
    description: `今日最大需量 ${maxDemand}kW，储能在需量峰值 15 分钟放电削到 ${target}kW（削 ${shaved}kW），需量电费月省 ${monthly} 元（≈${daily} 元/日）。`,
    window: [{ from: '13:00', to: '14:00', action: `discharge ${shaved}kW（需量峰值时刻放电，按当日曲线自动跟踪）` }],
    deltaYuan: daily,
    basis: {
      calc: `(${maxDemand} - ${target}) kW × ${DEMAND_PRICE} 元/kW·月 = ${monthly} 元/月 ÷ 30 = ${daily} 元/日（需量电价见 ${REF_421}）`,
      inputs: { maxDemandKw: maxDemand, targetDemandKw: target, shavedKw: shaved, demandPriceYuanKwMonth: DEMAND_PRICE, monthlySavingYuan: monthly },
      policyRef: [REF_421],
      dataRef: [`/api/load/profile?nodeId=PARK-01&date=${date}`],
      packVersion: policyPack.id,
    },
    truth: 'MODELED',
  };
}

/** 卡 4：防逆流——午间光伏富余转存储能，避免低价上网（对照：市场化上网按代理购电价近似） */
async function curtailmentGuardCard(date: string): Promise<StrategyCard> {
  const balance = await balanceDaily(date);
  // 富余 = 逐时 max(0, pv - load)（储能基线调度不含午间充电，富余即上网电量）
  const surplusKwh = r3(balance.reduce((s, row) => s + Math.max(0, row.pvKw - row.loadKw), 0));
  const eff = 0.9;
  const spread = r3(PEAK_PRICE * eff - FEED_IN_PRICE); // 存储能晚峰自用 vs 直接上网 的价差
  const delta = r2(surplusKwh * spread);
  const noSurplus = surplusKwh < 1;
  return {
    id: `STRATEGY-${date.replaceAll('-', '')}-04`,
    mode: 'curtailment_guard',
    title: '防逆流与富余消纳',
    description: noSurplus
      ? `今日光伏无显著富余（富余 ${surplusKwh}kWh），防逆流未触发；保持现行调度即可。`
      : `午间光伏富余 ${surplusKwh}kWh（现按约 ${FEED_IN_PRICE} 元/kWh 低价上网），转存储能晚峰自用（价值 ${r3(PEAK_PRICE * eff)} 元/kWh），日增收约 ${delta} 元。`,
    window: [{ from: '11:00', to: '14:00', action: noSurplus ? 'observe（无富余）' : `charge ${surplusKwh}kWh（消纳午间富余，17-22 时放出）` }],
    deltaYuan: delta,
    basis: {
      calc: `富余 ${surplusKwh}kWh × (峰价 ${PEAK_PRICE} × 效率 ${eff} - 上网参考 ${FEED_IN_PRICE}) 元/kWh = ${surplusKwh} × ${spread} = ${delta} 元/日`,
      inputs: { surplusKwh, peakPriceYuanKwh: PEAK_PRICE, roundTripEfficiency: eff, feedInPriceYuanKwh: FEED_IN_PRICE, spreadYuanKwh: spread },
      policyRef: [REF_481, '发改价格〔2025〕136号（上网电价市场化，上网收益按代理购电价样本近似）'],
      dataRef: [`/api/load/balance?date=${date}`, `/api/tariff?date=${date}`],
      packVersion: policyPack.id,
    },
    truth: 'MODELED',
  };
}

/** 当日策略卡数组（确定性，顺序固定） */
export async function strategyCards(date: string): Promise<StrategyCard[]> {
  return [essArbitrageCard(date), evShiftCard(date), demandControlCard(date), await curtailmentGuardCard(date)];
}
