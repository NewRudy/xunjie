// 巡界数字运维员：自然语言指令 → 受控数字人动作（contracts/avatar-command.md）
// 确定性中文解析，不依赖 LLM/密钥；只输出合同受控命令集合，绝不生成脚本、Cesium API 或未登记坐标。
// 本模块为纯函数（无 IO、无状态副作用，除响应内 commandId 序号外），Demo 稳定性优先。

// —— 受控命令集合（contracts/avatar-command.md §3） ——

export type AvatarMovement = 'walk' | 'run' | 'fly';
export type AvatarTargetId = 'OPS-01' | 'CP-B02-FRONT' | 'CP-B02-ROOF' | 'CP-INV-B02';

export type AvatarCommand =
  | { commandId: string; kind: 'navigate'; targetId: AvatarTargetId; movement: AvatarMovement }
  | { commandId: string; kind: 'move_relative'; direction: 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down'; distanceMeters: number; movement: AvatarMovement }
  | { commandId: string; kind: 'turn'; degrees: number }
  | { commandId: string; kind: 'jump' }
  | { commandId: string; kind: 'stop' }
  | { commandId: string; kind: 'focus_asset'; targetId: 'STR-B2-07' | 'INV-B-02' }
  | { commandId: string; kind: 'repair_simulation'; targetId: 'STR-B2-07'; checkpointId: 'CP-INV-B02' };

export interface AvatarInterpretation {
  normalizedText: string;
  reply: string;
  commands: AvatarCommand[];
}

/** Omit 对联合类型分发，保留每个分支的形状 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type AvatarCommandInput = DistributiveOmit<AvatarCommand, 'commandId'>;

/** 统一告警：仅数字现场仿真，不控制真实设备（合同 §2） */
export const AVATAR_WARNINGS = [
  '仅数字现场仿真（SIMULATED）：只控制数字孪生中的虚拟运维员，不连接、不控制任何真实设备',
];

/** 可说的示例（无法理解/目标不唯一时随 CLARIFICATION_NEEDED 返回，合同 §4） */
export const AVATAR_EXAMPLES = [
  '跑到 B2 楼前',
  '飞到 B2 屋顶',
  '去 B2 逆变器',
  '回运维点',
  '向前走 10 米',
  '上升 10 米',
  '左转 90 度',
  '跳一下',
  '停下',
  '维修 7 号异常组串',
];

// —— 澄清错误（路由层映射 400 CLARIFICATION_NEEDED，不猜目标） ——

export class AvatarClarificationError extends Error {
  constructor(message: string, public readonly examples: string[] = AVATAR_EXAMPLES) {
    super(message);
    this.name = 'AvatarClarificationError';
  }
}

const clarify = (message: string): never => {
  throw new AvatarClarificationError(message);
};

// —— 归一化：全角→半角、压缩空白、统一可读文本 ——

export function normalizeAvatarText(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

// —— 距离/角度钳制（合同 §3：distance 1..50，degrees -180..180） ——

const clampNum = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const DIST_MIN = 1;
const DIST_MAX = 50;
const DIST_DEFAULT = 10;
const DEG_MIN = -180;
const DEG_MAX = 180;

// —— 简式中文数字（一~九十九，距离/角度用）：十→10、十五→15、二十五→25 ——

const CN_DIGIT: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnToInt(text: string): number {
  if (text === '十') return 10;
  const tenIdx = text.indexOf('十');
  if (tenIdx === -1) return CN_DIGIT[text] ?? Number.NaN;
  const tens = tenIdx > 0 ? CN_DIGIT[text[tenIdx - 1]] : 1;
  const ones = tenIdx < text.length - 1 ? CN_DIGIT[text[tenIdx + 1]] : 0;
  return tens * 10 + ones;
}

/** 把紧邻“米/度”的简式中文数字替换为阿拉伯数字，便于统一提取 */
function normalizeCnNumbers(text: string): string {
  return text.replace(/([一二两三四五六七八九十]{1,3})(?=\s*(?:米|公尺|度))/g, (m) => String(cnToInt(m)));
}

// —— 词表（确定性 v1 映射，contracts/avatar-command.md §4） ——

const RE = {
  repair: /维修|修复|消缺|检修/,
  string7: /7\s*号|七号/,
  stringOtherNo: /[0-9一二两三四五六八九]\s*号/,
  roof: /屋顶|楼顶|屋面/,
  front: /楼前|楼跟前|大楼前|门前/,
  inverter: /逆变器/,
  ops: /(?:回|返回|回到|回去)(?:到)?运维/,
  forward: /向前|往前|前进/,
  backward: /向后|往后|后退/,
  left: /向左(?!转)|往左(?!转)|左移/,
  right: /向右(?!转)|往右(?!转)|右移/,
  up: /上升|向上|往上|升高|爬升/,
  down: /下降|向下|往下|降低/,
  turn: /左转|右转|转身|掉头/,
  turnLeft: /左转/,
  turnRight: /右转/,
  degrees: /(-?\d+(?:\.\d+)?)\s*(?:度|°)/,
  number: /(\d+(?:\.\d+)?)/,
  fly: /飞/,
  run: /跑/,
  stop: /停下|停止|站住|暂停|别动|停一下/,
  jump: /跳一下|跳一跳|跳跃/,
} as const;

const TARGET_LABEL: Record<AvatarTargetId, string> = {
  'OPS-01': '运维点',
  'CP-B02-FRONT': 'B2 楼前',
  'CP-B02-ROOF': 'B2 屋顶',
  'CP-INV-B02': 'B2 逆变器',
};

const MOVE_VERB: Record<AvatarMovement, string> = { walk: '步行', run: '跑步', fly: '飞行' };

// —— commandId：单次响应内唯一（avatar-<批次>-<序号>；批次进程内自增，确定性） ——

let interpretSeq = 0;

function withIds(commands: AvatarCommandInput[]): AvatarCommand[] {
  const batch = ++interpretSeq;
  return commands.map((c, i) => ({ ...c, commandId: `avatar-${batch}-${i + 1}` }) as AvatarCommand);
}

// —— 解析主流程 ——

/** 维修意图：目标组串在本场景唯一登记为 STR-B2-07（fixture.demoAnomaly），编号不符/缺失不猜 */
function parseRepair(text: string): AvatarCommand[] | null {
  if (!RE.repair.test(text)) return null;
  const mentionsRoof = RE.roof.test(text);
  const isSeven = RE.string7.test(text) || (/(组串|异常)/.test(text) && !RE.stringOtherNo.test(text));
  if (!isSeven) {
    clarify('维修目标不明确：本场景仅登记 7 号异常组串（STR-B2-07），请明确说「维修 7 号异常组串」，不猜测其他编号');
  }
  const cmds: AvatarCommandInput[] = [];
  if (mentionsRoof) {
    // 同一句明确飞到 B2 屋顶：先飞到屋面检查点，维修动作按合同安全落点（CP-INV-B02）处理
    cmds.push({ kind: 'navigate', targetId: 'CP-B02-ROOF', movement: 'fly' });
    cmds.push({ kind: 'focus_asset', targetId: 'STR-B2-07' });
    cmds.push({ kind: 'repair_simulation', targetId: 'STR-B2-07', checkpointId: 'CP-INV-B02' });
    return withIds(cmds);
  }
  const movement: AvatarMovement = RE.fly.test(text) ? 'fly' : RE.run.test(text) ? 'run' : 'walk';
  cmds.push({ kind: 'navigate', targetId: 'CP-INV-B02', movement });
  cmds.push({ kind: 'focus_asset', targetId: 'STR-B2-07' });
  cmds.push({ kind: 'repair_simulation', targetId: 'STR-B2-07', checkpointId: 'CP-INV-B02' });
  return withIds(cmds);
}

function parseNavigate(text: string): AvatarCommand[] | null {
  const hits: AvatarTargetId[] = [];
  if (RE.roof.test(text)) hits.push('CP-B02-ROOF');
  if (RE.front.test(text)) hits.push('CP-B02-FRONT');
  if (RE.inverter.test(text)) hits.push('CP-INV-B02');
  if (RE.ops.test(text)) hits.push('OPS-01');
  const unique = [...new Set(hits)];
  if (unique.length === 0) return null;
  if (unique.length > 1) {
    clarify(`目标不唯一（命中 ${unique.map((t) => TARGET_LABEL[t]).join('、')}）：一次说一个目的地，例如「跑到 B2 楼前」「飞到 B2 屋顶」`);
  }
  const target = unique[0];
  const movement: AvatarMovement = RE.fly.test(text) ? 'fly' : RE.run.test(text) ? 'run' : target === 'CP-B02-ROOF' ? 'fly' : 'walk';
  return withIds([{ kind: 'navigate', targetId: target, movement }]);
}

function parseRelative(text: string): AvatarCommand[] | null {
  const dir = RE.forward.test(text) ? 'forward'
    : RE.backward.test(text) ? 'backward'
    : RE.left.test(text) ? 'left'
    : RE.right.test(text) ? 'right'
    : RE.up.test(text) ? 'up'
    : RE.down.test(text) ? 'down'
    : null;
  if (!dir) return null;
  const numMatch = text.match(RE.number);
  const requested = numMatch ? Number.parseFloat(numMatch[1]) : DIST_DEFAULT;
  if (!Number.isFinite(requested)) clarify(`距离无法解析：「${text}」，例如「向前走 10 米」`);
  const distanceMeters = clampNum(requested, DIST_MIN, DIST_MAX);
  // 合同 §3：up/down 必须飞行；水平方向按动词 walk/run/fly
  const movement: AvatarMovement = dir === 'up' || dir === 'down' ? 'fly' : RE.fly.test(text) ? 'fly' : RE.run.test(text) ? 'run' : 'walk';
  return withIds([{ kind: 'move_relative', direction: dir, distanceMeters, movement }]);
}

function parseTurn(text: string): AvatarCommand[] | null {
  if (!RE.turn.test(text)) return null;
  const isLeft = RE.turnLeft.test(text);
  const isRight = RE.turnRight.test(text);
  const degMatch = text.match(RE.degrees);
  const requested = degMatch ? Number.parseFloat(degMatch[1]) : 90;
  if (!Number.isFinite(requested)) clarify(`角度无法解析：「${text}」，例如「左转 90 度」`);
  // 约定：左转=逆时针=正角度，右转=负角度（转身/掉头=180）
  const sign = isLeft ? 1 : isRight ? -1 : 1;
  const degrees = clampNum(Math.abs(requested) * sign, DEG_MIN, DEG_MAX);
  return withIds([{ kind: 'turn', degrees }]);
}

function parseSimple(text: string): AvatarCommand[] | null {
  if (RE.stop.test(text)) return withIds([{ kind: 'stop' }]);
  if (RE.jump.test(text)) return withIds([{ kind: 'jump' }]);
  // 去掉客套词后整句恰为「停/跳」也算命中（Demo 口语容错，仍确定性）
  const bare = text.replace(/[请麻烦帮忙你好吧呀啊呢嘛一下吗。，！？!?,\s]/g, '');
  if (bare === '停') return withIds([{ kind: 'stop' }]);
  if (bare === '跳') return withIds([{ kind: 'jump' }]);
  return null;
}

/** 单句（无连接词）解析；无法理解返回 null（由入口统一澄清） */
function parseSingle(text: string): AvatarCommand[] | null {
  const repair = parseRepair(text);
  if (repair) return repair;

  const nav = parseNavigate(text);
  const simple = parseSimple(text);
  const turn = parseTurn(text);
  const relative = parseRelative(text);

  // 一句多意图不猜：v1 每句一个动作（维修+屋顶的复合句已在 parseRepair 内处理）
  const matched = [nav, simple, turn, relative].filter(Boolean) as AvatarCommand[][];
  if (matched.length > 1) {
    clarify('一句包含多个动作，暂不支持：请一次说一个动作，例如「先停下」或「左转 90 度」');
  }
  return matched.length === 1 ? matched[0] : null;
}

/**
 * 解析一句中文指令 → 受控命令序列。
 * 无法理解 / 目标不唯一 / 一句多动作 → AvatarClarificationError（路由层转 400 CLARIFICATION_NEEDED）。
 */
export function parseAvatarCommand(rawText: string): AvatarCommand[] {
  const text = normalizeCnNumbers(normalizeAvatarText(rawText));
  if (!text) return clarify('指令为空：请说一句可执行的指令，例如「跑到 B2 楼前」');

  // 复合句（然后/再/，…）：分段解析，多段命中动作 → 澄清，不静默丢弃
  const parts = text.split(/然后|接着|之后|以后|，|,|。|；|;|！|!|？|\?/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const parsed = parts.map((p) => parseSingle(p)).filter(Boolean) as AvatarCommand[][];
    if (parsed.length > 1) {
      return clarify('一句包含多个动作，暂不支持：请一次说一个动作，例如「先停下」或「左转 90 度」');
    }
    if (parsed.length === 1) return parsed[0];
    return clarify(`无法理解指令：「${normalizeAvatarText(rawText)}」。可说的示例：${AVATAR_EXAMPLES.slice(0, 5).join('；')} 等`);
  }

  return parseSingle(text) ?? clarify(`无法理解指令：「${normalizeAvatarText(rawText)}」。可说的示例：${AVATAR_EXAMPLES.slice(0, 5).join('；')} 等`);
}

// —— 对外解释入口：外壳数据（truth=SIMULATED + 仿真告警由路由层统一附加） ——

export function interpretAvatarCommand(rawText: string): AvatarInterpretation {
  const commands = parseAvatarCommand(rawText);
  const normalizedText = normalizeAvatarText(rawText);
  return { normalizedText, reply: buildReply(commands), commands };
}

function buildReply(commands: AvatarCommand[]): string {
  const last = commands[commands.length - 1];
  switch (last.kind) {
    case 'navigate':
      return `收到，${MOVE_VERB[last.movement]}前往「${TARGET_LABEL[last.targetId]}」。`;
    case 'move_relative': {
      const dirLabel = { forward: '前', backward: '后', left: '左', right: '右', up: '上', down: '下' }[last.direction];
      return `收到，向${dirLabel}${MOVE_VERB[last.movement]} ${last.distanceMeters} 米。`;
    }
    case 'turn': {
      const dir = last.degrees >= 0 ? '左' : '右';
      return `收到，${dir}转 ${Math.abs(last.degrees)} 度。`;
    }
    case 'jump':
      return '收到，原地跳一下。';
    case 'stop':
      return '收到，立即停下。';
    case 'repair_simulation': {
      const flewToRoof = commands.some((c) => c.kind === 'navigate' && c.targetId === 'CP-B02-ROOF');
      return flewToRoof
        ? '收到，飞往 B2 屋顶，随后按安全落点（B2 逆变器检查点）执行 7 号异常组串维修仿真。'
        : '收到，前往 B2 逆变器并执行 7 号异常组串维修仿真。';
    }
    default:
      return '收到。';
  }
}
