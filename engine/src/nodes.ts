// 节点语义卡与园区实时状态（合同 engine-io.md §1 + semantic-tree.md §2）
// 语义卡必填字段按设备类型给齐；fixture 未提供的字段（投运日期、逆变器效率、组串电气参数）
// 为引擎假定值，随 truth: SIMULATED 一并标注，不冒充实测。
import { fixture, getNode, nodeRegistry, pvArrayOfNode, type NodeInfo } from './fixture';
import { actualSeries, expectedSeries } from './generation';
import { getAnomalyState } from './anomalyState';
import { balanceDaily } from './balance';
import { essDailyTotals, essScheduleHourly } from './ess';
import { loadProfile15, parkMaxDemandKw } from './load';
import { getWeatherDay } from './weather';
import { periodOfHour, policyPack } from './tariff';
import { addDays, nowShanghaiHHMM, r2, r3, todayShanghai } from './util';

/** 设备状态机五态（semantic-tree.md §3）；演示异常注入期间 STR-B2-07 / INV-B-02 为 degraded */
export function deviceStatus(nodeId: string): 'normal' | 'degraded' | 'fault' | 'offline' | 'maintenance' {
  const anomaly = getAnomalyState();
  if (anomaly.status === 'open' && (nodeId === anomaly.nodeId || nodeId === 'INV-B-02')) return 'degraded';
  return 'normal';
}

/** 当前实时功率（kW，SIMULATED）：取当日当前小时/15 分钟桶 */
export async function livePowerKw(nodeId: string): Promise<number> {
  const today = todayShanghai();
  const { hour, minute } = nowShanghaiHHMM();
  const bucket = hour * 4 + Math.floor(minute / 15);
  const node = getNode(nodeId);
  if (!node) return 0;
  switch (node.type) {
    case 'pvArray':
    case 'inverter':
    case 'string': {
      const act = await actualSeries(nodeId, today);
      return act ? r3(act.hourly[hour].actualKwh) : 0; // 1 小时桶 kWh ≈ 平均 kW
    }
    case 'building': {
      const meterId = node.raw.subMeterId;
      return meterId ? r3(loadProfile15(meterId, today)[bucket].kw) : 0;
    }
    case 'meter': {
      if (nodeId === 'MT-01') {
        const bal = await balanceDaily(today);
        return r3(bal[hour].gridKw);
      }
      return r3(loadProfile15(nodeId, today)[bucket].kw);
    }
    case 'charger':
      return r3(loadProfile15(nodeId, today)[bucket].kw);
    case 'ess':
      return essScheduleHourly()[hour].kw;
    case 'essCabinet':
      return r3(essScheduleHourly()[hour].kw / 2); // 两柜均分
    case 'transformer':
      return r3(loadProfile15('PARK-01', today)[bucket].kw);
    case 'park':
      return r3(loadProfile15('PARK-01', today)[bucket].kw);
    default:
      return 0; // 屋顶/并网箱/气象仪/运维点/检查点无功率
  }
}

/** 节点当日摘要（发电/用电） */
async function todaySummary(node: NodeInfo): Promise<Record<string, unknown>> {
  const today = todayShanghai();
  switch (node.type) {
    case 'pvArray':
    case 'inverter':
    case 'string': {
      const act = await actualSeries(node.id, today);
      if (!act) return {};
      return {
        date: today,
        expectedKwh: act.expectedTotalKwh,
        actualKwh: act.totalKwh,
        achievementPct: act.expectedTotalKwh > 0 ? r2((act.totalKwh / act.expectedTotalKwh) * 100) : 0,
        truth: 'SIMULATED',
      };
    }
    case 'building': {
      const meterId = node.raw.subMeterId;
      const kwh = meterId ? r3(loadProfile15(meterId, today).reduce((s, p) => s + p.kw * 0.25, 0)) : 0;
      const arr = pvArrayOfNode(node.id);
      const gen = arr ? await actualSeries(arr.id, today) : null;
      return {
        date: today,
        loadKwh: kwh,
        pvArrayId: arr?.id ?? null,
        generationKwh: gen ? gen.totalKwh : null,
        truth: 'SIMULATED',
      };
    }
    case 'meter': {
      if (node.id === 'MT-01') {
        const bal = await balanceDaily(today);
        const seg = { peak: 0, flat: 0, valley: 0 };
        let importKwh = 0;
        let exportKwh = 0;
        bal.forEach((row, h) => {
          if (row.gridKw > 0) {
            importKwh += row.gridKw;
            seg[periodOfHour(h)] += row.gridKw;
          } else exportKwh += -row.gridKw;
        });
        return {
          date: today,
          importKwh: r3(importKwh),
          exportKwh: r3(exportKwh),
          byPeriodKwh: { peak: r3(seg.peak), flat: r3(seg.flat), valley: r3(seg.valley) },
          truth: 'SIMULATED',
        };
      }
      const kwh = r3(loadProfile15(node.id, today).reduce((s, p) => s + p.kw * 0.25, 0));
      return { date: today, loadKwh: kwh, truth: 'SIMULATED' };
    }
    case 'charger': {
      const profile = loadProfile15(node.id, today);
      return {
        date: today,
        chargeKwh: r3(profile.reduce((s, p) => s + p.kw * 0.25, 0)),
        charging: profile.some((p) => p.kw > 1),
        truth: 'SIMULATED',
      };
    }
    case 'ess':
    case 'essCabinet': {
      const t = essDailyTotals();
      const sched = essScheduleHourly();
      const scale = node.type === 'essCabinet' ? 0.5 : 1;
      return {
        date: today,
        chargeKwh: r3(t.chargeKwh * scale),
        dischargeKwh: r3(t.dischargeKwh * scale),
        socKwh: sched[nowShanghaiHHMM().hour].socKwh,
        strategyMode: 'ess_arbitrage（谷充峰放）',
        truth: 'SIMULATED',
      };
    }
    case 'transformer': {
      const todayDemand = parkMaxDemandKw(today);
      // 当月最大需量：月内逐日 15 分钟口径最大值（纯函数，确定性）
      let monthDemand = 0;
      for (let d = `${today.slice(0, 7)}-01`; d <= today; d = addDays(d, 1)) {
        monthDemand = Math.max(monthDemand, parkMaxDemandKw(d));
      }
      const { hour, minute } = nowShanghaiHHMM();
      const loadNow = loadProfile15('PARK-01', today)[hour * 4 + Math.floor(minute / 15)].kw;
      return {
        date: today,
        capacityKva: node.raw.capacityKva,
        loadRatePct: r2((loadNow / node.raw.capacityKva) * 100),
        todayMaxDemandKw: r3(todayDemand),
        monthMaxDemandKw: r3(monthDemand),
        truth: 'SIMULATED',
      };
    }
    case 'weatherStation': {
      const w = await getWeatherDay(today);
      const { hour } = nowShanghaiHHMM();
      return {
        date: today,
        ghiWm2: w.hours[hour].ghi,
        tempC: w.hours[hour].temp,
        source: w.meta.source,
        synthetic: w.meta.synthetic,
        truth: 'MODELED',
      };
    }
    case 'park': {
      const act = await actualSeries('PARK-01', today);
      const loadKwh = r3(loadProfile15('PARK-01', today).reduce((s, p) => s + p.kw * 0.25, 0));
      return {
        date: today,
        expectedKwh: act?.expectedTotalKwh ?? 0,
        actualKwh: act?.totalKwh ?? 0,
        loadKwh,
        truth: 'SIMULATED',
      };
    }
    default:
      return { date: today };
  }
}

/** 类型中文名（语义卡展示用） */
const TYPE_NAME: Record<string, string> = {
  park: '园区', building: '楼栋', roof: '屋顶', pvArray: '光伏子阵', inverter: '逆变器',
  string: '组串', junctionBox: '并网箱', ess: '储能系统', essCabinet: '储能柜', charger: '充电桩',
  transformer: '箱变', meter: '电表', weatherStation: '环境监测仪', opsPoint: '运维点', checkpoint: '巡检检查点',
};

/** 单节点详情（合同 GET /api/node/{nodeId}）：语义卡 + 状态 + 当日摘要 + 子节点 */
export async function nodeDetail(nodeId: string): Promise<Record<string, unknown> | null> {
  const node = getNode(nodeId);
  if (!node) return null;
  const status = deviceStatus(nodeId);
  const live = await livePowerKw(nodeId);
  const raw = node.raw as any;
  // 语义卡：必填字段按 semantic-tree.md §2 给齐；假定字段显式标注 assumed: true
  let semanticCard: Record<string, unknown> = { type: node.type, typeName: TYPE_NAME[node.type] };
  switch (node.type) {
    case 'pvArray': {
      const selfUse = await selfUseRatioToday();
      semanticCard = {
        ...semanticCard,
        name: raw.carport ? '光伏车棚子阵' : `屋顶子阵（${raw.roofId}）`,
        capacityKwp: raw.peakKwp,
        panelCount: raw.panelCount,
        tiltDeg: raw.tiltDeg,
        azimuthDeg: raw.azimuthDeg,
        commissioningDate: '2024-06-01',
        selfUseRatioPct: selfUse,
        assumed: { commissioningDate: true }, // fixture 未提供投运日期，引擎假定
      };
      break;
    }
    case 'inverter': {
      const act = await actualSeries(nodeId, todayShanghai());
      semanticCard = {
        ...semanticCard,
        model: raw.model,
        ratedKw: raw.ratedKw,
        stringCount: raw.stringCount,
        efficiencyPct: 98.6,
        todayKwh: act?.totalKwh ?? 0,
        assumed: { efficiencyPct: true }, // 华为 SUN2000 典型最大效率，假定值
      };
      break;
    }
    case 'string': {
      const act = await actualSeries(nodeId, todayShanghai());
      const { hour } = nowShanghaiHHMM();
      const powerW = (act?.hourly[hour].actualKwh ?? 0) * 1000;
      const voltageV = raw.panelCount * 41.8; // 550W 组件 Vmp≈41.8V（假定）
      const currentA = voltageV > 0 ? powerW / voltageV : 0;
      const expH = act?.hourly[hour].expectedKwh ?? 0;
      const actH = act?.hourly[hour].actualKwh ?? 0;
      semanticCard = {
        ...semanticCard,
        panelCount: raw.panelCount,
        inverterId: raw.inverterId,
        voltageV: r2(voltageV),
        currentA: r2(currentA),
        deviationPct: expH > 0 ? r2(((actH - expH) / expH) * 100) : 0,
        note: raw.note,
        assumed: { voltageV: true }, // 组串电气参数为仿真推导
      };
      break;
    }
    case 'ess':
      semanticCard = { ...semanticCard, totalRatedKw: raw.totalRatedKw, totalCapacityKwh: raw.totalCapacityKwh, cabinets: raw.cabinets.map((c: any) => c.id) };
      break;
    case 'essCabinet':
      semanticCard = { ...semanticCard, ratedKw: raw.ratedKw, capacityKwh: raw.capacityKwh };
      break;
    case 'charger':
      semanticCard = { ...semanticCard, ratedKw: raw.ratedKw, state: (await livePowerKw(nodeId)) > 1 ? '充电中' : '空闲' };
      break;
    case 'transformer':
      semanticCard = { ...semanticCard, capacityKva: raw.capacityKva, note: raw.note };
      break;
    case 'meter':
      semanticCard = { ...semanticCard, note: raw.note ?? `分项电表（${raw.buildingId}）`, bidirectional: nodeId === 'MT-01' };
      break;
    case 'building':
      semanticCard = { ...semanticCard, name: raw.name, kind: raw.kind, floors: raw.floors, loadType: raw.loadType, subMeterId: raw.subMeterId };
      break;
    case 'roof':
      semanticCard = { ...semanticCard, buildingId: raw.buildingId, tiltDeg: raw.tiltDeg, azimuthDeg: raw.azimuthDeg, usableRatio: raw.usableRatio, pvArrayId: raw.pvArrayId, expansionCandidate: raw.expansionCandidate ?? false };
      break;
    case 'checkpoint':
      semanticCard = { ...semanticCard, nodeId: raw.nodeId, kind: raw.kind };
      break;
    case 'park':
      semanticCard = { ...semanticCard, name: fixture.name, fictional: fixture.fictional, prototypeNote: fixture.prototypeNote, gridConnection: fixture.gridConnection };
      break;
    default:
      semanticCard = { ...semanticCard, ...raw };
  }
  return {
    id: nodeId,
    type: node.type,
    typeName: TYPE_NAME[node.type],
    parentId: node.parentId,
    children: node.children,
    status,
    livePowerKw: live,
    liveTruth: 'SIMULATED',
    semanticCard,
    today: await todaySummary(node),
  };
}

/** 园区当日自用比例（%）：Σmin(pv,load) / Σpv */
async function selfUseRatioToday(): Promise<number> {
  const bal = await balanceDaily(todayShanghai());
  const pv = bal.reduce((s, r) => s + r.pvKw, 0);
  if (pv <= 0) return 0;
  const selfUse = bal.reduce((s, r) => s + Math.min(r.pvKw, r.loadKw), 0);
  return r2((selfUse / pv) * 100);
}

/** GET /api/park：fixture 原样透传 + 每台设备附加 status / livePowerKw（SIMULATED） */
export async function parkWithLive(): Promise<Record<string, unknown>> {
  const clone = JSON.parse(JSON.stringify(fixture)) as any;
  // 预取全部节点实时状态
  const liveMap: Record<string, { status: string; livePowerKw: number; liveTruth: string }> = {};
  for (const id of nodeRegistry.keys()) {
    const node = getNode(id)!;
    if (node.type === 'checkpoint' || node.type === 'opsPoint') {
      liveMap[id] = { status: 'normal', livePowerKw: 0, liveTruth: 'SIMULATED' };
      continue;
    }
    liveMap[id] = { status: deviceStatus(id), livePowerKw: await livePowerKw(id), liveTruth: 'SIMULATED' };
  }
  // 深度遍历克隆体：凡带 id 且命中注册表的对象，附加实时字段
  const walk = (obj: any): void => {
    if (!obj || typeof obj !== 'object') return;
    if (typeof obj.id === 'string' && liveMap[obj.id]) Object.assign(obj, liveMap[obj.id]);
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(clone);
  clone.engine = {
    policyVersion: policyPack.id,
    note: 'status/livePowerKw 为引擎附加实时字段（SIMULATED）；fixture 其余字段原样透传',
  };
  return clone;
}
