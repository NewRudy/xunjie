#!/usr/bin/env node
// PECC 引擎冒烟验收：contracts/acceptance-matrix.md §P2 逐行 + 巡检闭环端到端（P4 前置依赖）
// 用法：先启动引擎（pnpm start，端口 8787），再执行 node scripts/smoke.mjs
// 退出码：全绿 0；任何断言失败 1。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.ENGINE_URL ?? 'http://localhost:8787';
const POLICY_PATH = fileURLToPath(new URL('../../data/policy/gz-2026-08.json', import.meta.url));
const pack = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));

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

async function req(method, path, body) {
  const resp = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留原文 */
  }
  return { status: resp.status, json, text };
}
const get = (path) => req('GET', path);
const post = (path, body) => req('POST', path, body ?? {});

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const addDays = (d, n) => {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

// ---------- 准备：演示复位（异常重新注入、任务清空），挑选近期最晴天 ----------
await post('/api/debug/reset');

section('P2-0 预检：健康与最晴天选择');
const health = await get('/api/health');
ok(health.status === 200 && health.json.ok === true, 'GET /api/health 可用');

// 近 30 天（不含今天）里挑"日总辐照最大且正午平滑"的一天，用于 P2-2 形态与异常注入检查
const wx = await get(`/api/weather?from=${addDays(today, -30)}&to=${addDays(today, -1)}`);
ok(wx.status === 200 && wx.json.series.length === 30 * 24, '气象 30 天序列完整', `len=${wx.json?.series?.length}`);
const byDay = new Map();
for (const h of wx.json.series) {
  const d = h.ts.slice(0, 10);
  if (!byDay.has(d)) byDay.set(d, []);
  byDay.get(d).push(h);
}
let sunnyDate = null;
let bestScore = -1;
for (const [d, hours] of byDay) {
  const daily = hours.reduce((s, h) => s + h.ghi, 0) / 1000; // kWh/m²
  const midday = hours.slice(10, 16).map((h) => h.ghi);
  const smooth = Math.min(...midday) / (Math.max(...midday) || 1);
  const score = smooth * 100 + daily; // 平滑优先，其次总量
  if (score > bestScore) {
    bestScore = score;
    sunnyDate = d;
  }
}
const sunnyGhi = [...byDay.get(sunnyDate)].map((h) => h.ghi);
console.log(`  · 选用最晴天 ${sunnyDate}（日总辐照 ${r2(sunnyGhi.reduce((a, b) => a + b, 0) / 1000)} kWh/m²，来源 ${wx.json.meta.source}）`);

// ---------- P2-1 接口齐 ----------
section('P2-1 接口齐（engine-io.md §1-8，结构符合合同）');

const park = await get('/api/park');
ok(park.status === 200 && park.json.fictional === true && park.json.buildings.length === 6, '§1 GET /api/park：fixture 透传（6 栋楼、虚构标注）');
ok(
  park.json.inverters.every((i) => typeof i.status === 'string' && typeof i.livePowerKw === 'number'),
  '§1 /api/park：每台设备附加 status + livePowerKw',
);

const node = await get('/api/node/STR-B2-07');
ok(node.status === 200 && node.json.id === 'STR-B2-07' && node.json.semanticCard && node.json.today && Array.isArray(node.json.children), '§1 GET /api/node/{id}：语义卡+状态+当日摘要+子节点');
const node404 = await get('/api/node/NOPE-99');
ok(node404.status === 404 && node404.json.error?.code === 'UNKNOWN_NODE', '通用约定：未知 nodeId 返回 404 + error.code');

ok(wx.json.series[0].truth === 'MODELED' && typeof wx.json.meta.synthetic === 'boolean', '§2 GET /api/weather：{ts,ghi,temp,truth} + meta.synthetic');

const genExp = await get(`/api/generation/expected?nodeId=PV-B01-A&date=${sunnyDate}`);
ok(genExp.status === 200 && genExp.json.hourly.length === 24 && genExp.json.truth === 'MODELED' && typeof genExp.json.totalKwh === 'number', '§3 GET /api/generation/expected：逐时 24 点 + 合计 + MODELED');
const genAct = await get(`/api/generation/actual?nodeId=PV-B01-A&date=${sunnyDate}`);
ok(genAct.status === 200 && genAct.json.hourly.length === 24 && genAct.json.truth === 'SIMULATED', '§3 GET /api/generation/actual：逐时 24 点 + SIMULATED');
const genSum = await get(`/api/generation/summary?date=${sunnyDate}`);
ok(
  genSum.status === 200 && typeof genSum.json.achievementPct === 'number' && typeof genSum.json.equivalentHours === 'number' && typeof genSum.json.lossKwh === 'number' && genSum.json.byNode.length === 5,
  '§3 GET /api/generation/summary：装机/应发/实发/达成率/等效小时/损失/分节点',
);

const loadP = await get(`/api/load/profile?nodeId=MT-B01&date=${sunnyDate}`);
ok(loadP.status === 200 && loadP.json.series.length === 96 && loadP.json.resolutionMin === 15, '§4 GET /api/load/profile：15 分钟级 96 点');
const loadAgg = await get(`/api/load/profile?aggregate=park&date=${sunnyDate}`);
ok(loadAgg.status === 200 && loadAgg.json.nodeId === 'PARK-01' && loadAgg.json.series.length === 96, '§4 /api/load/profile?aggregate=park：园区总负荷');
const loadF = await get(`/api/load/forecast?date=${today}`);
ok(loadF.status === 200 && loadF.json.hourly.length === 24 && loadF.json.truth === 'MODELED', '§4 GET /api/load/forecast：逐时 24 点 + MODELED');
const bal = await get(`/api/load/balance?date=${sunnyDate}`);
ok(bal.status === 200 && bal.json.series.length === 24 && ['ts', 'pvKw', 'loadKw', 'essKw', 'gridKw', 'truth'].every((k) => k in bal.json.series[0]), '§4 GET /api/load/balance：24 行五元组');

const tariff = await get(`/api/tariff?date=${sunnyDate}`);
ok(tariff.status === 200 && tariff.json.segments.length === 24 && tariff.json.segments[0].truth === 'POLICY' && Array.isArray(tariff.json.policyRef), '§5 GET /api/tariff：24 段 + POLICY + policyRef');
const strat = await get(`/api/strategy?date=${sunnyDate}`);
ok(
  strat.status === 200 && strat.json.cards.length === 4 && ['ess_arbitrage', 'ev_shift', 'demand_control', 'curtailment_guard'].every((m, i) => strat.json.cards[i].mode === m),
  '§5 GET /api/strategy：四种 mode 策略卡',
);
ok(strat.json.cards.every((c) => typeof c.deltaYuan === 'number' && c.basis?.calc && c.basis.policyRef.length > 0 && c.truth === 'MODELED'), '§5 策略卡结构：deltaYuan + basis.calc + policyRef + truth');

const anom = await get(`/api/anomalies?date=${sunnyDate}&status=all`);
ok(anom.status === 200 && Array.isArray(anom.json.anomalies) && anom.json.anomalies[0]?.id === 'ANOM-DEMO-01' && anom.json.anomalies[0]?.evidence, '§6 GET /api/anomalies：demo 异常 + evidence');

const report = await get(`/api/report/monthly?month=${today.slice(0, 7)}`);
ok(report.status === 200 && report.json.park && report.json.byArray?.length === 5 && report.json.ess && report.json.ev && report.json.demand && report.json.anomalies, '§8 GET /api/report/monthly：分账/储能/EV/需量/异常各段齐');

const badDate = await get('/api/tariff?date=2026-13-99');
ok(badDate.status === 400 && badDate.json.error?.code && badDate.json.error?.message, '通用约定：错误格式 {error:{code,message}} + 语义化状态码');

// ---------- P2-2 应发合理 ----------
section('P2-2 应发合理（晴天单峰 + 年累计 955±5%）');
{
  const s = genExp.json.hourly.map((h) => h.expectedKwh);
  const max = Math.max(...s);
  const hmax = s.indexOf(max);
  ok(hmax >= 10 && hmax <= 15, `晴天 ${sunnyDate} PV-B01-A 应发峰值落在 10-15 时`, `峰值在 ${hmax} 时`);
  ok(s[7] < 0.6 * max && s[19] < 0.6 * max, '晨昏低发（7 时、19 时 < 60% 峰值）');
  let dips = 0;
  let runMax = 0;
  for (let h = 8; h <= hmax; h++) {
    if (s[h] < 0.55 * runMax) dips++;
    runMax = Math.max(runMax, s[h]);
  }
  ok(dips <= 1, `上升段基本单峰（显著回落次数 ${dips} ≤ 1）`);
  ok(s.slice(0, 6).every((v) => v === 0) && max > 0, '夜间为 0、日间有发电');
}
const y2025 = await get('/api/generation/annual-yield?year=2025');
ok(y2025.status === 200 && Math.abs(y2025.json.kwhPerKwp - 955) / 955 <= 0.05, `年累计自检 2025：${y2025.json.kwhPerKwp} kWh/kWp（955±5%，来源 ${y2025.json.weatherSource}）`);

// ---------- P2-3 负荷侧成立 ----------
section('P2-3 负荷侧成立（96 点、需量≤1500、形态符合 §3）');
{
  ok(loadP.json.series.length === 96, 'MT-B01 96 点/日');
  const parkSeries = loadAgg.json.series;
  const maxD = Math.max(...parkSeries.map((p) => p.kw));
  ok(maxD <= 1500, `园区最大需量 ${r3(maxD)} kW ≤ 1500 kW`);
  // 工作日两班制形态：8-12 高、0-6 基载低、午休 12 时回落
  const workday = sunnyDate;
  const prod = (await get(`/api/load/profile?nodeId=MT-B01&date=${workday}`)).json.series;
  const hAvg = (s, h) => avg(s.slice(h * 4, h * 4 + 4).map((p) => p.kw));
  ok(avg([8, 9, 10, 11].map((h) => hAvg(prod, h))) > 3 * avg([0, 1, 2, 3].map((h) => hAvg(prod, h))), '两班制：上午高峰 ≫ 夜间基载');
  ok(hAvg(prod, 12) < hAvg(prod, 13), '两班制：午休 12 时回落、13 时恢复');
  // 办公形态与周末因子（本周六/日对比工作日）
  const sat = addDays(today, ((6 - new Date(`${today}T00:00:00Z`).getUTCDay()) % 7) || 7); // 未来周六
  const mon = addDays(sat, 2); // 下周一
  const offWork = (await get(`/api/load/profile?nodeId=MT-B04&date=${mon}`)).json.series;
  const offWeekend = (await get(`/api/load/profile?nodeId=MT-B04&date=${sat}`)).json.series;
  const dayAvg = (s) => avg(s.slice(9 * 4, 17 * 4).map((p) => p.kw));
  ok(dayAvg(offWeekend) < 0.3 * dayAvg(offWork), `办公：周末（${sat}）日间均值 < 30% 工作日（${mon}）`);
  // 宿舍双峰
  const dorm = (await get(`/api/load/profile?nodeId=MT-B05&date=${workday}`)).json.series;
  ok(hAvg(dorm, 20) > 2.5 * hAvg(dorm, 14) && hAvg(dorm, 7) > 2 * hAvg(dorm, 14), '宿舍：早晚双峰 > 白天');
  // EV：base 窗口 9-17、shifted 窗口 0-8，日充电量一致
  const evBase = (await get(`/api/load/profile?nodeId=EV-02&date=${workday}`)).json.series;
  const evShift = (await get(`/api/load/profile?nodeId=EV-02&date=${workday}&window=shifted`)).json.series;
  const inWindow = (s, lo, hi) => s.every((p, b) => p.kw === 0 || (b / 4 >= lo && b / 4 < hi));
  const eBase = evBase.reduce((s, p) => s + p.kw * 0.25, 0);
  const eShift = evShift.reduce((s, p) => s + p.kw * 0.25, 0);
  ok(inWindow(evBase, 9, 17), 'EV base 曲线全部落在 9-17 窗口');
  ok(inWindow(evShift, 0, 8), 'EV shifted 曲线全部落在 0-8 谷段窗口（平移前后都可查）');
  ok(Math.abs(eBase - eShift) < 0.01, `EV 平移前后日充电量一致（${r3(eBase)} vs ${r3(eShift)} kWh）`);
}

// ---------- P2-4 发用电平衡 ----------
section('P2-4 逐时平衡闭合（±0.1kW）');
{
  const worst = Math.max(...bal.json.series.map((r) => Math.abs(r.pvKw + r.essKw + r.gridKw - r.loadKw)));
  ok(worst <= 0.1, `24 行 |pv+ess+grid-load| 最大偏差 ${worst.toExponential(2)} kW ≤ 0.1`);
}

// ---------- P2-5 策略卡算式复核 ----------
section('P2-5 策略卡可手算复核（程序重算 deltaYuan）');
{
  const cards = strat.json.cards;
  const seg = tariff.json.segments;
  const peakP = seg.find((s) => s.period === 'peak').priceYuanKwh;
  const valleyP = seg.find((s) => s.period === 'valley').priceYuanKwh;
  const c1 = cards[0];
  ok(Math.abs(c1.deltaYuan - r2(c1.basis.inputs.capacityKwh * (c1.basis.inputs.peakPriceYuanKwh - c1.basis.inputs.valleyPriceYuanKwh) * c1.basis.inputs.roundTripEfficiency)) < 0.01, `ess_arbitrage 重算一致（${c1.deltaYuan} 元）`);
  ok(c1.basis.inputs.peakPriceYuanKwh === peakP && c1.basis.inputs.valleyPriceYuanKwh === valleyP, 'ess_arbitrage 输入价与 /api/tariff 一致');

  const c2 = cards[1];
  // 独立重算：4 台桩 base 曲线逐时能量 × 逐时电价 → 原窗口加权均价
  let hourlyE = new Array(24).fill(0);
  for (const ev of ['EV-01', 'EV-02', 'EV-03', 'EV-04']) {
    const p = (await get(`/api/load/profile?nodeId=${ev}&date=${sunnyDate}`)).json.series;
    p.forEach((pt, b) => (hourlyE[Math.floor(b / 4)] += pt.kw * 0.25));
  }
  const totalE = hourlyE.reduce((a, b) => a + b, 0);
  const wAvg = hourlyE.reduce((s, e, h) => s + e * seg[h].priceYuanKwh, 0) / totalE;
  ok(Math.abs(c2.basis.inputs.energyKwh - r3(totalE)) < 0.01, `ev_shift 充电量与负荷曲线一致（${c2.basis.inputs.energyKwh} vs ${r3(totalE)} kWh）`);
  ok(Math.abs(c2.basis.inputs.originalAvgPriceYuanKwh - r3(wAvg)) < 0.001, `ev_shift 原窗口加权均价独立重算一致（${c2.basis.inputs.originalAvgPriceYuanKwh} vs ${r3(wAvg)}）`);
  // deltaYuan 按卡面声明的输入重算（手算复核口径：calc 字符串中的数字）
  const c2in = c2.basis.inputs;
  ok(Math.abs(c2.deltaYuan - r2(c2in.energyKwh * (c2in.originalAvgPriceYuanKwh - c2in.shiftedPriceYuanKwh))) < 0.01, `ev_shift deltaYuan 重算一致（${c2.deltaYuan} 元）`);

  const c3 = cards[2];
  const parkMax = Math.max(...(await get(`/api/load/profile?nodeId=PARK-01&date=${sunnyDate}`)).json.series.map((p) => p.kw));
  ok(Math.abs(c3.basis.inputs.maxDemandKw - r3(parkMax)) < 0.01, `demand_control 最大需量与园区曲线一致（${c3.basis.inputs.maxDemandKw} vs ${r3(parkMax)} kW）`);
  ok(Math.abs(c3.deltaYuan - r2((c3.basis.inputs.shavedKw * c3.basis.inputs.demandPriceYuanKwMonth) / 30)) < 0.01, `demand_control 重算一致（${c3.deltaYuan} 元/日）`);
  ok(c3.basis.inputs.demandPriceYuanKwMonth === pack.twoPartTariff.kv10.demandYuanKwMonth, 'demand_control 需量电价与政策包一致');

  const c4 = cards[3];
  const surplus = r3(bal.json.series.reduce((s, r) => s + Math.max(0, r.pvKw - r.loadKw), 0));
  ok(Math.abs(c4.basis.inputs.surplusKwh - surplus) < 0.01, `curtailment_guard 富余电量与平衡视图一致（${c4.basis.inputs.surplusKwh} vs ${surplus} kWh）`);
  ok(Math.abs(c4.deltaYuan - r2(c4.basis.inputs.surplusKwh * c4.basis.inputs.spreadYuanKwh)) < 0.01, `curtailment_guard 重算一致（${c4.deltaYuan} 元）`);
  ok(c4.basis.inputs.feedInPriceYuanKwh === pack.feedInReference.valueYuanKwh, 'curtailment_guard 上网参考价与政策包一致');

  ok(c1.basis.policyRef.includes('黔发改价格〔2023〕481号') && c3.basis.policyRef.includes('黔发改价格〔2026〕421号'), 'policyRef 文号挂接正确（481 分时 / 421 需量）');
}

// ---------- P2-6 确定性 ----------
section('P2-6 确定性（同参数两次逐字节一致，fetched_at 类除外）');
{
  const paths = [
    `/api/tariff?date=${sunnyDate}`,
    `/api/generation/expected?nodeId=PV-B01-A&date=${sunnyDate}`,
    `/api/generation/actual?nodeId=STR-B2-07&date=${sunnyDate}`,
    `/api/generation/summary?date=${sunnyDate}`,
    `/api/load/profile?nodeId=PARK-01&date=${sunnyDate}`,
    `/api/load/balance?date=${sunnyDate}`,
    `/api/load/forecast?date=${sunnyDate}`,
    `/api/strategy?date=${sunnyDate}`,
    `/api/anomalies?date=${sunnyDate}&status=all`,
    `/api/report/monthly?month=${sunnyDate.slice(0, 7)}`,
  ];
  for (const p of paths) {
    const [a, b] = [await get(p), await get(p)];
    ok(a.text === b.text, `两次调用逐字节一致：${p}`);
  }
  // 气象接口：fetchedAt 为缓存时间（P2-6 豁免字段），归一化后比较
  const w1 = (await get(`/api/weather?from=${sunnyDate}&to=${sunnyDate}`)).text.replace(/"fetchedAt":("[^"]*"|null)/, '"fetchedAt":*');
  const w2 = (await get(`/api/weather?from=${sunnyDate}&to=${sunnyDate}`)).text.replace(/"fetchedAt":("[^"]*"|null)/, '"fetchedAt":*');
  ok(w1 === w2, '两次调用一致（fetchedAt 归一化）：/api/weather');
}

// ---------- P2-7 电价正确 ----------
section('P2-7 电价时段与价格对政策包（481 号文）');
{
  const seg = tariff.json.segments;
  const periodExpect = (h) => {
    if (h < 8) return 'valley';
    if (h < 10) return 'flat';
    if (h < 13) return 'peak';
    if (h < 17) return 'flat';
    if (h < 22) return 'peak';
    return 'flat';
  };
  ok(seg.every((s, h) => s.period === periodExpect(h)), '24 段峰平谷划分 = 481 号文（峰 10-13/17-22，平 8-10/13-17/22-24，谷 0-8）');
  const priceOf = (p) => seg.find((s) => s.period === p).priceYuanKwh;
  ok(priceOf('flat') === pack.derived.flatYuanKwh && priceOf('peak') === pack.derived.peakYuanKwh && priceOf('valley') === pack.derived.valleyYuanKwh, `价格 = 政策包：平 ${priceOf('flat')} / 峰 ${priceOf('peak')} / 谷 ${priceOf('valley')}`);
  ok(tariff.json.policyRef.some((r) => r.id === '黔发改价格〔2023〕481号'), 'policyRef 含 481 号文');
}

// ---------- 巡检闭环端到端（P4-3/P4-4 引擎层保证） ----------
section('巡检闭环端到端（状态机强制 + 闭环恢复）');
{
  // 闭环前先确认注入可见：STR-B2-07 在 ghi>200 时段实发 ≈ 应发 × 0.82
  const actBefore = (await get(`/api/generation/actual?nodeId=STR-B2-07&date=${sunnyDate}`)).json.hourly;
  const injHours = actBefore.filter((h) => h.anomalyInjected);
  ok(injHours.length > 0, `异常注入可见：${injHours.length} 个小时被注入（ghi>200）`);
  ok(
    injHours.every((h) => h.actualKwh / h.expectedKwh > 0.79 && h.actualKwh / h.expectedKwh < 0.85),
    '注入时段实发 ≈ 应发 ×0.82（含 ±2% 噪声）',
  );
  const invB02 = (await get(`/api/generation/actual?nodeId=INV-B-02&date=${sunnyDate}`)).json;
  ok(invB02.hourly.some((h) => h.anomalyInjected), '连带可见：INV-B-02 汇总含注入标记');

  const create = await post('/api/inspection/tasks', { anomalyId: 'ANOM-DEMO-01', nodeId: 'STR-B2-07' });
  ok(create.status === 201 && create.json.status === 'created', `建任务 → created（${create.json.id}）`);
  const tid = create.json.id;

  const illegal = await post(`/api/inspection/tasks/${tid}/events`, { event: 'arrive_front' });
  ok(illegal.status === 409 && illegal.json.error.code === 'ILLEGAL_TRANSITION', '未 dispatch 就 arrive_front → 409');

  ok((await post(`/api/inspection/tasks/${tid}/events`, { event: 'dispatch' })).json.status === 'dispatched', 'dispatch → dispatched');
  const front = await post(`/api/inspection/tasks/${tid}/events`, { event: 'arrive_front' });
  ok(front.json.status === 'onsite' && front.json.transitions.some((t) => t.to === 'enroute'), 'arrive_front → onsite（途经 enroute 有迁移记录）');
  ok((await post(`/api/inspection/tasks/${tid}/events`, { event: 'arrive_roof' })).json.status === 'inspecting', 'arrive_roof → inspecting');

  const earlyResolve = await post(`/api/inspection/tasks/${tid}/events`, { event: 'resolve' });
  ok(earlyResolve.status === 409, '未提交证据直接 resolve → 409');

  const ev1 = await post(`/api/inspection/tasks/${tid}/evidence`, { checkpointId: 'CP-B02-FRONT', kind: 'photo', value: '楼前外观照片（模拟）', ts: `${today}T10:05:00+08:00` });
  ok(ev1.status === 201 && ev1.json.id, `提交非 ROOF 证据（${ev1.json.id}）`);
  ok((await post(`/api/inspection/tasks/${tid}/events`, { event: 'submit_evidence' })).json.status === 'evidence-submitted', 'submit_evidence → evidence-submitted');

  const noRoof = await post(`/api/inspection/tasks/${tid}/events`, { event: 'resolve' });
  ok(noRoof.status === 409 && noRoof.json.error.code === 'EVIDENCE_MISSING', '非 ROOF 证据 resolve → 409 EVIDENCE_MISSING');

  const ev2 = await post(`/api/inspection/tasks/${tid}/evidence`, { checkpointId: 'CP-B02-ROOF', kind: 'thermal', value: '屋面热成像：STR-B2-07 区域热斑（模拟）', ts: `${today}T10:25:00+08:00` });
  ok(ev2.status === 201, '提交 CP-B02-ROOF 热成像证据');
  ok((await post(`/api/inspection/tasks/${tid}/events`, { event: 'resolve' })).json.status === 'resolved', 'resolve → resolved');

  const detail = await get(`/api/inspection/tasks/${tid}`);
  ok(detail.json.transitions.every((t) => t.ts && t.operator) && detail.json.evidence.length === 2, '任务详情：完整时间线（时间戳+操作人）+ 证据链');

  const close = await post(`/api/inspection/tasks/${tid}/close`);
  ok(close.status === 200 && close.json.closedAt && close.json.anomalyResolved === true, 'close → 闭环，引擎撤销异常注入');

  // P4-4 引擎层保证：close 后实发回到 ±2% 区间（微小时段 <0.5kWh 受三位舍入影响，按合同口径检查有效发电时段）
  const actAfter = (await get(`/api/generation/actual?nodeId=STR-B2-07&date=${sunnyDate}`)).json.hourly;
  const effective = actAfter.filter((h) => h.expectedKwh >= 0.5);
  const worst = Math.max(...effective.map((h) => Math.abs(h.actualKwh / h.expectedKwh - 1)));
  ok(worst <= 0.02, `P4-4 闭环恢复：有效时段 |实发/应发-1| 最大 ${(worst * 100).toFixed(2)}% ≤ 2%`);
  ok(actAfter.every((h) => !h.anomalyInjected), '闭环后无任何注入标记');

  const anomAfter = (await get(`/api/anomalies?date=${sunnyDate}&status=all`)).json.anomalies[0];
  ok(anomAfter.status === 'resolved' && anomAfter.closedAt, '异常状态 → resolved（损失估算随注入撤销归零）');
  const reportAfter = (await get(`/api/report/monthly?month=${today.slice(0, 7)}`)).json.anomalies;
  ok(reportAfter.closed === 1 && reportAfter.closureRatePct === 100 && reportAfter.avgClosureHours >= 0, `月报闭环统计：闭环率 100%，平均闭环 ${reportAfter.avgClosureHours}h，挽回 ${reportAfter.recoveredKwh}kWh`);

  const task404 = await get('/api/inspection/tasks/TASK-NOPE');
  ok(task404.status === 404 && task404.json.error.code === 'NOT_FOUND', '未知任务 ID → 404');
}

// ---------- 汇总 ----------
console.log(`\n========================================`);
console.log(`smoke 结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.error('失败项：');
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('§P2 全部验收通过 ✔');
