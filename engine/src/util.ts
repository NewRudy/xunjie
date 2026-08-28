// 确定性工具：哈希、种子随机数、定小数位舍入、日期（Asia/Shanghai）
// 本模块是纯函数，不依赖外部环境，保证"同参数两次调用逐字节一致"。

/** FNV-1a 32 位哈希：字符串种子 → 32 位无符号整数 */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 伪随机数发生器：同一种子产生同一序列 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 合同种子规则：seed = hash(nodeId + date) 的泛化，key 任意拼接 */
export const seededRng = (key: string): (() => number) => mulberry32(fnv1a(key));

// 定小数位舍入：所有对外数字统一走这里，避免浮点尾巴破坏确定性
export const r2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;
export const r3 = (x: number): number => Math.round((x + Number.EPSILON) * 1000) / 1000;
export const r4 = (x: number): number => Math.round((x + Number.EPSILON) * 10000) / 10000;
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isValidDate = (s: unknown): s is string => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00+08:00`));
export const isValidMonth = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}$/.test(s) && Number(s.slice(5, 7)) >= 1 && Number(s.slice(5, 7)) <= 12;

/** 上海时区的"今天"（YYYY-MM-DD） */
export function todayShanghai(): string {
  // en-CA 区域输出 YYYY-MM-DD 格式
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

/** 当前上海时区小时（0-23）与分钟 */
export function nowShanghaiHHMM(): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return { hour: get('hour') % 24, minute: get('minute') };
}

/** 当前上海时区 ISO 时间戳（巡检/任务时间线用，允许非确定） */
export function nowIsoShanghai(): string {
  const d = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+08:00`;
}

/** 日期加减（返回 YYYY-MM-DD） */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 两日期间所有日期（含端点） */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function dayOfYear(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.floor((d.getTime() - start.getTime()) / 86400000) + 1;
}

/** 星期几（0=周日），与时区无关：按历法日计算 */
export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
