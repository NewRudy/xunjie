// 气象模块：Open-Meteo 逐时短波辐照/温度（合同 data-contracts.md §2.1）
// - 坐标取 fixture anchor（26.4085, 106.5225 贵安新区）
// - SQLite 缓存：历史（<= 今天-6 天，archive 延迟约 5 天）永久缓存；近期/预报缓存 6 小时
// - 区间请求按"缓存未命中的连续段"合并为一次外部调用（整年标定只需 1 次请求）
// - 离线降级：API 不可达时用确定性晴空模型 + 季节因子合成（同日结果一致），
//   仍标 MODELED，meta.synthetic = true，并 console.warn 警告
import { db } from './db';
import { fixture } from './fixture';
import { addDays, dateRange, dayOfYear, r2, todayShanghai } from './util';

const LAT = fixture.anchor.lat;
const LON = fixture.anchor.lon;
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const HOURLY_VARS = 'shortwave_radiation,temperature_2m';
const ARCHIVE_DELAY_DAYS = 6; // Open-Meteo 历史存档约有 5 天延迟，取 6 天保险
const FORECAST_TTL_MS = 6 * 3600 * 1000; // 预报缓存 6 小时
const FETCH_TIMEOUT_MS = 15000;

export interface WeatherHour {
  ts: string; // "YYYY-MM-DDTHH:00"（Asia/Shanghai 本地时）
  ghi: number; // W/m²
  temp: number; // ℃
}

export interface WeatherResult {
  hours: WeatherHour[];
  meta: {
    synthetic: boolean; // 是否含合成降级数据
    source: 'open-meteo' | 'synthetic' | 'mixed';
    fetchedAt: string | null; // 服务数据中最晚一次外部抓取时间（缓存值，非响应时间）
    lat: number;
    lon: number;
  };
}

interface CacheRow {
  ghi: number;
  temp: number;
  fetched_at: string;
}

// —— 确定性晴空合成模型（离线降级用）——
// 贵阳气候特征：年总辐照约 1050 kWh/m²（全国低值区），夏半年多于冬半年；仅供降级，不冒充实测。
function syntheticDay(date: string): WeatherHour[] {
  const doy = dayOfYear(date);
  const dayLen = 12 + 1.6 * Math.sin((2 * Math.PI * (doy - 172)) / 365); // 昼长季节变化（贵安约 10.4~13.6h）
  const sunrise = 12 - dayLen / 2;
  const sunset = 12 + dayLen / 2;
  const peakClear = 950 * (0.78 + 0.22 * Math.sin((2 * Math.PI * (doy - 80)) / 365)); // 晴空峰值季节因子
  const cloud = 0.45 + 0.18 * Math.sin((2 * Math.PI * (doy - 110)) / 365); // 季节云量因子（贵阳冬春多云）
  const tAvg = 15 + 9 * Math.sin((2 * Math.PI * (doy - 200)) / 365); // 日均温季节波（贵阳冬暖夏凉）
  const hours: WeatherHour[] = [];
  for (let h = 0; h < 24; h++) {
    const mid = h + 0.5; // 以小时中点代表该小时
    let ghi = 0;
    if (mid > sunrise && mid < sunset) {
      const x = Math.PI * ((mid - sunrise) / (sunset - sunrise));
      ghi = peakClear * cloud * Math.pow(Math.sin(x), 1.2);
    }
    const temp = tAvg + 5 * Math.sin((2 * Math.PI * (mid - 9)) / 24); // 日温波：最低约 6 时、最高约 15 时
    hours.push({ ts: `${date}T${String(h).padStart(2, '0')}:00`, ghi: r2(ghi), temp: r2(temp) });
  }
  return hours;
}

// —— 缓存读写 ——
function readCache(date: string): WeatherHour[] | null {
  const rows = db
    .prepare('SELECT hour, ghi, temp, fetched_at FROM weather_cache WHERE lat = ? AND lon = ? AND date = ? ORDER BY hour')
    .all(LAT, LON, date) as unknown as (CacheRow & { hour: number })[];
  if (rows.length !== 24) return null;
  return rows.map((r, i) => ({ ts: `${date}T${String(i).padStart(2, '0')}:00`, ghi: r2(r.ghi), temp: r2(r.temp) }));
}

function cacheFetchedAt(date: string): string | null {
  const row = db.prepare('SELECT fetched_at FROM weather_cache WHERE lat = ? AND lon = ? AND date = ? LIMIT 1').get(LAT, LON, date) as
    | { fetched_at: string }
    | undefined;
  return row?.fetched_at ?? null;
}

function writeCache(date: string, hours: WeatherHour[], fetchedAt: string): void {
  const stmt = db.prepare('INSERT OR REPLACE INTO weather_cache (lat, lon, date, hour, ghi, temp, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  hours.forEach((h, i) => stmt.run(LAT, LON, date, i, h.ghi, h.temp, fetchedAt));
}

// —— Open-Meteo 请求（合同 §2.1 格式，支持区间一次抓取）——
async function fetchOpenMeteo(kind: 'archive' | 'forecast', from: string, to: string): Promise<Map<string, WeatherHour[]>> {
  const base = kind === 'archive' ? ARCHIVE_URL : FORECAST_URL;
  const url =
    `${base}?latitude=${LAT}&longitude=${LON}&hourly=${HOURLY_VARS}` +
    `&timezone=Asia%2FShanghai&start_date=${from}&end_date=${to}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`Open-Meteo HTTP ${resp.status}`);
    const json = (await resp.json()) as any;
    const times: string[] = json.hourly?.time ?? [];
    const ghi: number[] = json.hourly?.shortwave_radiation ?? [];
    const temp: number[] = json.hourly?.temperature_2m ?? [];
    if (times.length === 0) throw new Error('Open-Meteo 返回空序列');
    const out = new Map<string, WeatherHour[]>();
    for (let i = 0; i < times.length; i++) {
      const date = times[i].slice(0, 10);
      if (!out.has(date)) out.set(date, []);
      out.get(date)!.push({ ts: times[i], ghi: r2(ghi[i] ?? 0), temp: r2(temp[i] ?? 0) });
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** 区间气象（合同 GET /api/weather?from&to；内部模块共用） */
export async function getWeatherRange(from: string, to: string): Promise<WeatherResult> {
  const today = todayShanghai();
  const days = dateRange(from, to);
  const historicalCut = addDays(today, -ARCHIVE_DELAY_DAYS);

  // 1) 逐日判定：缓存新鲜则直接用，否则标记待抓（区分 archive/forecast）
  const byDate = new Map<string, WeatherHour[]>();
  const needFetch: { date: string; kind: 'archive' | 'forecast' }[] = [];
  for (const date of days) {
    const isHistorical = date <= historicalCut;
    const cached = readCache(date);
    if (cached) {
      const fetchedAt = cacheFetchedAt(date);
      const fresh = isHistorical || (fetchedAt !== null && Date.parse(fetchedAt) + FORECAST_TTL_MS > Date.now());
      if (fresh) {
        byDate.set(date, cached);
        continue;
      }
    }
    needFetch.push({ date, kind: isHistorical ? 'archive' : 'forecast' });
  }

  // 2) 待抓日期按"同类 + 连续"合并为一次外部请求；失败整段合成降级
  const syntheticDates = new Set<string>();
  let i = 0;
  while (i < needFetch.length) {
    const kind = needFetch[i].kind;
    let j = i;
    while (j + 1 < needFetch.length && needFetch[j + 1].kind === kind && addDays(needFetch[j].date, 1) === needFetch[j + 1].date) j++;
    const segFrom = needFetch[i].date;
    const segTo = needFetch[j].date;
    try {
      const fetched = await fetchOpenMeteo(kind, segFrom, segTo);
      const fetchedAt = new Date().toISOString();
      for (let k = i; k <= j; k++) {
        const date = needFetch[k].date;
        const hours = fetched.get(date);
        if (!hours || hours.length !== 24) throw new Error(`Open-Meteo 缺少 ${date} 数据`);
        writeCache(date, hours, fetchedAt);
        byDate.set(date, hours);
      }
    } catch (err) {
      console.warn(`[weather] Open-Meteo 不可达（${segFrom}~${segTo}），启用确定性晴空合成模型降级：${(err as Error).message}`);
      for (let k = i; k <= j; k++) {
        const date = needFetch[k].date;
        byDate.set(date, syntheticDay(date));
        syntheticDates.add(date);
      }
    }
    i = j + 1;
  }

  // 3) 汇总输出
  const all: WeatherHour[] = [];
  let latestFetch: string | null = null;
  for (const date of days) {
    all.push(...byDate.get(date)!);
    const fa = cacheFetchedAt(date);
    if (fa && (!latestFetch || fa > latestFetch)) latestFetch = fa;
  }
  return {
    hours: all,
    meta: {
      synthetic: syntheticDates.size > 0,
      source: syntheticDates.size === 0 ? 'open-meteo' : syntheticDates.size === days.length ? 'synthetic' : 'mixed',
      fetchedAt: latestFetch,
      lat: LAT,
      lon: LON,
    },
  };
}

/** 单日逐时气象 */
export const getWeatherDay = (date: string): Promise<WeatherResult> => getWeatherRange(date, date);

/** 整年气象（PVGIS 标定与年产自检用） */
export const getWeatherYear = (year: number): Promise<WeatherResult> => getWeatherRange(`${year}-01-01`, `${year}-12-31`);
