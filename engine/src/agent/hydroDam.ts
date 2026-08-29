// 水电工程场景（HYDRO-PLANT-01）登记注册表（镜像 windFarm.ts，contracts/avatar-command.md §9 同模式）
// 单一事实源是 player-demo/example/public/hydro/dam.json（场景包与语义同源）；
// 本模块只读它导出 ID 集合与标签，不复制坐标——人物位置解算由前端场景页负责。

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HYDRO_SCENE_ID = 'HYDRO-PLANT-01';
export const HYDRO_SCENE_REVISION = 'fixture-v1';

export interface HydroDamFixture {
  sceneId: string;
  sceneRevision: string;
  name: string;
  /** 电站共用规格（人话问答用；键为中文属性名） */
  specs?: Record<string, string>;
  units: {
    id: string;
    label: string;
    no: number;
    checkpointId: string;
    offset?: { east: number; north: number; up: number };
    headingDeg?: number;
    riskLevel?: 'normal' | 'warning' | 'critical';
    /** 人可读的状态说明（演示仿真数据） */
    stateNote?: string;
  }[];
  opsPoint: { id: string; label: string };
  repairTargets: { targetId: string; checkpointId: string; componentId: string; componentLabel: string }[];
}

// 相对 engine/src/agent/ 退三级到仓库根（tsx/构建产物同级布局下均可用；运行 cwd 无关）
const damPath = fileURLToPath(new URL('../../../player-demo/example/public/hydro/dam.json', import.meta.url));
export const hydroDam: HydroDamFixture = JSON.parse(fs.readFileSync(damPath, 'utf8'));

if (hydroDam.sceneId !== HYDRO_SCENE_ID || hydroDam.sceneRevision !== HYDRO_SCENE_REVISION) {
  throw new Error(`hydro dam.json 场景标识不符：期望 ${HYDRO_SCENE_ID}/${HYDRO_SCENE_REVISION}，收到 ${hydroDam.sceneId}/${hydroDam.sceneRevision}`);
}

/** 水电场景 navigate 登记目标：运维点 + 每机组/闸门检查点 */
export const HYDRO_NAV_TARGETS: readonly string[] = [hydroDam.opsPoint.id, ...hydroDam.units.map((u) => u.checkpointId)];

/** 水电场景 focus_asset 登记目标：3 台机组 + 泄洪闸门 */
export const HYDRO_FOCUS_TARGETS: readonly string[] = hydroDam.units.map((u) => u.id);

/** 水电场景唯一登记维修对象：HS-HU-02 水轮机主轴密封 @ CP-HU-02 */
export const HYDRO_REPAIR = hydroDam.repairTargets[0];

const labelById = new Map<string, string>([
  [hydroDam.opsPoint.id, hydroDam.opsPoint.label],
  ...hydroDam.units.flatMap((u): [string, string][] => [
    [u.id, u.label],
    [u.checkpointId, `${u.label}检查点`],
  ]),
]);

export const hydroTargetLabel = (id: string): string => labelById.get(id) ?? id;

/** 「2 号机组」编号 → 机组/闸门（fixture units 登记，未登记返回 null；注意 no=4 是泄洪闸门 HS-GATE-01） */
export function hydroUnitByNo(no: number): HydroDamFixture['units'][number] | null {
  return hydroDam.units.find((u) => u.no === no) ?? null;
}
