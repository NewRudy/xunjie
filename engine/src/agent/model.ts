// ModelAdapter 边界（任务合同：预留 OpenAI-compatible/Kimi/智谱接入，无凭据不外呼、不打印密钥）
// 约定：适配器输出只是"原始提案"，必须经 planner.validateProposal 确定性校验后才可能生效；
// 校验不过 → 整条丢弃回退确定性 planner，并在响应中给出 fallback 原因。
//
// 环境变量（全部可选；不设置则永远走确定性回退）：
//   AGENT_LLM_API_KEY   API 密钥（Zhipu/Kimi/OpenAI-compatible 均用此名）
//   AGENT_LLM_BASE_URL  默认 https://open.bigmodel.cn/api/paas/v4（智谱）；Kimi 用 https://api.moonshot.cn/v1
//   AGENT_LLM_MODEL     默认 glm-4.6
import type { RawProposal } from './types';
import type { ContextBundle } from './context';

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
  const model = opts.model ?? process.env.AGENT_LLM_MODEL ?? 'glm-4.6';
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

/** OpenAI-compatible chat/completions 边界（智谱/Kimi 均兼容该协议） */
export class OpenAICompatibleAdapter implements ModelAdapter {
  id = 'openai-compatible';
  private key = process.env.AGENT_LLM_API_KEY ?? '';
  private baseUrl = trimSlash(process.env.AGENT_LLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4');
  private model = process.env.AGENT_LLM_MODEL ?? 'glm-4.6';

  available(): boolean {
    return Boolean(this.key) && Boolean(this.baseUrl);
  }

  async propose(input: ProposeInput): Promise<ProposeResult> {
    if (!this.available()) return { error: 'NO_CREDENTIALS' };
    // 上下文裁剪：只送 key/data/availability（不带内部对象），符合最小化原则
    const minimal = input.bundle.items.map((i) => ({ key: i.key, scope: i.scope, availability: i.availability, data: i.data, truth: i.truth }));
    const res = await chatCompletions({
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            '你是微电网运维任务规划器。只输出 JSON：{"summary":string,"steps":[{"kind":"navigate|focus|inspect|capture-evidence|request-confirmation|verify","title":string,"targetId"?:string,"requiredEvidence"?:string[]}],"basisRefs":string[]}。' +
            '硬性约束：不得新增任何数字、设备 ID、坐标或未登记动作；targetId/requiredEvidence 只能取自上下文；summary 中的数字必须逐字来自上下文。',
        },
        { role: 'user', content: JSON.stringify({ objective: input.objective, context: minimal }) },
      ],
    });
    if (!res.ok) return { error: res.error };
    try {
      const proposal = JSON.parse(res.content.replace(/^```json\s*|```\s*$/g, '')) as RawProposal;
      return { proposal, adapterId: this.id };
    } catch {
      return { error: 'LLM_BAD_JSON' };
    }
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
