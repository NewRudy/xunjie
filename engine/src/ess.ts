// 储能基线调度（SIMULATED 规则调度，确定性）
// 基线策略 = 谷充峰放（与策略卡 ess_arbitrage 同逻辑，视为园区现行运行方式）：
//   充电：谷段 0-8 时，≤400kW，充满 860kWh 为止；
//   放电：峰段 10-13 / 17-22 时，两个窗口各预算 430kWh（午间/晚间均匀覆盖），≤400kW。
// 日初 SOC 固定 20%（确定性初值）。功率约定：正=放电，负=充电（合同 engine-io.md §4）。
import { fixture } from './fixture';
import { r3 } from './util';

const TOTAL_KW = fixture.ess.totalRatedKw as number; // 400
const TOTAL_KWH = fixture.ess.totalCapacityKwh as number; // 860
const START_SOC_KWH = TOTAL_KWH * 0.2;
const CHARGE_HOURS = new Set([0, 1, 2, 3, 4, 5, 6, 7]); // 谷段 0-8
const DISCHARGE_WINDOWS: { hours: Set<number>; budgetKwh: number }[] = [
  { hours: new Set([10, 11, 12]), budgetKwh: TOTAL_KWH / 2 }, // 午间峰
  { hours: new Set([17, 18, 19, 20, 21]), budgetKwh: TOTAL_KWH / 2 }, // 晚间峰
];

export interface EssHour {
  hour: number;
  kw: number; // 正放负充
  socKwh: number; // 该小时末 SOC
}

/** 逐时储能调度（24 点，确定性） */
export function essScheduleHourly(): EssHour[] {
  let soc = START_SOC_KWH;
  const windowUsed = DISCHARGE_WINDOWS.map(() => 0); // 各放电窗口已放电量
  const out: EssHour[] = [];
  for (let h = 0; h < 24; h++) {
    let kw = 0;
    if (CHARGE_HOURS.has(h)) {
      kw = -Math.min(TOTAL_KW, TOTAL_KWH - soc); // 1 小时桶：kW 数值即 kWh
    } else {
      const wi = DISCHARGE_WINDOWS.findIndex((w) => w.hours.has(h));
      if (wi >= 0) {
        kw = Math.min(TOTAL_KW, soc, DISCHARGE_WINDOWS[wi].budgetKwh - windowUsed[wi]);
        windowUsed[wi] += kw;
      }
    }
    soc = Math.min(TOTAL_KWH, Math.max(0, soc - kw)); // 放电 kw>0 → SOC 下降
    out.push({ hour: h, kw: r3(kw), socKwh: r3(soc) });
  }
  return out;
}

/** 储能当日充/放电量合计（语义卡与月报用） */
export function essDailyTotals(): { chargeKwh: number; dischargeKwh: number } {
  const sched = essScheduleHourly();
  return {
    chargeKwh: r3(-sched.filter((h) => h.kw < 0).reduce((s, h) => s + h.kw, 0)),
    dischargeKwh: r3(sched.filter((h) => h.kw > 0).reduce((s, h) => s + h.kw, 0)),
  };
}
