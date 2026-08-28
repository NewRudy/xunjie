// 提案/计划：确定性回退 planner + 结构化校验（contracts/agent-state.md §3）
// 不变量：plan 只能引用已登记语义 ID；summary 中的数字必须逐字出现在装配上下文中
//（data-contracts.md §5"字符串包含检查"）；任何校验不过的模型输出整条丢弃、回退确定性 planner。
import { fixture, hasNode } from '../fixture';
import { fnv1a } from '../util';
import { canonicalJson, type ContextBundle } from './context';
import type { Plan, PlanStep, RawProposal } from './types';

const STEP_KINDS = ['navigate', 'focus', 'inspect', 'capture-evidence', 'request-confirmation', 'verify'];

export const planHashOf = (p: { summary: string; steps: unknown }): string =>
  `PLAN-${fnv1a(canonicalJson({ summary: p.summary, steps: p.steps })).toString(16).padStart(8, '0')}`;

const isRegisteredTarget = (id: string): boolean => hasNode(id) || fixture.checkpoints.some((c: any) => c.id === id);

/** summary 数字审计：所有数字串必须能回溯到上下文原文 */
export function summaryNumbersResolvable(summary: string, bundle: ContextBundle): boolean {
  const haystack = canonicalJson(bundle.items);
  const tokens = summary.match(/\d[\d.,:%]*/g) ?? [];
  return tokens.every((t) => haystack.includes(t));
}

/** 模型/回退提案 → 校验后的 Plan；失败返回原因（不静默修补） */
export function validateProposal(raw: RawProposal, bundle: ContextBundle): { ok: true; plan: Plan } | { ok: false; reason: string } {
  if (typeof raw.summary !== 'string' || !raw.summary.trim()) return { ok: false, reason: 'summary 缺失' };
  if (raw.summary.length > 500) return { ok: false, reason: 'summary 超长' };
  if (!summaryNumbersResolvable(raw.summary, bundle)) return { ok: false, reason: 'summary 含无法回溯上下文的数字' };
  if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > 12) return { ok: false, reason: 'steps 数量非法' };

  const steps: PlanStep[] = [];
  raw.steps.forEach((s, i) => {
    if (!STEP_KINDS.includes(s.kind)) throw new Error(`step ${i}: 未知 kind ${s.kind}`);
    if (typeof s.title !== 'string' || !s.title || s.title.length > 200) throw new Error(`step ${i}: title 非法`);
    if (s.targetId !== undefined && (typeof s.targetId !== 'string' || !isRegisteredTarget(s.targetId))) throw new Error(`step ${i}: 未登记目标 ${s.targetId}`);
    if (s.requiredEvidence !== undefined) {
      if (!Array.isArray(s.requiredEvidence)) throw new Error(`step ${i}: requiredEvidence 须为数组`);
      for (const cp of s.requiredEvidence) {
        if (!fixture.checkpoints.some((c: any) => c.id === cp)) throw new Error(`step ${i}: 未登记证据检查点 ${cp}`);
      }
    }
    steps.push({ id: `S${i + 1}`, kind: s.kind as PlanStep['kind'], title: s.title, targetId: s.targetId, requiredEvidence: s.requiredEvidence, status: 'pending' });
  });

  const basisRefs = (raw.basisRefs ?? []).filter((r) => typeof r === 'string' && bundle.items.some((i) => i.key === r || i.sourceRefs.includes(r)));
  return { ok: true, plan: { planHash: planHashOf({ summary: raw.summary, steps }), summary: raw.summary, steps, basisRefs } };
}

export interface FallbackFacts {
  targetAssetId: string;
  frontCheckpointId: string | null;
  roofCheckpointId: string | null;
  requiresRoofEvidence: boolean;
}

/** 从装配上下文提取确定性事实（planner 不自己发明） */
export function fallbackFacts(bundle: ContextBundle): FallbackFacts {
  const cpItem = bundle.items.find((i) => i.key.startsWith('checkpoints.'))?.data as Array<{ id: string; kind: string }> | undefined;
  const cps = cpItem ?? [];
  const anomaly = bundle.items.find((i) => i.scope === 'anomaly')?.data as { nodeId?: string } | undefined;
  const targetAssetId = anomaly?.nodeId ?? bundle.items.find((i) => i.key.startsWith('asset.'))!.key.split('.')[1];
  return {
    targetAssetId,
    frontCheckpointId: cps.find((c) => c.kind === 'building-front')?.id ?? null,
    roofCheckpointId: cps.find((c) => c.kind === 'roof')?.id ?? null,
    requiresRoofEvidence: Boolean((bundle.items.find((i) => i.scope === 'anomaly')?.data as any)?.requiresRoofEvidence),
  };
}

/**
 * 确定性回退 planner：纯结构推导，零外部调用、零生成数字。
 * 演示路线：聚焦目标 → 楼前 → 屋面 → 取证 → 用户确认闭环。
 */
export function fallbackProposal(bundle: ContextBundle): RawProposal {
  const f = fallbackFacts(bundle);
  const steps: RawProposal['steps'] = [{ kind: 'focus', title: `聚焦目标 ${f.targetAssetId}`, targetId: f.targetAssetId }];
  if (f.frontCheckpointId) {
    steps.push({ kind: 'navigate', title: `前往楼前检查点 ${f.frontCheckpointId}`, targetId: f.frontCheckpointId });
    steps.push({ kind: 'capture-evidence', title: `在 ${f.frontCheckpointId} 拍照记录`, targetId: f.frontCheckpointId });
  }
  if (f.roofCheckpointId) {
    steps.push({ kind: 'navigate', title: `沿登记路线前往屋面检查点 ${f.roofCheckpointId}`, targetId: f.roofCheckpointId });
    steps.push({ kind: 'inspect', title: `检查 ${f.targetAssetId}（先取得屋面证据再闭环）`, targetId: f.targetAssetId });
    steps.push({ kind: 'capture-evidence', title: `在 ${f.roofCheckpointId} 提交热成像/照片证据`, targetId: f.roofCheckpointId, requiredEvidence: [f.roofCheckpointId] });
  }
  steps.push({ kind: 'request-confirmation', title: '证据齐备后请求用户确认闭环' });
  steps.push({ kind: 'verify', title: '闭环后核对实发恢复' });
  return {
    summary: `先取得屋面证据再闭环：${f.frontCheckpointId ? `楼前 ${f.frontCheckpointId} → ` : ''}${f.roofCheckpointId ? `屋面 ${f.roofCheckpointId} → ` : ''}提交 ${f.targetAssetId} 证据 → 用户确认后闭环（数字现场演示）。`,
    steps,
    basisRefs: bundle.items.filter((i) => ['anomaly', 'scene', 'sop'].includes(i.scope)).map((i) => i.key),
  };
}
