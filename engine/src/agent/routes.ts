// /api/agent/* 路由（contracts/agent-tools.md §2）
// 错误格式与现有 API 一致：{ error: { code, message } } + 语义化状态码；成功走统一结果外壳。
import { Hono } from 'hono';
import { TransitionError } from '../inspection';
import { nowIsoShanghai } from '../util';
import { createMission, handleSceneEvent, RuntimeHttpError, submitApproval, getMission, envelope } from './runtime';
import { SCENE_ID, SCENE_REVISION } from './context';
import { AVATAR_WARNINGS, AvatarClarificationError, interpretAvatarCommand } from './avatar';
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

// —— POST /api/agent/avatar/interpret：自然语言 → 受控数字人动作（contracts/avatar-command.md） ——
// 确定性中文解析（无 LLM/密钥）；只读演示控制面，不改 MissionState 与任务闭环。
agentRoutes.post('/avatar/interpret', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.text !== 'string' || !body.text.trim() || typeof body.sceneId !== 'string' || typeof body.sceneRevision !== 'string') {
    return err(c, 400, 'BAD_BODY', '入参须为 { text, sceneId, sceneRevision }');
  }
  if (body.sceneId !== SCENE_ID || body.sceneRevision !== SCENE_REVISION) {
    return err(
      c,
      400,
      'CLARIFICATION_NEEDED',
      `场景须为 ${SCENE_ID}/${SCENE_REVISION}，收到: ${body.sceneId}/${body.sceneRevision}`,
      { clarification: { field: body.sceneId !== SCENE_ID ? 'sceneId' : 'sceneRevision', options: [{ sceneId: SCENE_ID, sceneRevision: SCENE_REVISION }] } },
    );
  }
  try {
    const { normalizedText, reply, commands } = interpretAvatarCommand(body.text);
    return c.json({
      status: 'available' as const,
      data: { normalizedText, reply, commands },
      sourceRefs: ['contracts/avatar-command.md', 'data/fixtures/park-pecc-01.json'],
      truth: 'SIMULATED' as const,
      observedAt: nowIsoShanghai(),
      warnings: [...AVATAR_WARNINGS],
      nextAllowedActions: ['POST /api/agent/avatar/interpret {"text","sceneId","sceneRevision"}（继续下一条指令；任务闭环走 /missions，与本接口解耦）'],
      planner: { mode: 'deterministic-fallback' as const, modelAvailable: false, reason: '确定性中文解析（Demo 稳定，无 LLM/密钥依赖）' },
    });
  } catch (e) {
    if (e instanceof AvatarClarificationError) {
      return err(c, 400, 'CLARIFICATION_NEEDED', e.message, { clarification: { message: e.message, examples: e.examples } });
    }
    throw e;
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
