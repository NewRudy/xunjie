// 演示异常注入状态（SQLite kv 持久化）
// 规则（合同 data-contracts.md §4）：fixture demoAnomaly 定义 STR-B2-07 在 ghi>200 时段电流 -18%；
// 巡检任务 close 后立即撤销注入，之后实发回到 ±2% 区间（验收 P4-4 依赖此条）。
import { kvGet, kvSet } from './db';
import { fixture } from './fixture';
import { todayShanghai } from './util';

export interface AnomalyState {
  id: string;
  nodeId: string; // 目标组串 STR-B2-07
  type: string;
  magnitude: number; // -0.18
  suspected: string;
  taskId: string;
  status: 'open' | 'resolved';
  detectedAt: string;
  closedAt: string | null;
  lossKwhTotal: number | null; // 闭环时固化的累计损失电量（闭环后实发恢复，历史损失靠此值入账）
}

const KEY = `anomaly:${fixture.demoAnomaly.id}`;

/** 读取（首次访问时按 fixture 定义注入，detectedAt 定死后持久化，保证确定性） */
export function getAnomalyState(): AnomalyState {
  const raw = kvGet(KEY);
  if (raw) return JSON.parse(raw) as AnomalyState;
  const demo = fixture.demoAnomaly;
  const state: AnomalyState = {
    id: demo.id,
    nodeId: demo.targetStringId,
    type: demo.type,
    magnitude: demo.magnitude,
    suspected: demo.suspected,
    taskId: demo.taskId,
    status: 'open',
    detectedAt: `${todayShanghai()}T08:00:00+08:00`,
    closedAt: null,
    lossKwhTotal: null,
  };
  kvSet(KEY, JSON.stringify(state));
  return state;
}

/** 闭环：撤销注入（之后所有实发查询回到 ±2% 区间），并固化累计损失电量 */
export function closeAnomaly(closedAt: string, lossKwhTotal: number): AnomalyState {
  const state = getAnomalyState();
  const next: AnomalyState = { ...state, status: 'resolved', closedAt, lossKwhTotal };
  kvSet(KEY, JSON.stringify(next));
  return next;
}

/** 演示复位（debug/reset 用）：重新注入异常 */
export function resetAnomaly(): void {
  const state = getAnomalyState();
  kvSet(KEY, JSON.stringify({ ...state, status: 'open' as const, closedAt: null, lossKwhTotal: null }));
}

/** 异常是否处于注入中（实发仿真器用） */
export const anomalyActive = (): boolean => getAnomalyState().status === 'open';
