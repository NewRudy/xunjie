// 风电工程场景（WIND-FARM-01）登记注册表（contracts/avatar-command.md §9）
// 单一事实源是 player-demo/example/public/wind/farm.json（场景包与语义同源）；
// 本模块只读它导出 ID 集合与标签，不复制坐标——人物位置解算由前端场景页负责。

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const WIND_SCENE_ID = 'WIND-FARM-01';
export const WIND_SCENE_REVISION = 'fixture-v1';

export interface WindFarmFixture {
  sceneId: string;
  sceneRevision: string;
  name: string;
  /** 机组共用规格（人话问答用；键为中文属性名） */
  specs?: Record<string, string>;
  turbines: {
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
const farmPath = fileURLToPath(new URL('../../../player-demo/example/public/wind/farm.json', import.meta.url));
export const windFarm: WindFarmFixture = JSON.parse(fs.readFileSync(farmPath, 'utf8'));

if (windFarm.sceneId !== WIND_SCENE_ID || windFarm.sceneRevision !== WIND_SCENE_REVISION) {
  throw new Error(`wind farm.json 场景标识不符：期望 ${WIND_SCENE_ID}/${WIND_SCENE_REVISION}，收到 ${windFarm.sceneId}/${windFarm.sceneRevision}`);
}

/** 风电场景 navigate 登记目标：运维点 + 每机塔下检查点 */
export const WIND_NAV_TARGETS: readonly string[] = [windFarm.opsPoint.id, ...windFarm.turbines.map((t) => t.checkpointId)];

/** 风电场景 focus_asset 登记目标：10 台机组 */
export const WIND_FOCUS_TARGETS: readonly string[] = windFarm.turbines.map((t) => t.id);

/** 风电场景唯一登记维修对象：HS-WTG-07 齿轮箱高速端轴承 @ CP-WT-07 */
export const WIND_REPAIR = windFarm.repairTargets[0];

const labelById = new Map<string, string>([
  [windFarm.opsPoint.id, windFarm.opsPoint.label],
  ...windFarm.turbines.flatMap((t): [string, string][] => [
    [t.id, t.label],
    [t.checkpointId, `${t.label}塔下`],
  ]),
]);

export const windTargetLabel = (id: string): string => labelById.get(id) ?? id;

/** 「7 号风机」编号 → 机组（1..10，未登记返回 null） */
export function windTurbineByNo(no: number): WindFarmFixture['turbines'][number] | null {
  return windFarm.turbines.find((t) => t.no === no) ?? null;
}
