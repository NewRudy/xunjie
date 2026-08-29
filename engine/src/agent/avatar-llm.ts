// 人物指令 LLM-first 解释（contracts/avatar-command.md §0/§2）
// 配置 AGENT_LLM_API_KEY 时真实调用 OpenAI-compatible 模型（经 model.ts structured 网关）。
// system prompt 与输出校验均由 capabilities.ts 能力目录单一来源驱动；
// 模型输出只是"原始意图"：必须通过确定性白名单校验（kind/字段集合/登记 ID/数值域）才生效；
// HTTP/超时/JSON/校验任一失败 → 整条丢弃，回退 avatar.ts 确定性中文解析，planner 如实标注（reason 只给错误类型）。
import { AvatarClarificationError, buildReply, interpretAvatarCommand, normalizeAvatarText, withIds } from './avatar';
import type { AvatarCommand, AvatarCommandInput, AvatarScene } from './avatar';
import { avatarCapabilityFor, avatarRepairPairsFor, renderAvatarSystemPromptFor } from './capabilities';
import { structured } from './model';
import type { PlannerInfo } from './types';

const AVATAR_SYSTEM_PROMPT_PECC = renderAvatarSystemPromptFor('pecc');
const AVATAR_SYSTEM_PROMPT_WIND = renderAvatarSystemPromptFor('wind');
const AVATAR_SYSTEM_PROMPT_HYDRO = renderAvatarSystemPromptFor('hydro');

export const AVATAR_LLM_MAX_COMMANDS = 6;
const REPLY_MAX_CHARS = 200;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 严格字段集合：键名与数量完全一致（模型多给 commandId 或任何额外字段都算不过） */
function exactFields(obj: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(obj);
  return keys.length === fields.length && fields.every((f) => f in obj);
}

type CommandCheck = { ok: true; command: AvatarCommandInput } | { ok: false; code: string };

/** 按能力目录逐字段校验 + 跨字段确定性规则；字段集合/取值域/数值域全部来自登记，不在校验处硬编码 */
function validateCommand(raw: unknown, scene: AvatarScene): CommandCheck {
  if (!isPlainObject(raw)) return { ok: false, code: 'SHAPE' };
  const { kind } = raw;
  if (!isStr(kind)) return { ok: false, code: 'KIND' };
  const cap = avatarCapabilityFor(scene, kind);
  if (!cap) return { ok: false, code: 'KIND' };
  if (!exactFields(raw, cap.fields)) return { ok: false, code: 'FIELDS' };

  for (const field of cap.fields) {
    if (field === 'kind') continue;
    const failCode = cap.fieldErrorCodes[field] ?? 'FIELDS';
    const exactArray = cap.exactArrays?.[field];
    if (exactArray) {
      const arr = raw[field];
      if (!Array.isArray(arr) || arr.length !== exactArray.length || !exactArray.every((v, i) => arr[i] === v)) {
        return { ok: false, code: failCode };
      }
      continue;
    }
    const domain = cap.domains?.[field];
    if (domain && (!isStr(raw[field]) || !domain.includes(raw[field] as string))) return { ok: false, code: failCode };
    const range = cap.ranges?.[field];
    if (range && (!isNum(raw[field]) || raw[field] < range.min || raw[field] > range.max)) return { ok: false, code: failCode };
  }

  // —— 跨字段确定性规则（无法表达为单字段取值域的组合约束） ——
  if (kind === 'move_relative' && (raw.direction === 'up' || raw.direction === 'down') && raw.movement !== 'fly') {
    return { ok: false, code: 'MOVEMENT_FLY' };
  }
  if (kind === 'repair_simulation') {
    // 同一目标可登记多个落点（STR-B2-07：CP-INV-B02 / CP-STR-B-07），按 (targetId, checkpointId) 成对匹配
    const pair = avatarRepairPairsFor(scene).some((p) => p.targetId === raw.targetId && p.checkpointId === raw.checkpointId);
    if (!pair) return { ok: false, code: 'TARGET' };
  }

  const { kind: _kind, ...values } = raw;
  return { ok: true, command: { kind, ...values } as unknown as AvatarCommandInput };
}

export type LlmAvatarValidation = { ok: true; commands: AvatarCommandInput[]; reply: string | null } | { ok: false; code: string };

/** 顶层校验：形状/reply/数量上限 + 逐条白名单；失败只给错误类型 code（不回传模型原文） */
export function validateLlmAvatarOutput(raw: unknown, scene: AvatarScene = 'pecc'): LlmAvatarValidation {
  if (!isPlainObject(raw)) return { ok: false, code: 'SHAPE' };
  const { commands, reply } = raw;
  if (!Array.isArray(commands) || commands.length === 0) return { ok: false, code: 'COMMANDS' };
  if (commands.length > AVATAR_LLM_MAX_COMMANDS) return { ok: false, code: 'COUNT' };
  let llmReply: string | null = null;
  if (reply !== undefined) {
    if (!isStr(reply)) return { ok: false, code: 'REPLY' };
    const trimmed = reply.trim().slice(0, REPLY_MAX_CHARS);
    if (trimmed) llmReply = trimmed;
  }
  const out: AvatarCommandInput[] = [];
  for (const c of commands) {
    const checked = validateCommand(c, scene);
    if (!checked.ok) return checked;
    out.push(checked.command);
  }
  return { ok: true, commands: out, reply: llmReply };
}

// —— LLM 调用（structured 网关）+ 校验 → 或错误类型 ——

type LlmAttempt = { ok: true; commands: AvatarCommand[]; reply: string } | { ok: false; error: string };

/** 注入 prompt 的历史轮次摘要（结构化、有界；来自 store.AgentTurn，不携带模型原文） */
export interface AvatarTurnHint {
  text: string;
  commands: Array<{ kind: string; targetId?: string }>;
}

async function interpretViaLlm(rawText: string, scene: AvatarScene, history?: AvatarTurnHint[]): Promise<LlmAttempt> {
  const userPayload = history?.length ? { text: normalizeAvatarText(rawText), recent: history } : { text: normalizeAvatarText(rawText) };
  const res = await structured<Record<string, unknown>>({
    messages: [
      { role: 'system', content: scene === 'wind' ? AVATAR_SYSTEM_PROMPT_WIND : scene === 'hydro' ? AVATAR_SYSTEM_PROMPT_HYDRO : AVATAR_SYSTEM_PROMPT_PECC },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
    parse: (v) => (isPlainObject(v) ? v : null),
    validator: (v) => {
      const checked = validateLlmAvatarOutput(v, scene);
      // 校验失败码统一带前缀，与传输层错误类型（LLM_HTTP_x/LLM_TIMEOUT 等不包前缀）区分
      return checked.ok ? null : `LLM_VALIDATION_FAILED:${checked.code}`;
    },
    // 冻结口径：校验失败单次即回退确定性解析（演示稳定性优先；赛后可评估开启修复重试）
    maxAttempts: 1,
  });
  if (!res.ok) return { ok: false, error: res.error };
  const validated = validateLlmAvatarOutput(res.value, scene);
  if (!validated.ok) return { ok: false, error: `LLM_VALIDATION_FAILED:${validated.code}` };
  const commands = withIds(validated.commands);
  return { ok: true, commands, reply: validated.reply ?? buildReply(commands) };
}

// —— 对外编排：LLM-first，失败整条丢弃回退确定性解析 ——

export interface AvatarOutcome {
  normalizedText: string;
  reply: string;
  commands: AvatarCommand[];
  planner: PlannerInfo;
}

const DETERMINISTIC_PLANNER: PlannerInfo = { mode: 'deterministic-fallback', modelAvailable: false, reason: 'NO_CREDENTIALS' };

export async function interpretAvatar(rawText: string, scene: AvatarScene = 'pecc', history?: AvatarTurnHint[]): Promise<AvatarOutcome> {
  const normalizedText = normalizeAvatarText(rawText);

  // 无凭据：完全保持既有确定性行为，绝不外呼
  if (!process.env.AGENT_LLM_API_KEY) {
    try {
      const { reply, commands } = interpretAvatarCommand(rawText, scene);
      return { normalizedText, reply, commands, planner: DETERMINISTIC_PLANNER };
    } catch (e) {
      if (e instanceof AvatarClarificationError) throw e.withPlanner(DETERMINISTIC_PLANNER);
      throw e;
    }
  }

  const llm = await interpretViaLlm(rawText, scene, history);
  if (llm.ok) {
    return { normalizedText, reply: llm.reply, commands: llm.commands, planner: { mode: 'llm', modelAvailable: true } };
  }

  // 模型失败（HTTP/超时/JSON/校验）：整条丢弃 → 确定性回退，reason 只给错误类型
  const planner: PlannerInfo = { mode: 'deterministic-fallback', modelAvailable: true, reason: llm.error };
  try {
    const { reply, commands } = interpretAvatarCommand(rawText, scene);
    return { normalizedText, reply, commands, planner };
  } catch (e) {
    if (e instanceof AvatarClarificationError) throw e.withPlanner(planner);
    throw e;
  }
}
