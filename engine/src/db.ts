// SQLite 持久层：Node 24 内置 node:sqlite（无原生依赖）
// 用途：气象缓存（合同 data-contracts.md §2.1）、引擎 kv（标定常数）、巡检任务、异常状态。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const varDir = fileURLToPath(new URL('../var', import.meta.url));
fs.mkdirSync(varDir, { recursive: true });

// PECC_DB 环境变量允许测试/演示使用独立数据库文件（默认 var/engine.db）
export const dbPath = process.env.PECC_DB ?? fileURLToPath(new URL('../var/engine.db', import.meta.url));

export const db = new DatabaseSync(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS weather_cache (
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  date TEXT NOT NULL,
  hour INTEGER NOT NULL,
  ghi REAL NOT NULL,
  temp REAL NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (lat, lon, date, hour)
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inspection_tasks (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_missions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_events (
  event_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  mission_id TEXT NOT NULL,
  data TEXT NOT NULL
);
`);

export function kvGet(key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function kvSet(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, value);
}
