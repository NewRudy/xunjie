// 人物指令 LLM-first 解释（contracts/avatar-command.md §0/§2）
// 配置 AGENT_LLM_API_KEY 时真实调用 OpenAI-compatible 模型（复用 model.ts chatCompletions 通道）。
// 模型输出只是"原始意图"：必须通过本模块独立确定性白名单校验（kind/字段集合/登记 ID/数值域）才生效；
// HTTP/超时/JSON/校验任一失败 → 整条丢弃，回退 avatar.ts 确定性中文解析，planner 如实标注（reason 只给错误类型）。
import { AvatarClarificationError, DEG_MAX, DEG_MIN, DIST_MAX, DIST_MIN, buildReply, interpretAvatarCommand, normalizeAvatarText, withIds } from './avatar';
import type { AvatarCommand, AvatarCommandInput, AvatarMovement, AvatarTargetId } from './avatar';
import { chatCompletions } from './model';
import type { PlannerInfo } from './types';

// —— system prompt：只允许输出 JSON，命令只能来自合同 §3 白名单与登记 ID ——

const AVATAR_SYSTEM_PROMPT = [
  '你是「巡界」数字运维员的指令解释器，把一句中文口语映射为受控命令序列。只输出一个 JSON 对象，禁止输出任何解释、注释、markdown 或代码。',
  '格式：{"reply":"<简短中文确认，一两句>","commands":[<命令>...]}',
  'commands 每个元素必须恰好是以下形状之一（字段名与取值完全一致，不得增加/缺少字段，不得携带 commandId，服务端统一编号）：',
  '{"kind":"navigate","targetId":"OPS-01"|"CP-B02-FRONT"|"CP-B02-ROOF"|"CP-INV-B02","movement":"walk"|"run"|"fly"}',
  '{"kind":"move_relative","direction":"forward"|"backward"|"left"|"right"|"up"|"down","distanceMeters":<1..50 数值>,"movement":"walk"|"run"|"fly"}',
  '{"kind":"turn","degrees":<-180..180 数值>}',
  '{"kind":"jump"}',
  '{"kind":"stop"}',
  '{"kind":"focus_asset","targetId":"STR-B2-07"|"INV-B-02"}',
  '{"kind":"repair_simulation","targetId":"STR-B2-07","checkpointId":"CP-INV-B02"}',
  '{"kind":"start_inspection","anomalyId":"ANOM-DEMO-01"}',
  '{"kind":"decide_pending","decision":"approve"|"reject"}',
  '{"kind":"capture_evidence","evidenceKinds":["photo","thermal","reading"]}',
  '硬性约束：',
  '1. targetId/anomalyId/checkpointId 只能取上表登记值——这是本场景全部登记对象；禁止发明其他 ID、世界坐标、脚本、Cesium API 或任何代码。',
  '2. direction 为 up/down 时 movement 必须为 "fly"；distanceMeters 取 1..50；degrees 取 -180..180。',
  '3. commands 按执行顺序排列，最多 6 条；无法把用户输入映射为上述命令时，输出 {"reply":"...","commands":[]}。',
  '4. 你只控制数字孪生中的虚拟运维员（SIMULATED 仿真），绝不输出任何真实设备操作。',
  '5. 语义映射参考：「维修 7 号异常组串」→ navigate CP-INV-B02 + focus_asset STR-B2-07 + repair_simulation；「检查 B2 屋顶异常」→ start_inspection；「我同意/我不同意」→ decide_pending approve/reject；「采集证据」→ capture_evidence。',
].join('\n');

// —— JSON 提取：容忍 ```json 围栏与少量前后缀文本；解析失败一律 LLM_BAD_JSON ——

const BROKEN = Symbol('broken-json');

function extractJson(content: string): unknown | typeof BROKEN {
  const stripped = content.replace(/^```json\s*|```\s*$/g, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // 继续尝试
  }
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch {
      // 落入 BROKEN
    }
  }
  return BROKEN;
}

// —— 独立严格确定性校验（不信任模型输出；任一命令不过 → 整条丢弃） ——

const NAV_TARGETS: readonly string[] = ['OPS-01', 'CP-B02-FRONT', 'CP-B02-ROOF', 'CP-INV-B02'];
const FOCUS_TARGETS: readonly string[] = ['STR-B2-07', 'INV-B-02'];
const DIRECTIONS: readonly string[] = ['forward', 'backward', 'left', 'right', 'up', 'down'];
const MOVEMENTS: readonly string[] = ['walk', 'run', 'fly'];
const EVIDENCE_KINDS = ['photo', 'thermal', 'reading'] as const;
export const AVATAR_LLM_MAX_COMMANDS = 6;
const REPLY_MAX_CHARS = 200;

type CommandCheck = { ok: true; command: AvatarCommandInput } | { ok: false; code: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 严格字段集合：键名与数量完全一致（模型多给 commandId 或任何额外字段都算不过） */
function exactFields(obj: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(obj);
  return keys.length === fields.length && fields.every((f) => f in obj);
}

function validateCommand(raw: unknown): CommandCheck {
  if (!isPlainObject(raw)) return { ok: false, code: 'SHAPE' };
  const { kind } = raw;
  if (!isStr(kind)) return { ok: false, code: 'KIND' };
  switch (kind) {
    case 'navigate': {
      if (!exactFields(raw, ['kind', 'targetId', 'movement'])) return { ok: false, code: 'FIELDS' };
      if (!isStr(raw.targetId) || !NAV_TARGETS.includes(raw.targetId)) return { ok: false, code: 'TARGET' };
      if (!isStr(raw.movement) || !MOVEMENTS.includes(raw.movement)) return { ok: false, code: 'MOVEMENT' };
      return { ok: true, command: { kind: 'navigate', targetId: raw.targetId as AvatarTargetId, movement: raw.movement as AvatarMovement } };
    }
    case 'move_relative': {
      if (!exactFields(raw, ['kind', 'direction', 'distanceMeters', 'movement'])) return { ok: false, code: 'FIELDS' };
      if (!isStr(raw.direction) || !DIRECTIONS.includes(raw.direction)) return { ok: false, code: 'DIRECTION' };
      if (!isStr(raw.movement) || !MOVEMENTS.includes(raw.movement)) return { ok: false, code: 'MOVEMENT' };
      if (!isNum(raw.distanceMeters) || raw.distanceMeters < DIST_MIN || raw.distanceMeters > DIST_MAX) return { ok: false, code: 'DISTANCE' };
      // 合同 §3：up/down 必须飞行
      if ((raw.direction === 'up' || raw.direction === 'down') && raw.movement !== 'fly') return { ok: false, code: 'MOVEMENT_FLY' };
      return {
        ok: true,
        command: { kind: 'move_relative', direction: raw.direction as 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down', distanceMeters: raw.distanceMeters, movement: raw.movement as AvatarMovement },
      };
    }
    case 'turn': {
      if (!exactFields(raw, ['kind', 'degrees'])) return { ok: false, code: 'FIELDS' };
      if (!isNum(raw.degrees) || raw.degrees < DEG_MIN || raw.degrees > DEG_MAX) return { ok: false, code: 'DEGREES' };
      return { ok: true, command: { kind: 'turn', degrees: raw.degrees } };
    }
    case 'jump':
    case 'stop': {
      if (!exactFields(raw, ['kind'])) return { ok: false, code: 'FIELDS' };
      return { ok: true, command: { kind } };
    }
    case 'focus_asset': {
      if (!exactFields(raw, ['kind', 'targetId'])) return { ok: false, code: 'FIELDS' };
      if (!isStr(raw.targetId) || !FOCUS_TARGETS.includes(raw.targetId)) return { ok: false, code: 'TARGET' };
      return { ok: true, command: { kind: 'focus_asset', targetId: raw.targetId as 'STR-B2-07' | 'INV-B-02' } };
    }
    case 'repair_simulation': {
      if (!exactFields(raw, ['kind', 'targetId', 'checkpointId'])) return { ok: false, code: 'FIELDS' };
      // 维修检查点唯一：STR-B2-07 @ CP-INV-B02（fixture 登记）
      if (raw.targetId !== 'STR-B2-07' || raw.checkpointId !== 'CP-INV-B02') return { ok: false, code: 'TARGET' };
      return { ok: true, command: { kind: 'repair_simulation', targetId: 'STR-B2-07', checkpointId: 'CP-INV-B02' } };
    }
    case 'start_inspection': {
      if (!exactFields(raw, ['kind', 'anomalyId'])) return { ok: false, code: 'FIELDS' };
      if (raw.anomalyId !== 'ANOM-DEMO-01') return { ok: false, code: 'TARGET' };
      return { ok: true, command: { kind: 'start_inspection', anomalyId: 'ANOM-DEMO-01' } };
    }
    case 'decide_pending': {
      if (!exactFields(raw, ['kind', 'decision'])) return { ok: false, code: 'FIELDS' };
      if (raw.decision !== 'approve' && raw.decision !== 'reject') return { ok: false, code: 'DECISION' };
      return { ok: true, command: { kind: 'decide_pending', decision: raw.decision } };
    }
    case 'capture_evidence': {
      if (!exactFields(raw, ['kind', 'evidenceKinds'])) return { ok: false, code: 'FIELDS' };
      const kinds = raw.evidenceKinds;
      if (!Array.isArray(kinds) || kinds.length !== EVIDENCE_KINDS.length || !EVIDENCE_KINDS.every((k, i) => kinds[i] === k)) {
        return { ok: false, code: 'EVIDENCE' };
      }
      return { ok: true, command: { kind: 'capture_evidence', evidenceKinds: ['photo', 'thermal', 'reading'] } };
    }
    default:
      return { ok: false, code: 'KIND' };
  }
}

export type LlmAvatarValidation = { ok: true; commands: AvatarCommandInput[]; reply: string | null } | { ok: false; code: string };

/** 顶层校验：形状/reply/数量上限 + 逐条白名单；失败只给错误类型 code（不回传模型原文） */
export function validateLlmAvatarOutput(raw: unknown): LlmAvatarValidation {
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
    const checked = validateCommand(c);
    if (!checked.ok) return checked;
    out.push(checked.command);
  }
  return { ok: true, commands: out, reply: llmReply };
}

// —— LLM 调用 + 校验 → 或错误类型 ——

type LlmAttempt = { ok: true; commands: AvatarCommand[]; reply: string } | { ok: false; error: string };

async function interpretViaLlm(rawText: string): Promise<LlmAttempt> {
  const res = await chatCompletions({
    messages: [
      { role: 'system', content: AVATAR_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ text: normalizeAvatarText(rawText) }) },
    ],
  });
  if (!res.ok) return { ok: false, error: res.error };
  const parsed = extractJson(res.content);
  if (parsed === BROKEN) return { ok: false, error: 'LLM_BAD_JSON' };
  const validated = validateLlmAvatarOutput(parsed);
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

export async function interpretAvatar(rawText: string): Promise<AvatarOutcome> {
  const normalizedText = normalizeAvatarText(rawText);

  // 无凭据：完全保持既有确定性行为，绝不外呼
  if (!process.env.AGENT_LLM_API_KEY) {
    try {
      const { reply, commands } = interpretAvatarCommand(rawText);
      return { normalizedText, reply, commands, planner: DETERMINISTIC_PLANNER };
    } catch (e) {
      if (e instanceof AvatarClarificationError) throw e.withPlanner(DETERMINISTIC_PLANNER);
      throw e;
    }
  }

  const llm = await interpretViaLlm(rawText);
  if (llm.ok) {
    return { normalizedText, reply: llm.reply, commands: llm.commands, planner: { mode: 'llm', modelAvailable: true } };
  }

  // 模型失败（HTTP/超时/JSON/校验）：整条丢弃 → 确定性回退，reason 只给错误类型
  const planner: PlannerInfo = { mode: 'deterministic-fallback', modelAvailable: true, reason: llm.error };
  try {
    const { reply, commands } = interpretAvatarCommand(rawText);
    return { normalizedText, reply, commands, planner };
  } catch (e) {
    if (e instanceof AvatarClarificationError) throw e.withPlanner(planner);
    throw e;
  }
}
