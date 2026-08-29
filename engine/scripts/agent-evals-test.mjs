#!/usr/bin/env node
// 确定性路由评测（engine/scripts/agent-evals-test.mjs，参考 pipe-report-agent routing evals）
// 固定语料断言：每句指令路由到受控意图（命令 kind/目标/移动方式）或显式澄清；含跨场景泄漏检查。
// 全部离线（确定性门控层），不访问公网、不调用 LLM。语料规模有发布下限：低于下限直接失败。
// 用法：pnpm test:evals（= tsx scripts/agent-evals-test.mjs，退出码 0=全绿）
import { parseAvatarCommand } from '../src/agent/avatar.ts';
import { AvatarClarificationError } from '../src/agent/avatar.ts';

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, label, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// —— 语料：expect.kind 匹配任一命令；expect.target/degrees/decision 细化断言；'clarify' 断言澄清 ——
const CORPUS = [
  // 光伏·导航与运动
  { text: '跑到 B2 楼前', scene: 'pecc', expect: { kind: 'navigate', targetId: 'CP-B02-FRONT', movement: 'run' } },
  { text: '飞到 B2 屋顶', scene: 'pecc', expect: { kind: 'navigate', targetId: 'CP-B02-ROOF', movement: 'fly' } },
  { text: '去 B2 逆变器', scene: 'pecc', expect: { kind: 'navigate', targetId: 'CP-INV-B02', movement: 'walk' } },
  { text: 'B2 屋顶', scene: 'pecc', expect: { kind: 'navigate', targetId: 'CP-B02-ROOF', movement: 'fly' } },
  { text: '回运维点', scene: 'pecc', expect: { kind: 'navigate', targetId: 'OPS-01', movement: 'walk' } },
  { text: '向前走 10 米', scene: 'pecc', expect: { kind: 'move_relative', direction: 'forward', distanceMeters: 10 } },
  { text: '向前走十五米', scene: 'pecc', expect: { kind: 'move_relative', direction: 'forward', distanceMeters: 15 } },
  { text: '上升 10 米', scene: 'pecc', expect: { kind: 'move_relative', direction: 'up', movement: 'fly', distanceMeters: 10 } },
  { text: '左转 90 度', scene: 'pecc', expect: { kind: 'turn', degrees: 90 } },
  { text: '右转90度', scene: 'pecc', expect: { kind: 'turn', degrees: -90 } },
  { text: '跳一下', scene: 'pecc', expect: { kind: 'jump' } },
  { text: '停下', scene: 'pecc', expect: { kind: 'stop' } },
  { text: '请停一下', scene: 'pecc', expect: { kind: 'stop' } },
  // 光伏·任务闭环
  { text: '检查 B2 屋顶异常', scene: 'pecc', expect: { kind: 'start_inspection', anomalyId: 'ANOM-DEMO-01' } },
  { text: '维修 7 号异常组串', scene: 'pecc', expect: { kind: 'repair_simulation', targetId: 'STR-B2-07', checkpointId: 'CP-INV-B02' } },
  { text: '飞到 B2 屋顶维修 7 号异常组串', scene: 'pecc', expect: { kind: 'repair_simulation', targetId: 'STR-B2-07' } },
  { text: '我同意', scene: 'pecc', expect: { kind: 'decide_pending', decision: 'approve' } },
  { text: '我不同意', scene: 'pecc', expect: { kind: 'decide_pending', decision: 'reject' } },
  { text: '采集证据', scene: 'pecc', expect: { kind: 'capture_evidence' } },
  { text: '拍照取证', scene: 'pecc', expect: { kind: 'capture_evidence' } },
  // 光伏·不猜目标 → 澄清
  { text: '维修 5 号异常组串', scene: 'pecc', expect: 'clarify' },
  { text: '检查 3 号屋顶异常', scene: 'pecc', expect: 'clarify' },
  { text: '跑到 B2 楼前 然后飞到 B2 屋顶', scene: 'pecc', expect: 'clarify' },
  { text: '给我唱首歌', scene: 'pecc', expect: 'clarify' },
  // 风电·导航/聚焦/维修
  { text: '飞到 7 号风机', scene: 'wind', expect: { kind: 'navigate', targetId: 'CP-WT-07', movement: 'fly' } },
  { text: '跑到 2 号风机', scene: 'wind', expect: { kind: 'navigate', targetId: 'CP-WT-02', movement: 'run' } },
  { text: '查看 5 号风机', scene: 'wind', expect: { kind: 'focus_asset', targetId: 'HS-WTG-05' } },
  { text: '维修 7 号风机', scene: 'wind', expect: { kind: 'repair_simulation', targetId: 'HS-WTG-07', checkpointId: 'CP-WT-07' } },
  { text: '回运维点', scene: 'wind', expect: { kind: 'navigate', targetId: 'OPS-WIND-01', movement: 'fly' } },
  { text: '去 10 号风机', scene: 'wind', expect: { kind: 'navigate', targetId: 'CP-WT-10' } },
  { text: '飞到七号风机', scene: 'wind', expect: { kind: 'navigate', targetId: 'CP-WT-07', movement: 'fly' } },
  // 风电·不猜目标 → 澄清
  { text: '飞到 11 号风机', scene: 'wind', expect: 'clarify' },
  { text: '维修 3 号风机', scene: 'wind', expect: 'clarify' },
  { text: '跑到 2 号风机 然后停下', scene: 'wind', expect: 'clarify' },
  // 跨场景泄漏：光伏句在风电场景 / 风电句在光伏场景都必须澄清，不得误路由
  { text: '我同意', scene: 'wind', expect: 'clarify' },
  { text: '检查 B2 屋顶异常', scene: 'wind', expect: 'clarify' },
  { text: '采集证据', scene: 'wind', expect: 'clarify' },
  { text: '飞到 7 号风机', scene: 'pecc', expect: 'clarify' },
  { text: '查看 5 号风机', scene: 'pecc', expect: 'clarify' },
];

ok(CORPUS.length >= 28, `语料规模下限（当前 ${CORPUS.length} 条，下限 28）`);

for (const c of CORPUS) {
  const label = `[${c.scene}] ${c.text}`;
  try {
    const cmds = parseAvatarCommand(c.text, c.scene);
    if (c.expect === 'clarify') {
      ok(false, `${label} → 应澄清却返回了 ${cmds.map((x) => x.kind).join('+')}`);
      continue;
    }
    const hit = cmds.find((x) => x.kind === c.expect.kind);
    if (!hit) {
      ok(false, `${label} → 应含 ${c.expect.kind}`, `实际 ${cmds.map((x) => x.kind).join('+')}`);
      continue;
    }
    const mismatches = [];
    for (const [field, want] of Object.entries(c.expect)) {
      if (field === 'kind') continue;
      if (JSON.stringify(hit[field]) !== JSON.stringify(want)) mismatches.push(`${field}: 期望 ${JSON.stringify(want)} 实际 ${JSON.stringify(hit[field])}`);
    }
    ok(mismatches.length === 0, `${label} → ${c.expect.kind}`, mismatches.join('; '));
  } catch (e) {
    if (c.expect === 'clarify' && e instanceof AvatarClarificationError) {
      ok(true, `${label} → 澄清（不猜目标）`);
    } else if (e instanceof AvatarClarificationError) {
      ok(false, `${label} → 应路由到 ${JSON.stringify(c.expect)} 却澄清`, e.message);
    } else {
      ok(false, `${label} → 解析抛错`, String(e));
    }
  }
}

console.log(`\n========================================`);
console.log(`agent-evals-test 结果：${passed} 通过 / ${failed} 失败（语料 ${CORPUS.length} 条）`);
if (failed > 0) {
  console.error('失败项：');
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('确定性路由评测全部通过 ✔');
