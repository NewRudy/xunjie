// 月度报告（合同 engine-io.md §8）：JSON 数据，非 LLM 文本
// - 按屋顶/楼栋分账：各 PV 子阵发电量、自用电量、上网电量、收益（对照 POLICY 电价）
// - 储能套利收益、充电桩转移收益、需量控制估算
// - 异常与运维：事件数、闭环率、平均闭环时长、挽回电量
// 每行数字带 truth 与 basis；LLM 层只能在此 JSON 之上生成叙事。
import { fixture } from './fixture';
import { actualSeries, expectedSeries, totalParkKwp } from './generation';
import { balanceDaily } from './balance';
import { evDailyEnergyKwh, parkMaxDemandKw } from './load';
import { essScheduleHourly } from './ess';
import { FEED_IN_PRICE, PEAK_PRICE, VALLEY_PRICE, DEMAND_PRICE, policyPack, tariffSegments } from './tariff';
import { getAnomalyState } from './anomalyState';
import { dateRange, r2, r3, todayShanghai } from './util';

interface Money {
  value: number;
  truth: string;
  basis: string;
}

/** 月度报告主函数；month=YYYY-MM，当月只统计到今天（daysCovered 注明） */
export async function monthlyReport(month: string) {
  const today = todayShanghai();
  const monthEnd = `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
  const lastDay = monthEnd < today ? monthEnd : today; // 当月截至今天
  const days = dateRange(`${month}-01`, lastDay);
  const segments = tariffSegments();

  // —— 逐日聚合：园区发电量/自用/上网/收益、储能收益、EV 转移收益 ——
  let parkExpected = 0;
  let parkActual = 0;
  let parkSelfUse = 0;
  let parkExport = 0;
  let parkSelfUseRevenue = 0;
  let essRevenue = 0;
  let evShiftRevenue = 0;
  const ess = essScheduleHourly();
  const perArray = new Map<string, { generationKwh: number }>();
  for (const arr of fixture.pvArrays) perArray.set(arr.id, { generationKwh: 0 });

  for (const day of days) {
    const exp = await expectedSeries('PARK-01', day);
    const act = await actualSeries('PARK-01', day);
    const bal = await balanceDaily(day);
    parkExpected += exp?.totalKwh ?? 0;
    parkActual += act?.totalKwh ?? 0;
    bal.forEach((row, h) => {
      const su = Math.min(row.pvKw, row.loadKw);
      parkSelfUse += su;
      parkExport += Math.max(0, row.pvKw - row.loadKw);
      parkSelfUseRevenue += su * segments[h].priceYuanKwh;
      essRevenue += row.essKw * segments[h].priceYuanKwh; // 放电收益 - 充电成本（kw 带符号，负值即充电成本）
    });
    // EV 转移收益：每日车队全部电量 × (原窗口加权均价 - 谷价)
    const base = evDailyEnergyKwh(day, 'base');
    if (base.totalKwh > 0) {
      const weighted = base.hourlyKwh.reduce((s, kwh, h) => s + kwh * segments[h].priceYuanKwh, 0);
      evShiftRevenue += base.totalKwh * (weighted / base.totalKwh - VALLEY_PRICE);
    }
    for (const arr of fixture.pvArrays) {
      const a = await actualSeries(arr.id, day);
      perArray.get(arr.id)!.generationKwh += a?.totalKwh ?? 0;
    }
  }

  const exportRevenue = parkExport * FEED_IN_PRICE;
  const parkRevenue = parkSelfUseRevenue + exportRevenue;

  // —— 按屋顶分账：自用/上网按各阵发电量占比分摊（分摊规则见 basis） ——
  const byArray = fixture.pvArrays.map((arr) => {
    const gen = perArray.get(arr.id)!.generationKwh;
    const share = parkActual > 0 ? gen / parkActual : 0;
    const selfUseKwh = parkSelfUse * share;
    const exportKwh = parkExport * share;
    const revenue = parkRevenue * share;
    return {
      pvArrayId: arr.id,
      roofId: arr.roofId ?? '车棚',
      capacityKwp: arr.peakKwp,
      generationKwh: r3(gen),
      selfUseKwh: r3(selfUseKwh),
      exportKwh: r3(exportKwh),
      revenueYuan: r2(revenue),
      truth: 'SIMULATED',
      basis: `发电量为引擎逐日实发累计；自用/上网按本阵发电占比 ${r2(share * 100)}% 分摊园区口径；收益 = 自用×分时到户价 + 上网×${FEED_IN_PRICE}（${policyPack.proxyPurchasePrice.policyRef}，上网参考）`,
    };
  });

  // —— 需量控制估算：当月最大需量 × 削峰 3% × 需量电价 ——
  let monthMaxDemand = 0;
  for (const day of days) monthMaxDemand = Math.max(monthMaxDemand, parkMaxDemandKw(day));
  const shavedKw = r3(monthMaxDemand * 0.03);
  const demandSaving = r2(shavedKw * DEMAND_PRICE);

  // —— 异常与运维闭环 ——
  const anomaly = getAnomalyState();
  const inMonth = anomaly.detectedAt.slice(0, 7) <= month && month <= (anomaly.closedAt?.slice(0, 7) ?? '9999-12');
  const closureHours = anomaly.closedAt ? (Date.parse(anomaly.closedAt) - Date.parse(anomaly.detectedAt)) / 3600000 : null;
  // 损失电量：闭环时已固化为 lossKwhTotal；未闭环则按当月逐日组串损失累计
  let lossKwh = anomaly.lossKwhTotal ?? 0;
  if (anomaly.status === 'open' && inMonth) {
    lossKwh = 0;
    for (const day of days) {
      const exp = await expectedSeries(anomaly.nodeId, day);
      const act = await actualSeries(anomaly.nodeId, day);
      lossKwh += Math.max(0, (exp?.totalKwh ?? 0) - (act?.totalKwh ?? 0));
    }
  }

  return {
    month,
    daysCovered: days.length,
    note: monthEnd > today ? '当月报告，统计至今天' : '整月报告',
    park: {
      capacityKwp: totalParkKwp(),
      expectedKwh: r3(parkExpected),
      actualKwh: r3(parkActual),
      achievementPct: parkExpected > 0 ? r2((parkActual / parkExpected) * 100) : 0,
      selfUseKwh: r3(parkSelfUse),
      exportKwh: r3(parkExport),
      selfUseRatioPct: parkActual > 0 ? r2((parkSelfUse / parkActual) * 100) : 0,
      revenueYuan: r2(parkRevenue),
      truth: 'SIMULATED',
      basis: `自用收益 = Σ逐时 min(pv,load)×分时到户价（${r2(parkSelfUseRevenue)} 元）；上网收益 = ${r3(parkExport)}kWh × ${FEED_IN_PRICE} 元/kWh（代理购电价样本近似，${policyPack.feedInReference.policyRef}）`,
    },
    byArray,
    ess: {
      arbitrageRevenueYuan: r2(essRevenue),
      chargeKwh: r3(-ess.filter((h) => h.kw < 0).reduce((s, h) => s + h.kw, 0) * days.length),
      dischargeKwh: r3(ess.filter((h) => h.kw > 0).reduce((s, h) => s + h.kw, 0) * days.length),
      truth: 'MODELED',
      basis: `Σ逐日（放电电量×放电工况分时价 - 充电电量×谷价），基线谷充峰放调度 × ${days.length} 天；时段价见 /api/tariff`,
      policyRef: ['黔发改价格〔2023〕481号'],
    },
    ev: {
      shiftRevenueYuan: r2(evShiftRevenue),
      truth: 'MODELED',
      basis: `Σ逐日 车队充电量×(原9-17时窗口加权均价 - 谷段${VALLEY_PRICE})；详见 /api/strategy 的 ev_shift 卡`,
      policyRef: ['黔发改价格〔2023〕481号'],
    },
    demand: {
      monthMaxDemandKw: r3(monthMaxDemand),
      controlEstimateYuan: demandSaving,
      truth: 'MODELED',
      basis: `当月最大需量 ${r3(monthMaxDemand)}kW × 削峰3% = ${shavedKw}kW × ${DEMAND_PRICE} 元/kW·月（黔发改价格〔2026〕421号）`,
      policyRef: ['黔发改价格〔2026〕421号'],
    },
    anomalies: {
      events: inMonth ? 1 : 0,
      closed: anomaly.status === 'resolved' && inMonth ? 1 : 0,
      closureRatePct: inMonth ? (anomaly.status === 'resolved' ? 100 : 0) : null,
      avgClosureHours: closureHours !== null ? r2(closureHours) : null,
      lossKwh: r3(lossKwh),
      recoveredKwh: anomaly.status === 'resolved' ? r3(lossKwh) : 0,
      truth: 'SIMULATED',
      basis: '损失电量 = 异常注入期间 Σ(组串应发-实发)；闭环后实发恢复，损失视为挽回（验收 P4-4）',
    },
    policyPack: policyPack.id,
    generatedBy: 'pecc-engine（确定性代码，无 LLM 数字）',
  };
}
