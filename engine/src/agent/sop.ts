// 已登记 SOP 片段（contracts/agent-context.md §2 scope=sop）
// 片段只能在此登记后进入上下文；来源必须是合同/引擎规则，不是模型生成。
export interface SopSnippet {
  id: string;
  version: string;
  title: string;
  steps: string[];
  evidenceRequired: string[];
  appliesTo: (ctx: { requiresRoofEvidence: boolean }) => boolean;
  sourceRefs: string[];
}

export const SOP_REGISTRY: SopSnippet[] = [
  {
    id: 'SOP-ROOF-STRING-INSPECT',
    version: 'v0.1',
    title: '屋面组串异常现场核查（数字演示）',
    steps: [
      '楼前检查点确认建筑外观与入场路径',
      '沿登记路线到达屋面检查点',
      '对目标组串拍照 + 红外热成像',
      '提交屋面检查点证据后等待用户确认闭环',
    ],
    evidenceRequired: ['CP-xxx-ROOF 检查点的 photo/thermal 证据（resolve 前置条件）'],
    appliesTo: ({ requiresRoofEvidence }) => requiresRoofEvidence,
    sourceRefs: ['contracts/semantic-tree.md §3 巡检任务状态机', 'engine/src/inspection.ts assertRoofEvidence'],
  },
  {
    id: 'SOP-FRONT-VISUAL-CHECK',
    version: 'v0.1',
    title: '楼前目视检查（数字演示）',
    steps: ['在楼前检查点对建筑/屋面整体拍照记录'],
    evidenceRequired: ['任一登记检查点的 photo 证据'],
    appliesTo: () => true,
    sourceRefs: ['contracts/scene-events.md §2 允许命令', 'data/fixtures/park-pecc-01.json checkpoints'],
  },
];

/** 按上下文筛选相关 SOP（预算：最多 2 条） */
export function relevantSops(requiresRoofEvidence: boolean): SopSnippet[] {
  return SOP_REGISTRY.filter((s) => s.appliesTo({ requiresRoofEvidence })).slice(0, 2);
}
