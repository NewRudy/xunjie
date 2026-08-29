#!/usr/bin/env node
// 结构化输出网关测试（engine/scripts/model-gateway-test.mjs）
// 本地 mock OpenAI-compatible（劫持 globalThis.fetch，绝不调用真实公网 API），证明：
//   1. 首轮成功：普通 JSON / ```json 围栏 / 带前后缀文本均可提取（恰 1 次调用）；
//   2. GLM 特判：嵌套对象被序列化成 JSON 字符串时自动解包一层；
//   3. 修复重试：validator 失败 → 第 2 次请求携带「失败原因 + Schema + 原始输出」；第 2 次成功/仍失败语义正确；
//   4. 默认 maxAttempts=1：失败不重试（恰 1 次调用）；
//   5. 传输层失败（HTTP/无凭据）不重试，错误类型原样透传，不泄漏密钥。
// 用法：pnpm test:model-gateway（= tsx scripts/model-gateway-test.mjs，退出码 0=全绿）
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

const realFetch = globalThis.fetch;
const calls = []; // { url, init }
let queue = []; // 每次调用按序弹出 { status?, content } | { reject: Error }
let defaultBehavior = { content: '{}' };
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  const b = queue.length ? queue.shift() : defaultBehavior;
  if (b?.reject) throw b.reject;
  return new Response(JSON.stringify({ choices: [{ message: { content: b?.content ?? '' } }] }), {
    status: b?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
const callBodies = () => calls.map((c) => JSON.parse(c.init?.body ?? '{}'));

process.env.AGENT_LLM_API_KEY = 'mock-gw-key';
process.env.AGENT_LLM_BASE_URL = 'http://127.0.0.1:9/gw-v1';
process.env.AGENT_LLM_MODEL = 'mock-gw-model';

const { structured, tryExtractJson, unwrapModelJson } = await import('../src/agent/model.ts');

const parseNum = (v) => (v && typeof v === 'object' && !Array.isArray(v) && typeof v.n === 'number' ? v : null);

// ---------- 1. 首轮成功 ----------
section('首轮成功（普通 JSON / 围栏 / 前后缀文本）');
{
  calls.length = 0; queue = [];
  queue.push({ content: '{"n":1}' }, { content: '```json\n{"n":2}\n```' }, { content: '好的，结果如下 {"n":3} 以上。' });
  for (const [i, expect] of [1, 2, 3].entries()) {
    const r = await structured({ messages: [{ role: 'user', content: 'x' }], parse: parseNum });
    ok(r.ok && r.value.n === expect && r.attempts === 1, `提取方式 ${i + 1} 首轮成功 n=${expect}`, JSON.stringify(r));
  }
  ok(calls.length === 3, '三种提取各恰 1 次调用', `calls=${calls.length}`);
}

// ---------- 2. GLM 嵌套字符串解包 ----------
section('GLM 嵌套 JSON 字符串自动解包');
{
  const nested = JSON.stringify(JSON.stringify({ n: 7 }));
  ok(unwrapModelJson(nested).n === 7, '字符串解包一层得到对象', String(nested));
  ok(unwrapModelJson('不是 JSON') === '不是 JSON', '非 JSON 字符串原样保留');
  ok(unwrapModelJson({ n: 8 }).n === 8, '对象类型不改动');
  calls.length = 0; queue = [];
  queue.push({ content: nested });
  const r = await structured({ messages: [{ role: 'user', content: 'x' }], parse: parseNum });
  ok(r.ok && r.value.n === 7 && r.attempts === 1, 'structured 走通嵌套字符串（1 次调用成功）', JSON.stringify(r));
}

// ---------- 3. 修复重试：第 2 次成功 ----------
section('修复重试（maxAttempts=2）：第 2 次请求携带原因/Schema/原输出');
{
  calls.length = 0; queue = [];
  queue.push({ content: '{"n":-1}' }, { content: '{"n":9}' });
  const SCHEMA = '{"n":number}';
  const r = await structured({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'give n' },
    ],
    parse: parseNum,
    validator: (v) => (v.n > 0 ? null : 'POSITIVE'),
    schemaHint: SCHEMA,
    maxAttempts: 2,
  });
  ok(r.ok && r.value.n === 9 && r.attempts === 2, '第 2 次成功（attempts=2）', JSON.stringify(r));
  ok(calls.length === 2, '恰 2 次调用', `calls=${calls.length}`);
  const bodies = callBodies();
  const second = bodies[1];
  ok(second.messages.length === 4, '第 2 次请求 = 原 2 条 + assistant 原输出 + 修复指令', `len=${second.messages.length}`);
  ok(second.messages[2].role === 'assistant' && second.messages[2].content.includes('"n":-1'), 'assistant 消息携带首轮原始输出', second.messages[2]?.content);
  const repair = second.messages[3];
  ok(repair.role === 'user' && repair.content.includes('POSITIVE'), '修复指令携带失败原因', repair.content);
  ok(repair.content.includes(SCHEMA), '修复指令携带 Schema 形状');
  ok(repair.content.includes('"n":-1'), '修复指令携带原始输出摘录');
}

// ---------- 4. 修复重试仍失败 ----------
section('修复重试仍失败：错误码 + 尝试次数如实');
{
  calls.length = 0; queue = [];
  queue.push({ content: '{"n":-1}' }, { content: '{"n":-2}' });
  const r = await structured({
    messages: [{ role: 'user', content: 'x' }],
    parse: parseNum,
    validator: (v) => (v.n > 0 ? null : 'POSITIVE'),
    maxAttempts: 2,
  });
  ok(!r.ok && r.error === 'POSITIVE' && r.attempts === 2, '两次均失败 → error=最后一轮 code, attempts=2', JSON.stringify(r));
  ok(calls.length === 2, '恰 2 次调用', `calls=${calls.length}`);
}

// ---------- 5. 默认单次：失败不重试 ----------
section('默认 maxAttempts=1：失败即返（恰 1 次调用）');
{
  calls.length = 0; queue = [];
  queue.push({ content: '{"n":"bad"}' });
  const r = await structured({ messages: [{ role: 'user', content: 'x' }], parse: parseNum });
  ok(!r.ok && r.error === 'LLM_BAD_JSON' && r.attempts === 1, '形状解析失败 → LLM_BAD_JSON（默认码）', JSON.stringify(r));
  ok(calls.length === 1, '默认不重试', `calls=${calls.length}`);

  calls.length = 0; queue = [];
  queue.push({ content: '{"n":5}' });
  const r2 = await structured({
    messages: [{ role: 'user', content: 'x' }],
    parse: parseNum,
    validator: () => 'CUSTOM_CODE',
  });
  ok(!r2.ok && r2.error === 'CUSTOM_CODE' && calls.length === 1, 'validator 失败 → 透传自定义 code 且不重试', JSON.stringify(r2));

  calls.length = 0; queue = [];
  queue.push({ content: '[1,2,3]' });
  const r3 = await structured({
    messages: [{ role: 'user', content: 'x' }],
    parse: parseNum,
    parseErrorCode: 'MY_SHAPE',
  });
  ok(!r3.ok && r3.error === 'MY_SHAPE' && calls.length === 1, 'parseErrorCode 自定义生效且默认单次', JSON.stringify(r3));
}

// ---------- 6. 坏 JSON：先失败后成功 ----------
section('坏 JSON 修复重试');
{
  calls.length = 0; queue = [];
  queue.push({ content: '这不是 JSON' }, { content: '{"n":11}' });
  const r = await structured({
    messages: [{ role: 'user', content: 'x' }],
    parse: parseNum,
    maxAttempts: 2,
  });
  ok(r.ok && r.value.n === 11 && r.attempts === 2, '首轮坏 JSON → 重试成功', JSON.stringify(r));
  ok(calls.length === 2, '恰 2 次调用', `calls=${calls.length}`);
}

// ---------- 7. 传输层失败：不重试、错误类型透传 ----------
section('传输层失败（HTTP/无凭据）不重试');
{
  calls.length = 0; queue = [];
  queue.push({ status: 500, content: 'boom' });
  const r = await structured({
    messages: [{ role: 'user', content: 'x' }],
    parse: parseNum,
    maxAttempts: 3,
  });
  ok(!r.ok && r.error === 'LLM_HTTP_500' && r.attempts === 1 && calls.length === 1, 'HTTP 500 → LLM_HTTP_500，不重试', JSON.stringify(r));

  delete process.env.AGENT_LLM_API_KEY;
  calls.length = 0; queue = [];
  const r2 = await structured({ messages: [{ role: 'user', content: 'x' }], parse: parseNum, maxAttempts: 3 });
  ok(!r2.ok && r2.error === 'NO_CREDENTIALS' && calls.length === 0, '无凭据 → NO_CREDENTIALS 零外呼', JSON.stringify(r2));
  process.env.AGENT_LLM_API_KEY = 'mock-gw-key';
}

// ---------- 8. tryExtractJson 直测 ----------
section('tryExtractJson 直测');
{
  ok(tryExtractJson('{"a":1}').ok, '裸 JSON');
  ok(tryExtractJson('```json\n{"a":1}\n```').ok, '围栏');
  ok(tryExtractJson('前缀 {"a":1} 后缀').ok, '花括号截取');
  ok(!tryExtractJson('完全没有 JSON').ok, '纯文本失败');
  ok(!tryExtractJson('{"a":'.repeat(1)).ok, '残缺 JSON 失败');
}

// ---------- 9. 密钥不泄漏 ----------
section('错误与消息不泄漏密钥');
{
  calls.length = 0; queue = [];
  queue.push({ content: '{"n":1}' });
  const r = await structured({ messages: [{ role: 'user', content: 'x' }], parse: parseNum });
  ok(!JSON.stringify(r).includes('mock-gw-key'), '结果不含密钥');
  const header = calls[0].init?.headers?.Authorization;
  ok(header === 'Bearer mock-gw-key', '密钥只走 Authorization header', String(header));
}

// ---------- 汇总 ----------
globalThis.fetch = realFetch;
for (const k of ['AGENT_LLM_API_KEY', 'AGENT_LLM_BASE_URL', 'AGENT_LLM_MODEL']) delete process.env[k];
console.log(`\n========================================`);
console.log(`model-gateway-test 结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.error('失败项：');
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('结构化输出网关测试全部通过 ✔');
