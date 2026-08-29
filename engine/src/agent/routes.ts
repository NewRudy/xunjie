// /api/agent/* 路由（contracts/agent-tools.md §2）
// 错误格式与现有 API 一致：{ error: { code, message } } + 语义化状态码；成功走统一结果外壳。
import { Hono } from 'hono';
import { TransitionError } from '../inspection';
import { nowIsoShanghai } from '../util';
import { createMission, handleSceneEvent, RuntimeHttpError, submitApproval, getMission, envelope } from './runtime';
import { dispatchAvatarText } from './dispatch';
import { SCENE_ID, SCENE_REVISION } from './context';
import { AVATAR_WARNINGS, AvatarClarificationError } from './avatar';
import { interpretAvatar } from './avatar-llm';
import { WIND_SCENE_ID, WIND_SCENE_REVISION } from './windFarm';
import type { SceneEventInput } from './types';

export const agentRoutes = new Hono();

const err = (c: any, status: number, code: string, message: string, extra?: Record<string, unknown>) =>
  c.json({ error: { code, message }, ...(extra ?? {}) }, status as any);

function httpError(c: any, e: unknown) {
  if (e instanceof RuntimeHttpError) return err(c, e.http, e.code, e.message, e.extra);
  if (e instanceof TransitionError) {
    const status = e.code === 'NOT_FOUND' ? 404 : e.code.startsWith('UNKNOWN') ? 400 : 409;
    return err(c, status, e.code, e.message);
  }
  throw e;
}

// —— POST /api/agent/missions：创建任务/获取提案（不明确 → clarification，不猜 ID） ——
agentRoutes.post('/missions', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.objective !== 'string' || !body.objective.trim() || typeof body.sceneId !== 'string' || typeof body.sceneRevision !== 'string') {
    return err(c, 400, 'BAD_BODY', '入参须为 { objective, sceneId, sceneRevision, operator?, trigger?, anomalyId? }');
  }
  if (body.trigger !== undefined && !['user', 'anomaly', 'system'].includes(body.trigger)) {
    return err(c, 400, 'BAD_TRIGGER', `trigger 仅允许 user|anomaly|system，收到: ${body.trigger}`);
  }
  try {
    const res = await createMission(body);
    if ('clarification' in res) {
      return err(c, 400, 'CLARIFICATION_NEEDED', res.clarification.message, { clarification: res.clarification });
    }
    return c.json(envelope(res.mission), 201 as any);
  } catch (e) {
    return httpError(c, e);
  }
});

// —— POST /api/agent/avatar/interpret：自然语言 → 受控数字人动作（contracts/avatar-command.md §0/§2/§9） ——
// LLM-first：配置 AGENT_LLM_API_KEY 时真实调用 OpenAI-compatible 模型，模型 JSON 过确定性白名单校验后返回；
// 未配置/失败 → 确定性中文解析回退。只读演示控制面，不改 MissionState 与任务闭环。
// 场景白名单：PECC-PARK-01（光伏）与 WIND-FARM-01（风电，登记见 windFarm.ts/farm.json）。
const AVATAR_SCENES: Record<string, { sceneRevision: string; scene: 'pecc' | 'wind'; sourceRef: string }> = {
  [SCENE_ID]: { sceneRevision: SCENE_REVISION, scene: 'pecc', sourceRef: 'data/fixtures/park-pecc-01.json' },
  [WIND_SCENE_ID]: { sceneRevision: WIND_SCENE_REVISION, scene: 'wind', sourceRef: 'player-demo/example/public/wind/farm.json' },
};

/** 场景白名单守卫：未登记返回 400 响应（不猜场景），通过返回 null */
function sceneGuard(c: any, body: { sceneId: string; sceneRevision: string }) {
  const sceneEntry = AVATAR_SCENES[body.sceneId];
  if (!sceneEntry || body.sceneRevision !== sceneEntry.sceneRevision) {
    return err(
      c,
      400,
      'CLARIFICATION_NEEDED',
      `场景须为 ${Object.entries(AVATAR_SCENES).map(([id, s]) => `${id}/${s.sceneRevision}`).join(' 或 ')}，收到: ${body.sceneId}/${body.sceneRevision}`,
      { clarification: { field: !sceneEntry ? 'sceneId' : 'sceneRevision', options: Object.entries(AVATAR_SCENES).map(([sceneId, s]) => ({ sceneId, sceneRevision: s.sceneRevision })) } },
    );
  }
  return null;
}

agentRoutes.post('/avatar/interpret', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.text !== 'string' || !body.text.trim() || typeof body.sceneId !== 'string' || typeof body.sceneRevision !== 'string') {
    return err(c, 400, 'BAD_BODY', '入参须为 { text, sceneId, sceneRevision }');
  }
  const guard = sceneGuard(c, body);
  if (guard) return guard;
  try {
    const { normalizedText, reply, commands, planner } = await interpretAvatar(body.text, AVATAR_SCENES[body.sceneId].scene);
    return c.json({
      status: 'available' as const,
      data: { normalizedText, reply, commands },
      sourceRefs: ['contracts/avatar-command.md', AVATAR_SCENES[body.sceneId].sourceRef],
      truth: 'SIMULATED' as const,
      observedAt: nowIsoShanghai(),
      warnings: [...AVATAR_WARNINGS],
      nextAllowedActions: ['POST /api/agent/avatar/interpret {"text","sceneId","sceneRevision"}（继续下一条指令；任务闭环走 /missions，与本接口解耦）'],
      planner,
    });
  } catch (e) {
    if (e instanceof AvatarClarificationError) {
      const extra: Record<string, unknown> = { clarification: { message: e.message, examples: e.examples } };
      if (e.planner) extra.planner = e.planner;
      return err(c, 400, 'CLARIFICATION_NEEDED', e.message, extra);
    }
    throw e;
  }
});

// —— POST /api/agent/avatar/dispatch：语言指令 → 服务端受控编排（P1 编排收权） ——
// 解释与 /avatar/interpret 完全相同（LLM-first + 白名单校验 + 确定性回退）；差异在执行权：
// 闭环命令由服务端直接执行——start_inspection=复位+建任务原子化；decide_pending=服务端补全当前
// 待审批四重绑定；capture_evidence=走既有状态机（过早暂存/缺 ROOF 阻塞）。场景命令原样返回前端执行；
// 审批签发的 pendingCommands 仍在任务快照里，前端按既有通道执行。风电场景闭环命令显式拒绝。
agentRoutes.post('/avatar/dispatch', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.text !== 'string' || !body.text.trim() || typeof body.sceneId !== 'string' || typeof body.sceneRevision !== 'string') {
    return err(c, 400, 'BAD_BODY', '入参须为 { text, sceneId, sceneRevision, missionId?, reset? }');
  }
  const guard = sceneGuard(c, body);
  if (guard) return guard;
  try {
    const res = await dispatchAvatarText({
      text: body.text,
      sceneId: body.sceneId,
      sceneRevision: body.sceneRevision,
      scene: AVATAR_SCENES[body.sceneId].scene,
      missionId: typeof body.missionId === 'string' && body.missionId ? body.missionId : undefined,
      reset: body.reset !== false,
    });
    if (res.kind === 'clarification') {
      return err(c, 400, 'CLARIFICATION_NEEDED', res.clarification.message, { clarification: res.clarification, planner: res.planner });
    }
    const missionEnvelope = res.mission ? envelope(res.mission) : null;
    return c.json({
      status: res.status,
      data: {
        normalizedText: res.normalizedText,
        reply: res.reply,
        commands: res.commands,
        dispatch: res.outcomes,
        mission: missionEnvelope ? missionEnvelope.data : null,
      },
      sourceRefs: ['contracts/avatar-command.md', AVATAR_SCENES[body.sceneId].sourceRef, ...(res.mission ? [`/api/agent/missions/${res.mission.missionId}`] : [])],
      truth: 'SIMULATED' as const,
      observedAt: nowIsoShanghai(),
      warnings: [...AVATAR_WARNINGS, ...(res.mission ? res.mission.warnings : [])],
      nextAllowedActions: missionEnvelope ? missionEnvelope.nextAllowedActions : ['POST /api/agent/avatar/dispatch {"text","sceneId","sceneRevision"}（继续下一条指令）'],
      planner: res.planner,
    });
  } catch (e) {
    if (e instanceof AvatarClarificationError) {
      const extra: Record<string, unknown> = { clarification: { message: e.message, examples: e.examples } };
      if (e.planner) extra.planner = e.planner;
      return err(c, 400, 'CLARIFICATION_NEEDED', e.message, extra);
    }
    return httpError(c, e);
  }
});

// —— GET /api/agent/missions/:missionId：当前状态 + 上下文 + 提案 + 审批 + 待执行命令 ——
agentRoutes.get('/missions/:missionId', async (c) => {
  const m = await getMission(c.req.param('missionId'));
  if (!m) return err(c, 404, 'NOT_FOUND', `任务 ${c.req.param('missionId')} 不存在`);
  return c.json(envelope(m));
});

// —— POST /api/agent/missions/:missionId/approval：approve|reject（四重绑定校验） ——
agentRoutes.post('/missions/:missionId/approval', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return err(c, 400, 'BAD_BODY', '入参须为 { approvalId, decision: approve|reject, contextVersion, planHash }');
  try {
    const res = await submitApproval(c.req.param('missionId'), body);
    if (!res.ok) return err(c, res.http, res.code, res.message);
    return c.json(envelope(res.mission, { status: res.status ?? 'available', extra: res.extra }));
  } catch (e) {
    return httpError(c, e);
  }
});

// —— POST /api/agent/missions/:missionId/events：高层场景事件（幂等） ——
agentRoutes.post('/missions/:missionId/events', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.eventId !== 'string' || !body.eventId || typeof body.idempotencyKey !== 'string' || !body.idempotencyKey) {
    return err(c, 400, 'BAD_BODY', '入参须含 eventId、idempotencyKey 及 scene-events.md 事件字段 { type, reason, clientTs, ... }');
  }
  if (typeof body.reason !== 'string' || !body.reason || typeof body.clientTs !== 'string') {
    return err(c, 400, 'BAD_BODY', '事件须含 reason 与 clientTs（scene-events.md §1）');
  }
  const input: SceneEventInput = {
    eventId: body.eventId,
    idempotencyKey: body.idempotencyKey,
    type: body.type,
    sceneId: body.sceneId,
    sceneRevision: body.sceneRevision,
    assetId: body.assetId,
    componentId: body.componentId,
    checkpointId: body.checkpointId,
    reason: body.reason,
    clientTs: body.clientTs,
    payload: body.payload,
    evidence: body.evidence,
  };
  try {
    const res = await handleSceneEvent(c.req.param('missionId'), input);
    if (!res.ok) return err(c, res.http, res.code, res.message);
    return c.json(envelope(res.mission, { extra: res.extra }));
  } catch (e) {
    return httpError(c, e);
  }
});
