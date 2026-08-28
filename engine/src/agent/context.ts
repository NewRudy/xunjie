// ContextAssembler（contracts/agent-context.md）
// 每次装配产出"最小、高信号、带来源与时效"的上下文项；预算由构造保证：
// 1 任务摘要 + 1 场景标识 + 1 异常 + 1 目标资产卡 + ≤3 相关资产 + 1 检查点集 + 1 环境 + ≤2 SOP + 1 证据引用。
// 任何数字都能沿 sourceRefs 回到引擎接口/fixture；不可用是显式状态，不用猜测值替代。
import { deviceStatus } from '../nodes';
import { listAnomalies } from '../anomalies';
import { getWeatherDay } from '../weather';
import { fixture, getNode } from '../fixture';
import { getTask } from '../inspection';
import { fnv1a, r2, todayShanghai } from '../util';
import { relevantSops } from './sop';
import type { ContextItem, MissionState } from './types';
import { nextSeq } from './store';

// 业务场景 ID 与 fixture 根节点 ID 分离：PARK-01 是语义树节点，PECC-PARK-01 是 Agent 场景包 ID。
export const SCENE_ID = 'PECC-PARK-01';
export const SCENE_REVISION = 'fixture-v1'; // 已登记场景修订号（contracts/agent-tools.md 示例）

export interface ContextBundle {
  items: ContextItem[];
  contextVersion: string;
  contextHash: string;
  generatedAt: string;
}

/** 稳定序列化：键排序，同数据逐字节一致 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, val]) => [k, walk(val)]));
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

function assetCard(nodeId: string): Record<string, unknown> | null {
  const n = getNode(nodeId);
  if (!n) return null;
  return {
    id: n.id,
    type: n.type,
    parentId: n.parentId,
    children: n.children,
    status: deviceStatus(nodeId),
    card: n.raw,
  };
}

/** 相关资产：父链向上 + 目标检查点归属节点，去重，预算 ≤3 */
function relatedAssetIds(targetId: string): string[] {
  const out: string[] = [];
  let cur = getNode(targetId)?.parentId;
  while (cur && out.length < 3) {
    out.push(cur);
    cur = getNode(cur)?.parentId;
  }
  return out;
}

function targetCheckpoints(targetId: string): Array<{ id: string; nodeId: string; kind: string }> {
  // 目标节点的检查点 + 其祖先的检查点（楼前/屋面）
  const ids = new Set<string>([targetId]);
  let cur = getNode(targetId)?.parentId;
  while (cur) {
    ids.add(cur);
    cur = getNode(cur)?.parentId;
  }
  return fixture.checkpoints.filter((c: any) => ids.has(c.nodeId)).map((c: any) => ({ id: c.id, nodeId: c.nodeId, kind: c.kind }));
}

/**
 * 装配最小上下文。每次调用产生新的 contextVersion（序号单调递增），
 * 使旧审批按合同失效（agent-state.md §3：审批必须绑定 contextVersion）。
 */
export async function assembleContext(mission: MissionState): Promise<ContextBundle> {
  const items: ContextItem[] = [];
  const today = todayShanghai();

  // 1) 任务摘要
  items.push({
    key: 'mission.summary',
    scope: 'mission',
    availability: 'available',
    data: {
      missionId: mission.missionId,
      objective: mission.objective,
      operator: mission.operator,
      trigger: mission.trigger,
      phase: mission.phase,
      focus: mission.focus,
      inspectionTaskId: mission.inspectionTaskId ?? null,
    },
    sourceRefs: ['POST /api/agent/missions 请求体', 'contracts/agent-state.md §2'],
    reasonIncluded: '任务目标、阶段与焦点决定本轮可用动作',
  });

  // 2) 场景标识（虚构园区常驻标注）
  items.push({
    key: 'scene.identity',
    scope: 'scene',
    availability: 'available',
    data: { sceneId: SCENE_ID, sceneRevision: SCENE_REVISION, fictional: fixture.fictional, prototypeNote: fixture.prototypeNote, fixtureRootId: fixture.id },
    sourceRefs: ['data/fixtures/park-pecc-01.json'],
    truth: 'SIMULATED',
    reasonIncluded: '所有语义 ID 必须来自该场景包',
  });

  // 3) 异常（类型/强度/数据质量/影响数字）
  try {
    const view = (await listAnomalies(today, 'all')).find((a) => a.id === mission.anomalyId) ?? null;
    items.push({
      key: `anomaly.${mission.anomalyId}`,
      scope: 'anomaly',
      availability: view ? 'available' : 'unavailable',
      data: view
        ? {
            id: view.id, nodeId: view.nodeId, type: view.type, severity: view.severity,
            detectedAt: view.detectedAt, status: view.status, closedAt: view.closedAt,
            requiresRoofEvidence: view.requiresRoofEvidence, suspected: view.evidence.suspected,
            evidence: view.evidence,
          }
        : { id: mission.anomalyId, error: '未在当日异常列表中找到该 ID' },
      sourceRefs: [`/api/anomalies?date=${today}&status=all`, 'data-contracts.md §4'],
      truth: 'SIMULATED',
      observedAt: view?.detectedAt,
      reasonIncluded: '异常类型与损失数字是提案与证据门槛的依据',
    });
  } catch {
    items.push({
      key: `anomaly.${mission.anomalyId}`,
      scope: 'anomaly',
      availability: 'unavailable',
      data: { id: mission.anomalyId, error: '异常数据装配失败' },
      sourceRefs: [`/api/anomalies?date=${today}&status=all`],
      reasonIncluded: '异常不可用必须显式标注，不得以空值替代',
    });
  }

  // 4) 目标资产卡 + ≤3 相关资产（父子链）
  const target = assetCard(mission.nodeId);
  items.push({
    key: `asset.${mission.nodeId}`,
    scope: 'asset',
    availability: target ? 'available' : 'unavailable',
    data: target ?? { id: mission.nodeId, error: '未知节点' },
    sourceRefs: [`/api/node/${mission.nodeId}`, 'data/fixtures/park-pecc-01.json'],
    truth: 'SIMULATED',
    observedAt: mission.createdAt,
    reasonIncluded: '目标设备状态与所属层级是检查路径依据',
  });
  for (const rel of relatedAssetIds(mission.nodeId)) {
    const card = assetCard(rel);
    if (!card) continue;
    items.push({
      key: `asset.${rel}`,
      scope: 'asset',
      availability: 'available',
      data: card,
      sourceRefs: [`/api/node/${rel}`, 'data/fixtures/park-pecc-01.json'],
      truth: 'SIMULATED',
      reasonIncluded: '父级/相邻设备提供连带影响与定位上下文',
    });
  }

  // 5) 检查点集（路线与证据门槛）
  items.push({
    key: `checkpoints.${mission.nodeId}`,
    scope: 'scene',
    availability: 'available',
    data: targetCheckpoints(mission.nodeId),
    sourceRefs: ['data/fixtures/park-pecc-01.json checkpoints', 'contracts/scene-events.md §2'],
    truth: 'SIMULATED',
    reasonIncluded: '提案只能引用已登记检查点',
  });

  // 6) 环境（每次装配重取，不沿用任务创建时的旧值）
  try {
    const w = await getWeatherDay(today);
    const ghiPeak = r2(Math.max(...w.hours.map((h) => h.ghi)));
    const tempMax = r2(Math.max(...w.hours.map((h) => h.temp)));
    items.push({
      key: 'environment.today',
      scope: 'environment',
      availability: 'available',
      data: { date: today, ghiPeakWm2: ghiPeak, tempMaxC: tempMax, source: w.meta.source, synthetic: w.meta.synthetic },
      sourceRefs: [`/api/weather?from=${today}&to=${today}`],
      truth: 'MODELED',
      observedAt: w.meta.fetchedAt ?? undefined,
      reasonIncluded: '可作业性与热成像有效性依赖当日环境',
    });
  } catch {
    items.push({
      key: 'environment.today',
      scope: 'environment',
      availability: 'unavailable',
      data: { date: today, error: '气象数据不可用' },
      sourceRefs: [`/api/weather?from=${today}&to=${today}`],
      reasonIncluded: '环境不可用必须显式标注',
    });
  }

  // 7) SOP 片段（≤2）
  const requiresRoof = (await listAnomalies(today, 'all')).find((a) => a.id === mission.anomalyId)?.requiresRoofEvidence ?? false;
  for (const sop of relevantSops(requiresRoof)) {
    items.push({
      key: `sop.${sop.id}`,
      scope: 'sop',
      availability: 'available',
      data: { id: sop.id, version: sop.version, title: sop.title, steps: sop.steps, evidenceRequired: sop.evidenceRequired },
      sourceRefs: sop.sourceRefs,
      truth: 'POLICY',
      reasonIncluded: '规程约束证据要求与步骤顺序',
    });
  }

  // 8) 证据引用（已提交 + 暂存）
  if (mission.inspectionTaskId) {
    const task = getTask(mission.inspectionTaskId);
    items.push({
      key: 'evidence.task',
      scope: 'evidence',
      availability: task ? 'available' : 'unavailable',
      data: {
        taskId: mission.inspectionTaskId,
        status: task?.status ?? null,
        evidence: task?.evidence.map((e) => ({ id: e.id, checkpointId: e.checkpointId, kind: e.kind, ts: e.ts })) ?? [],
        buffered: mission.bufferedEvidence.map((e) => ({ checkpointId: e.checkpointId, kind: e.kind, ts: e.ts })),
      },
      sourceRefs: [`/api/inspection/tasks/${mission.inspectionTaskId}`],
      truth: 'SIMULATED',
      reasonIncluded: '证据齐备情况决定能否推进/闭环',
    });
  }

  const contextVersion = `CTX-${String(nextSeq('context')).padStart(4, '0')}`;
  const contextHash = `CHASH-${fnv1a(canonicalJson(items.map((i) => ({ key: i.key, scope: i.scope, availability: i.availability, data: i.data }))))
    .toString(16)
    .padStart(8, '0')}`;
  return { items, contextVersion, contextHash, generatedAt: mission.updatedAt };
}
