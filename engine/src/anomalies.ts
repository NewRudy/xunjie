// 异常事件（合同 engine-io.md §6）：demo 异常 STR-B2-07 组串电流偏低 18%（fixture demoAnomaly）
// evidence 由确定性代码按当日气象/发电模型计算：偏差率、损失电量、损失金额（元/天）。
import { getAnomalyState } from './anomalyState';
import { actualSeries, expectedSeries } from './generation';
import { getWeatherDay } from './weather';
import { FLAT_PRICE } from './tariff';
import { r2, r3 } from './util';

export interface AnomalyView {
  id: string;
  nodeId: string;
  type: string;
  detectedAt: string;
  severity: 'high' | 'medium' | 'low';
  evidence: {
    date: string;
    ghiPeakWm2: number;
    expectedKwh: number; // 目标组串当日应发
    actualKwh: number; // 目标组串当日实发
    deviationPct: number; // 偏差率（%）
    lossKwh: number; // 当日损失电量
    lossYuanPerDay: number; // 损失折算（按平段到户价）
    suspected: string;
  };
  status: 'open' | 'resolved';
  closedAt: string | null;
  requiresRoofEvidence: boolean; // 屋面类异常：resolve 需 CP-xxx-ROOF 证据
  truth: 'SIMULATED';
}

/** 当日异常事件数组（status=open|all） */
export async function listAnomalies(date: string, status: 'open' | 'all'): Promise<AnomalyView[]> {
  const state = getAnomalyState();
  if (status === 'open' && state.status !== 'open') return [];
  const exp = await expectedSeries(state.nodeId, date);
  const act = await actualSeries(state.nodeId, date);
  const weather = await getWeatherDay(date);
  const expectedKwh = exp?.totalKwh ?? 0;
  const actualKwh = act?.totalKwh ?? 0;
  const lossKwh = Math.max(0, expectedKwh - actualKwh);
  return [
    {
      id: state.id,
      nodeId: state.nodeId,
      type: state.type,
      detectedAt: state.detectedAt,
      severity: 'high',
      evidence: {
        date,
        ghiPeakWm2: r2(Math.max(...weather.hours.map((h) => h.ghi))),
        expectedKwh: r3(expectedKwh),
        actualKwh: r3(actualKwh),
        deviationPct: expectedKwh > 0 ? r2(((actualKwh - expectedKwh) / expectedKwh) * 100) : 0,
        lossKwh: r3(lossKwh),
        lossYuanPerDay: r2(lossKwh * FLAT_PRICE),
        suspected: state.suspected,
      },
      status: state.status,
      closedAt: state.closedAt,
      requiresRoofEvidence: true, // STR-B2-07 位于 PV-B02-A 屋面，需 CP-B02-ROOF 证据
      truth: 'SIMULATED',
    },
  ];
}
