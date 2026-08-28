// 电价模块（POLICY）：政策包是引擎唯一允许的电价来源（合同 data-contracts.md §2.3）
// 政策包：data/policy/gz-2026-08.json（按月版本化；字段变更必须 bump 月份版本）
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { r3 } from './util';

export interface PolicyPack {
  id: string;
  region: string;
  month: string;
  truth: 'POLICY';
  versionNote: string;
  twoPartTariff: {
    kv10: { energyYuanKwh: number; demandYuanKwMonth: number; capacityYuanKvaMonth: number };
    kv35: { energyYuanKwh: number; demandYuanKwMonth: number; capacityYuanKvaMonth: number };
    effectiveFrom: string;
    policyRef: string;
  };
  tou: {
    factors: { peak: number; flat: number; valley: number };
    periods: { peak: [number, number][]; flat: [number, number][]; valley: [number, number][] };
    floatBaseNote: string;
    surchargeYuanKwh: number;
    surchargeNote: string;
    policyRef: string;
  };
  proxyPurchasePrice: { valueYuanKwh: number; month: string; note: string; policyRef: string };
  derived: {
    floatBaseYuanKwh: number;
    floatBaseCalc: string;
    flatYuanKwh: number;
    peakYuanKwh: number;
    valleyYuanKwh: number;
    peakValleyDiffYuanKwh: number;
    calcNote: string;
  };
  feedInReference: { valueYuanKwh: number; note: string; policyRef: string };
  policyRefs: { id: string; title: string; excerpt: string; source: string }[];
}

const packPath = fileURLToPath(new URL('../../data/policy/gz-2026-08.json', import.meta.url));
export const policyPack: PolicyPack = JSON.parse(fs.readFileSync(packPath, 'utf8'));

export type Period = 'peak' | 'flat' | 'valley';

/** 小时 → 峰平谷时段（黔发改价格〔2023〕481号：峰 10-13/17-22，平 8-10/13-17/22-24，谷 0-8） */
export function periodOfHour(hour: number): Period {
  const { periods } = policyPack.tou;
  for (const p of ['peak', 'flat', 'valley'] as Period[]) {
    if (periods[p].some(([a, b]) => hour >= a && hour < b)) return p;
  }
  throw new Error(`小时 ${hour} 未落入任何时段（政策包 periods 配置不完整）`);
}

/** 时段 → 到户电价（元/kWh）：浮动基数 × 分时系数 + 基金附加（不浮动），三位小数 */
export function priceOfPeriod(period: Period): number {
  const { floatBaseYuanKwh } = policyPack.derived;
  const factor = policyPack.tou.factors[period];
  return r3(floatBaseYuanKwh * factor + policyPack.tou.surchargeYuanKwh);
}

export interface TariffSegment {
  hour: number;
  period: Period;
  priceYuanKwh: number;
  truth: 'POLICY';
}

/** 当日 24 段电价表（合同 engine-io.md §5） */
export function tariffSegments(): TariffSegment[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const period = periodOfHour(hour);
    return { hour, period, priceYuanKwh: priceOfPeriod(period), truth: 'POLICY' as const };
  });
}

/** 策略卡/报告引用的政策出处（文号 + 条款摘录 + 来源说明） */
export function policyRefFor(): { id: string; title: string; excerpt: string; source: string }[] {
  return policyPack.policyRefs;
}

export const PEAK_PRICE = priceOfPeriod('peak'); // 0.884
export const FLAT_PRICE = priceOfPeriod('flat'); // 0.562
export const VALLEY_PRICE = priceOfPeriod('valley'); // 0.240
export const FEED_IN_PRICE = policyPack.feedInReference.valueYuanKwh; // 0.388997（代理购电价样本近似）
export const DEMAND_PRICE = policyPack.twoPartTariff.kv10.demandYuanKwMonth; // 35 元/kW·月
