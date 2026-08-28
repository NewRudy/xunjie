#!/usr/bin/env node
// 数字运维员指令解析测试（engine/scripts/avatar-test.mjs）
// 覆盖 contracts/avatar-command.md §4 映射：跑到 B2 楼前、飞到 B2 屋顶、向前走 10 米、左转 90 度、
//       停下、维修 7 号异常组串（含飞屋顶复合句）、未知指令澄清、钳制与 commandId 唯一性；
//       并经 Hono 路由冒烟验证统一外壳（truth=SIMULATED + 仿真告警）与 400 CLARIFICATION_NEEDED。
// 用法：pnpm test:avatar（= tsx scripts/avatar-test.mjs，退出码 0=全绿）
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

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
function section(title) {
  console.log(`\n== ${title} ==`);
}

const { parseAvatarCommand, interpretAvatarCommand, AvatarClarificationError, AVATAR_WARNINGS } = await import('../src/agent/avatar.ts');

// 路由冒烟：临时 SQLite（导入链含 db 初始化，PECC_DB 须在动态 import 前设置）
const tmpDb = path.join(os.tmpdir(), `avatar-route-test-${process.pid}.db`);
process.env.PECC_DB = tmpDb;
const { agentRoutes } = await import('../src/agent/routes.ts');
const post = (body) =>
  agentRoutes.request('/avatar/interpret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId: 'PECC-PARK-01', sceneRevision: 'fixture-v1', ...body }),
  });

const kinds = (text) => parseAvatarCommand(text).map((c) => c.kind);

// ---------- 合同 §4 主映射 ----------
section('合同 v1 中文映射');
{
  const run = parseAvatarCommand('跑到 B2 楼前');
  ok(run.length === 1 && run[0].kind === 'navigate' && run[0].targetId === 'CP-B02-FRONT' && run[0].movement === 'run', '跑到 B2 楼前 → navigate CP-B02-FRONT run', JSON.stringify(run));

  const fly = parseAvatarCommand('飞到 B2 屋顶');
  ok(fly.length === 1 && fly[0].kind === 'navigate' && fly[0].targetId === 'CP-B02-ROOF' && fly[0].movement === 'fly', '飞到 B2 屋顶 → navigate CP-B02-ROOF fly', JSON.stringify(fly));

  const walk10 = parseAvatarCommand('向前走 10 米');
  ok(walk10.length === 1 && walk10[0].kind === 'move_relative' && walk10[0].direction === 'forward' && walk10[0].distanceMeters === 10 && walk10[0].movement === 'walk', '向前走 10 米 → move_relative forward 10 walk', JSON.stringify(walk10));

  const left90 = parseAvatarCommand('左转 90 度');
  ok(left90.length === 1 && left90[0].kind === 'turn' && left90[0].degrees === 90, '左转 90 度 → turn +90', JSON.stringify(left90));
  const right45 = parseAvatarCommand('右转 45 度');
  ok(right45[0].kind === 'turn' && right45[0].degrees === -45, '右转 45 度 → turn -45', JSON.stringify(right45));

  const stop = parseAvatarCommand('停下');
  ok(stop.length === 1 && stop[0].kind === 'stop', '停下 → stop', JSON.stringify(stop));

  const jump = parseAvatarCommand('跳一下');
  ok(jump.length === 1 && jump[0].kind === 'jump', '跳一下 → jump', JSON.stringify(jump));

  const ops = parseAvatarCommand('回运维点');
  ok(ops.length === 1 && ops[0].kind === 'navigate' && ops[0].targetId === 'OPS-01' && ops[0].movement === 'walk', '回运维点 → navigate OPS-01 walk', JSON.stringify(ops));

  const inv = parseAvatarCommand('去 B2 逆变器');
  ok(inv.length === 1 && inv[0].kind === 'navigate' && inv[0].targetId === 'CP-INV-B02' && inv[0].movement === 'walk', '去 B2 逆变器 → navigate CP-INV-B02 walk', JSON.stringify(inv));

  const up = parseAvatarCommand('上升 10 米');
  ok(up[0].kind === 'move_relative' && up[0].direction === 'up' && up[0].movement === 'fly', '上升 10 米 → move_relative up fly', JSON.stringify(up));
  const down = parseAvatarCommand('下降 5 米');
  ok(down[0].direction === 'down' && down[0].movement === 'fly', '下降 5 米 → down fly（up/down 必须飞行）', JSON.stringify(down));
}

// ---------- 维修流（focus_asset + repair_simulation） ----------
section('维修 7 号异常组串');
{
  const repair = parseAvatarCommand('维修 7 号异常组串');
  ok(JSON.stringify(kinds('维修 7 号异常组串')) === JSON.stringify(['navigate', 'focus_asset', 'repair_simulation']), '维修 7 号异常组串 → navigate + focus_asset + repair_simulation', JSON.stringify(repair));
  const nav = repair[0];
  ok(nav.targetId === 'CP-INV-B02' && nav.movement === 'walk', '先导航到 CP-INV-B02（walk）', JSON.stringify(nav));
  ok(repair[1].targetId === 'STR-B2-07', 'focus_asset STR-B2-07', JSON.stringify(repair[1]));
  ok(repair[2].targetId === 'STR-B2-07' && repair[2].checkpointId === 'CP-INV-B02', 'repair_simulation STR-B2-07 @ CP-INV-B02', JSON.stringify(repair[2]));
  const ids = new Set(repair.map((c) => c.commandId));
  ok(ids.size === 3 && repair.every((c) => c.commandId.startsWith('avatar-')), 'commandId 单次响应内唯一（avatar-…）', JSON.stringify(repair.map((c) => c.commandId)));

  const roof = parseAvatarCommand('飞到 B2 屋顶维修 7 号异常组串');
  ok(roof.length === 3 && roof[0].kind === 'navigate' && roof[0].targetId === 'CP-B02-ROOF' && roof[0].movement === 'fly', '飞到 B2 屋顶维修 → 先 fly 到 CP-B02-ROOF', JSON.stringify(roof));
  ok(roof[2].kind === 'repair_simulation' && roof[2].checkpointId === 'CP-INV-B02', '维修动作按合同安全落点 CP-INV-B02', JSON.stringify(roof[2]));

  const interp = interpretAvatarCommand('飞到 B2 屋顶维修 7 号异常组串');
  ok(typeof interp.reply === 'string' && interp.reply.includes('B2 屋顶') && interp.reply.includes('维修仿真'), 'reply 面向观众可读', interp.reply);
}

// ---------- 钳制与默认值 ----------
section('钳制与默认（distance 1..50 默认 10；degrees -180..180）');
{
  ok(parseAvatarCommand('向前走')[0].distanceMeters === 10, '向前走（无数字）→ 默认 10 米');
  ok(parseAvatarCommand('向前走 999 米')[0].distanceMeters === 50, '999 米 → 钳制 50');
  ok(parseAvatarCommand('向前走 0 米')[0].distanceMeters === 1, '0 米 → 钳制 1');
  ok(parseAvatarCommand('向前走十米')[0].distanceMeters === 10, '中文数字「十米」→ 10');
  ok(parseAvatarCommand('左转')[0].degrees === 90, '左转（无角度）→ 默认 90');
  ok(parseAvatarCommand('左转 270 度')[0].degrees === 180, '270 度 → 钳制 180');
  ok(parseAvatarCommand('右转 270 度')[0].degrees === -180, '右转 270 度 → 钳制 -180');
  ok(parseAvatarCommand('向前飞 20 米')[0].movement === 'fly', '向前飞 20 米 → movement fly');
}

// ---------- 澄清：未知/不明确不猜 ----------
section('澄清（400 CLARIFICATION_NEEDED 语义）');
{
  const unknown = '给我唱首歌';
  try {
    parseAvatarCommand(unknown);
    ok(false, `未知指令「${unknown}」应抛澄清`);
  } catch (e) {
    ok(e instanceof AvatarClarificationError && e.message.includes(unknown) && e.examples.length > 0, '未知指令 → 澄清异常 + 可说示例', e.message);
  }
  for (const [text, why] of [
    ['去 B2', '目的地不唯一（楼前/屋顶/逆变器）'],
    ['维修 8 号组串', '编号未登记（仅 STR-B2-07）'],
    ['维修一下', '维修目标缺失'],
    ['左转 90 度然后跳', '一句多意图'],
  ]) {
    try {
      parseAvatarCommand(text);
      ok(false, `「${text}」应抛澄清（${why}）`);
    } catch (e) {
      ok(e instanceof AvatarClarificationError, `「${text}」→ 澄清（${why}）`, e.message);
    }
  }
}

// ---------- 路由冒烟：统一外壳 + 错误码 ----------
section('路由 POST /api/agent/avatar/interpret（Hono 冒烟）');
{
  const res = await post({ text: '跑到 B2 楼前' });
  const body = await res.json();
  ok(res.status === 200 && body.status === 'available', '200 available', JSON.stringify(body).slice(0, 200));
  ok(body.truth === 'SIMULATED', 'truth=SIMULATED');
  ok(Array.isArray(body.warnings) && body.warnings.some((w) => w.includes('仅数字现场仿真') && w.includes('不控制')), 'warnings 明确仅数字现场仿真、不控制真实设备', JSON.stringify(body.warnings));
  ok(body.data?.commands?.[0]?.targetId === 'CP-B02-FRONT' && body.data.commands[0].commandId.startsWith('avatar-'), 'data.commands 受控命令 + commandId', JSON.stringify(body.data?.commands));
  ok(body.planner?.mode === 'deterministic-fallback' && body.planner?.modelAvailable === false, 'planner 标识确定性解析（无 LLM）');
  ok(typeof body.data?.normalizedText === 'string' && typeof body.data?.reply === 'string', 'normalizedText + reply 齐备');

  const badScene = await post({ text: '停下', sceneId: 'PECC-PARK-99' });
  ok(badScene.status === 400 && (await badScene.json()).error?.code === 'CLARIFICATION_NEEDED', 'sceneId 不符 → 400 CLARIFICATION_NEEDED');

  const unknown = await post({ text: '给我唱首歌' });
  const unknownBody = await unknown.json();
  ok(unknown.status === 400 && unknownBody.error?.code === 'CLARIFICATION_NEEDED', '未知指令 → 400 CLARIFICATION_NEEDED');
  ok(Array.isArray(unknownBody.clarification?.examples) && unknownBody.clarification.examples.includes('维修 7 号异常组串'), '澄清含可说示例', JSON.stringify(unknownBody.clarification?.examples));

  const noText = await post({ text: '   ' });
  ok(noText.status === 400 && (await noText.json()).error?.code === 'BAD_BODY', '空 text → 400 BAD_BODY');
}

// ---------- 汇总 ----------
fs.rmSync(tmpDb, { force: true });
console.log(`\n========================================`);
console.log(`avatar-test 结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.error('失败项：');
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('数字运维员指令解析测试全部通过 ✔');
