#!/usr/bin/env node
// 人物指令 LLM-first 解释测试（engine/scripts/avatar-llm-test.mjs）
// 本地 mock OpenAI-compatible（劫持 globalThis.fetch，绝不调用真实公网 API），证明：
//   1. 配置 AGENT_LLM_API_KEY 时真的发起 chat/completions 请求（URL/Bearer/model/system 约束断言）；
//   2. 模型合法输出 → planner.mode=llm，命令过白名单校验后生效、commandId 服务端重编；
//   3. 非法输出（未知 kind/未登记 ID/超界数值/多余字段/脚本注入/超量）→ 整条拒绝并回退确定性解析；
//   4. HTTP/超时/坏 JSON → reason 只给错误类型；
//   5. 无凭据 → 保持既有确定性行为，零外呼。
// 用法：pnpm test:avatar-llm（= tsx scripts/avatar-llm-test.mjs，退出码 0=全绿）
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

// —— fetch mock（先于任何被测调用安装；被测代码运行期才读 env） ——

const realFetch = globalThis.fetch;
let mockBehavior = null; // { status?, content } | { reject: Error }
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  if (mockBehavior?.reject) throw mockBehavior.reject;
  const content = mockBehavior?.content ?? '';
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: mockBehavior?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
const mockContent = (commands, reply) => JSON.stringify(reply === undefined ? { commands } : { reply, commands });
const lastCall = () => calls[calls.length - 1];

// 路由冒烟需临时 SQLite（导入链含 db 初始化，PECC_DB 须在动态 import 前设置）
const tmpDb = path.join(os.tmpdir(), `avatar-llm-test-${process.pid}.db`);
process.env.PECC_DB = tmpDb;
// 模拟「已配置凭据」：模型指向本地 mock 基址（127.0.0.1:9 不会被真实连接）
process.env.AGENT_LLM_API_KEY = 'mock-test-key';
process.env.AGENT_LLM_BASE_URL = 'http://127.0.0.1:9/mock-v1';
process.env.AGENT_LLM_MODEL = 'mock-model-x';

const { agentRoutes } = await import('../src/agent/routes.ts');
const { interpretAvatar } = await import('../src/agent/avatar-llm.ts');
const { AvatarClarificationError } = await import('../src/agent/avatar.ts');

const post = (body) =>
  agentRoutes.request('/avatar/interpret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId: 'PECC-PARK-01', sceneRevision: 'fixture-v1', ...body }),
  });

// ---------- 1. 合法输出：planner=llm，且真的发起了模型请求 ----------
section('配置凭据 + 模型合法输出 → planner llm（真实发起请求）');
{
  calls.length = 0;
  mockBehavior = { content: mockContent([{ kind: 'navigate', targetId: 'CP-INV-B02', movement: 'fly' }], '收到，飞往 B2 逆变器。') };
  const out = await interpretAvatar('赶紧带我去逆变器那边');
  ok(calls.length === 1, '恰发起 1 次 chat/completions 请求', `calls=${calls.length}`);
  const { url, init } = lastCall();
  ok(url === 'http://127.0.0.1:9/mock-v1/chat/completions', '请求 URL=BASE_URL/chat/completions', url);
  ok(init?.method === 'POST', 'POST 方法');
  ok(init?.headers?.Authorization === 'Bearer mock-test-key', 'Authorization Bearer 携带配置密钥', String(init?.headers?.Authorization));
  const sentBody = JSON.parse(init?.body ?? '{}');
  ok(sentBody.model === 'mock-model-x', 'body.model=AGENT_LLM_MODEL', sentBody.model);
  ok(sentBody.messages?.[0]?.role === 'system' && sentBody.messages[0].content.includes('只输出一个 JSON 对象'), 'system prompt 限定只输出 JSON');
  ok(sentBody.messages[0].content.includes('不得携带 commandId') && sentBody.messages[0].content.includes('ANOM-DEMO-01'), 'system prompt 含白名单登记 ID');
  ok(sentBody.messages?.[1]?.content.includes('赶紧带我去逆变器那边'), 'user 消息携带用户文本', sentBody.messages?.[1]?.content);
  ok(out.planner.mode === 'llm' && out.planner.modelAvailable === true && out.planner.reason === undefined, 'planner={mode:llm, modelAvailable:true}（无 reason）', JSON.stringify(out.planner));
  ok(out.commands.length === 1 && out.commands[0].kind === 'navigate' && out.commands[0].targetId === 'CP-INV-B02' && out.commands[0].movement === 'fly', 'LLM 命令过校验后生效（fly，区别于确定性 walk）', JSON.stringify(out.commands));
  ok(out.commands[0].commandId.startsWith('avatar-'), 'commandId 由服务端重新编号', out.commands[0].commandId);
  ok(out.reply === '收到，飞往 B2 逆变器。', 'reply 取自模型输出', out.reply);
  ok(out.normalizedText === '赶紧带我去逆变器那边', 'normalizedText 保留', out.normalizedText);
}

// ---------- 2. 多命令编排合法（维修流） ----------
section('LLM 多命令编排（维修流 3 命令）');
{
  calls.length = 0;
  mockBehavior = {
    content: mockContent([
      { kind: 'navigate', targetId: 'CP-INV-B02', movement: 'walk' },
      { kind: 'focus_asset', targetId: 'STR-B2-07' },
      { kind: 'repair_simulation', targetId: 'STR-B2-07', checkpointId: 'CP-INV-B02' },
    ], '收到，前往 B2 逆变器执行维修仿真。'),
  };
  const out = await interpretAvatar('维修 7 号异常组串');
  ok(out.planner.mode === 'llm' && out.commands.length === 3, 'planner llm + 3 条命令', JSON.stringify(out.planner));
  const ids = out.commands.map((c) => c.commandId);
  ok(new Set(ids).size === 3 && ids.every((i) => i.startsWith('avatar-')), 'commandId 唯一且 avatar- 前缀', ids.join(','));
  ok(out.commands[2].kind === 'repair_simulation' && out.commands[2].checkpointId === 'CP-INV-B02', 'repair_simulation @ CP-INV-B02', JSON.stringify(out.commands[2]));
}

// ---------- 3. 一句多意图：确定性会澄清，LLM 编排合法即放行 ----------
section('LLM 编排解锁一句多意图（确定性路径会澄清的句子）');
{
  calls.length = 0;
  mockBehavior = { content: mockContent([{ kind: 'turn', degrees: 90 }, { kind: 'jump' }], '收到，左转 90 度并跳一下。') };
  try {
    const out = await interpretAvatar('左转90度然后跳一下');
    ok(out.planner.mode === 'llm' && out.commands.length === 2 && out.commands[0].kind === 'turn' && out.commands[1].kind === 'jump', 'LLM 合法编排放行（turn+jump）', JSON.stringify(out.commands));
  } catch (e) {
    ok(false, 'LLM 合法编排放行（turn+jump）', e.message);
  }
  mockBehavior = { content: mockContent([]) };
  try {
    await interpretAvatar('给我唱首歌');
    ok(false, 'LLM 输出空 commands（无法理解）应回退并澄清');
  } catch (e) {
    ok(e instanceof AvatarClarificationError && e.planner?.mode === 'deterministic-fallback', '空 commands → 回退澄清且携带 planner', `${e.name}: ${e.message}`);
  }
}

// ---------- 4. 非法输出矩阵：整条拒绝 + 回退确定性解析 ----------
section('非法输出整条拒绝 → 回退确定性（reason=LLM_VALIDATION_FAILED:检查名）');
{
  const baseText = '跑到 B2 楼前';
  const expectFallback = async (label, content, expectedCode) => {
    calls.length = 0;
    mockBehavior = { content };
    const out = await interpretAvatar(baseText);
    const callsAfter = calls.length;
    ok(out.planner.mode === 'deterministic-fallback' && out.planner.modelAvailable === true, `${label}：planner=deterministic-fallback（modelAvailable=true）`, JSON.stringify(out.planner));
    ok(out.planner.reason === `LLM_VALIDATION_FAILED:${expectedCode}`, `${label}：reason=${out.planner.reason}`, JSON.stringify(out.planner));
    ok(out.commands.length === 1 && out.commands[0].kind === 'navigate' && out.commands[0].targetId === 'CP-B02-FRONT' && out.commands[0].movement === 'run', `${label}：命令来自确定性解析`, JSON.stringify(out.commands));
    ok(callsAfter === 1, `${label}：确曾尝试模型请求`, `calls=${callsAfter}`);
  };
  await expectFallback('未登记 targetId', mockContent([{ kind: 'navigate', targetId: 'MARS-01', movement: 'walk' }]), 'TARGET');
  await expectFallback('未知 kind+脚本注入', mockContent([{ kind: 'run_script', script: 'viewer.destroy()' }]), 'KIND');
  await expectFallback('携带 commandId 多余字段', mockContent([{ kind: 'stop', commandId: 'hijack-1' }]), 'FIELDS');
  await expectFallback('distance 超界(80)', mockContent([{ kind: 'move_relative', direction: 'forward', distanceMeters: 80, movement: 'walk' }]), 'DISTANCE');
  await expectFallback('distance 非数值', mockContent([{ kind: 'move_relative', direction: 'forward', distanceMeters: '10', movement: 'walk' }]), 'DISTANCE');
  await expectFallback('degrees 超界(270)', mockContent([{ kind: 'turn', degrees: 270 }]), 'DEGREES');
  await expectFallback('up 必须 fly', mockContent([{ kind: 'move_relative', direction: 'up', distanceMeters: 10, movement: 'walk' }]), 'MOVEMENT_FLY');
  await expectFallback('evidenceKinds 不完整', mockContent([{ kind: 'capture_evidence', evidenceKinds: ['photo'] }]), 'EVIDENCE');
  await expectFallback('维修检查点不符', mockContent([{ kind: 'repair_simulation', targetId: 'STR-B2-07', checkpointId: 'CP-B02-ROOF' }]), 'TARGET');
  await expectFallback('异常 ID 未登记', mockContent([{ kind: 'start_inspection', anomalyId: 'ANOM-XX' }]), 'TARGET');
  await expectFallback('decision 非法', mockContent([{ kind: 'decide_pending', decision: 'execute' }]), 'DECISION');
  await expectFallback('reply 非字符串', JSON.stringify({ reply: 1, commands: [{ kind: 'stop' }] }), 'REPLY');
  await expectFallback('空 commands', mockContent([]), 'COMMANDS');
  await expectFallback('超过数量上限(7)', mockContent(Array.from({ length: 7 }, () => ({ kind: 'stop' }))), 'COUNT');

  calls.length = 0;
  mockBehavior = { content: '这不是 JSON' };
  const badJson = await interpretAvatar('跑到 B2 楼前');
  ok(badJson.planner.mode === 'deterministic-fallback' && badJson.planner.reason === 'LLM_BAD_JSON' && badJson.commands[0].targetId === 'CP-B02-FRONT', '坏 JSON → LLM_BAD_JSON + 回退', JSON.stringify(badJson.planner));
}

// ---------- 5. 传输层失败：reason 只给错误类型 ----------
section('HTTP/超时/网络失败 → 错误类型 reason + 回退');
{
  calls.length = 0;
  mockBehavior = { status: 500, content: 'server exploded' };
  const httpErr = await interpretAvatar('停下');
  ok(httpErr.planner.reason === 'LLM_HTTP_500' && httpErr.planner.mode === 'deterministic-fallback', 'HTTP 500 → LLM_HTTP_500（不透传响应原文）', JSON.stringify(httpErr.planner));
  ok(httpErr.commands.length === 1 && httpErr.commands[0].kind === 'stop', 'HTTP 失败 → 确定性 stop', JSON.stringify(httpErr.commands));

  mockBehavior = { reject: new TypeError('fetch failed') };
  const netErr = await interpretAvatar('停下');
  ok(netErr.planner.reason === 'LLM_CALL_FAILED: TypeError', '网络失败 → LLM_CALL_FAILED: <错误名>', JSON.stringify(netErr.planner));

  const abortErr = new Error('The operation was aborted');
  abortErr.name = 'AbortError';
  mockBehavior = { reject: abortErr };
  const timeout = await interpretAvatar('停下');
  ok(timeout.planner.reason === 'LLM_TIMEOUT', '超时(AbortError) → LLM_TIMEOUT', JSON.stringify(timeout.planner));

  const allReasons = [httpErr.planner.reason, netErr.planner.reason, timeout.planner.reason].join('|');
  ok(!/mock-test-key|sceneRevision|messages/i.test(allReasons), 'reason 不含密钥/请求体痕迹', allReasons);
}

// ---------- 6. 无凭据：保持确定性行为，零外呼 ----------
section('无凭据 → NO_CREDENTIALS，零外呼');
{
  delete process.env.AGENT_LLM_API_KEY;
  calls.length = 0;
  const out = await interpretAvatar('飞到 B2 屋顶');
  ok(calls.length === 0, '未发起任何网络请求', `calls=${calls.length}`);
  ok(out.planner.mode === 'deterministic-fallback' && out.planner.modelAvailable === false && out.planner.reason === 'NO_CREDENTIALS', 'planner={deterministic-fallback, modelAvailable:false, NO_CREDENTIALS}', JSON.stringify(out.planner));
  ok(out.commands.length === 1 && out.commands[0].kind === 'navigate' && out.commands[0].targetId === 'CP-B02-ROOF' && out.commands[0].movement === 'fly', '命令与既有确定性解析一致', JSON.stringify(out.commands));
  try {
    await interpretAvatar('给我唱首歌');
    ok(false, '无凭据未知指令应澄清');
  } catch (e) {
    ok(e instanceof AvatarClarificationError && e.planner?.reason === 'NO_CREDENTIALS', '无凭据澄清语义不变且携带 planner', e.message);
  }
  process.env.AGENT_LLM_API_KEY = 'mock-test-key';
}

// ---------- 7. 路由冒烟：planner 如实上浮到 HTTP 响应 ----------
section('路由 POST /avatar/interpret（LLM 与回退的 planner 上浮）');
{
  calls.length = 0;
  mockBehavior = { content: mockContent([{ kind: 'navigate', targetId: 'CP-B02-FRONT', movement: 'run' }], '模型确认：跑步前往 B2 楼前。') };
  const okRes = await post({ text: '带我去B2楼前' });
  const okBody = await okRes.json();
  ok(okRes.status === 200 && okBody.planner?.mode === 'llm' && okBody.planner?.modelAvailable === true, '200 + planner.llm 上浮', JSON.stringify(okBody.planner));
  ok(okBody.data?.reply === '模型确认：跑步前往 B2 楼前。', 'reply 为模型输出', okBody.data?.reply);
  ok(okBody.truth === 'SIMULATED' && okBody.warnings?.some((w) => w.includes('仅数字现场仿真')), 'truth=SIMULATED + 仿真告警不因 LLM 缺失', JSON.stringify(okBody.warnings));

  mockBehavior = { content: mockContent([{ kind: 'navigate', targetId: 'MARS-01', movement: 'walk' }]) };
  const fbRes = await post({ text: '带我去B2楼前' });
  const fbBody = await fbRes.json();
  ok(fbRes.status === 200 && fbBody.planner?.mode === 'deterministic-fallback' && String(fbBody.planner?.reason).startsWith('LLM_VALIDATION_FAILED:'), '非法输出 → 200 + deterministic-fallback + 错误类型 reason', JSON.stringify(fbBody.planner));
  ok(fbBody.data?.commands?.[0]?.targetId === 'CP-B02-FRONT', '回退命令来自确定性解析', JSON.stringify(fbBody.data?.commands));

  mockBehavior = { status: 503, content: '' };
  const clrRes = await post({ text: '给我唱首歌' });
  const clrBody = await clrRes.json();
  ok(clrRes.status === 400 && clrBody.error?.code === 'CLARIFICATION_NEEDED', '模型失败且不可理解 → 400 CLARIFICATION_NEEDED', JSON.stringify(clrBody.error));
  ok(clrBody.planner?.mode === 'deterministic-fallback' && clrBody.planner?.reason === 'LLM_HTTP_503', '澄清响应携带回退 planner 与错误类型', JSON.stringify(clrBody.planner));
  ok(Array.isArray(clrBody.clarification?.examples) && clrBody.clarification.examples.length > 0, '澄清示例保留', JSON.stringify(clrBody.clarification?.examples?.length));
}

// ---------- 8. 风电场景：白名单按场景分流（WIND-FARM-01，合同 §9） ----------
section('风电场景 LLM 校验（scene=wind）');
{
  calls.length = 0;
  mockBehavior = { content: mockContent([{ kind: 'navigate', targetId: 'CP-WT-07', movement: 'fly' }], '收到，飞往 7 号风机。') };
  const out = await interpretAvatar('带我去 7 号风机', 'wind');
  ok(out.planner.mode === 'llm' && out.commands.length === 1 && out.commands[0].targetId === 'CP-WT-07' && out.commands[0].movement === 'fly', '风电登记 ID 过校验生效', JSON.stringify(out.commands));
  const windPrompt = JSON.parse(lastCall()?.init?.body ?? '{}')?.messages?.[0]?.content ?? '';
  ok(windPrompt.includes('CP-WT-07') && windPrompt.includes('HS-WTG-07'), '风电 system prompt 含风电登记 ID（能力目录按场景渲染）');

  calls.length = 0;
  mockBehavior = { content: mockContent([{ kind: 'navigate', targetId: 'CP-INV-B02', movement: 'walk' }]) };
  const cross = await interpretAvatar('飞到 7 号风机', 'wind');
  ok(cross.planner.mode === 'deterministic-fallback' && String(cross.planner.reason).startsWith('LLM_VALIDATION_FAILED:'), '光伏 ID 混入风电场景 → 整条拒绝回退', JSON.stringify(cross.planner));
  ok(cross.commands.length === 1 && cross.commands[0].targetId === 'CP-WT-07' && cross.commands[0].movement === 'fly', '回退命令来自风电确定性解析（CP-WT-07 fly）', JSON.stringify(cross.commands));

  calls.length = 0;
  mockBehavior = { content: mockContent([{ kind: 'repair_simulation', targetId: 'HS-WTG-07', checkpointId: 'CP-WT-07' }], '收到，执行齿轮箱高速端轴承维修仿真。') };
  const routeRes = await post({ text: '维修 7 号风机', sceneId: 'WIND-FARM-01', sceneRevision: 'fixture-v1' });
  const routeBody = await routeRes.json();
  ok(routeRes.status === 200 && routeBody.planner?.mode === 'llm' && routeBody.data?.commands?.[0]?.targetId === 'HS-WTG-07', '风电路由 LLM 合法输出 → 200 + planner.llm', JSON.stringify(routeBody.planner));
  ok(routeBody.truth === 'SIMULATED' && routeBody.warnings?.some((w) => w.includes('仅数字现场仿真')), '风电 LLM 路径 truth=SIMULATED + 仿真告警不缺失');
}

// ---------- 汇总 ----------
globalThis.fetch = realFetch;
for (const k of ['AGENT_LLM_API_KEY', 'AGENT_LLM_BASE_URL', 'AGENT_LLM_MODEL']) delete process.env[k];
fs.rmSync(tmpDb, { force: true });
console.log(`\n========================================`);
console.log(`avatar-llm-test 结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.error('失败项：');
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('人物指令 LLM-first 解释测试全部通过 ✔');
