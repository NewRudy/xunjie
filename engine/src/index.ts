// PECC 确定性引擎入口（Hono，端口 8787，CORS 放开给 web dev server 5173）
// 合同：contracts/engine-io.md §1-8 全部接口；通用约定：
//   - 时间参数 YYYY-MM-DD / ISO 8601（Asia/Shanghai）
//   - 数值字段带 truth 标签；金额元、功率 kW、电量 kWh、辐照 W/m²
//   - 错误 { "error": { "code", "message" } }；未知 nodeId → 404
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

// 本机开发凭据从 engine/.env 加载（gitignored；不覆盖已有环境变量，无 .env 时静默跳过）
// 放在所有 import 之后、任何 env 读取之前——voice.ts 等在请求时才读 env，这里启动时加载即可
try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch { /* 无 .env：相关功能显式未启用 */ }
import { getWeatherRange } from './weather';
import { actualSeries, annualYieldCheck, ensureCalibration, expectedSeries, PVGIS_ANCHOR_KWH_KWP, totalParkKwp } from './generation';
import { loadForecastHourly, loadProfile15 } from './load';
import { balanceDaily } from './balance';
import { policyPack, policyRefFor, tariffSegments } from './tariff';
import { strategyCards } from './strategy';
import { listAnomalies } from './anomalies';
import { addEvidence, closeTask, createTask, getTask, pushEvent, resetTasks, TransitionError } from './inspection';
import { resetAnomaly } from './anomalyState';
import { monthlyReport } from './report';
import { nodeDetail, parkWithLive } from './nodes';
import { fixture, hasNode } from './fixture';
import { isValidDate, isValidMonth, r2, r3, todayShanghai } from './util';
import { agentRoutes } from './agent/routes';
import { resetAgentData } from './agent/store';

const PORT = Number(process.env.PORT ?? 8787);
const app = new Hono();

app.use('*', cors()); // web dev server（5173）跨域访问

// —— 通用错误格式与参数守卫（均直接返回 Response，保证 Hono 处理器始终有返回值）——
const err = (c: any, status: number, code: string, message: string) => c.json({ error: { code, message } }, status as any);

// —— 访问口令（部署公网时设 AGENT_ACCESS_KEY；本地 dev 不设则不校验）——
const ACCESS_KEY = process.env.AGENT_ACCESS_KEY ?? '';
if (ACCESS_KEY) {
  app.use('/api/*', async (c, next) => {
    const key = c.req.query('key') ?? c.req.header('x-agent-key');
    if (key !== ACCESS_KEY) return err(c, 401, 'UNAUTHORIZED', '缺少或错误的访问口令（query ?key= 或 header x-agent-key）');
    await next();
  });
}

/** date 查询参数：缺省今天；非法 → 400 Response；合法 → 日期串 */
function dateArg(c: any): string | Response {
  const v = c.req.query('date') ?? todayShanghai();
  return isValidDate(v) ? v : err(c, 400, 'BAD_DATE', `参数 date 须为 YYYY-MM-DD，收到: ${v}`);
}

/** nodeId 查询参数：缺失 → 400；未知 → 404；合法 → ID */
function nodeArg(c: any): string | Response {
  const v = c.req.query('nodeId');
  if (!v) return err(c, 400, 'MISSING_NODE', '缺少参数 nodeId');
  if (!hasNode(v)) return err(c, 404, 'UNKNOWN_NODE', `未知 nodeId: ${v}（须来自语义树 semantic-tree.md）`);
  return v;
}

// —— §0 健康检查 ——
app.get('/api/health', (c) => c.json({ ok: true, service: 'pecc-engine', policyPack: policyPack.id }));

// —— §1 场景与资产 ——
app.get('/api/park', async (c) => c.json(await parkWithLive()));

app.get('/api/node/:nodeId', async (c) => {
  const nodeId = c.req.param('nodeId');
  if (!hasNode(nodeId)) return err(c, 404, 'UNKNOWN_NODE', `未知 nodeId: ${nodeId}（须来自语义树 semantic-tree.md）`);
  return c.json(await nodeDetail(nodeId));
});

// —— §2 气象 ——
app.get('/api/weather', async (c) => {
  const today = todayShanghai();
  const from = c.req.query('from') ?? today;
  const to = c.req.query('to') ?? from;
  if (!isValidDate(from) || !isValidDate(to) || from > to) {
    return err(c, 400, 'BAD_DATE', `from/to 须为 YYYY-MM-DD 且 from<=to，收到 from=${from} to=${to}`);
  }
  if (Math.round((Date.parse(`${to}Z`) - Date.parse(`${from}Z`)) / 86400000) > 370) return err(c, 400, 'RANGE_TOO_LARGE', '区间超过 370 天');
  const w = await getWeatherRange(from, to);
  return c.json({
    from,
    to,
    lat: w.meta.lat,
    lon: w.meta.lon,
    timezone: 'Asia/Shanghai',
    meta: { source: w.meta.source, synthetic: w.meta.synthetic, fetchedAt: w.meta.fetchedAt, cache: 'SQLite：历史永久，预报 6 小时' },
    series: w.hours.map((h) => ({ ts: h.ts, ghi: h.ghi, temp: h.temp, truth: 'MODELED' })),
  });
});

// —— §3 发电 ——
app.get('/api/generation/expected', async (c) => {
  const nodeId = nodeArg(c);
  if (nodeId instanceof Response) return nodeId;
  const date = dateArg(c);
  if (date instanceof Response) return date;
  const res = await expectedSeries(nodeId, date);
  if (!res) return err(c, 400, 'NO_PV', `节点 ${nodeId} 无光伏发电能力`);
  return c.json({
    nodeId,
    date,
    capacityKwp: res.capacityKwp,
    truth: 'MODELED',
    hourly: res.hourly.map((h) => ({ ts: h.ts, expectedKwh: h.expectedKwh, ghi: h.ghi, temp: h.temp })),
    totalKwh: res.totalKwh,
    basis: {
      formula: 'expectedKwh(h) = capacityKwp × (ghi(h)/1000) × tempDerate(h) × systemLoss(0.82) × pvgisCalibration（交流侧按逆变器额定和截顶）',
      anchorKwhKwpYear: PVGIS_ANCHOR_KWH_KWP,
      dataRef: [`/api/weather?from=${date}&to=${date}`],
    },
  });
});

app.get('/api/generation/actual', async (c) => {
  const nodeId = nodeArg(c);
  if (nodeId instanceof Response) return nodeId;
  const date = dateArg(c);
  if (date instanceof Response) return date;
  const res = await actualSeries(nodeId, date);
  if (!res) return err(c, 400, 'NO_PV', `节点 ${nodeId} 无光伏发电能力`);
  return c.json({
    nodeId,
    date,
    capacityKwp: res.capacityKwp,
    truth: 'SIMULATED',
    hourly: res.hourly.map((h) => ({ ts: h.ts, actualKwh: h.actualKwh, expectedKwh: h.expectedKwh, anomalyInjected: h.anomalyInjected })),
    totalKwh: res.totalKwh,
    expectedTotalKwh: res.expectedTotalKwh,
    basis: { formula: 'actual = expected × 异常因子 × (1 ± 2% 噪声)，种子 = hash(nodeId + date)；异常规则见 data-contracts.md §4' },
  });
});

app.get('/api/generation/summary', async (c) => {
  const date = dateArg(c);
  if (date instanceof Response) return date;
  const park = await actualSeries('PARK-01', date);
  if (!park) return err(c, 500, 'INTERNAL', '园区发电序列不可用');
  const byNode = [];
  for (const arr of fixture.pvArrays) {
    const a = await actualSeries(arr.id, date);
    byNode.push({
      pvArrayId: arr.id,
      capacityKwp: arr.peakKwp,
      expectedKwh: a?.expectedTotalKwh ?? 0,
      actualKwh: a?.totalKwh ?? 0,
      achievementPct: a && a.expectedTotalKwh > 0 ? r2((a.totalKwh / a.expectedTotalKwh) * 100) : 0,
      lossKwh: a ? Math.max(0, r3(a.expectedTotalKwh - a.totalKwh)) : 0,
      truth: 'SIMULATED',
    });
  }
  return c.json({
    date,
    totalCapacityKwp: totalParkKwp(),
    expectedKwh: park.expectedTotalKwh,
    actualKwh: park.totalKwh,
    achievementPct: park.expectedTotalKwh > 0 ? r2((park.totalKwh / park.expectedTotalKwh) * 100) : 0,
    equivalentHours: r3(park.totalKwh / totalParkKwp()),
    lossKwh: Math.max(0, r3(park.expectedTotalKwh - park.totalKwh)),
    truth: 'SIMULATED',
    byNode,
  });
});

/** 年产自检（验收 P2-2 用，附加端点）：年累计是否收敛 955 kWh/kWp ±5% */
app.get('/api/generation/annual-yield', async (c) => {
  const year = Number(c.req.query('year') ?? '2025');
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return err(c, 400, 'BAD_YEAR', `year 须为 2000-2100 整数，收到: ${c.req.query('year')}`);
  const check = await annualYieldCheck(year);
  return c.json({ ...check, truth: 'MODELED', basis: '园区全子阵应发年累计 ÷ 总装机；标定常数持久化于引擎 kv 存储' });
});

// —— §4 用电 ——
app.get('/api/load/profile', (c) => {
  const date = dateArg(c);
  if (date instanceof Response) return date;
  const aggregate = c.req.query('aggregate');
  const window = c.req.query('window') ?? 'base';
  if (window !== 'base' && window !== 'shifted') return err(c, 400, 'BAD_WINDOW', `window 仅支持 base|shifted，收到: ${window}`);
  let nodeId = c.req.query('nodeId') ?? (aggregate === 'park' ? 'PARK-01' : null);
  if (!nodeId) return err(c, 400, 'MISSING_NODE', '缺少参数 nodeId（或 aggregate=park）');
  if (aggregate === 'park') nodeId = 'PARK-01';
  if (!hasNode(nodeId)) return err(c, 404, 'UNKNOWN_NODE', `未知 nodeId: ${nodeId}`);
  let series;
  try {
    series = loadProfile15(nodeId, date, window as 'base' | 'shifted');
  } catch {
    return err(c, 400, 'NO_LOAD', `节点 ${nodeId} 无负荷曲线（支持 MT-B01..06、EV-01..04、PARK-01）`);
  }
  return c.json({ nodeId, date, window, resolutionMin: 15, points: series.length, truth: 'SIMULATED', series: series.map((p) => ({ ts: p.ts, kw: p.kw, truth: 'SIMULATED' })) });
});

app.get('/api/load/forecast', async (c) => {
  const date = dateArg(c);
  if (date instanceof Response) return date;
  const hourly = await loadForecastHourly(date);
  return c.json({
    date,
    truth: 'MODELED',
    hourly: hourly.map((kw, h) => ({ ts: `${date}T${String(h).padStart(2, '0')}:00`, kw, truth: 'MODELED' })),
    basis: {
      rule: '同日历类型基线（无抖动）× 温度修正（非 EV 部分 1+0.008×(T-26℃)，限幅 [0.9,1.1]）；EV 按车队期望 60kWh/辆 均布 9-17 时',
      dataRef: [`/api/weather?from=${date}&to=${date}`],
    },
  });
});

app.get('/api/load/balance', async (c) => {
  const date = dateArg(c);
  if (date instanceof Response) return date;
  const rows = await balanceDaily(date);
  return c.json({ date, convention: 'gridKw>0 购电、<0 上网；essKw 正放负充；逐时 pvKw+essKw+gridKw==loadKw', series: rows });
});

// —— §5 价格与策略 ——
app.get('/api/tariff', (c) => {
  const date = dateArg(c);
  if (date instanceof Response) return date;
  return c.json({ date, policyVersion: policyPack.id, policyRef: policyRefFor(), versionNote: policyPack.versionNote, segments: tariffSegments() });
});

app.get('/api/strategy', async (c) => {
  const date = dateArg(c);
  if (date instanceof Response) return date;
  const cards = await strategyCards(date);
  return c.json({ date, policyVersion: policyPack.id, cards });
});

// —— §6 异常与告警 ——
app.get('/api/anomalies', async (c) => {
  const date = dateArg(c);
  if (date instanceof Response) return date;
  const status = c.req.query('status') ?? 'open';
  if (status !== 'open' && status !== 'all') return err(c, 400, 'BAD_STATUS', `status 仅支持 open|all，收到: ${status}`);
  return c.json({ date, status, anomalies: await listAnomalies(date, status) });
});

// —— §7 巡检闭环 ——
app.post('/api/inspection/tasks', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.anomalyId !== 'string' || typeof body.nodeId !== 'string') {
    return err(c, 400, 'BAD_BODY', '入参须为 { anomalyId, nodeId, assignee? }');
  }
  const res = createTask({ anomalyId: body.anomalyId, nodeId: body.nodeId, assignee: body.assignee });
  if ('error' in res) return err(c, res.code, 'CREATE_FAILED', res.error);
  return c.json(res.task, (res.existed ? 200 : 201) as any);
});

app.get('/api/inspection/tasks/:id', (c) => {
  const task = getTask(c.req.param('id'));
  if (!task) return err(c, 404, 'NOT_FOUND', `任务 ${c.req.param('id')} 不存在`);
  return c.json(task);
});

/** 状态机事件/证据的错误码 → HTTP：NOT_FOUND→404，入参类→400，状态机类→409 */
function transitionErr(c: any, e: unknown) {
  if (e instanceof TransitionError) {
    const status = e.code === 'NOT_FOUND' ? 404 : e.code.startsWith('UNKNOWN') ? 400 : 409;
    return err(c, status, e.code, e.message);
  }
  throw e;
}

app.post('/api/inspection/tasks/:id/events', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.event !== 'string') return err(c, 400, 'BAD_BODY', '入参须为 { event, payload? }');
  try {
    return c.json(pushEvent(c.req.param('id'), body.event, body.payload));
  } catch (e) {
    return transitionErr(c, e);
  }
});

app.post('/api/inspection/tasks/:id/evidence', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.checkpointId !== 'string' || typeof body.kind !== 'string') {
    return err(c, 400, 'BAD_BODY', '入参须为 { checkpointId, kind: photo|thermal|reading|note, value, ts? }');
  }
  try {
    return c.json(addEvidence(c.req.param('id'), { checkpointId: body.checkpointId, kind: body.kind, value: String(body.value ?? ''), ts: body.ts }), 201 as any);
  } catch (e) {
    return transitionErr(c, e);
  }
});

app.post('/api/inspection/tasks/:id/close', async (c) => {
  try {
    return c.json(await closeTask(c.req.param('id')));
  } catch (e) {
    return transitionErr(c, e);
  }
});

// —— §8 报表 ——
app.get('/api/report/monthly', async (c) => {
  const month = c.req.query('month');
  if (!isValidMonth(month)) return err(c, 400, 'BAD_MONTH', `参数 month 须为 YYYY-MM，收到: ${month ?? '(缺失)'}`);
  return c.json(await monthlyReport(month!));
});

// —— §9 Agent MissionRuntime（contracts/agent-tools.md §2；实现见 engine/src/agent/） ——
app.route('/api/agent', agentRoutes);

// —— 附加：演示复位（清空巡检任务 + 重新注入 demo 异常；不动气象缓存与标定） ——
app.post('/api/debug/reset', (c) => {
  resetTasks();
  resetAnomaly();
  const agent = resetAgentData();
  return c.json({ ok: true, note: '巡检任务已清空，demoAnomaly 已重新注入；agent missions/events 已清空', agent });
});

// —— 兜底 ——
app.notFound((c) => err(c, 404, 'NOT_FOUND', `路由不存在: ${c.req.method} ${c.req.path}`));
app.onError((e, c) => {
  console.error('[engine] 未捕获异常:', e);
  return err(c, 500, 'INTERNAL', e.message);
});

// —— 启动：先确保 PVGIS 标定常数就绪 ——
const cal = await ensureCalibration();
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[pecc-engine] 确定性引擎已启动: http://localhost:${info.port}（政策包 ${policyPack.id}，PVGIS 标定 ${cal.value.toFixed(4)}，来源 ${cal.source}）`);
});
