// 风场参数与类型（移植自黔风智维 apps/web/src/scene/sceneConfig.ts 的 windField 段，参数原样照抄）。
// 与本页 farm.json 的关系：bounds 罩住山体与 10 台风机（farm.json 机组最大 |east| 650 / north 560 / up ≈145）。

export interface LocalOffset {
    east: number;
    north: number;
    up: number;
}

export interface WindFieldConfig {
    flowDirectionDegrees: number;
    referenceSpeed: number;
    bounds: {
        eastMin: number;
        eastMax: number;
        northMin: number;
        northMax: number;
        upMin: number;
        upMax: number;
    };
    streamCount: number;
    pathLength: number;
    pathSamples: number;
}

export const WIND_FIELD_CONFIG: WindFieldConfig = {
    flowDirectionDegrees: 68,
    referenceSpeed: 8.6,
    bounds: {
        eastMin: -820,
        eastMax: 880,
        northMin: -600,
        northMax: 780,
        upMin: 115,
        upMax: 285,
    },
    streamCount: 48,
    pathLength: 820,
    pathSamples: 18,
};
