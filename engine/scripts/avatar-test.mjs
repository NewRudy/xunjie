#!/usr/bin/env node
// 数字运维员指令解析测试（engine/scripts/avatar-test.mjs）
// 覆盖 contracts/avatar-command.md §4 映射：跑到 B2 楼前、飞到 B2 屋顶、向前走 10 米、左转 90 度、
//       停下、维修 7 号异常组串（含飞屋顶复合句）、未知指令澄清、钳制与 commandId 唯一性；
//       任务闭环三意图：检查/巡检/排查 → start_inspection、我同意/不同意（负向优先）→ decide_pending、
//       采集/提交证据/拍照取证 → capture_evidence（§7）；
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

// Hermetic 守卫：本测试锁定「无凭据 → 确定性解析」行为；若 shell 带 LLM 凭据会让路由真实外呼，先清掉
for (const k of ['AGENT_LLM_API_KEY', 'AGENT_LLM_BASE_URL', 'AGENT_LLM_MODEL']) delete process.env[k];

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
  ok(left90.length === 1 && left90[0].kind === 'turn' && left90[0].degrees === -90, '左转 90 度 → turn -90（渲染器 addYaw 顺时针为正）', JSON.stringify(left90));
  const right45 = parseAvatarCommand('右转 45 度');
  ok(right45[0].kind === 'turn' && right45[0].degrees === 45, '右转 45 度 → turn +45', JSON.stringify(right45));

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

// ---------- 任务闭环三意图（合同 §4 新增 + §7：巡检 / 审批意图 / 采证） ----------
section('任务闭环：start_inspection / decide_pending / capture_evidence');
{
  for (const t of ['检查 B2 屋顶异常', '巡检 B2 屋顶异常', '排查 7 号异常组串']) {
    const insp = parseAvatarCommand(t);
    ok(insp.length === 1 && insp[0].kind === 'start_inspection' && insp[0].anomalyId === 'ANOM-DEMO-01', `「${t}」→ start_inspection ANOM-DEMO-01（唯一）`, JSON.stringify(insp));
  }
  try {
    parseAvatarCommand('检查 8 号组串');
    ok(false, '「检查 8 号组串」应抛澄清（编号未登记）');
  } catch (e) {
    ok(e instanceof AvatarClarificationError, '「检查 8 号组串」→ 澄清（仅登记 ANOM-DEMO-01）', e.message);
  }

  for (const t of ['我同意', '同意', '批准', '执行']) {
    const cmd = parseAvatarCommand(t);
    ok(cmd.length === 1 && cmd[0].kind === 'decide_pending' && cmd[0].decision === 'approve', `「${t}」→ decide_pending approve`, JSON.stringify(cmd));
  }
  // 负向优先：「我不同意」含「同意」，不得误判为 approve
  for (const [t, why] of [['我不同意', '负向优先'], ['不同意', '负向优先'], ['拒绝', '负向优先'], ['取消', '负向优先']]) {
    const cmd = parseAvatarCommand(t);
    ok(cmd.length === 1 && cmd[0].kind === 'decide_pending' && cmd[0].decision === 'reject', `「${t}」→ decide_pending reject（${why}）`, JSON.stringify(cmd));
  }

  for (const t of ['采集证据', '提交证据', '拍照取证']) {
    const ev = parseAvatarCommand(t);
    ok(ev.length === 1 && ev[0].kind === 'capture_evidence' && JSON.stringify(ev[0].evidenceKinds) === JSON.stringify(['photo', 'thermal', 'reading']), `「${t}」→ capture_evidence photo+thermal+reading`, JSON.stringify(ev));
  }

  // 命令唯一性 + commandId 唯一；reply 只说「将…」的下一步，不声称已执行
  for (const t of ['检查 B2 屋顶异常', '我同意', '我不同意', '采集证据']) {
    const cmds = parseAvatarCommand(t);
    ok(cmds.length === 1 && new Set(cmds.map((c) => c.commandId)).size === 1, `「${t}」恰一个受控意图且 commandId 唯一`, JSON.stringify(cmds));
    const reply = interpretAvatarCommand(t).reply;
    ok(reply.includes('将') && !/已(批准|驳回|创建|采集|完成)/.test(reply), `「${t}」reply 指向下一步、不声称已执行`, reply);
  }

  // 不触碰 MissionState：解析只返回意图命令，无任务/审批副作用字段
  const insp = parseAvatarCommand('检查 B2 屋顶异常')[0];
  ok(Object.keys(insp).filter((k) => !['commandId', 'kind', 'anomalyId'].includes(k)).length === 0, 'start_inspection 仅含受控字段', JSON.stringify(insp));
}

// ---------- 钳制与默认值 ----------
section('钳制与默认（distance 1..50 默认 10；degrees -180..180）');
{
  ok(parseAvatarCommand('向前走')[0].distanceMeters === 10, '向前走（无数字）→ 默认 10 米');
  ok(parseAvatarCommand('向前走 999 米')[0].distanceMeters === 50, '999 米 → 钳制 50');
  ok(parseAvatarCommand('向前走 0 米')[0].distanceMeters === 1, '0 米 → 钳制 1');
  ok(parseAvatarCommand('向前走十米')[0].distanceMeters === 10, '中文数字「十米」→ 10');
  ok(parseAvatarCommand('左转')[0].degrees === -90, '左转（无角度）→ 默认 -90');
  ok(parseAvatarCommand('左转 270 度')[0].degrees === -180, '270 度 → 钳制 -180');
  ok(parseAvatarCommand('右转 270 度')[0].degrees === 180, '右转 270 度 → 钳制 180');
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
  ok(Array.isArray(body.warnings) && body.warnings.length === 0, 'warnings 不再附带仿真免责（真值标签保留在 truth 字段）', JSON.stringify(body.warnings));
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

// ---------- 风电场景（合同 §9，WIND-FARM-01；登记 ID 来自 farm.json/windFarm.ts） ----------
section('风电场景 WIND-FARM-01（scene=wind）');
{
  const wkinds = (text) => parseAvatarCommand(text, 'wind').map((c) => c.kind);

  const fly7 = parseAvatarCommand('飞到 7 号风机', 'wind');
  ok(fly7.length === 1 && fly7[0].kind === 'navigate' && fly7[0].targetId === 'CP-WT-07' && fly7[0].movement === 'fly', '飞到 7 号风机 → navigate CP-WT-07 fly', JSON.stringify(fly7));

  const run10 = parseAvatarCommand('跑到 10 号风机', 'wind');
  ok(run10.length === 1 && run10[0].kind === 'navigate' && run10[0].targetId === 'CP-WT-10' && run10[0].movement === 'run', '跑到 10 号风机 → navigate CP-WT-10 run', JSON.stringify(run10));

  const go2 = parseAvatarCommand('去 2 号风机', 'wind');
  ok(go2.length === 1 && go2[0].targetId === 'CP-WT-02' && go2[0].movement === 'fly', '去 2 号风机（未说移动方式）→ 山地默认 fly（§9）', JSON.stringify(go2));

  const repair = parseAvatarCommand('维修 7 号风机', 'wind');
  ok(JSON.stringify(wkinds('维修 7 号风机')) === JSON.stringify(['navigate', 'focus_asset', 'repair_simulation']), '维修 7 号风机 → navigate + focus_asset + repair_simulation', JSON.stringify(repair));
  ok(repair[0].targetId === 'CP-WT-07', '先导航到 CP-WT-07', JSON.stringify(repair[0]));
  ok(repair[1].targetId === 'HS-WTG-07', 'focus_asset HS-WTG-07', JSON.stringify(repair[1]));
  ok(repair[2].kind === 'repair_simulation' && repair[2].targetId === 'HS-WTG-07' && repair[2].checkpointId === 'CP-WT-07', 'repair_simulation HS-WTG-07 @ CP-WT-07（齿轮箱高速端轴承）', JSON.stringify(repair[2]));
  const reply = interpretAvatarCommand('维修 7 号风机', 'wind').reply;
  ok(reply.includes('7 号风机') && reply.includes('维修仿真') && reply.includes('SIMULATED'), '风电维修 reply 面向观众可读且标 SIMULATED', reply);

  const focus5 = parseAvatarCommand('查看 5 号风机', 'wind');
  ok(focus5.length === 1 && focus5[0].kind === 'focus_asset' && focus5[0].targetId === 'HS-WTG-05', '查看 5 号风机 → focus_asset HS-WTG-05（无移动动词不导航）', JSON.stringify(focus5));

  const ops = parseAvatarCommand('回运维点', 'wind');
  ok(ops.length === 1 && ops[0].kind === 'navigate' && ops[0].targetId === 'OPS-WIND-01', '风电 回运维点 → navigate OPS-WIND-01', JSON.stringify(ops));

  for (const [text, why] of [
    ['维修 3 号风机', '维修仅登记 7 号风机'],
    ['飞到 12 号风机', '编号未登记（1~10）'],
    ['维修一下风机', '维修编号缺失'],
  ]) {
    try {
      parseAvatarCommand(text, 'wind');
      ok(false, `「${text}」应抛澄清（${why}）`);
    } catch (e) {
      ok(e instanceof AvatarClarificationError && e.examples.includes('维修 7 号风机'), `「${text}」→ 澄清（${why}）+ 风电示例`, e.message);
    }
  }
}

// ---------- 风电路由冒烟：白名单第二场景 + 统一外壳 ----------
section('路由 POST /api/agent/avatar/interpret（风电 WIND-FARM-01）');
{
  const okRes = await post({ text: '飞到 7 号风机', sceneId: 'WIND-FARM-01', sceneRevision: 'fixture-v1' });
  const okBody = await okRes.json();
  ok(okRes.status === 200 && okBody.status === 'available', '风电 200 available', JSON.stringify(okBody).slice(0, 200));
  ok(okBody.truth === 'SIMULATED', '风电 truth=SIMULATED');
  ok(okBody.data?.commands?.[0]?.targetId === 'CP-WT-07' && okBody.data.commands[0].movement === 'fly', 'data.commands → CP-WT-07 fly', JSON.stringify(okBody.data?.commands));
  ok(Array.isArray(okBody.sourceRefs) && okBody.sourceRefs.includes('player-demo/example/public/wind/farm.json'), 'sourceRefs 含 farm.json 事实源', JSON.stringify(okBody.sourceRefs));

  const badRev = await post({ text: '停下', sceneId: 'WIND-FARM-01', sceneRevision: 'fixture-v0' });
  ok(badRev.status === 400 && (await badRev.json()).error?.code === 'CLARIFICATION_NEEDED', '风电 revision 不符 → 400 CLARIFICATION_NEEDED');

  const clarifyRes = await post({ text: '维修 3 号风机', sceneId: 'WIND-FARM-01', sceneRevision: 'fixture-v1' });
  const clarifyBody = await clarifyRes.json();
  ok(clarifyRes.status === 400 && clarifyBody.error?.code === 'CLARIFICATION_NEEDED', '风电未登记维修目标 → 400');
  ok(Array.isArray(clarifyBody.clarification?.examples) && clarifyBody.clarification.examples.includes('维修 7 号风机'), '风电澄清示例来自 WIND_AVATAR_EXAMPLES', JSON.stringify(clarifyBody.clarification?.examples));
}

// ---------- 简式运动与飞行动词（口语容错，两场景共享） ----------
section('简式运动：上/下/左/右/前/后 + 起飞/飞行/降落/悬停');
{
  const moveCases = [
    ['上', { direction: 'up', movement: 'fly', distanceMeters: 10 }],
    ['上 5 米', { direction: 'up', movement: 'fly', distanceMeters: 5 }],
    ['上升', { direction: 'up', movement: 'fly', distanceMeters: 10 }],
    ['下', { direction: 'down', movement: 'fly', distanceMeters: 10 }],
    ['降落', { direction: 'down', movement: 'fly', distanceMeters: 10 }],
    ['落地', { direction: 'down', movement: 'fly', distanceMeters: 10 }],
    ['左 3 米', { direction: 'left', movement: 'walk', distanceMeters: 3 }],
    ['右', { direction: 'right', movement: 'walk', distanceMeters: 10 }],
    ['前 2 米', { direction: 'forward', movement: 'walk', distanceMeters: 2 }],
    ['前进', { direction: 'forward', movement: 'walk', distanceMeters: 10 }],
    ['后退', { direction: 'backward', movement: 'walk', distanceMeters: 10 }],
    ['麻烦上5米', { direction: 'up', movement: 'fly', distanceMeters: 5 }],
    ['起飞', { direction: 'up', movement: 'fly', distanceMeters: 10 }],
    ['飞行', { direction: 'up', movement: 'fly', distanceMeters: 10 }],
    ['飞', { direction: 'up', movement: 'fly', distanceMeters: 10 }],
  ];
  for (const [text, want] of moveCases) {
    try {
      const cmds = parseAvatarCommand(text, 'pecc');
      const c = cmds[0];
      const mismatches = Object.entries(want).filter(([k, v]) => c?.[k] !== v).map(([k, v]) => `${k}: ${String(c?.[k])}≠${String(v)}`);
      ok(cmds.length === 1 && c.kind === 'move_relative' && mismatches.length === 0, `「${text}」→ move_relative`, mismatches.join('; '));
    } catch (e) {
      ok(false, `「${text}」→ move_relative`, e.message);
    }
  }
  const hover = parseAvatarCommand('悬停', 'pecc');
  ok(hover[0].kind === 'stop', '「悬停」→ stop', JSON.stringify(hover[0]));

  // 长句不受简式匹配影响
  const long1 = parseAvatarCommand('飞到 B2 屋顶', 'pecc');
  ok(long1[0].kind === 'navigate' && long1[0].targetId === 'CP-B02-ROOF', '「飞到 B2 屋顶」仍走导航路由', JSON.stringify(long1[0]));
  const long2 = parseAvatarCommand('左转 90 度', 'pecc');
  ok(long2[0].kind === 'turn' && long2[0].degrees === -90, '「左转 90 度」仍走转向路由', JSON.stringify(long2[0]));

  // 风电场景共享简式运动
  const windUp = parseAvatarCommand('上', 'wind');
  ok(windUp[0].kind === 'move_relative' && windUp[0].direction === 'up' && windUp[0].movement === 'fly', '风电「上」→ 上升飞行', JSON.stringify(windUp[0]));
  const windFly = parseAvatarCommand('起飞', 'wind');
  ok(windFly[0].kind === 'move_relative' && windFly[0].direction === 'up' && windFly[0].movement === 'fly', '风电「起飞」→ 上升飞行', JSON.stringify(windFly[0]));
  const windLong = parseAvatarCommand('飞到 7 号风机', 'wind');
  ok(windLong[0].kind === 'navigate' && windLong[0].targetId === 'CP-WT-07', '风电长句仍走导航路由', JSON.stringify(windLong[0]));
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
