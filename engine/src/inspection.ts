// 巡检任务状态机（合同 engine-io.md §7 + semantic-tree.md §3）
// 状态链：created → dispatched → enroute → onsite → inspecting → evidence-submitted → resolved/escalated
// 强制规则：
//   - 非法跃迁一律 409（如未 dispatch 就 arrive_front）
//   - 屋面类异常 resolve 前必须有 CP-xxx-ROOF 检查点证据（否则 409）
//   - close：校验证据齐备 → resolved → 引擎立即撤销异常注入（实发曲线恢复，验收 P4-4 依赖）
// 每次迁移记录时间、操作人（演示期模拟操作人）、关联证据 ID。
import { db } from './db';
import { fixture, hasNode } from './fixture';
import { closeAnomaly, getAnomalyState } from './anomalyState';
import { nowIsoShanghai } from './util';

export type TaskStatus =
  | 'created' | 'dispatched' | 'enroute' | 'onsite' | 'inspecting'
  | 'evidence-submitted' | 'resolved' | 'escalated';

export interface Evidence {
  id: string;
  checkpointId: string;
  kind: 'photo' | 'thermal' | 'reading' | 'note';
  value: string;
  ts: string;
}

export interface Transition {
  from: TaskStatus | null;
  to: TaskStatus;
  event: string;
  ts: string;
  operator: string;
  evidenceIds: string[];
}

export interface InspectionTask {
  id: string;
  anomalyId: string;
  nodeId: string;
  assignee: string;
  status: TaskStatus;
  createdAt: string;
  closedAt: string | null;
  transitions: Transition[];
  evidence: Evidence[];
  anomalyResolved: boolean; // close 后引擎已撤销注入
}

// —— 持久化（SQLite） ——
function save(task: InspectionTask): void {
  db.prepare('INSERT OR REPLACE INTO inspection_tasks (id, data) VALUES (?, ?)').run(task.id, JSON.stringify(task));
}

export function getTask(id: string): InspectionTask | null {
  const row = db.prepare('SELECT data FROM inspection_tasks WHERE id = ?').get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as InspectionTask) : null;
}

/** 创建任务：同一异常已有未结任务时直接返回既有任务（幂等，演示友好） */
export function createTask(input: { anomalyId: string; nodeId: string; assignee?: string }): { task: InspectionTask; existed: boolean } | { error: string; code: number } {
  const anomaly = getAnomalyState();
  if (input.anomalyId !== anomaly.id) return { error: `未知异常 ${input.anomalyId}`, code: 404 };
  if (!hasNode(input.nodeId)) return { error: `未知节点 ${input.nodeId}`, code: 404 };
  const existing = db.prepare('SELECT data FROM inspection_tasks').all() as { data: string }[];
  for (const row of existing) {
    const t = JSON.parse(row.data) as InspectionTask;
    if (t.anomalyId === input.anomalyId && t.status !== 'resolved' && t.status !== 'escalated') return { task: t, existed: true };
  }
  // fixture demoAnomaly 指定的演示任务 ID 优先使用（TASK-DEMO-01），其后顺序编号
  let id = anomaly.taskId;
  if (getTask(id)) {
    let seq = 2;
    while (getTask(`${anomaly.taskId}-${String(seq).padStart(2, '0')}`)) seq++;
    id = `${anomaly.taskId}-${String(seq).padStart(2, '0')}`;
  }
  const task: InspectionTask = {
    id,
    anomalyId: input.anomalyId,
    nodeId: input.nodeId,
    assignee: input.assignee ?? '运维员-演示',
    status: 'created',
    createdAt: nowIsoShanghai(),
    closedAt: null,
    transitions: [{ from: null, to: 'created', event: 'create', ts: nowIsoShanghai(), operator: '系统', evidenceIds: [] }],
    evidence: [],
    anomalyResolved: false,
  };
  save(task);
  return { task, existed: false };
}

// —— 状态机迁移表 ——
const EVENT_TRANSITIONS: Record<string, Partial<Record<TaskStatus, TaskStatus>>> = {
  dispatch: { created: 'dispatched' },
  arrive_front: { dispatched: 'onsite' }, // 途经 enroute：自动补记 dispatched→enroute→onsite 两条迁移
  arrive_roof: { onsite: 'inspecting' },
  submit_evidence: { inspecting: 'evidence-submitted' },
  resolve: { 'evidence-submitted': 'resolved' },
  escalate: {
    created: 'escalated', dispatched: 'escalated', enroute: 'escalated',
    onsite: 'escalated', inspecting: 'escalated', 'evidence-submitted': 'escalated',
  },
};

export class TransitionError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 屋面证据校验：屋面类异常必须含 CP-xxx-ROOF 检查点证据 */
function assertRoofEvidence(task: InspectionTask): void {
  const anomaly = getAnomalyState();
  if (task.anomalyId !== anomaly.id) return; // 非演示异常暂不强制（新异常类型须先登记合同）
  const hasRoof = task.evidence.some((e) => e.checkpointId.endsWith('-ROOF'));
  if (!hasRoof) {
    throw new TransitionError('EVIDENCE_MISSING', '屋面类异常必须提交 CP-xxx-ROOF 检查点证据才能 resolve（当前缺少 ROOF 证据）');
  }
}

/** 推进状态机：非法跃迁抛 TransitionError（路由层映射 409） */
export function pushEvent(taskId: string, event: string, payload?: { operator?: string }): InspectionTask {
  const task = getTask(taskId);
  if (!task) throw new TransitionError('NOT_FOUND', `任务 ${taskId} 不存在`);
  if (task.closedAt) throw new TransitionError('ALREADY_CLOSED', `任务 ${taskId} 已闭环，禁止再迁移`);
  const table = EVENT_TRANSITIONS[event];
  if (!table) throw new TransitionError('UNKNOWN_EVENT', `未知事件 ${event}（允许 dispatch|arrive_front|arrive_roof|submit_evidence|resolve|escalate）`);
  const next = table[task.status];
  if (!next) throw new TransitionError('ILLEGAL_TRANSITION', `状态 ${task.status} 不允许事件 ${event}`);
  if (event === 'submit_evidence' && task.evidence.length === 0) {
    throw new TransitionError('NO_EVIDENCE', '尚未提交任何证据，不能标记 evidence-submitted');
  }
  if (event === 'resolve') assertRoofEvidence(task);

  const ts = nowIsoShanghai();
  const operator = payload?.operator ?? task.assignee;
  if (event === 'arrive_front') {
    // 楼前到达 = dispatched → enroute → onsite，两段迁移都记录（合同：每次迁移记录时间/操作人）
    task.transitions.push({ from: 'dispatched', to: 'enroute', event: 'depart', ts, operator, evidenceIds: [] });
    task.transitions.push({ from: 'enroute', to: 'onsite', event: 'arrive_front', ts, operator, evidenceIds: [] });
  } else {
    task.transitions.push({ from: task.status, to: next, event, ts, operator, evidenceIds: task.evidence.map((e) => e.id) });
  }
  task.status = next;
  save(task);
  return task;
}

/** 提交证据：仅 inspecting / evidence-submitted 状态可提交 */
export function addEvidence(taskId: string, input: { checkpointId: string; kind: Evidence['kind']; value: string; ts?: string }): Evidence {
  const task = getTask(taskId);
  if (!task) throw new TransitionError('NOT_FOUND', `任务 ${taskId} 不存在`);
  if (task.closedAt) throw new TransitionError('ALREADY_CLOSED', `任务 ${taskId} 已闭环，禁止再提交证据`);
  if (task.status !== 'inspecting' && task.status !== 'evidence-submitted') {
    throw new TransitionError('ILLEGAL_STATE', `状态 ${task.status} 不能提交证据（需先 arrive_roof 进入检查中）`);
  }
  if (!fixture.checkpoints.some((c) => c.id === input.checkpointId)) {
    throw new TransitionError('UNKNOWN_CHECKPOINT', `未知检查点 ${input.checkpointId}`);
  }
  if (!['photo', 'thermal', 'reading', 'note'].includes(input.kind)) {
    throw new TransitionError('UNKNOWN_KIND', `未知证据类型 ${input.kind}（允许 photo|thermal|reading|note）`);
  }
  const evidence: Evidence = {
    id: `EVID-${task.id}-${String(task.evidence.length + 1).padStart(2, '0')}`,
    checkpointId: input.checkpointId,
    kind: input.kind,
    value: input.value,
    ts: input.ts ?? nowIsoShanghai(),
  };
  task.evidence.push(evidence);
  save(task);
  return evidence;
}

/** 闭环：校验证据齐备 → resolved → 立即撤销异常注入（实发恢复，验收 P4-4 依赖） */
export async function closeTask(taskId: string): Promise<InspectionTask> {
  const task = getTask(taskId);
  if (!task) throw new TransitionError('NOT_FOUND', `任务 ${taskId} 不存在`);
  if (task.closedAt) throw new TransitionError('ALREADY_CLOSED', `任务 ${taskId} 已闭环`);
  if (task.status !== 'evidence-submitted' && task.status !== 'resolved') {
    throw new TransitionError('ILLEGAL_STATE', `状态 ${task.status} 不能闭环（需先提交证据并 resolve）`);
  }
  assertRoofEvidence(task);
  const ts = nowIsoShanghai();
  if (task.status !== 'resolved') {
    task.transitions.push({ from: task.status, to: 'resolved', event: 'resolve', ts, operator: task.assignee, evidenceIds: task.evidence.map((e) => e.id) });
    task.status = 'resolved';
  }
  task.closedAt = ts;
  task.anomalyResolved = true;
  // 闭环前固化累计损失电量（detectedAt 当日 → 闭环日），随后撤销注入 → 实发曲线立即恢复 ±2% 区间（验收 P4-4 依赖）
  const lossKwhTotal = await cumulativeLossKwh(getAnomalyState().nodeId, getAnomalyState().detectedAt.slice(0, 10), ts.slice(0, 10));
  closeAnomaly(ts, lossKwhTotal);
  save(task);
  return task;
}

/** 异常注入期间累计损失电量：Σ(组串应发 - 实发) */
async function cumulativeLossKwh(nodeId: string, fromDate: string, toDate: string): Promise<number> {
  const { expectedSeries, actualSeries } = await import('./generation');
  let loss = 0;
  for (let d = fromDate; d <= toDate; ) {
    const exp = await expectedSeries(nodeId, d);
    const act = await actualSeries(nodeId, d);
    loss += Math.max(0, (exp?.totalKwh ?? 0) - (act?.totalKwh ?? 0));
    const dt = new Date(`${d}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    d = dt.toISOString().slice(0, 10);
  }
  return Math.round(loss * 1000) / 1000;
}

/** 演示复位（debug/reset 用）：清空全部任务 */
export function resetTasks(): void {
  db.exec('DELETE FROM inspection_tasks');
}
