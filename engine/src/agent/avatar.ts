// 巡界数字运维员：自然语言指令 → 受控数字人动作（contracts/avatar-command.md）
// 确定性中文解析，不依赖 LLM/密钥；只输出合同受控命令集合，绝不生成脚本、Cesium API 或未登记坐标。
// 本模块按场景（PECC 光伏 / WIND-FARM-01 风电 / HYDRO-PLANT-01 水电）分别解析；风电登记 ID 来自 windFarm.ts（farm.json 单一事实源），水电登记 ID 来自 hydroDam.ts（dam.json 单一事实源）。
// Demo 稳定性优先：除响应内 commandId 序号与模块加载时的 farm.json 读取外无其他副作用。

import { WIND_REPAIR, windTargetLabel, windTurbineByNo } from './windFarm';
import { HYDRO_REPAIR, hydroDam, hydroTargetLabel, hydroUnitByNo } from './hydroDam';
import { SOLAR_REPAIR, solarBearingText, solarStringByCheckpointId, solarStringByZoneNo, solarTargetLabel } from './solarArray';
import type { PlannerInfo } from './types';

// —— 受控命令集合（contracts/avatar-command.md §3 + §9 风电场景） ——

export type AvatarMovement = 'walk' | 'run' | 'fly';
export type AvatarScene = 'pecc' | 'wind' | 'hydro';
export type PeccTargetId = 'OPS-01' | 'CP-B02-FRONT' | 'CP-B02-ROOF' | 'CP-INV-B02';
export type WindCheckpointId =
  | 'CP-WT-01' | 'CP-WT-02' | 'CP-WT-03' | 'CP-WT-04' | 'CP-WT-05'
  | 'CP-WT-06' | 'CP-WT-07' | 'CP-WT-08' | 'CP-WT-09' | 'CP-WT-10';
export type WindTurbineId =
  | 'HS-WTG-01' | 'HS-WTG-02' | 'HS-WTG-03' | 'HS-WTG-04' | 'HS-WTG-05'
  | 'HS-WTG-06' | 'HS-WTG-07' | 'HS-WTG-08' | 'HS-WTG-09' | 'HS-WTG-10';
export type HydroCheckpointId = 'CP-HU-01' | 'CP-HU-02' | 'CP-HU-03' | 'CP-GATE-01';
export type HydroUnitId = 'HS-HU-01' | 'HS-HU-02' | 'HS-HU-03' | 'HS-GATE-01';
/** 光伏阵列组串检查点（solar.json 登记，CP-STR-{A..G}-{nn}；数据驱动故用模板类型，不手抄 84 个字面量） */
export type SolarStringCheckpointId = `CP-STR-${'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'}-${string}`;
export type AvatarTargetId = PeccTargetId | 'OPS-WIND-01' | WindCheckpointId | 'OPS-HYDRO-01' | HydroCheckpointId | SolarStringCheckpointId;
export type AvatarFocusId = 'STR-B2-07' | 'INV-B-02' | WindTurbineId | HydroUnitId;

export type AvatarCommand =
  | { commandId: string; kind: 'navigate'; targetId: AvatarTargetId; movement: AvatarMovement }
  | { commandId: string; kind: 'move_relative'; direction: 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down'; distanceMeters: number; movement: AvatarMovement }
  | { commandId: string; kind: 'turn'; degrees: number }
  | { commandId: string; kind: 'jump' }
  | { commandId: string; kind: 'stop' }
  | { commandId: string; kind: 'focus_asset'; targetId: AvatarFocusId }
  | { commandId: string; kind: 'repair_simulation'; targetId: 'STR-B2-07'; checkpointId: 'CP-INV-B02' }
  | { commandId: string; kind: 'repair_simulation'; targetId: 'STR-B2-07'; checkpointId: 'CP-STR-B-07' }
  | { commandId: string; kind: 'repair_simulation'; targetId: 'HS-WTG-07'; checkpointId: 'CP-WT-07' }
  | { commandId: string; kind: 'repair_simulation'; targetId: 'HS-HU-02'; checkpointId: 'CP-HU-02' }
  | { commandId: string; kind: 'start_inspection'; anomalyId: 'ANOM-DEMO-01' }
  | { commandId: string; kind: 'decide_pending'; decision: 'approve' | 'reject' }
  | { commandId: string; kind: 'capture_evidence'; evidenceKinds: ['photo', 'thermal', 'reading'] };

export interface AvatarInterpretation {
  normalizedText: string;
  reply: string;
  commands: AvatarCommand[];
}

/** Omit 对联合类型分发，保留每个分支的形状 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type AvatarCommandInput = DistributiveOmit<AvatarCommand, 'commandId'>;

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
  'B 区 7 号组串在哪',
  '检查 B2 屋顶异常',
  '我同意',
  '我不同意',
  '采集证据',
];

/** 风电场景示例（合同 §9；山地尺度大，导航默认飞行） */
export const WIND_AVATAR_EXAMPLES = [
  '飞到 7 号风机',
  '维修 7 号风机',
  '跑到 2 号风机',
  '查看 5 号风机',
  '回运维点',
  '向前走 10 米',
  '左转 90 度',
  '跳一下',
  '停下',
];

/** 水电场景示例（镜像风电；坝区尺度大，导航默认飞行） */
export const HYDRO_AVATAR_EXAMPLES = [
  '飞到 2 号机组',
  '维修 2 号机组',
  '查看泄洪闸门',
  '查看 3 号机组',
  '规划巡检路线',
  '回运维点',
  '向前走 10 米',
  '左转 90 度',
  '跳一下',
  '停下',
];

export class AvatarClarificationError extends Error {
  constructor(message: string, public readonly examples: string[] = AVATAR_EXAMPLES, public readonly planner?: PlannerInfo) {
    super(message);
    this.name = 'AvatarClarificationError';
  }

  /** 回退/编排层携带本轮解释来源信息（planner 只含错误类型，不含密钥/请求体） */
  withPlanner(planner: PlannerInfo): AvatarClarificationError {
    return new AvatarClarificationError(this.message, this.examples, planner);
  }

  /** 场景化示例替换（风电场景澄清时给出风电示例，消息保持不变） */
  withExamples(examples: string[]): AvatarClarificationError {
    return new AvatarClarificationError(this.message, examples, this.planner);
  }
}

const clarify = (message: string): never => {
  throw new AvatarClarificationError(message);
};

// —— 归一化：全角→半角、压缩空白、统一可读文本 ——

export function normalizeAvatarText(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

// —— 距离/角度钳制（合同 §3：distance 1..2000（默认 10；用户说了多少用多少），degrees -180..180） ——

const clampNum = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const DIST_MIN = 1;
export const DIST_MAX = 2000;
const DIST_DEFAULT = 10;
export const DEG_MIN = -180;
export const DEG_MAX = 180;

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
  inspection: /检查|巡检|排查/,
  decideApprove: /同意|批准|赞同|执行/,
  // 负向优先：「不同意」包含「同意」，必须先判负向，避免误判为 approve
  decideReject: /不同意|不批准|不赞同|拒绝|取消/,
  evidence: /采集证据|提交证据|拍照取证|取证|拍照|采集/,
} as const;

const TARGET_LABEL: Record<string, string> = {
  'OPS-01': '运维点',
  'CP-B02-FRONT': 'B2 楼前',
  'CP-B02-ROOF': 'B2 屋顶',
  'CP-INV-B02': 'B2 逆变器',
  'STR-B2-07': '7 号异常组串',
  'INV-B-02': 'B2 逆变器',
};

/** 标签解析：光伏静态表优先，风电/水电/光伏阵列 ID 走各自 fixture 注册表（windFarm.ts / hydroDam.ts / solarArray.ts；未命中回退原 ID，互不冲突） */
const labelOf = (id: string): string => {
  if (TARGET_LABEL[id]) return TARGET_LABEL[id];
  const windLabel = windTargetLabel(id);
  if (windLabel !== id) return windLabel;
  const hydroLabel = hydroTargetLabel(id);
  return hydroLabel !== id ? hydroLabel : solarTargetLabel(id);
};

const MOVE_VERB: Record<AvatarMovement, string> = { walk: '步行', run: '跑步', fly: '飞行' };

// —— commandId：单次响应内唯一（avatar-<批次>-<序号>；批次进程内自增，确定性） ——

let interpretSeq = 0;

export function withIds(commands: AvatarCommandInput[]): AvatarCommand[] {
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

/** 巡检意图：fixture 唯一登记异常 ANOM-DEMO-01，其他编号不猜（合同 §3：不在本接口内另造任务状态） */
function parseInspection(text: string): AvatarCommand[] | null {
  if (!RE.inspection.test(text)) return null;
  if (RE.stringOtherNo.test(text) && !RE.string7.test(text)) {
    clarify('巡检目标不明确：本场景仅登记 ANOM-DEMO-01（B2 屋顶 7 号异常组串），请说「检查 B2 屋顶异常」，不猜测其他编号');
  }
  return withIds([{ kind: 'start_inspection', anomalyId: 'ANOM-DEMO-01' }]);
}

/** 审批意图：只返回语言意图，执行与否由前端读 pendingApproval 调既有审批接口（合同 §3）；负向优先 */
function parseDecision(text: string): AvatarCommand[] | null {
  if (RE.decideReject.test(text)) return withIds([{ kind: 'decide_pending', decision: 'reject' }]);
  if (RE.decideApprove.test(text)) return withIds([{ kind: 'decide_pending', decision: 'approve' }]);
  return null;
}

/** 采证意图：证据类型固定 photo/thermal/reading（fixture 约定），是否允许由前端按任务阶段校验 */
function parseEvidence(text: string): AvatarCommand[] | null {
  if (!RE.evidence.test(text)) return null;
  return withIds([{ kind: 'capture_evidence', evidenceKinds: ['photo', 'thermal', 'reading'] }]);
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

// —— 简式运动意图（口语容错，合同 §3）：整句恰为「上/下/左/右/前/后（可带距离）」或「起飞/飞行/降落/悬停」 ——
// 只做剥离客套词后的精确匹配，绝不子串匹配——「飞到 B2 屋顶」等长句仍走各自登记路由，不受影响。

const BARE_MOVE_RES: Array<[RegExp, 'up' | 'down' | 'left' | 'right' | 'forward' | 'backward']> = [
  [/^上(?:飞)?([0-9]+(?:\.[0-9]+)?)?米?$/, 'up'],
  [/^下(?:降|落|飞)?([0-9]+(?:\.[0-9]+)?)?米?$/, 'down'],
  [/^左(?:移|飞)?([0-9]+(?:\.[0-9]+)?)?米?$/, 'left'],
  [/^右(?:移|飞)?([0-9]+(?:\.[0-9]+)?)?米?$/, 'right'],
  [/^前(?:进|行|飞)?([0-9]+(?:\.[0-9]+)?)?米?$/, 'forward'],
  [/^后(?:退|飞)?([0-9]+(?:\.[0-9]+)?)?米?$/, 'backward'],
];
const BARE_TAKEOFF = /^(起飞|飞起来|飞行|飞|升空)$/;
const BARE_LAND = /^(降落|落地|着陆|降|下来)$/;
const BARE_HOVER = /^(悬停|停飞|原地待命)$/;
/** 简式指令专用剥离：按词去客套（「一下」整体剥离，绝不单剥「一/下」——否则「下」会被剥成空串） */
const BARE_STRIP = /请|麻烦|帮忙|你好|一下|吧|呀|啊|呢|嘛|吗|[。，！？!?,\s]/g;

function parseBareMove(text: string): AvatarCommand[] | null {
  const bare = text.replace(BARE_STRIP, '');
  if (BARE_TAKEOFF.test(bare)) return withIds([{ kind: 'move_relative', direction: 'up', distanceMeters: DIST_DEFAULT, movement: 'fly' }]);
  if (BARE_LAND.test(bare)) return withIds([{ kind: 'move_relative', direction: 'down', distanceMeters: DIST_DEFAULT, movement: 'fly' }]);
  if (BARE_HOVER.test(bare)) return withIds([{ kind: 'stop' }]);
  // 「飞 150 米」：未说方向 = 沿当前朝向前向飞行
  const flyM = bare.match(/^飞(?:行|往)?([0-9]+(?:\.[0-9]+)?)?米?$/);
  if (flyM && flyM[1]) {
    const requested = Number.parseFloat(flyM[1]);
    if (Number.isFinite(requested)) return withIds([{ kind: 'move_relative', direction: 'forward', distanceMeters: clampNum(requested, DIST_MIN, DIST_MAX), movement: 'fly' }]);
  }
  for (const [re, dir] of BARE_MOVE_RES) {
    const m = bare.match(re);
    if (!m) continue;
    const requested = m[1] ? Number.parseFloat(m[1]) : DIST_DEFAULT;
    if (!Number.isFinite(requested)) return null;
    // 合同 §3：up/down 必须飞行；水平简式默认步行，句中带跑/飞则跟随
    const movement: AvatarMovement = dir === 'up' || dir === 'down' ? 'fly' : RE.fly.test(text) ? 'fly' : RE.run.test(text) ? 'run' : 'walk';
    return withIds([{ kind: 'move_relative', direction: dir, distanceMeters: clampNum(requested, DIST_MIN, DIST_MAX), movement }]);
  }
  return null;
}

function parseRelative(text: string): AvatarCommand[] | null {
  const bareCmd = parseBareMove(text);
  if (bareCmd) return bareCmd;
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
  // 约定：左转=-角度 / 右转=+角度（人物渲染器 addYaw 顺时针为正，左转必须为负；转身/掉头=180 不受符号影响）
  const sign = isLeft ? -1 : isRight ? 1 : 1;
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

// —— 风电场景（WIND-FARM-01，合同 §9）：登记对象 OPS-WIND-01 / CP-WT-01..10 / HS-WTG-01..10；维修仅 HS-WTG-07 齿轮箱高速端轴承 ——

const WIND_RE = {
  turbineWord: /风机|机组/,
  turbineNo: /([0-9]{1,2}|[一二两三四五六七八九十])\s*号/,
  moveVerb: /走|跑|飞|去|到|前往|赶到|回/,
  focusVerb: /查看|看看|看一下|聚焦|对准/,
} as const;

/** 「7 号风机」编号提取：阿拉伯或简式中文数字，1~10 之外由调用方澄清 */
function extractTurbineNo(text: string): number | null {
  const m = text.match(WIND_RE.turbineNo);
  if (!m) return null;
  const raw = m[1];
  const no = /^[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) : cnToInt(raw);
  return Number.isFinite(no) ? no : null;
}

/** 风电导航动词：山地尺度大，未明说走/跑时默认飞行（合同 §9） */
function windMovement(text: string): AvatarMovement {
  if (RE.fly.test(text)) return 'fly';
  if (RE.run.test(text)) return 'run';
  if (/走/.test(text)) return 'walk';
  return 'fly';
}

/** 风电维修意图：仅登记 7 号风机（HS-WTG-07 齿轮箱高速端轴承 @ CP-WT-07），其他编号不猜 */
function parseWindRepair(text: string): AvatarCommand[] | null {
  if (!RE.repair.test(text)) return null;
  if (!WIND_RE.turbineWord.test(text)) return null;
  const no = extractTurbineNo(text);
  if (no === null) {
    clarify(`维修目标不明确：请说「维修 N 号风机」；本场景仅登记 ${WIND_REPAIR.componentLabel}（${WIND_REPAIR.targetId}）`);
  }
  if (no !== 7) {
    clarify(`维修目标未登记：本场景仅登记 7 号风机维修（${WIND_REPAIR.targetId} ${WIND_REPAIR.componentLabel}），不猜测 ${no} 号`);
  }
  return withIds([
    { kind: 'navigate', targetId: 'CP-WT-07', movement: windMovement(text) },
    { kind: 'focus_asset', targetId: 'HS-WTG-07' },
    { kind: 'repair_simulation', targetId: 'HS-WTG-07', checkpointId: 'CP-WT-07' },
  ]);
}

/** 风电导航意图：「走/跑/飞/去/回 + N 号风机 / 运维点」；未登记编号澄清（1~10） */
function parseWindNavigate(text: string): AvatarCommand[] | null {
  const hits: string[] = [];
  const no = extractTurbineNo(text);
  if (no !== null && WIND_RE.turbineWord.test(text) && WIND_RE.moveVerb.test(text)) {
    const t = windTurbineByNo(no);
    if (!t) {
      throw new AvatarClarificationError(`未登记 ${no} 号风机：本场景登记 1~10 号风机（HS-WTG-01..10）`);
    }
    hits.push(t.checkpointId);
  }
  if (RE.ops.test(text)) hits.push('OPS-WIND-01');
  const unique = [...new Set(hits)];
  if (unique.length === 0) return null;
  if (unique.length > 1) {
    clarify(`目标不唯一（命中 ${unique.map((t) => labelOf(t)).join('、')}）：一次说一个目的地，例如「飞到 7 号风机」`);
  }
  return withIds([{ kind: 'navigate', targetId: unique[0] as AvatarTargetId, movement: windMovement(text) }]);
}

/** 风电聚焦意图：「查看/聚焦 N 号风机」（不含移动动词，否则归导航） */
function parseWindFocus(text: string): AvatarCommand[] | null {
  if (!WIND_RE.focusVerb.test(text) || WIND_RE.moveVerb.test(text)) return null;
  const no = extractTurbineNo(text);
  if (no === null || !WIND_RE.turbineWord.test(text)) return null;
  const t = windTurbineByNo(no);
  if (!t) {
    throw new AvatarClarificationError(`未登记 ${no} 号风机：本场景登记 1~10 号风机（HS-WTG-01..10）`);
  }
  return withIds([{ kind: 'focus_asset', targetId: t.id as WindTurbineId }]);
}

/** 风电单句解析：维修 → 导航/聚焦 → 通用简单动作；一句多意图不猜 */
function parseWindSingle(text: string): AvatarCommand[] | null {
  const repair = parseWindRepair(text);
  if (repair) return repair;
  const nav = parseWindNavigate(text);
  const focus = parseWindFocus(text);
  const simple = parseSimple(text);
  const turn = parseTurn(text);
  const relative = parseRelative(text);
  const matched = [nav, focus, simple, turn, relative].filter(Boolean) as AvatarCommand[][];
  if (matched.length > 1) {
    clarify('一句包含多个动作，暂不支持：请一次说一个动作，例如「先停下」或「左转 90 度」');
  }
  return matched.length === 1 ? matched[0] : null;
}

// —— 水电场景（HYDRO-PLANT-01，镜像风电模式）：登记对象 OPS-HYDRO-01 / CP-HU-01..03 / CP-GATE-01 / HS-HU-01..03 / HS-GATE-01；维修仅 HS-HU-02 水轮机主轴密封 ——

const HYDRO_RE = {
  unitWord: /机组|水轮机/,
  gateWord: /泄洪闸|闸门/,
  unitNo: /([0-9]{1,2}|[一二两三四五六七八九十])\s*号/,
  moveVerb: /走|跑|飞|去|到|前往|赶到|回/,
  focusVerb: /查看|看看|看一下|聚焦|对准/,
} as const;

/** 「2 号机组」编号提取：阿拉伯或简式中文数字，未登记编号由调用方澄清 */
function extractHydroUnitNo(text: string): number | null {
  const m = text.match(HYDRO_RE.unitNo);
  if (!m) return null;
  const raw = m[1];
  const no = /^[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) : cnToInt(raw);
  return Number.isFinite(no) ? no : null;
}

/** 水电导航动词：坝区尺度大，未明说走/跑时默认飞行（与风电一致） */
function hydroMovement(text: string): AvatarMovement {
  if (RE.fly.test(text)) return 'fly';
  if (RE.run.test(text)) return 'run';
  if (/走/.test(text)) return 'walk';
  return 'fly';
}

/** 机组编号解析：仅 1~3 号机组（HS-HU-01..03）；no=4 是泄洪闸门，不算机组 */
function hydroTurbineByNo(no: number) {
  const u = hydroUnitByNo(no);
  return u && u.id.startsWith('HS-HU') ? u : null;
}

/** 水电维修意图：仅登记 2 号机组（HS-HU-02 水轮机主轴密封 @ CP-HU-02），其他编号/闸门不猜 */
function parseHydroRepair(text: string): AvatarCommand[] | null {
  if (!RE.repair.test(text)) return null;
  if (!HYDRO_RE.unitWord.test(text) && !HYDRO_RE.gateWord.test(text)) return null;
  if (HYDRO_RE.gateWord.test(text) && !HYDRO_RE.unitWord.test(text)) {
    clarify(`维修目标未登记：本场景仅登记 2 号机组维修（${HYDRO_REPAIR.targetId} ${HYDRO_REPAIR.componentLabel}），闸门维修未登记`);
  }
  const no = extractHydroUnitNo(text);
  if (no === null) {
    clarify(`维修目标不明确：请说「维修 N 号机组」；本场景仅登记 ${HYDRO_REPAIR.componentLabel}（${HYDRO_REPAIR.targetId}）`);
  }
  if (no !== 2) {
    clarify(`维修目标未登记：本场景仅登记 2 号机组维修（${HYDRO_REPAIR.targetId} ${HYDRO_REPAIR.componentLabel}），不猜测 ${no} 号`);
  }
  return withIds([
    { kind: 'navigate', targetId: 'CP-HU-02', movement: hydroMovement(text) },
    { kind: 'focus_asset', targetId: 'HS-HU-02' },
    { kind: 'repair_simulation', targetId: 'HS-HU-02', checkpointId: 'CP-HU-02' },
  ]);
}

/** 水电导航意图：「走/跑/飞/去/回 + N 号机组 / 泄洪闸门 / 运维点」；未登记编号澄清 */
function parseHydroNavigate(text: string): AvatarCommand[] | null {
  const hits: string[] = [];
  const no = extractHydroUnitNo(text);
  if (HYDRO_RE.gateWord.test(text) && HYDRO_RE.moveVerb.test(text) && !HYDRO_RE.unitWord.test(text)) {
    hits.push('CP-GATE-01');
  } else if (no !== null && HYDRO_RE.unitWord.test(text) && HYDRO_RE.moveVerb.test(text)) {
    const u = hydroTurbineByNo(no);
    if (!u) {
      throw new AvatarClarificationError(`未登记 ${no} 号机组：本场景登记 1~3 号机组（HS-HU-01..03）与泄洪闸门（HS-GATE-01）`);
    }
    hits.push(u.checkpointId);
  }
  if (RE.ops.test(text)) hits.push('OPS-HYDRO-01');
  const unique = [...new Set(hits)];
  if (unique.length === 0) return null;
  if (unique.length > 1) {
    clarify(`目标不唯一（命中 ${unique.map((t) => labelOf(t)).join('、')}）：一次说一个目的地，例如「飞到 2 号机组」`);
  }
  return withIds([{ kind: 'navigate', targetId: unique[0] as AvatarTargetId, movement: hydroMovement(text) }]);
}

/** 水电聚焦意图：「查看/聚焦 N 号机组 / 泄洪闸门」（不含移动动词，否则归导航） */
function parseHydroFocus(text: string): AvatarCommand[] | null {
  if (!HYDRO_RE.focusVerb.test(text) || HYDRO_RE.moveVerb.test(text)) return null;
  if (HYDRO_RE.gateWord.test(text) && !HYDRO_RE.unitWord.test(text)) {
    return withIds([{ kind: 'focus_asset', targetId: 'HS-GATE-01' }]);
  }
  const no = extractHydroUnitNo(text);
  if (no === null || !HYDRO_RE.unitWord.test(text)) return null;
  const u = hydroTurbineByNo(no);
  if (!u) {
    throw new AvatarClarificationError(`未登记 ${no} 号机组：本场景登记 1~3 号机组（HS-HU-01..03）与泄洪闸门（HS-GATE-01）`);
  }
  return withIds([{ kind: 'focus_asset', targetId: u.id as HydroUnitId }]);
}

/** 水电巡检路线规划意图：「规划巡检路线 / 巡检一圈 / 来条路线 / 带我巡检一遍」→ 依次 fly 导航 1→2→3 号机组 → 泄洪闸门（多命令数组，走 commands 通道逐站执行） */
const HYDRO_ROUTE_PLAN_RE = /规划.{0,4}路线|巡检路线|巡检一圈|巡检一遍|来条路线|带我巡检/;

/** 路线站点从 dam.json 派生：机组按 no 升序在前，泄洪闸门收尾（单一事实源，不手抄 ID） */
function hydroRouteStops(): HydroCheckpointId[] {
  const units = hydroDam.units.filter((u) => u.id.startsWith('HS-HU')).sort((a, b) => a.no - b.no);
  const gates = hydroDam.units.filter((u) => u.id.startsWith('HS-GATE'));
  return [...units, ...gates].map((u) => u.checkpointId as HydroCheckpointId);
}

function parseHydroRoutePlan(text: string): AvatarCommand[] | null {
  if (!HYDRO_ROUTE_PLAN_RE.test(text)) return null;
  return withIds(hydroRouteStops().map((targetId) => ({ kind: 'navigate' as const, targetId, movement: 'fly' as const })));
}

/** 水电单句解析：路线规划 → 维修 → 导航/聚焦 → 通用简单动作；一句多意图不猜 */
function parseHydroSingle(text: string): AvatarCommand[] | null {
  const routePlan = parseHydroRoutePlan(text);
  if (routePlan) return routePlan;
  const repair = parseHydroRepair(text);
  if (repair) return repair;
  const nav = parseHydroNavigate(text);
  const focus = parseHydroFocus(text);
  const simple = parseSimple(text);
  const turn = parseTurn(text);
  const relative = parseRelative(text);
  const matched = [nav, focus, simple, turn, relative].filter(Boolean) as AvatarCommand[][];
  if (matched.length > 1) {
    clarify('一句包含多个动作，暂不支持：请一次说一个动作，例如「先停下」或「左转 90 度」');
  }
  return matched.length === 1 ? matched[0] : null;
}


// —— 光伏阵列「找板子」意图（solarArray.ts / solar.json 登记 84 组串；区编址 A~G，每区 12 串） ——
// 首页痛点「组串成千上万，热斑难定位」：一句话定位某块组串。语义键是 (区, 串号)，STR-ID 仅作别名解析。

const SOLAR_RE = {
  stringWord: /组串|光伏板|板子/,
  locateVerb: /在哪|哪里|定位|找到|带我去|带我到|带我过去|去看看|看一下|看看/,
  zone: /([A-G])\s*区/i,
  stringNo: /([0-9]{1,2}|十[一二]?|[一二两三四五六七八九])\s*号/,
  stringId: /STR-([A-G])[12]-([0-9]{1,2})/i,
} as const;

type SolarResolve =
  | { hit: import('./solarArray').SolarString }
  | { ambiguousNo: number }
  | { unregistered: string }
  | null;

/** 组串指称解析：STR-ID / 区+号（「2 排」排号忽略，兼容旧说法）→ fixture 登记组串；缺区号/未登记交调用方澄清 */
function resolveSolarString(text: string): SolarResolve {
  const idM = text.match(SOLAR_RE.stringId);
  if (idM) {
    // ID 的语义键同样是 (区, 串号)：STR-B1-07 与 STR-B2-07 同指 B 区 7 号（B 区 7 号挂 INV-B-02，以 fixture 登记为准）
    const s = solarStringByZoneNo(idM[1].toUpperCase(), Number.parseInt(idM[2], 10));
    return s ? { hit: s } : { unregistered: idM[0].toUpperCase() };
  }
  const noM = text.match(SOLAR_RE.stringNo);
  if (!noM) return null;
  const raw = noM[1];
  const no = /^[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) : cnToInt(raw);
  if (!Number.isFinite(no)) return null;
  const zoneM = text.match(SOLAR_RE.zone);
  if (!zoneM) return { ambiguousNo: no };
  const s = solarStringByZoneNo(zoneM[1].toUpperCase(), no);
  return s ? { hit: s } : { unregistered: `${zoneM[1].toUpperCase()} 区 ${no} 号` };
}

/** 光伏阵列维修意图：「维修 B 区 7 号组串 / 维修 STR-B2-07」→ navigate + focus_asset + repair_simulation（镜像风电模式）；仅 STR-B2-07 登记旁路二极管维修，其他组串不猜 */
function parseSolarRepair(text: string): AvatarCommand[] | null {
  if (!RE.repair.test(text)) return null;
  if (!SOLAR_RE.stringWord.test(text) && !SOLAR_RE.stringId.test(text)) return null;
  const r = resolveSolarString(text);
  // 无编号或不带区号：维持旧行为（「维修 7 号异常组串」→ 唯一登记异常组串 @ CP-INV-B02，见 parseRepair）
  if (!r || 'ambiguousNo' in r) return null;
  if ('unregistered' in r) {
    throw new AvatarClarificationError(`维修目标未登记：${r.unregistered} 不在本场景登记内（A~G 区各 12 串，共 84 串），不猜测其他组串`);
  }
  const s = r.hit;
  if (s.id !== SOLAR_REPAIR.targetId) {
    throw new AvatarClarificationError(`该组串未登记维修对象：${s.label}（${s.id}）无维修登记；本场景仅登记${SOLAR_REPAIR.componentLabel}维修（${SOLAR_REPAIR.targetId}）`);
  }
  return withIds([
    { kind: 'navigate', targetId: s.checkpointId as SolarStringCheckpointId, movement: 'walk' },
    { kind: 'focus_asset', targetId: 'STR-B2-07' },
    { kind: 'repair_simulation', targetId: 'STR-B2-07', checkpointId: 'CP-STR-B-07' },
  ]);
}

/** 光伏阵列定位意图：「B 区 7 号组串在哪 / 定位 STR-B2-07 / 带我去 C 区 3 号组串」→ walk 导航到组串旁检查点（平地阵列）；只说「7 号组串」缺区号 → 澄清 A~G 分区 */
function parseSolarLocate(text: string): AvatarCommand[] | null {
  if (!SOLAR_RE.locateVerb.test(text)) return null;
  if (!SOLAR_RE.stringWord.test(text) && !SOLAR_RE.stringId.test(text)) return null;
  const r = resolveSolarString(text);
  if (!r) return null;
  if ('ambiguousNo' in r) {
    throw new AvatarClarificationError(`组串定位需要区号：本场景按 A~G 分区（A=中心，B/C=南排，D=东，E/F=北排，G=西），每区 12 串；请说「B 区 ${r.ambiguousNo} 号组串」`);
  }
  if ('unregistered' in r) {
    throw new AvatarClarificationError(`未登记组串：${r.unregistered}；本场景登记 A~G 区各 12 串（共 84 串），例如「B 区 7 号组串」`);
  }
  return withIds([{ kind: 'navigate', targetId: r.hit.checkpointId as SolarStringCheckpointId, movement: 'walk' }]);
}

/** 光伏单句（无连接词）解析；无法理解返回 null（由入口统一澄清） */
function parseSingle(text: string): AvatarCommand[] | null {
  const solarRepair = parseSolarRepair(text);
  if (solarRepair) return solarRepair;

  const repair = parseRepair(text);
  if (repair) return repair;

  // 任务闭环三意图（巡检/审批/采证）先于导航判定：「检查 B2 屋顶异常」含「屋顶」不得误判为 navigate
  const inspection = parseInspection(text);
  if (inspection) return inspection;

  const decision = parseDecision(text);
  if (decision) return decision;

  const evidence = parseEvidence(text);
  if (evidence) return evidence;

  const solarLocate = parseSolarLocate(text);
  if (solarLocate) return solarLocate;

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
 * 解析一句中文指令 → 受控命令序列。scene='pecc'（默认，光伏园区）、'wind'（风电场站，合同 §9）或 'hydro'（水电站，镜像风电模式）。
 * 无法理解 / 目标不唯一 / 一句多动作 → AvatarClarificationError（路由层转 400 CLARIFICATION_NEEDED）。
 */
export function parseAvatarCommand(rawText: string, scene: AvatarScene = 'pecc'): AvatarCommand[] {
  const text = normalizeCnNumbers(normalizeAvatarText(rawText));
  const examples = scene === 'wind' ? WIND_AVATAR_EXAMPLES : scene === 'hydro' ? HYDRO_AVATAR_EXAMPLES : AVATAR_EXAMPLES;
  try {
    if (!text) return clarify('指令为空：请说一句可执行的指令');
    const parseOne = scene === 'wind' ? parseWindSingle : scene === 'hydro' ? parseHydroSingle : parseSingle;

    // 复合句（然后/再/，…）：分段解析，多段命中动作 → 澄清，不静默丢弃
    const parts = text.split(/然后|接着|之后|以后|，|,|。|；|;|！|!|？|\?/).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      const parsed = parts.map((p) => parseOne(p)).filter(Boolean) as AvatarCommand[][];
      if (parsed.length > 1) {
        return clarify('一句包含多个动作，暂不支持：请一次说一个动作，例如「先停下」或「左转 90 度」');
      }
      if (parsed.length === 1) return parsed[0];
      return clarify(`无法理解指令：「${normalizeAvatarText(rawText)}」。可说的示例：${examples.slice(0, 5).join('；')} 等`);
    }

    return parseOne(text) ?? clarify(`无法理解指令：「${normalizeAvatarText(rawText)}」。可说的示例：${examples.slice(0, 5).join('；')} 等`);
  } catch (e) {
    if (e instanceof AvatarClarificationError && scene === 'wind') throw e.withExamples(WIND_AVATAR_EXAMPLES);
    if (e instanceof AvatarClarificationError && scene === 'hydro') throw e.withExamples(HYDRO_AVATAR_EXAMPLES);
    throw e;
  }
}

// —— 对外解释入口：外壳数据（truth=SIMULATED + 仿真告警由路由层统一附加） ——

export function interpretAvatarCommand(rawText: string, scene: AvatarScene = 'pecc'): AvatarInterpretation {
  const commands = parseAvatarCommand(rawText, scene);
  const normalizedText = normalizeAvatarText(rawText);
  return { normalizedText, reply: buildReply(commands), commands };
}

export function buildReply(commands: AvatarCommand[]): string {
  // 多站纯导航序列 = 巡检路线规划（当前仅水电路线意图产生）：报站名清单而非逐条确认
  if (commands.length > 1 && commands.every((c) => c.kind === 'navigate')) {
    const stops = commands.map((c) => labelOf((c as { targetId: string }).targetId).replace(/(?:检查点|塔下)$/, ''));
    return `已规划巡检路线：${stops.join(' → ')}，共 ${stops.length} 站，依次前往。`;
  }
  const last = commands[commands.length - 1];
  switch (last.kind) {
    case 'navigate': {
      // 光伏阵列组串定位：回复带相对方位（offset 符号推出，演示级简单描述）
      const s = solarStringByCheckpointId(last.targetId);
      if (s) return `${s.label}在${solarBearingText(s)}，已带你过去。`;
      return `收到，${MOVE_VERB[last.movement]}前往「${labelOf(last.targetId)}」。`;
    }
    case 'move_relative': {
      const dirLabel = { forward: '前', backward: '后', left: '左', right: '右', up: '上', down: '下' }[last.direction];
      return `收到，向${dirLabel}${MOVE_VERB[last.movement]} ${last.distanceMeters} 米。`;
    }
    case 'turn': {
      // 约定与渲染器一致：负=左转，正=右转（addYaw 顺时针为正）
      const dir = last.degrees <= 0 ? '左' : '右';
      return `收到，${dir}转 ${Math.abs(last.degrees)} 度。`;
    }
    case 'jump':
      return '收到，原地跳一下。';
    case 'stop':
      return '收到，立即停下。';
    case 'focus_asset':
      return `收到，聚焦「${labelOf(last.targetId)}」。`;
    case 'repair_simulation': {
      if (last.targetId === 'HS-WTG-07') {
        return `收到，前往 7 号风机塔下（CP-WT-07）并执行${WIND_REPAIR.componentLabel}维修仿真（SIMULATED），逐步骤留痕。`;
      }
      if (last.targetId === 'HS-HU-02') {
        return `收到，前往 2 号机组（CP-HU-02）并执行${HYDRO_REPAIR.componentLabel}维修仿真（SIMULATED），逐步骤留痕。`;
      }
      if (last.targetId === 'STR-B2-07' && last.checkpointId === 'CP-STR-B-07') {
        return `收到，前往 B 区 7 号组串（CP-STR-B-07）并执行${SOLAR_REPAIR.componentLabel}维修仿真（SIMULATED），逐步骤留痕。`;
      }
      const flewToRoof = commands.some((c) => c.kind === 'navigate' && c.targetId === 'CP-B02-ROOF');
      return flewToRoof
        ? '收到，飞往 B2 屋顶，随后按安全落点（B2 逆变器检查点）执行 7 号异常组串维修仿真。'
        : '收到，前往 B2 逆变器并执行 7 号异常组串维修仿真。';
    }
    case 'start_inspection':
      return '收到，将创建 B2 屋顶异常巡检任务（ANOM-DEMO-01）；请看任务面板确认上下文与建议。';
    case 'decide_pending':
      return last.decision === 'approve'
        ? '收到，将批准当前待审批方案；审批结果请以任务面板状态为准。'
        : '收到，将驳回当前待审批方案；审批结果请以任务面板状态为准。';
    case 'capture_evidence':
      return '收到，将采集照片、红外、读数三类仿真证据；请确保人物已在屋面检查点且任务阶段允许。';
    default:
      return '收到。';
  }
}
