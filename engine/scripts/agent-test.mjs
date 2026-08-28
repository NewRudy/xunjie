#!/usr/bin/env node
// Agent MissionRuntime 回放/集成测试（engine/scripts/agent-test.mjs）
// 覆盖：happy path、审批三元组失效/过期、未批准拒绝、缺 ROOF 证据阻塞、重复事件幂等、
//       navigation_failed 阻塞、上下文刷新使旧审批失效、重启恢复（独立进程 + 独立 SQLite）。
// 用法：node scripts/agent-test.mjs（自动拉起两个引擎实例，退出码 0=全绿）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(ENGINE_DIR, 'node_modules/tsx/dist/cli.mjs');

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

async function req(port, method, p, body) {
  const resp = await fetch(`http://localhost:${port}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: resp.status, json, text };
}
const get = (port, p) => req(port, 'GET', p);
const post = (port, p, body) => req(port, 'POST', p, body ?? {});

function startEngine(port, dbFile, extraEnv = {}) {
  const child = spawn(process.execPath, [TSX, 'src/index.ts'], {
    cwd: ENGINE_DIR,
    env: { ...process.env, PORT: String(port), PECC_DB: dbFile, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.env.AGENT_TEST_VERBOSE && process.stderr.write(d));
  return child;
}

async function waitHealth(port, timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await get(port, '/api/health');
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function stopEngine(child) {
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => child.killed && child.kill('SIGKILL'), 3000).unref();
  });
}

// —— 独立临时库（不污染演示库 var/engine.db） ——
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pecc-agent-test-'));
const dbFile = path.join(tmpDir, 'engine.db');
const PORT = 8791;
const EXPIRY_PORT = 8792;

let child = startEngine(PORT, dbFile);
ok(await waitHealth(PORT), '引擎实例启动（临时 SQLite）');

// 选近期最晴天（与 smoke 同口径，保证 ghi>200 时段存在）
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const addDays = (d, n) => {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};
const wx = await get(PORT, `/api/weather?from=${addDays(today, -30)}&to=${addDays(today, -1)}`);
const byDay = new Map();
for (const h of wx.json.series) {
  const d = h.ts.slice(0, 10);
  if (!byDay.has(d)) byDay.set(d, 0);
  byDay.set(d, byDay.get(d) + h.ghi);
}
const sunnyDate = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0][0];

let evSeq = 0;
const nextEvent = (idempotencyKey) => ({ eventId: `EVT-TEST-${String(++evSeq).padStart(4, '0')}`, idempotencyKey: idempotencyKey ?? `idem-${evSeq}` });
const nowIso = () => new Date().toISOString();

// ---------- 澄清：不猜 ID ----------
section('澄清：缺少/未登记 anomalyId 不猜 ID');
{
  const missing = await post(PORT, '/api/agent/missions', { objective: '去看一下 B2 屋顶这个异常', sceneId: 'PECC-PARK-01', sceneRevision: 'fixture-v1' });
  ok(missing.status === 400 && missing.json.error?.code === 'CLARIFICATION_NEEDED', '缺少 anomalyId → 400 CLARIFICATION_NEEDED');
  ok(JSON.stringify(missing.json.clarification?.options ?? []).includes('ANOM-DEMO-01'), '澄清 options 含已登记 ANOM-DEMO-01');

  const unknown = await post(PORT, '/api/agent/missions', { objective: '看看异常', sceneId: 'PECC-PARK-01', sceneRevision: 'fixture-v1', anomalyId: 'ANOM-NOPE' });
  ok(unknown.status === 400 && unknown.json.error?.code === 'CLARIFICATION_NEEDED', '未登记 anomalyId → clarification，不猜测');

  const badScene = await post(PORT, '/api/agent/missions', { objective: 'x', sceneId: 'PECC-PARK-99', sceneRevision: 'fixture-v1' });
  ok(badScene.status === 400 && badScene.json.error?.code === 'CLARIFICATION_NEEDED', '未登记 sceneId → clarification');

  const m404 = await get(PORT, '/api/agent/missions/MSN-9999');
  ok(m404.status === 404 && m404.json.error?.code === 'NOT_FOUND', '未知 mission → 404');
}

// ---------- Happy path ----------
section('Happy path：提案 → 审批 → 巡检推进 → 闭环（ANOM-DEMO-01 / STR-B2-07）');
let mid, task, approval, cmdFront, cmdRoof;
{
  const created = await post(PORT, '/api/agent/missions', {
    objective: '去看一下 B2 屋顶这个异常',
    sceneId: 'PECC-PARK-01',
    sceneRevision: 'fixture-v1',
    operator: '运维员-演示',
    trigger: 'user',
    anomalyId: 'ANOM-DEMO-01',
  });
  ok(created.status === 201 && created.json.status === 'available', '创建 mission → 201 available');
  const d = created.json.data;
  mid = d.mission.missionId;
  ok(d.mission.phase === 'awaiting-approval', `阶段 awaiting-approval（${mid}）`);
  ok(d.mission.nodeId === 'STR-B2-07', '目标解析为已登记 STR-B2-07');
  ok(d.plan?.summary?.includes('屋面证据') && d.plan.summary.includes('CP-B02-ROOF'), '提案说明先取屋面证据，引用 CP-B02-ROOF');
  ok(d.plan.steps.some((s) => s.targetId === 'CP-B02-FRONT'), '提案引用已登记 CP-B02-FRONT');
  approval = d.pendingApproval;
  ok(approval?.approvalId && approval.contextVersion && approval.planHash && approval.impact === 'digital-simulation-only', 'pendingApproval 三元组 + impact 齐备');
  ok(created.json.planner?.mode === 'deterministic-fallback' && created.json.planner?.modelAvailable === false, '模型不可用 → 明确 fallback 标识');
  const scopes = new Set(d.context.items.map((i) => i.scope));
  ok(['mission', 'scene', 'anomaly', 'asset', 'environment', 'sop'].every((s) => scopes.has(s)), `上下文覆盖 mission/scene/anomaly/asset/environment/sop（${[...scopes].join(',')}）`);
  ok(d.context.items.every((i) => Array.isArray(i.sourceRefs) && i.sourceRefs.length > 0 && typeof i.reasonIncluded === 'string'), '每个上下文项带 sourceRefs + reasonIncluded');
  ok(d.context.items.find((i) => i.scope === 'anomaly')?.truth === 'SIMULATED', '异常项 truth=SIMULATED');

  // 审批三元组逐一破坏
  const badHash = await post(PORT, `/api/agent/missions/${mid}/approval`, { approvalId: approval.approvalId, decision: 'approve', contextVersion: approval.contextVersion, planHash: 'PLAN-deadbeef' });
  ok(badHash.status === 403 && badHash.json.error?.code === 'PLAN_HASH_MISMATCH', 'planHash 不匹配 → 403');
  const badVer = await post(PORT, `/api/agent/missions/${mid}/approval`, { approvalId: approval.approvalId, decision: 'approve', contextVersion: 'CTX-0000', planHash: approval.planHash });
  ok(badVer.status === 403 && badVer.json.error?.code === 'CONTEXT_VERSION_MISMATCH', 'contextVersion 不匹配 → 403');
  const badId = await post(PORT, `/api/agent/missions/${mid}/approval`, { approvalId: 'APR-nope', decision: 'approve', contextVersion: approval.contextVersion, planHash: approval.planHash });
  ok(badId.status === 403 && badId.json.error?.code === 'APPROVAL_MISMATCH', 'approvalId 不匹配 → 403');
  const badDecision = await post(PORT, `/api/agent/missions/${mid}/approval`, { approvalId: approval.approvalId, decision: '我同意', contextVersion: approval.contextVersion, planHash: approval.planHash });
  ok(badDecision.status === 400 && badDecision.json.error?.code === 'BAD_DECISION', '自然语言 decision → 400（不解析为同意）');

  const approved = await post(PORT, `/api/agent/missions/${mid}/approval`, {
    approvalId: approval.approvalId, decision: 'approve', contextVersion: approval.contextVersion, planHash: approval.planHash,
  });
  ok(approved.status === 200 && approved.json.data.mission.phase === 'executing', '正确三元组 approve → executing');
  const cmds = approved.json.data.pendingCommands;
  ok(cmds[0]?.kind === 'focus_asset' && cmds[0]?.targetId === 'STR-B2-07', '命令 1：focus_asset STR-B2-07');
  ok(cmds[1]?.kind === 'navigate_to_checkpoint' && cmds[1]?.targetId === 'CP-B02-FRONT', '命令 2：navigate_to_checkpoint CP-B02-FRONT');
  task = approved.json.data.inspectionTask;
  ok(task?.id && task.status === 'dispatched', `复用现有 createTask：${task?.id} dispatched`);

  const again = await post(PORT, `/api/agent/missions/${mid}/approval`, {
    approvalId: approval.approvalId, decision: 'approve', contextVersion: approval.contextVersion, planHash: approval.planHash,
  });
  ok(again.status === 409 && again.json.error?.code === 'NO_PENDING_APPROVAL', '重复审批 → 409（不解析为任意新动作）');
}

// ---------- 场景事件推进 ----------
section('场景事件：checkpoint/evidence 推进 + 幂等 + 安全阻塞');
{
  const before = await get(PORT, `/api/agent/missions/${mid}`);
  cmdFront = before.json.data.pendingCommands.find((c) => c.targetId === 'CP-B02-FRONT');

  const arrived = await post(PORT, `/api/agent/missions/${mid}/events`, {
    ...nextEvent(), type: 'checkpoint_arrived', checkpointId: 'CP-B02-FRONT', reason: '控制器到达楼前', clientTs: nowIso(),
  });
  ok(arrived.status === 200 && arrived.json.data.inspectionTask.status === 'onsite', 'CP-B02-FRONT 到达 → 任务 onsite（arrive_front）');
  ok(arrived.json.data.mission.phase === 'awaiting-evidence', '阶段 → awaiting-evidence');
  ok(arrived.json.data.pendingCommands.some((c) => c.targetId === 'CP-B02-ROOF'), '签发下一跳 CP-B02-ROOF 导航命令');
  cmdRoof = arrived.json.data.pendingCommands.find((c) => c.targetId === 'CP-B02-ROOF');

  const dup = await post(PORT, `/api/agent/missions/${mid}/events`, {
    eventId: `EVT-TEST-${String(evSeq).padStart(4, '0')}`, idempotencyKey: `idem-${evSeq}`, type: 'checkpoint_arrived',
    checkpointId: 'CP-B02-FRONT', reason: '断线重试重发', clientTs: nowIso(),
  });
  ok(dup.status === 200 && dup.json.duplicate === true && dup.json.data.inspectionTask.status === 'onsite', '重复 eventId → duplicate=true，无副作用');

  const again409 = await post(PORT, `/api/agent/missions/${mid}/events`, {
    ...nextEvent(), type: 'checkpoint_arrived', checkpointId: 'CP-B02-FRONT', reason: '重复到达（新事件）', clientTs: nowIso(),
  });
  ok(again409.status === 409 && again409.json.error?.code === 'ILLEGAL_TRANSITION', 'onsite 再次 arrive_front → 409（既有状态机语义）');

  const keyDup = await post(PORT, `/api/agent/missions/${mid}/events`, {
    eventId: 'EVT-TEST-BRAND-NEW', idempotencyKey: `idem-${evSeq - 1}`, type: 'asset_focused', assetId: 'STR-B2-07', reason: 'idem 冲突', clientTs: nowIso(),
  });
  ok(keyDup.status === 200 && keyDup.json.duplicate === true, '重复 idempotencyKey → 幂等返回');

  // 楼前证据：任务 onsite 不能直接收证据 → 暂存
  const frontEv = await post(PORT, `/api/agent/missions/${mid}/events`, {
    ...nextEvent(), type: 'evidence_captured', reason: '楼前目视拍照', clientTs: nowIso(),
    evidence: { checkpointId: 'CP-B02-FRONT', kind: 'photo', value: '楼前外观照片' },
  });
  ok(frontEv.status === 200 && frontEv.json.data.inspectionTask.evidence.length === 0, 'onsite 阶段证据暂存（不违反 addEvidence 状态约束）');

  // 导航失败：记录 blocked，不自动跳过
  const navFail = await post(PORT, `/api/agent/missions/${mid}/events`, {
    ...nextEvent(), type: 'navigation_failed', checkpointId: 'CP-B02-ROOF', reason: '路线被封锁', clientTs: nowIso(),
  });
  ok(navFail.status === 200 && navFail.json.data.blocked === true, 'navigation_failed → blocked');
  ok(navFail.json.data.mission.warnings.some((w) => w.includes('NAVIGATION_FAILED')), '警告已记录');
  ok(navFail.json.data.inspectionTask.status === 'onsite', '不自动跳过：任务仍停在 onsite');
  // 恢复：控制端重试成功
  const retryArrive = await post(PORT, `/api/agent/missions/${mid}/events`, {
    ...nextEvent(), type: 'checkpoint_arrived', checkpointId: 'CP-B02-ROOF', reason: '重试后到达屋面', clientTs: nowIso(),
  });
  ok(retryArrive.status === 200 && retryArrive.json.data.inspectionTask.status === 'evidence-submitted', 'CP-B02-ROOF 到达 → 冲洗暂存证据 + submit_evidence');

  // 缺 ROOF 证据 → resolve 阻塞 EVIDENCE_MISSING（不能自然语言绕过）
  ok(retryArrive.json.data.blocked === 'EVIDENCE_MISSING', '仅楼前证据 → resolve 阻塞 EVIDENCE_MISSING');
  ok(retryArrive.json.data.mission.warnings.some((w) => w.startsWith('EVIDENCE_MISSING')), 'EVIDENCE_MISSING 警告已记录');
  ok(retryArrive.json.data.mission.phase === 'awaiting-evidence', '阶段保持 awaiting-evidence');
  const earlyClose = await post(PORT, `/api/agent/missions/${mid}/approval`, {
    approvalId: 'APR-any', decision: 'approve', contextVersion: 'CTX-any', planHash: 'PLAN-any',
  });
  ok(earlyClose.status === 409 && earlyClose.json.error?.code === 'NO_PENDING_APPROVAL', '无挂起审批时闭环确认 → 409（未批准拒绝）');

  // 屋面热成像证据 → resolve 通过 → 等待用户确认闭环
  const roofEv = await post(PORT, `/api/agent/missions/${mid}/events`, {
    ...nextEvent(), type: 'evidence_captured', reason: '屋面热成像', clientTs: nowIso(),
    evidence: { checkpointId: 'CP-B02-ROOF', kind: 'thermal', value: 'STR-B2-07 区域热斑' },
  });
  const t = roofEv.json.data.inspectionTask;
  ok(t.status === 'resolved' && t.evidence.length === 2, '屋面证据 → submit + resolve → 任务 resolved（2 条证据）');
  ok(t.evidence.every((e) => e.value.startsWith('[SIMULATED]')), '证据显式标 SIMULATED');
  ok(roofEv.json.data.mission.phase === 'awaiting-confirmation', '阶段 → awaiting-confirmation（等待用户确认闭环）');
  approval = roofEv.json.data.pendingApproval;
  ok(approval?.purpose === 'close' && approval.requestedActions.includes('close_task'), '签发闭环确认审批（mission.close_or_escalate）');

  const wrongClose = await post(PORT, `/api/agent/missions/${mid}/approval`, {
    approvalId: approval.approvalId, decision: 'approve', contextVersion: 'CTX-wrong', planHash: approval.planHash,
  });
  ok(wrongClose.status === 403 && wrongClose.json.error?.code === 'CONTEXT_VERSION_MISMATCH', '闭环确认版本不匹配 → 403');

  const closed = await post(PORT, `/api/agent/missions/${mid}/approval`, {
    approvalId: approval.approvalId, decision: 'approve', contextVersion: approval.contextVersion, planHash: approval.planHash,
  });
  ok(closed.status === 200 && closed.json.data.mission.phase === 'resolved', '闭环确认 → mission resolved');
  const receipt = closed.json.data.receipt;
  ok(receipt?.closedAt && receipt.anomalyStatus === 'resolved' && typeof receipt.lossKwhTotal === 'number', `回执：closedAt + 损失固化 ${receipt?.lossKwhTotal} kWh`);
  ok(closed.json.data.inspectionTask.anomalyResolved === true, 'closeTask 撤销异常注入（anomalyResolved）');

  // 闭环恢复语义（P4-4）：实发回到 ±2%
  const act = await get(PORT, `/api/generation/actual?nodeId=STR-B2-07&date=${sunnyDate}`);
  const effective = act.json.hourly.filter((h) => h.expectedKwh >= 0.5);
  const worst = Math.max(...effective.map((h) => Math.abs(h.actualKwh / h.expectedKwh - 1)));
  ok(act.json.hourly.every((h) => !h.anomalyInjected) && worst <= 0.02, `闭环恢复：注入撤销，最大偏差 ${(worst * 100).toFixed(2)}% ≤ 2%`);
}

// ---------- 非法事件 / 场景校验 ----------
section('事件校验：未知类型/场景不一致/未知检查点');
{
  const badType = await post(PORT, `/api/agent/missions/${mid}/events`, { ...nextEvent(), type: 'keypress_w', reason: 'x', clientTs: nowIso() });
  ok(badType.status === 400 && badType.json.error?.code === 'UNKNOWN_EVENT_TYPE', '逐帧按键类事件 → 400（只接受高层语义事件）');
  const badScene = await post(PORT, `/api/agent/missions/${mid}/events`, { ...nextEvent(), type: 'scene_entered', sceneId: 'PECC-PARK-99', reason: 'x', clientTs: nowIso() });
  ok(badScene.status === 400 && badScene.json.error?.code === 'SCENE_MISMATCH', 'sceneId 不一致 → 400');
  const badCp = await post(PORT, `/api/agent/missions/${mid}/events`, { ...nextEvent(), type: 'checkpoint_arrived', checkpointId: 'CP-NOPE', reason: 'x', clientTs: nowIso() });
  ok(badCp.status === 400 && badCp.json.error?.code === 'UNKNOWN_CHECKPOINT', '未登记检查点 → 400');
}

// ---------- 上下文刷新使旧审批失效 ----------
section('上下文刷新：asset_focused 使旧审批失效并重新提案');
{
  const created = await post(PORT, '/api/agent/missions', {
    objective: '复查 B2', sceneId: 'PECC-PARK-01', sceneRevision: 'fixture-v1', anomalyId: 'ANOM-DEMO-01',
  });
  const d = created.json.data;
  const oldApproval = d.pendingApproval;
  const focus = await post(PORT, `/api/agent/missions/${d.mission.missionId}/events`, {
    ...nextEvent(), type: 'asset_focused', assetId: 'STR-B2-07', reason: '用户点击设备卡', clientTs: nowIso(),
  });
  ok(focus.status === 200 && focus.json.data.mission.focus.assetId === 'STR-B2-07', 'asset_focused 更新焦点');
  ok(focus.json.data.mission.contextVersion !== oldApproval.contextVersion, '焦点变化 → contextVersion 刷新');
  const stale = await post(PORT, `/api/agent/missions/${d.mission.missionId}/approval`, {
    approvalId: oldApproval.approvalId, decision: 'approve', contextVersion: oldApproval.contextVersion, planHash: oldApproval.planHash,
  });
  ok(stale.status === 403 && stale.json.error?.code === 'CONTEXT_VERSION_MISMATCH', '旧审批在新上下文下 → 403');
  const fresh = await get(PORT, `/api/agent/missions/${d.mission.missionId}`);
  const newApproval = fresh.json.data.pendingApproval;
  ok(newApproval && newApproval.contextVersion === focus.json.data.mission.contextVersion, '自动重新提案 + 新审批绑定新 contextVersion');
  const reApproved = await post(PORT, `/api/agent/missions/${d.mission.missionId}/approval`, {
    approvalId: newApproval.approvalId, decision: 'approve', contextVersion: newApproval.contextVersion, planHash: newApproval.planHash,
  });
  ok(reApproved.status === 200 && reApproved.json.data.mission.phase === 'executing', '新审批可正常通过');
  ok(reApproved.json.data.inspectionTask?.id && reApproved.json.data.inspectionTask.status === 'dispatched', '巡检任务经现有 createTask 建立并派发');
}

// ---------- 审批过期 ----------
section('审批过期（独立实例 TTL=300ms）');
{
  let expChild = startEngine(EXPIRY_PORT, path.join(tmpDir, 'expiry.db'), { PECC_APPROVAL_TTL_MS: '300' });
  ok(await waitHealth(EXPIRY_PORT), '过期测试实例启动');
  const created = await post(EXPIRY_PORT, '/api/agent/missions', {
    objective: '过期演示', sceneId: 'PECC-PARK-01', sceneRevision: 'fixture-v1', anomalyId: 'ANOM-DEMO-01',
  });
  const a = created.json.data.pendingApproval;
  await new Promise((r) => setTimeout(r, 600));
  const expired = await post(EXPIRY_PORT, `/api/agent/missions/${created.json.data.mission.missionId}/approval`, {
    approvalId: a.approvalId, decision: 'approve', contextVersion: a.contextVersion, planHash: a.planHash,
  });
  ok(expired.status === 410 && expired.json.error?.code === 'APPROVAL_EXPIRED', '过期审批 → 410 APPROVAL_EXPIRED');
  const renewed = created.json.data.pendingApproval && (await get(EXPIRY_PORT, `/api/agent/missions/${created.json.data.mission.missionId}`)).json.data.pendingApproval;
  ok(renewed && renewed.approvalId !== a.approvalId, '过期后自动重新提案（新 approvalId）');
  const reOk = await post(EXPIRY_PORT, `/api/agent/missions/${created.json.data.mission.missionId}/approval`, {
    approvalId: renewed.approvalId, decision: 'approve', contextVersion: renewed.contextVersion, planHash: renewed.planHash,
  });
  ok(reOk.status === 200 && reOk.json.data.mission.phase === 'executing', '新审批可执行（不沿用旧批准）');
  await stopEngine(expChild);
}

// ---------- 重启恢复 ----------
section('重启恢复：独立进程重开同一 SQLite');
{
  await stopEngine(child);
  child = startEngine(PORT, dbFile);
  ok(await waitHealth(PORT), '引擎重启（同一 PECC_DB）');
  const after = await get(PORT, `/api/agent/missions/${mid}`);
  ok(after.status === 200 && after.json.data.mission.phase === 'resolved', 'mission 状态从 SQLite 原样恢复（resolved）');
  ok(after.json.data.receipt?.closedAt && after.json.data.inspectionTask?.anomalyResolved === true, '回执与巡检任务恢复完整');
  ok(after.json.data.plan?.steps.length > 0 && after.json.data.context.items.length > 0, '计划/上下文快照随状态恢复');
  const t = await get(PORT, `/api/inspection/tasks/${after.json.data.inspectionTask.id}`);
  ok(t.status === 200 && t.json.transitions.length >= 6, '既有巡检任务读取：完整迁移时间线');
  const lateApprove = await post(PORT, `/api/agent/missions/${mid}/approval`, {
    approvalId: approval.approvalId, decision: 'approve', contextVersion: approval.contextVersion, planHash: approval.planHash,
  });
  ok(lateApprove.status === 409 && lateApprove.json.error?.code === 'NO_PENDING_APPROVAL', '重启后旧审批仍不可用 → 409');
}

// ---------- 汇总 ----------
await stopEngine(child);
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n========================================`);
console.log(`agent-test 结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.error('失败项：');
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('MissionRuntime 回放测试全部通过 ✔');
