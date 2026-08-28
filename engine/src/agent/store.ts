// MissionState / 场景事件持久化（SQLite，contracts/agent-state.md §5）
// 全部读写直接落库，进程内不缓存 → 重启后由存储原样恢复（任务合同：重启恢复）。
import { db } from '../db';
import { kvGet, kvSet } from '../db';
import { nowIsoShanghai } from '../util';
import type { MissionState, StoredSceneEvent } from './types';

// —— 稳定 ID：kv 序号自增，重启安全，不由模型生成 ——

/** 取下一个序号（从 1 开始） */
export function nextSeq(name: string): number {
  const key = `agent:seq:${name}`;
  const cur = Number(kvGet(key) ?? '0');
  const next = Number.isFinite(cur) ? cur + 1 : 1;
  kvSet(key, String(next));
  return next;
}

export const newMissionId = (): string => `MSN-${String(nextSeq('mission')).padStart(4, '0')}`;
export const newApprovalId = (): string => `APR-${String(nextSeq('approval')).padStart(4, '0')}`;
export const newCommandId = (): string => `CMD-${String(nextSeq('command')).padStart(4, '0')}`;

// —— MissionState ——

export function saveMission(m: MissionState): void {
  db.prepare('INSERT OR REPLACE INTO agent_missions (id, data) VALUES (?, ?)').run(m.missionId, JSON.stringify(m));
}

export function loadMission(id: string): MissionState | null {
  const row = db.prepare('SELECT data FROM agent_missions WHERE id = ?').get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as MissionState) : null;
}

// —— 事件幂等（scene-events.md §3：重复 eventId/idempotencyKey 不产生重复副作用） ——

export interface EventRecord extends StoredSceneEvent {
  resultSummary: Record<string, unknown>;
}

export function findEventById(eventId: string): EventRecord | null {
  const row = db.prepare('SELECT data FROM agent_events WHERE event_id = ?').get(eventId) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as EventRecord) : null;
}

export function findEventByIdempotencyKey(key: string): EventRecord | null {
  const row = db.prepare('SELECT data FROM agent_events WHERE idempotency_key = ?').get(key) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as EventRecord) : null;
}

/** 副作用成功后落事件记录；失败方可用 forgetEvent 允许重试 */
export function recordEvent(rec: EventRecord): void {
  db.prepare('INSERT OR REPLACE INTO agent_events (event_id, idempotency_key, mission_id, data) VALUES (?, ?, ?, ?)').run(
    rec.eventId, rec.idempotencyKey, rec.missionId, JSON.stringify(rec),
  );
}

/** 事件副作用抛错时回滚占位，让客户端可重试（不吞错误） */
export function forgetEvent(eventId: string): void {
  db.prepare('DELETE FROM agent_events WHERE event_id = ?').run(eventId);
}

export function nowEventTs(): string {
  return nowIsoShanghai();
}

// —— 演示复位：清空 agent 数据（/api/debug/reset 调用；不动气象缓存与标定） ——

export function resetAgentData(): { missions: number; events: number } {
  const missions = (db.prepare('SELECT COUNT(*) AS n FROM agent_missions').get() as { n: number }).n;
  const events = (db.prepare('SELECT COUNT(*) AS n FROM agent_events').get() as { n: number }).n;
  db.exec('DELETE FROM agent_missions; DELETE FROM agent_events;');
  return { missions, events };
}
