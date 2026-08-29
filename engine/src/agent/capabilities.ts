// 能力目录 CapabilityRegistry（contracts/avatar-command.md §3 / agent-tools.md 的登记式单一事实来源）
// 命令 kind、字段集合、取值域、数值范围、登记 ID 只在本文件登记；
// system prompt 由目录渲染生成，LLM 输出校验按目录执行——换场景包 = 改本文件登记数据，不改校验代码、不改提示词模板。
// （模式参考：pipe-report-agent 的 CapabilityRegistry.model_context / registry_accepts）
import { DEG_MAX, DEG_MIN, DIST_MAX, DIST_MIN } from './avatar';
import { SOLAR_NAV_TARGETS, SOLAR_REPAIR } from './solarArray';

// —— 登记 ID（与 avatar.ts 确定性解析使用同一场景 fixture；增删需同步 contracts/avatar-command.md §3） ——

export const AVATAR_NAV_TARGETS = ['OPS-01', 'CP-B02-FRONT', 'CP-B02-ROOF', 'CP-INV-B02', ...SOLAR_NAV_TARGETS] as const;
export const AVATAR_FOCUS_TARGETS = ['STR-B2-07', 'INV-B-02'] as const;
export const AVATAR_ANOMALY_IDS = ['ANOM-DEMO-01'] as const;
export const AVATAR_MOVEMENTS = ['walk', 'run', 'fly'] as const;
export const AVATAR_DIRECTIONS = ['forward', 'backward', 'left', 'right', 'up', 'down'] as const;
export const AVATAR_DECISIONS = ['approve', 'reject'] as const;
export const AVATAR_EVIDENCE_KINDS = ['photo', 'thermal', 'reading'] as const;
/** 维修目标与安全落点检查点的唯一绑定：不在表内的组合一律拒绝（fixture 登记；STR-B2-07 有两处登记落点：旧 B2 逆变器 + solar.json 组串旁） */
export const AVATAR_REPAIR_PAIRS = [
  { targetId: 'STR-B2-07', checkpointId: 'CP-INV-B02' },
  { targetId: SOLAR_REPAIR.targetId, checkpointId: SOLAR_REPAIR.checkpointId },
] as const;

// —— 风电场景 WIND-FARM-01（合同 §9）：登记 ID 派生自 farm.json（windFarm.ts），不手抄 ——

import { WIND_FOCUS_TARGETS, WIND_NAV_TARGETS, WIND_REPAIR } from './windFarm';

export const WIND_AVATAR_NAV_TARGETS = WIND_NAV_TARGETS;
export const WIND_AVATAR_FOCUS_TARGETS = WIND_FOCUS_TARGETS;
export const WIND_AVATAR_REPAIR_PAIRS = [{ targetId: WIND_REPAIR.targetId, checkpointId: WIND_REPAIR.checkpointId }] as const;

// —— 水电场景 HYDRO-PLANT-01（镜像风电）：登记 ID 派生自 dam.json（hydroDam.ts），不手抄 ——

import { HYDRO_FOCUS_TARGETS, HYDRO_NAV_TARGETS, HYDRO_REPAIR } from './hydroDam';

export const HYDRO_AVATAR_NAV_TARGETS = HYDRO_NAV_TARGETS;
export const HYDRO_AVATAR_FOCUS_TARGETS = HYDRO_FOCUS_TARGETS;
export const HYDRO_AVATAR_REPAIR_PAIRS = [{ targetId: HYDRO_REPAIR.targetId, checkpointId: HYDRO_REPAIR.checkpointId }] as const;

// —— 人物命令能力登记项 ——

export interface AvatarCommandCapability {
  kind: string;
  label: string;
  /** 严格字段集合（含 kind）：模型输出多一个/少一个字段都算不过 */
  fields: readonly string[];
  /** 枚举取值域：字段 → 允许值（只能取登记值） */
  domains?: Record<string, readonly string[]>;
  /** 数值闭区间：字段 → {min,max} */
  ranges?: Record<string, { min: number; max: number }>;
  /** 数组字段精确匹配：字段 → 完整有序数组（多/少/乱序都拒绝） */
  exactArrays?: Record<string, readonly string[]>;
  /** 字段级校验失败码（与既有合同错误码一致，回退原因只给错误类型） */
  fieldErrorCodes: Record<string, string>;
}

export const AVATAR_COMMAND_CAPABILITIES: readonly AvatarCommandCapability[] = [
  {
    kind: 'navigate',
    label: '导航到登记检查点/运维点',
    fields: ['kind', 'targetId', 'movement'],
    domains: { targetId: AVATAR_NAV_TARGETS, movement: AVATAR_MOVEMENTS },
    fieldErrorCodes: { targetId: 'TARGET', movement: 'MOVEMENT' },
  },
  {
    kind: 'move_relative',
    label: '相对移动（up/down 必须飞行）',
    fields: ['kind', 'direction', 'distanceMeters', 'movement'],
    domains: { direction: AVATAR_DIRECTIONS, movement: AVATAR_MOVEMENTS },
    ranges: { distanceMeters: { min: DIST_MIN, max: DIST_MAX } },
    fieldErrorCodes: { direction: 'DIRECTION', movement: 'MOVEMENT', distanceMeters: 'DISTANCE' },
  },
  {
    kind: 'turn',
    label: '原地转向',
    fields: ['kind', 'degrees'],
    ranges: { degrees: { min: DEG_MIN, max: DEG_MAX } },
    fieldErrorCodes: { degrees: 'DEGREES' },
  },
  { kind: 'jump', label: '原地跳跃', fields: ['kind'], fieldErrorCodes: {} },
  { kind: 'stop', label: '停止移动', fields: ['kind'], fieldErrorCodes: {} },
  {
    kind: 'focus_asset',
    label: '聚焦登记设备',
    fields: ['kind', 'targetId'],
    domains: { targetId: AVATAR_FOCUS_TARGETS },
    fieldErrorCodes: { targetId: 'TARGET' },
  },
  {
    kind: 'repair_simulation',
    label: '维修仿真（目标与检查点必须按登记成对出现）',
    fields: ['kind', 'targetId', 'checkpointId'],
    domains: {
      targetId: AVATAR_REPAIR_PAIRS.map((p) => p.targetId),
      checkpointId: AVATAR_REPAIR_PAIRS.map((p) => p.checkpointId),
    },
    fieldErrorCodes: { targetId: 'TARGET', checkpointId: 'TARGET' },
  },
  {
    kind: 'start_inspection',
    label: '创建登记异常的巡检任务',
    fields: ['kind', 'anomalyId'],
    domains: { anomalyId: AVATAR_ANOMALY_IDS },
    fieldErrorCodes: { anomalyId: 'TARGET' },
  },
  {
    kind: 'decide_pending',
    label: '审批意向（执行与否由审批接口裁决）',
    fields: ['kind', 'decision'],
    domains: { decision: AVATAR_DECISIONS },
    fieldErrorCodes: { decision: 'DECISION' },
  },
  {
    kind: 'capture_evidence',
    label: '按固定清单采集三类仿真证据',
    fields: ['kind', 'evidenceKinds'],
    exactArrays: { evidenceKinds: AVATAR_EVIDENCE_KINDS },
    fieldErrorCodes: { evidenceKinds: 'EVIDENCE' },
  },
];

export function avatarCapability(kind: string): AvatarCommandCapability | undefined {
  return AVATAR_COMMAND_CAPABILITIES.find((c) => c.kind === kind);
}

// —— 风电场景能力目录（合同 §9）：共享运动命令 + 风电导航/聚焦/维修；不含光伏任务闭环三命令 ——

export const WIND_AVATAR_COMMAND_CAPABILITIES: readonly AvatarCommandCapability[] = [
  {
    kind: 'navigate',
    label: '导航到登记检查点/运维点（风电场站）',
    fields: ['kind', 'targetId', 'movement'],
    domains: { targetId: WIND_AVATAR_NAV_TARGETS, movement: AVATAR_MOVEMENTS },
    fieldErrorCodes: { targetId: 'TARGET', movement: 'MOVEMENT' },
  },
  {
    kind: 'move_relative',
    label: '相对移动（up/down 必须飞行）',
    fields: ['kind', 'direction', 'distanceMeters', 'movement'],
    domains: { direction: AVATAR_DIRECTIONS, movement: AVATAR_MOVEMENTS },
    ranges: { distanceMeters: { min: DIST_MIN, max: DIST_MAX } },
    fieldErrorCodes: { direction: 'DIRECTION', movement: 'MOVEMENT', distanceMeters: 'DISTANCE' },
  },
  {
    kind: 'turn',
    label: '原地转向',
    fields: ['kind', 'degrees'],
    ranges: { degrees: { min: DEG_MIN, max: DEG_MAX } },
    fieldErrorCodes: { degrees: 'DEGREES' },
  },
  { kind: 'jump', label: '原地跳跃', fields: ['kind'], fieldErrorCodes: {} },
  { kind: 'stop', label: '停止移动', fields: ['kind'], fieldErrorCodes: {} },
  {
    kind: 'focus_asset',
    label: '聚焦登记机组',
    fields: ['kind', 'targetId'],
    domains: { targetId: WIND_AVATAR_FOCUS_TARGETS },
    fieldErrorCodes: { targetId: 'TARGET' },
  },
  {
    kind: 'repair_simulation',
    label: '维修仿真（目标与检查点必须按登记成对出现）',
    fields: ['kind', 'targetId', 'checkpointId'],
    domains: {
      targetId: WIND_AVATAR_REPAIR_PAIRS.map((p) => p.targetId),
      checkpointId: WIND_AVATAR_REPAIR_PAIRS.map((p) => p.checkpointId),
    },
    fieldErrorCodes: { targetId: 'TARGET', checkpointId: 'TARGET' },
  },
];

// —— 水电场景能力目录（镜像风电）：共享运动命令 + 水电导航/聚焦/维修；不含光伏任务闭环三命令 ——

export const HYDRO_AVATAR_COMMAND_CAPABILITIES: readonly AvatarCommandCapability[] = [
  {
    kind: 'navigate',
    label: '导航到登记检查点/运维点（水电站）',
    fields: ['kind', 'targetId', 'movement'],
    domains: { targetId: HYDRO_AVATAR_NAV_TARGETS, movement: AVATAR_MOVEMENTS },
    fieldErrorCodes: { targetId: 'TARGET', movement: 'MOVEMENT' },
  },
  {
    kind: 'move_relative',
    label: '相对移动（up/down 必须飞行）',
    fields: ['kind', 'direction', 'distanceMeters', 'movement'],
    domains: { direction: AVATAR_DIRECTIONS, movement: AVATAR_MOVEMENTS },
    ranges: { distanceMeters: { min: DIST_MIN, max: DIST_MAX } },
    fieldErrorCodes: { direction: 'DIRECTION', movement: 'MOVEMENT', distanceMeters: 'DISTANCE' },
  },
  {
    kind: 'turn',
    label: '原地转向',
    fields: ['kind', 'degrees'],
    ranges: { degrees: { min: DEG_MIN, max: DEG_MAX } },
    fieldErrorCodes: { degrees: 'DEGREES' },
  },
  { kind: 'jump', label: '原地跳跃', fields: ['kind'], fieldErrorCodes: {} },
  { kind: 'stop', label: '停止移动', fields: ['kind'], fieldErrorCodes: {} },
  {
    kind: 'focus_asset',
    label: '聚焦登记机组/闸门',
    fields: ['kind', 'targetId'],
    domains: { targetId: HYDRO_AVATAR_FOCUS_TARGETS },
    fieldErrorCodes: { targetId: 'TARGET' },
  },
  {
    kind: 'repair_simulation',
    label: '维修仿真（目标与检查点必须按登记成对出现）',
    fields: ['kind', 'targetId', 'checkpointId'],
    domains: {
      targetId: HYDRO_AVATAR_REPAIR_PAIRS.map((p) => p.targetId),
      checkpointId: HYDRO_AVATAR_REPAIR_PAIRS.map((p) => p.checkpointId),
    },
    fieldErrorCodes: { targetId: 'TARGET', checkpointId: 'TARGET' },
  },
];

/** 场景化能力目录与维修绑定对：avatar.ts 的 AvatarScene 联合类型在这里取 catalog（避免循环依赖用字符串） */
export function avatarCapabilitiesFor(scene: 'pecc' | 'wind' | 'hydro'): readonly AvatarCommandCapability[] {
  return scene === 'wind' ? WIND_AVATAR_COMMAND_CAPABILITIES : scene === 'hydro' ? HYDRO_AVATAR_COMMAND_CAPABILITIES : AVATAR_COMMAND_CAPABILITIES;
}

export function avatarCapabilityFor(scene: 'pecc' | 'wind' | 'hydro', kind: string): AvatarCommandCapability | undefined {
  return avatarCapabilitiesFor(scene).find((c) => c.kind === kind);
}

export function avatarRepairPairsFor(scene: 'pecc' | 'wind' | 'hydro'): readonly { targetId: string; checkpointId: string }[] {
  return scene === 'wind' ? WIND_AVATAR_REPAIR_PAIRS : scene === 'hydro' ? HYDRO_AVATAR_REPAIR_PAIRS : AVATAR_REPAIR_PAIRS;
}

// —— 任务提案 step 能力（contracts/agent-state.md §3 的 kind 白名单登记） ——

export interface PlanStepCapability {
  kind: string;
  label: string;
}

export const PLAN_STEP_CAPABILITIES: readonly PlanStepCapability[] = [
  { kind: 'navigate', label: '前往检查点' },
  { kind: 'focus', label: '聚焦设备' },
  { kind: 'inspect', label: '检查部件' },
  { kind: 'capture-evidence', label: '采集证据' },
  { kind: 'request-confirmation', label: '请求用户确认' },
  { kind: 'verify', label: '核对恢复' },
];

export const PLAN_STEP_KINDS: readonly string[] = PLAN_STEP_CAPABILITIES.map((c) => c.kind);

export const PLAN_PROPOSAL_SCHEMA_HINT = `{"summary":string,"steps":[{"kind":"${PLAN_STEP_KINDS.join('|')}","title":string,"targetId"?:string,"requiredEvidence"?:string[]}],"basisRefs":string[]}`;

// —— system prompt 渲染（由目录生成；冻结话术逐字保留，数值域/ID 清单不再手抄） ——

const enumText = (values: readonly string[]): string => values.map((v) => `"${v}"`).join('|');

function fieldShapeText(cap: AvatarCommandCapability, field: string): string {
  const exact = cap.exactArrays?.[field];
  if (exact) return JSON.stringify(exact);
  const domain = cap.domains?.[field];
  if (domain) return enumText(domain);
  const range = cap.ranges?.[field];
  if (range) return `<${range.min}..${range.max} 数值>`;
  return 'string';
}

function shapeLine(cap: AvatarCommandCapability): string {
  const parts = cap.fields.filter((f) => f !== 'kind').map((f) => `"${f}":${fieldShapeText(cap, f)}`);
  return `{"kind":"${cap.kind}"${parts.length ? ',' + parts.join(',') : ''}}`;
}

/** 人物指令解释器 system prompt（由能力目录渲染；硬断言子串「只输出一个 JSON 对象」「不得携带 commandId」由固定话术包含） */
export function renderAvatarSystemPrompt(): string {
  return [
    '你是「巡界」数字运维员的指令解释器，把一句中文口语映射为受控命令序列。只输出一个 JSON 对象，禁止输出任何解释、注释、markdown 或代码。',
    '格式：{"reply":"<简短中文确认，一两句>","commands":[<命令>...]}',
    'commands 每个元素必须恰好是以下形状之一（字段名与取值完全一致，不得增加/缺少字段，不得携带 commandId，服务端统一编号）：',
    ...AVATAR_COMMAND_CAPABILITIES.map(shapeLine),
    '硬性约束：',
    '1. targetId/anomalyId/checkpointId 只能取上表登记值——这是本场景全部登记对象；禁止发明其他 ID、世界坐标、脚本、Cesium API 或任何代码。',
    `2. direction 为 up/down 时 movement 必须为 "fly"；distanceMeters 取 ${DIST_MIN}..${DIST_MAX}；degrees 取 ${DEG_MIN}..${DEG_MAX}。`,
    '3. commands 按执行顺序排列，最多 6 条；无法把用户输入映射为上述命令时，输出 {"reply":"...","commands":[]}。',
    '4. 你只控制数字孪生中的虚拟运维员（SIMULATED 仿真），绝不输出任何真实设备操作。',
    '5. 语义映射参考：「维修 7 号异常组串」→ navigate CP-INV-B02 + focus_asset STR-B2-07 + repair_simulation；「检查 B2 屋顶异常」→ start_inspection；「我同意/我不同意」→ decide_pending approve/reject；「采集证据」→ capture_evidence；「上/下/左/右/前/后（可带距离，如「上 5 米」）」→ move_relative 对应方向（up/down 必 fly）；「起飞/飞行」→ move_relative up fly；「降落/落地」→ move_relative down fly；「悬停」→ stop。',
  ].join('\n');
}

/** 风电场景（WIND-FARM-01）人物指令解释器 system prompt：同一模板换风电能力目录与语义映射（合同 §9） */
export function renderWindAvatarSystemPrompt(): string {
  return [
    '你是「巡界」数字运维员的指令解释器，当前场景为风电场站（老鸦岭，WIND-FARM-01），把一句中文口语映射为受控命令序列。只输出一个 JSON 对象，禁止输出任何解释、注释、markdown 或代码。',
    '格式：{"reply":"<简短中文确认，一两句>","commands":[<命令>...]}',
    '本场景登记对象：运维点 OPS-WIND-01；机组 HS-WTG-01..HS-WTG-10（1~10 号风机）；塔下检查点 CP-WT-01..CP-WT-10（与机组编号一一对应）。',
    'commands 每个元素必须恰好是以下形状之一（字段名与取值完全一致，不得增加/缺少字段，不得携带 commandId，服务端统一编号）：',
    ...WIND_AVATAR_COMMAND_CAPABILITIES.map(shapeLine),
    '硬性约束：',
    '1. targetId/checkpointId 只能取上表登记值——这是本场景全部登记对象；禁止发明其他 ID、世界坐标、脚本、Cesium API 或任何代码。',
    `2. direction 为 up/down 时 movement 必须为 "fly"；distanceMeters 取 ${DIST_MIN}..${DIST_MAX}；degrees 取 ${DEG_MIN}..${DEG_MAX}。`,
    '3. commands 按执行顺序排列，最多 6 条；无法把用户输入映射为上述命令时，输出 {"reply":"...","commands":[]}。',
    '4. 你只控制数字孪生中的虚拟运维员（SIMULATED 仿真），绝不输出任何真实设备操作。',
    `5. 语义映射参考：「飞到 N 号风机」→ navigate CP-WT-0N fly（N=1~10，不足两位补零）；「查看 N 号风机」→ focus_asset HS-WTG-0N；「维修 7 号风机」→ navigate CP-WT-07 + focus_asset HS-WTG-07 + repair_simulation（维修仅登记 7 号机 ${WIND_REPAIR.componentLabel}，其他编号输出空 commands 并在 reply 说明）；「回运维点」→ navigate OPS-WIND-01；「上/下/左/右/前/后（可带距离，如「上 5 米」）」→ move_relative 对应方向（up/down 必 fly）；「起飞/飞行」→ move_relative up fly；「降落/落地」→ move_relative down fly；「悬停」→ stop。`,
  ].join('\n');
}

/** 水电场景（HYDRO-PLANT-01）人物指令解释器 system prompt：同一模板换水电能力目录与语义映射（镜像风电） */
export function renderHydroAvatarSystemPrompt(): string {
  return [
    '你是「巡界」数字运维员的指令解释器，当前场景为水电站（黔澜峡，HYDRO-PLANT-01），把一句中文口语映射为受控命令序列。只输出一个 JSON 对象，禁止输出任何解释、注释、markdown 或代码。',
    '格式：{"reply":"<简短中文确认，一两句>","commands":[<命令>...]}',
    '本场景登记对象：运维点 OPS-HYDRO-01；机组 HS-HU-01..HS-HU-03（1~3 号机组）；机组检查点 CP-HU-01..CP-HU-03（与机组编号一一对应）；泄洪闸门 HS-GATE-01 及其检查点 CP-GATE-01。',
    'commands 每个元素必须恰好是以下形状之一（字段名与取值完全一致，不得增加/缺少字段，不得携带 commandId，服务端统一编号）：',
    ...HYDRO_AVATAR_COMMAND_CAPABILITIES.map(shapeLine),
    '硬性约束：',
    '1. targetId/checkpointId 只能取上表登记值——这是本场景全部登记对象；禁止发明其他 ID、世界坐标、脚本、Cesium API 或任何代码。',
    `2. direction 为 up/down 时 movement 必须为 "fly"；distanceMeters 取 ${DIST_MIN}..${DIST_MAX}；degrees 取 ${DEG_MIN}..${DEG_MAX}。`,
    '3. commands 按执行顺序排列，最多 6 条；无法把用户输入映射为上述命令时，输出 {"reply":"...","commands":[]}。',
    '4. 你只控制数字孪生中的虚拟运维员（SIMULATED 仿真），绝不输出任何真实设备操作。',
    `5. 语义映射参考：「飞到 N 号机组」→ navigate CP-HU-0N fly（N=1~3，不足两位补零）；「查看 N 号机组」→ focus_asset HS-HU-0N；「维修 2 号机组」→ navigate CP-HU-02 + focus_asset HS-HU-02 + repair_simulation（维修仅登记 2 号机组 ${HYDRO_REPAIR.componentLabel}，其他编号输出空 commands 并在 reply 说明）；「去泄洪闸门」→ navigate CP-GATE-01；「查看泄洪闸门」→ focus_asset HS-GATE-01；「回运维点」→ navigate OPS-HYDRO-01；「上/下/左/右/前/后（可带距离，如「上 5 米」）」→ move_relative 对应方向（up/down 必 fly）；「起飞/飞行」→ move_relative up fly；「降落/落地」→ move_relative down fly；「悬停」→ stop。`,
  ].join('\n');
}

/** 场景化 prompt 选择 */
export function renderAvatarSystemPromptFor(scene: 'pecc' | 'wind' | 'hydro'): string {
  return scene === 'wind' ? renderWindAvatarSystemPrompt() : scene === 'hydro' ? renderHydroAvatarSystemPrompt() : renderAvatarSystemPrompt();
}

/** 任务提案 planner system prompt（由 step 能力登记渲染） */
export function renderPlanProposalPrompt(): string {
  return (
    '你是微电网运维任务规划器。只输出 JSON：' +
    PLAN_PROPOSAL_SCHEMA_HINT +
    '。硬性约束：不得新增任何数字、设备 ID、坐标或未登记动作；targetId/requiredEvidence 只能取自上下文；summary 中的数字必须逐字来自上下文。'
  );
}
