// ModelAdapter 边界（任务合同：预留 OpenAI-compatible/Kimi/智谱接入，无凭据不外呼、不打印密钥）
// 约定：适配器输出只是"原始提案"，必须经 planner.validateProposal 确定性校验后才可能生效；
// 校验不过 → 整条丢弃回退确定性 planner，并在响应中给出 fallback 原因。
//
// 环境变量（全部可选；不设置则永远走确定性回退）：
//   AGENT_LLM_API_KEY   API 密钥（Zhipu/Kimi/OpenAI-compatible 均用此名）
//   AGENT_LLM_BASE_URL  默认 https://open.bigmodel.cn/api/paas/v4（智谱）；Kimi 用 https://api.moonshot.cn/v1
//   AGENT_LLM_MODEL     默认 glm-5.3-flash（Flash 档，额度消耗最低；可用 AGENT_LLM_MODEL 覆盖）
import type { RawProposal } from './types';
import type { ContextBundle } from './context';
import { PLAN_PROPOSAL_SCHEMA_HINT, renderPlanProposalPrompt } from './capabilities';

export interface ProposeInput {
  objective: string;
  bundle: ContextBundle;
}

export type ProposeResult = { proposal: RawProposal; adapterId: string } | { error: string };

export interface ModelAdapter {
  id: string;
  available(): boolean;
  propose(input: ProposeInput): Promise<ProposeResult>;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type ChatCompletionsResult = { ok: true; content: string } | { ok: false; error: string };

/**
 * OpenAI-compatible chat/completions 共用通道（智谱/Kimi 均兼容；AGENT_LLM_API_KEY/BASE_URL/MODEL）。
 * 错误只回错误类型（LLM_HTTP_x / LLM_TIMEOUT / LLM_CALL_FAILED），绝不携带密钥、请求体或响应原文。
 */
export async function chatCompletions(opts: { messages: ChatMessage[]; temperature?: number; model?: string; timeoutMs?: number }): Promise<ChatCompletionsResult> {
  const key = process.env.AGENT_LLM_API_KEY ?? '';
  const baseUrl = trimSlash(process.env.AGENT_LLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4');
  const model = opts.model ?? process.env.AGENT_LLM_MODEL ?? 'glm-5.3-flash';
  if (!key || !baseUrl) return { ok: false, error: 'NO_CREDENTIALS' };
  const body = { model, temperature: opts.temperature ?? 0, messages: opts.messages };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return { ok: false, error: `LLM_HTTP_${resp.status}` };
    const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return { ok: true, content: json.choices?.[0]?.message?.content ?? '' };
  } catch (e) {
    // 只记错误类型，绝不输出密钥或完整请求体
    if (e instanceof Error && e.name === 'AbortError') return { ok: false, error: 'LLM_TIMEOUT' };
    return { ok: false, error: e instanceof Error ? `LLM_CALL_FAILED: ${e.name}` : 'LLM_CALL_FAILED' };
  }
}

// —— 结构化输出网关（模式参考 pipe-report-agent ModelGateway.structured 生命周期） ——
// chat → 提取 JSON（容忍 ```json 围栏与前后缀文本）→ GLM 嵌套字符串解包 → parse（形状）→ validator（业务校验）
// → 失败拼「原因 + Schema + 原始输出截断」修复重试 → 分级错误。传输层失败不重试，原样透传错误类型。

export type JsonResult = { ok: true; value: unknown } | { ok: false };

/** 容忍 ```json 围栏与少量前后缀文本的 JSON 提取 */
export function tryExtractJson(content: string): JsonResult {
  const stripped = content.replace(/^```json\s*|```\s*$/g, '').trim();
  try {
    return { ok: true, value: JSON.parse(stripped) };
  } catch {
    // 继续尝试截取花括号段
  }
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return { ok: true, value: JSON.parse(stripped.slice(start, end + 1)) };
    } catch {
      // 落入失败
    }
  }
  return { ok: false };
}

/** GLM 特判：嵌套对象被序列化成 JSON 字符串时逐层解包（最多 3 层，防奇异输入循环） */
export function unwrapModelJson(value: unknown): unknown {
  for (let i = 0; i < 3 && typeof value === 'string'; i++) {
    try {
      const parsed = JSON.parse(value);
      if (parsed === value) break;
      value = parsed;
    } catch {
      break;
    }
  }
  return value;
}

export interface StructuredRequest<T> {
  messages: ChatMessage[];
  /** 形状解析：合法形状返回强类型值；否则返回 null（按 parseErrorCode 记） */
  parse: (value: unknown) => T | null;
  /** 业务校验：通过返回 null，否则返回错误类型 code */
  validator?: (value: T) => string | null;
  /** JSON 形状说明（修复重试时回传给模型） */
  schemaHint?: string;
  /** 形状解析失败时的错误码，默认 LLM_BAD_JSON */
  parseErrorCode?: string;
  /** 总尝试次数（含首次），默认 1 */
  maxAttempts?: number;
  temperature?: number;
  model?: string;
}

export type StructuredResult<T> = { ok: true; value: T; attempts: number } | { ok: false; error: string; attempts: number };

const REPAIR_RAW_MAX_CHARS = 4000;

export async function structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
  const maxAttempts = Math.max(1, Math.floor(req.maxAttempts ?? 1));
  const messages = [...req.messages];
  let raw = '';
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await chatCompletions({ messages, temperature: req.temperature, model: req.model });
    if (!res.ok) return { ok: false, error: res.error, attempts: attempt };
    raw = res.content;
    const extracted = tryExtractJson(raw);
    if (extracted.ok) {
      const value = req.parse(unwrapModelJson(extracted.value));
      if (value !== null) {
        const code = req.validator ? req.validator(value) : null;
        if (code === null) return { ok: true, value, attempts: attempt };
        lastError = code;
      } else {
        lastError = req.parseErrorCode ?? 'LLM_BAD_JSON';
      }
    } else {
      lastError = req.parseErrorCode ?? 'LLM_BAD_JSON';
    }
    if (attempt < maxAttempts) {
      const rawExcerpt = raw.slice(0, REPAIR_RAW_MAX_CHARS);
      messages.push({ role: 'assistant', content: rawExcerpt });
      messages.push({
        role: 'user',
        content: `你上一次的输出未通过校验，失败原因：${lastError}。请严格只输出一个 JSON 对象${req.schemaHint ? `，形状：${req.schemaHint}` : ''}；不得包含解释、注释、markdown 或代码。你上次的输出仅供参考，不得重复其中的错误：${rawExcerpt}`,
      });
    }
  }
  return { ok: false, error: lastError, attempts: maxAttempts };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 提案形状解析：summary 字符串 + steps 数组（深度业务校验交给 planner.validateProposal） */
function parseRawProposal(value: unknown): RawProposal | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.summary !== 'string' || !Array.isArray(value.steps)) return null;
  if (value.basisRefs !== undefined && !Array.isArray(value.basisRefs)) return null;
  return value as unknown as RawProposal;
}

/** OpenAI-compatible chat/completions 边界（智谱/Kimi 均兼容该协议） */
export class OpenAICompatibleAdapter implements ModelAdapter {
  id = 'openai-compatible';
  private key = process.env.AGENT_LLM_API_KEY ?? '';
  private baseUrl = trimSlash(process.env.AGENT_LLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4');
  private model = process.env.AGENT_LLM_MODEL ?? 'glm-5.3-flash';

  available(): boolean {
    return Boolean(this.key) && Boolean(this.baseUrl);
  }

  async propose(input: ProposeInput): Promise<ProposeResult> {
    if (!this.available()) return { error: 'NO_CREDENTIALS' };
    // 上下文裁剪：只送 key/data/availability（不带内部对象），符合最小化原则
    const minimal = input.bundle.items.map((i) => ({ key: i.key, scope: i.scope, availability: i.availability, data: i.data, truth: i.truth }));
    const res = await structured<RawProposal>({
      model: this.model,
      messages: [
        { role: 'system', content: renderPlanProposalPrompt() },
        { role: 'user', content: JSON.stringify({ objective: input.objective, context: minimal }) },
      ],
      parse: parseRawProposal,
      schemaHint: PLAN_PROPOSAL_SCHEMA_HINT,
      // 深度校验（数字溯源/登记 ID）在 planner.validateProposal；此处 2 次尝试只救形状与坏 JSON
      maxAttempts: 2,
    });
    if (!res.ok) return { error: res.error };
    return { proposal: res.value, adapterId: this.id };
  }
}

/** 当前启用链：环境变量配置了凭据 → LLM 优先；否则确定性回退（本仓库默认状态） */
export function activeAdapter(): ModelAdapter | null {
  const adapter = new OpenAICompatibleAdapter();
  return adapter.available() ? adapter : null;
}

export function fallbackReason(): string {
  return process.env.AGENT_LLM_API_KEY ? 'MODEL_NOT_ATTEMPTED' : 'NO_CREDENTIALS';
}
