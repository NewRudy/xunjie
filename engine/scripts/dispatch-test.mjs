#!/usr/bin/env node
// 服务端受控编排测试（engine/scripts/dispatch-test.mjs）
// 覆盖（P1 编排收权合同）：
//   1. 无任务时 decide_pending → 拒绝且不建任务；
//   2. start_inspection = 复位 + 建任务原子化（重复下达得新任务）；
//   3. decide_pending approve：服务端绑定当前待审批 → 任务 executing + 签发 pendingCommands；
//   4. capture_evidence 过早 → 状态机自动暂存（buffered=3），不推进阶段；
//   5. 楼前/屋面事件到达 → 暂存证据冲洗 → awaiting-confirmation → dispatch 我同意 → resolved+回执；
//   6. decide_pending reject → cancelled；
//   7. 风电场景：闭环命令不可达（澄清），场景命令照常透传（风电页不受影响）；
//   8. /avatar/interpret 兼容不变；显式 missionId 生效；BAD_BODY 400。
// 用法：node scripts/dispatch-test.mjs（自动拉起引擎实例，退出码 0=全绿）
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
  const resp = await fetch(`http://127.0.0.1:${port}${p}`, {
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
const post = (port, p, body) => req(port, 'POST', p, body ?? {});

function startEngine(port, dbFile) {
  const child = spawn(process.execPath, [TSX, 'src/index.ts'], {
    cwd: ENGINE_DIR,
    env: { ...process.env, PORT: String(port), PECC_DB: dbFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.env.AGENT_TEST_VERBOSE && process.stderr.write(d));
  return child;
}

// 引擎启动先做 2025 整年气象标定（open-meteo）；网络差时要等外部超时才回退 synthetic，启动可能远超常规预期
async function waitHealth(port, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await req(port, 'GET', '/api/health');
      last = `status=${r.status} body=${r.text.slice(0, 120)}`;
      if (r.status === 200) return true;
    } catch (e) {
      last = `throw=${e.cause?.code ?? e.message}`;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error(`  [waitHealth] 超时未就绪，最后一次: ${last}`);
  return false;
}

const dbFile = path.join(os.tmpdir(), `dispatch-test-${process.pid}.db`);
const port = 8800 + (process.pid % 500);
const child = startEngine(port, dbFile);
const PECC = { sceneId: 'PECC-PARK-01', sceneRevision: 'fixture-v1' };
const WIND = { sceneId: 'WIND-FARM-01', sceneRevision: 'fixture-v1' };
const dispatch = (text, extra = {}) => post(port, '/api/agent/avatar/dispatch', { text, ...PECC, ...extra });
const outcomeOf = (j, kind) => j?.data?.dispatch?.find((o) => o.kind === kind);

try {
  ok(await waitHealth(port), '引擎健康检查通过');

  // ---------- 1. 无任务时 decide ----------
  section('无任务时 decide_pending → 拒绝不建任务');
  {
    const r = await dispatch('我同意');
    ok(r.status === 200 && r.json.status === 'rejected', '200 + overall rejected（无任务唯一闭环命令失败）', JSON.stringify(r.json?.status));
    const o = outcomeOf(r.json, 'decide_pending');
    ok(o?.status === 'rejected' && o?.code === 'NO_ACTIVE_MISSION', 'outcome 拒绝 NO_ACTIVE_MISSION', JSON.stringify(o));
    ok(r.json.data?.mission === null, '未创建任务（mission=null）');
  }

  // ---------- 2. start_inspection 原子复位+建任务 ----------
  section('start_inspection：复位+建任务原子化');
  {
    const r = await dispatch('检查 B2 屋顶异常');
    ok(r.status === 200 && r.json.status === 'available', '200 + available', JSON.stringify(r.json?.status));
    const o = outcomeOf(r.json, 'start_inspection');
    ok(o?.status === 'available' && !!o?.detail?.missionId, 'outcome available + missionId', JSON.stringify(o));
    ok(r.json.data?.mission?.mission?.phase === 'awaiting-approval', '任务阶段 awaiting-approval', r.json.data?.mission?.mission?.phase);
    ok(Array.isArray(r.json.data?.mission?.pendingCommands), '任务快照含 pendingCommands 字段');
    ok(!!r.json.planner, 'planner 如实上浮', JSON.stringify(r.json.planner));

    const r2 = await dispatch('检查 B2 屋顶异常');
    const id1 = o?.detail?.missionId;
    const id2 = outcomeOf(r2.json, 'start_inspection')?.detail?.missionId;
    ok(r2.status === 200 && id2 && id1 && id2 !== id1, '重复下达 → 复位后新任务（原子性）', `${id1} -> ${id2}`);
  }

  // ---------- 3-5. approve → 过早取证暂存 → 事件到达推进 ----------
  section('主链：approve → 过早取证暂存 → 到达冲洗 → 闭环');
  {
    const r = await dispatch('我同意');
    ok(r.status === 200 && r.json.status === 'available', 'approve 200 available');
    const mission = r.json.data?.mission;
    ok(mission?.mission?.phase === 'executing', '任务阶段 executing', mission?.mission?.phase);
    ok((mission?.pendingCommands ?? []).length >= 1 && mission.pendingCommands[0].kind === 'focus_asset', '审批签发 pendingCommands（focus 领先）', JSON.stringify(mission?.pendingCommands?.map((c) => c.kind)));

    const mid = mission.mission.missionId;
    const cap = await dispatch('采集证据', { missionId: mid });
    ok(cap.status === 200 && cap.json.status === 'available', '过早取证仍 available（状态机裁决而非报错）', JSON.stringify(cap.json?.status));
    const capOutcome = outcomeOf(cap.json, 'capture_evidence');
    ok(capOutcome?.status === 'available' && capOutcome?.detail?.buffered === 3, '三类证据自动暂存（buffered=3）', JSON.stringify(capOutcome));
    ok(cap.json.data?.mission?.mission?.phase === 'executing', '阶段未推进（executing）', cap.json.data?.mission?.mission?.phase);

    const ev = (type, checkpointId) => post(port, `/api/agent/missions/${mid}/events`, {
      eventId: `EVT-T-${type}-${checkpointId}`,
      idempotencyKey: `dispatch-test-${type}-${checkpointId}`,
      type,
      checkpointId,
      reason: 'dispatch-test 到达',
      clientTs: new Date().toISOString(),
    });
    const front = await ev('checkpoint_arrived', 'CP-B02-FRONT');
    ok(front.status === 200 && front.json.data?.mission?.phase === 'awaiting-evidence', '楼前到达 → awaiting-evidence', front.json?.data?.mission?.phase);
    const roof = await ev('checkpoint_arrived', 'CP-B02-ROOF');
    ok(roof.status === 200 && roof.json.data?.mission?.phase === 'awaiting-confirmation', '屋面到达 + 暂存冲洗 → awaiting-confirmation', roof.json?.data?.mission?.phase);
    ok(!!roof.json.data?.pendingApproval && roof.json.data.pendingApproval.purpose === 'close', 'close 审批已挂起');

    const close = await dispatch('我同意', { missionId: mid });
    ok(close.status === 200 && close.json.status === 'available', '闭环确认 200 available');
    ok(close.json.data?.mission?.mission?.phase === 'resolved', '任务 resolved', close.json.data?.mission?.mission?.phase);
    ok(close.json.data?.mission?.receipt?.kind === 'mission_closed', '闭环回执固化', JSON.stringify(close.json.data?.mission?.receipt?.kind));
  }

  // ---------- 6. reject ----------
  section('decide_pending reject → cancelled');
  {
    await dispatch('检查 B2 屋顶异常');
    const r = await dispatch('我不同意');
    ok(r.status === 200 && r.json.data?.mission?.mission?.phase === 'cancelled', '驳回 → cancelled', r.json?.data?.mission?.mission?.phase);
  }

  // ---------- 7. 会话与 trace（P2） ----------
  section('会话聚合 + trace 上浮');
  {
    const r = await dispatch('检查 B2 屋顶异常', { conversationId: 'CONV-T2' });
    ok(r.status === 200 && r.json.data?.conversationId === 'CONV-T2', '回显 conversationId', r.json.data?.conversationId);
    const trace = r.json.data?.trace ?? [];
    ok(Array.isArray(trace) && trace[0]?.label === '解释' && typeof trace[0]?.durationMs === 'number', 'trace 含解释节点与耗时', JSON.stringify(trace[0]));
    ok(trace.some((s) => s.label === '执行:start_inspection' && s.status === 'ok'), 'trace 含闭环执行节点');
    ok(trace[trace.length - 1]?.label === '总计', 'trace 以总计收尾');
    const r2 = await dispatch('我同意', { conversationId: 'CONV-T2' });
    ok(r2.status === 200 && r2.json.data?.conversationId === 'CONV-T2' && r2.json.data?.mission?.mission?.phase === 'executing', '同会话第二条指令 + trace 持续上浮', JSON.stringify(r2.json.data?.trace?.map((s) => s.label)));
    const def = await dispatch('停下');
    ok(def.json.data?.conversationId === 'CONV-DEMO', '缺省会话 CONV-DEMO', def.json.data?.conversationId);
  }

  // ---------- 8. 上下文问答（你是谁 / 当前啥场景 / 任务状态） ----------
  section('上下文问答门控（确定性，不产生命令）');
  {
    const who = await dispatch('你是谁', { conversationId: 'CONV-QA' });
    ok(who.status === 200 && who.json.data?.reply?.includes('巡界'), '你是谁 → 巡界身份作答', who.json.data?.reply?.slice(0, 40));
    ok((who.json.data?.commands ?? []).length === 0 && who.json.data?.sceneBrief?.kind === 'identity', '零命令 + identity brief', JSON.stringify(who.json.data?.sceneBrief?.kind));
    const sceneQ = await post(port, '/api/agent/avatar/dispatch', { text: '当前啥场景', ...WIND });
    ok(sceneQ.status === 200 && sceneQ.json.data?.reply?.includes('WIND-FARM-01'), '当前啥场景 → 场景元数据', sceneQ.json.data?.reply?.slice(0, 50));
    ok(sceneQ.json.data?.sceneBrief?.kind === 'scene' && sceneQ.json.data.sceneBrief.sceneId === 'WIND-FARM-01', 'scene brief 结构化', JSON.stringify(sceneQ.json.data?.sceneBrief?.sceneId));
    const taskQ = await dispatch('当前任务状态', { conversationId: 'CONV-QA' });
    ok(taskQ.status === 200 && typeof taskQ.json.data?.reply === 'string' && taskQ.json.data.reply.length > 4, '任务状态有作答', taskQ.json.data?.reply?.slice(0, 40));
    const qaTrace = who.json.data?.trace ?? [];
    ok(qaTrace[0]?.detail === 'context-qa', 'trace 标记 context-qa', JSON.stringify(qaTrace[0]));
  }

  // ---------- 9. 风电场景 ----------
  section('风电场景：闭环不可达（澄清）+ 场景命令透传');
  {
    const r = await post(port, '/api/agent/avatar/dispatch', { text: '我同意', ...WIND });
    ok(r.status === 400 && r.json.error?.code === 'CLARIFICATION_NEEDED', '风电闭环不可达 → 400 澄清', JSON.stringify(r.json?.error?.code));
    const nav = await post(port, '/api/agent/avatar/dispatch', { text: '跑到 2 号风机', ...WIND });
    ok(nav.status === 200 && nav.json.data?.commands?.[0]?.kind === 'navigate' && nav.json.data.commands[0].targetId === 'CP-WT-02', '风电导航命令透传（CP-WT-02）', JSON.stringify(nav.json?.data?.commands));
    ok(nav.json.data?.mission === null, '风电命令不触碰任务状态');
  }

  // ---------- 8. 兼容与边界 ----------
  section('兼容与边界');
  {
    const it = await post(port, '/api/agent/avatar/interpret', { text: '带我去B2楼前', ...PECC });
    ok(it.status === 200 && it.json.data?.commands?.[0]?.kind === 'navigate', '/avatar/interpret 兼容不变', JSON.stringify(it.json?.data?.commands));
    const bad = await post(port, '/api/agent/avatar/dispatch', { text: '停下' });
    ok(bad.status === 400 && bad.json.error?.code === 'BAD_BODY', '缺场景 → 400 BAD_BODY', JSON.stringify(bad.json?.error?.code));
    const clr = await dispatch('给我唱首歌');
    ok(clr.status === 400 && clr.json.error?.code === 'CLARIFICATION_NEEDED', '不可理解 → 400 澄清', JSON.stringify(clr.json?.error?.code));
  }
} finally {
  child.kill('SIGTERM');
  fs.rmSync(dbFile, { force: true });
}

console.log(`\n========================================`);
console.log(`dispatch-test 结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.error('失败项：');
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('服务端受控编排测试全部通过 ✔');
