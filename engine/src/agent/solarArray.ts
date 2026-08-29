// 光伏阵列场景（PECC-PARK-01）组串登记注册表（镜像 windFarm.ts / hydroDam.ts 模式）
// 单一事实源是 player-demo/example/public/solar/solar.json（场景包与语义同源）；
// 本模块只读它导出 ID 集合与标签，不复制坐标——人物位置解算由前端场景页负责。
// 区编址：A=中心，B/C=南排西/东，D=东，E/F=北排东/西，G=西；每区 12 组串（no 1..12）。
// 组串 ID 形如 STR-{zone}{1|2}-{nn}（B 区 7 号因挂 INV-B-02 登记为 STR-B2-07，其余多
// 为 {zone}1-nn）——语义键是 (zone, no)，ID 仅作别名解析，一律以 fixture 实际登记为准。

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SOLAR_SCENE_ID = 'PECC-PARK-01';
export const SOLAR_SCENE_REVISION = 'fixture-v1';

export interface SolarArrayFixture {
  sceneId: string;
  sceneRevision: string;
  name: string;
  /** 阵列共用规格（人话问答用；键为中文属性名） */
  specs?: Record<string, string>;
  strings: {
    id: string;
    zone: string;
    no: number;
    label: string;
    panelCount?: number;
    offset?: { east: number; north: number; up: number };
    inverterId?: string;
  }[];
  checkpoints: { id: string; stringId?: string | null; offset?: { east: number; north: number; up: number } }[];
  inverters: { id: string; label: string; checkpointId?: string; offset?: { east: number; north: number; up: number } }[];
  opsPoint: { id: string; label: string };
  repairTargets: { targetId: string; checkpointId: string; componentId: string; componentLabel: string }[];
}

// 相对 engine/src/agent/ 退三级到仓库根（tsx/构建产物同级布局下均可用；运行 cwd 无关）
const solarPath = fileURLToPath(new URL('../../../player-demo/example/public/solar/solar.json', import.meta.url));
export const solarArray: SolarArrayFixture = JSON.parse(fs.readFileSync(solarPath, 'utf8'));

if (solarArray.sceneId !== SOLAR_SCENE_ID || solarArray.sceneRevision !== SOLAR_SCENE_REVISION) {
  throw new Error(`solar solar.json 场景标识不符：期望 ${SOLAR_SCENE_ID}/${SOLAR_SCENE_REVISION}，收到 ${solarArray.sceneId}/${solarArray.sceneRevision}`);
}

const checkpointByStringId = new Map<string, string>(
  solarArray.checkpoints.flatMap((c): [string, string][] => (c.stringId ? [[c.stringId, c.id]] : [])),
);

/** 登记组串：fixture string + 关联检查点（导航落点，checkpoints 按 stringId 关联） */
export type SolarString = SolarArrayFixture['strings'][number] & { checkpointId: string };

/** 全部登记组串（84 串），每条带关联检查点；缺检查点宁可起不来，不带病运行 */
export const SOLAR_STRINGS: readonly SolarString[] = solarArray.strings.map((s) => {
  const checkpointId = checkpointByStringId.get(s.id);
  if (!checkpointId) throw new Error(`solar.json 组串 ${s.id} 缺少关联检查点`);
  return { ...s, checkpointId };
});

/** 光伏阵列 navigate 登记目标：每串旁检查点 CP-STR-{ZONE}-{nn}（CP-INV-B02 已在光伏既有登记内） */
export const SOLAR_NAV_TARGETS: readonly string[] = SOLAR_STRINGS.map((s) => s.checkpointId);

/** 光伏阵列唯一登记维修对象：STR-B2-07 组串旁路二极管 @ CP-STR-B-07 */
export const SOLAR_REPAIR = solarArray.repairTargets[0];

const labelById = new Map<string, string>([
  [solarArray.opsPoint.id, solarArray.opsPoint.label],
  ...SOLAR_STRINGS.flatMap((s): [string, string][] => [
    [s.id, s.label],
    [s.checkpointId, `${s.label}检查点`],
  ]),
  ...solarArray.inverters.map((i): [string, string] => [i.id, i.label]),
]);

export const solarTargetLabel = (id: string): string => labelById.get(id) ?? id;

/** 区号 + 串号 → 组串（语义键；未登记返回 null，不猜 ID） */
export function solarStringByZoneNo(zone: string, no: number): SolarString | null {
  return SOLAR_STRINGS.find((s) => s.zone === zone && s.no === no) ?? null;
}

/** 组串 ID → 组串（精确匹配；未登记返回 null） */
export function solarStringById(id: string): SolarString | null {
  return SOLAR_STRINGS.find((s) => s.id === id) ?? null;
}

/** 检查点 ID → 组串（reply 位置描述用；非组串检查点返回 null） */
export function solarStringByCheckpointId(checkpointId: string): SolarString | null {
  return SOLAR_STRINGS.find((s) => s.checkpointId === checkpointId) ?? null;
}

/** 相对方位一句话（从 offset 符号推出，演示级简单描述） */
export function solarBearingText(s: SolarString): string {
  const ns = (s.offset?.north ?? 0) >= 0 ? '北' : '南';
  const ew = (s.offset?.east ?? 0) >= 0 ? '东' : '西';
  return `场地${ns}侧偏${ew}`;
}
