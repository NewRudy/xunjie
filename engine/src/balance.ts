// 逐时发用电平衡（合同 engine-io.md §4）
// pvKw + essKw + gridKw == loadKw 逐时闭合（gridKw 为残差，天然闭合）；
// gridKw>0 购电、<0 上网；essKw 正放负充。行级 truth：SIMULATED（实发/负荷/储能均为仿真）。
import { actualSeries } from './generation';
import { essScheduleHourly } from './ess';
import { parkLoadHourly } from './load';
import { r3 } from './util';

export interface BalanceRow {
  ts: string;
  pvKw: number;
  loadKw: number;
  essKw: number;
  gridKw: number;
  socKwh: number; // 附加字段：该小时末储能 SOC（UI 能量流用）
  truth: 'SIMULATED';
}

export async function balanceDaily(date: string): Promise<BalanceRow[]> {
  const pv = await actualSeries('PARK-01', date);
  if (!pv) throw new Error('园区发电序列不可用');
  const load = parkLoadHourly(date);
  const ess = essScheduleHourly();
  return ess.map((e, h) => {
    const pvKw = pv.hourly[h].actualKwh; // 1 小时桶：kWh 数值 = 平均 kW
    const loadKw = load[h];
    const gridKw = loadKw - pvKw - e.kw; // 残差 → 逐时天然闭合
    return {
      ts: pv.hourly[h].ts,
      pvKw: r3(pvKw),
      loadKw: r3(loadKw),
      essKw: e.kw,
      gridKw: r3(gridKw),
      socKwh: e.socKwh,
      truth: 'SIMULATED' as const,
    };
  });
}
