// 局部 ENU 风场模型（纯函数，无 Cesium 依赖；移植自黔风智维 apps/web/src/scene/windFieldModel.ts，原样照抄）。
import type { LocalOffset, WindFieldConfig } from "./windFieldConfig";

export interface WindFieldSeed extends LocalOffset {
    phase: number;
    speedScale: number;
    highlight: boolean;
}

export interface LocalWindSample {
    directionEast: number;
    directionNorth: number;
    speed: number;
    verticalRate: number;
    terrainInfluence: number;
}

const GOLDEN_RATIO = 0.6180339887498949;

export function createWindFieldSeeds(config: WindFieldConfig): WindFieldSeed[] {
    const count = clampInt(config.streamCount, 30, 60);
    const { bounds } = config;
    const eastSpan = bounds.eastMax - bounds.eastMin;
    const northSpan = bounds.northMax - bounds.northMin;
    const upSpan = bounds.upMax - bounds.upMin;
    const seeds: WindFieldSeed[] = [];

    for (let index = 0; index < count; index += 1) {
        const sampleIndex = index + 1;
        const eastUnit = 0.08 + 0.84 * halton(sampleIndex, 2);
        const northUnit = 0.08 + 0.84 * halton(sampleIndex, 3);
        const upUnit = 0.12 + 0.76 * halton(sampleIndex, 5);
        seeds.push({
            east: bounds.eastMin + eastSpan * eastUnit,
            north: bounds.northMin + northSpan * northUnit,
            up: bounds.upMin + upSpan * upUnit,
            phase: fractional(sampleIndex * GOLDEN_RATIO + 0.17),
            speedScale: 0.84 + 0.24 * halton(sampleIndex + 9, 5),
            highlight: index % 8 === 1,
        });
    }

    return seeds;
}

export function sampleLocalWindField(config: WindFieldConfig, point: LocalOffset): LocalWindSample {
    const { bounds } = config;
    const eastSpan = Math.max(bounds.eastMax - bounds.eastMin, 1);
    const northSpan = Math.max(bounds.northMax - bounds.northMin, 1);
    const upSpan = Math.max(bounds.upMax - bounds.upMin, 1);
    const x = clamp((point.east - bounds.eastMin) / eastSpan, 0, 1) * 2 - 1;
    const y = clamp((point.north - bounds.northMin) / northSpan, 0, 1) * 2 - 1;
    const z = clamp((point.up - bounds.upMin) / upSpan, 0, 1);

    // Two low-frequency terms describe a ridge-following channel and its lee-side wake.
    const ridge = 0.58 * Math.sin(x * 4.1 + y * 1.35) + 0.42 * Math.cos(y * 3.4 - x * 0.9);
    const ridgeLine = 0.18 * Math.sin(x * 2.4 + 0.7);
    const channelDistance = y - ridgeLine - 0.12 * Math.sin(x * 3.2);
    const channel = Math.exp(-(channelDistance * channelDistance) / 0.34);
    const terrainInfluence = clamp(0.68 * Math.sin(x * 3.8 - y * 1.7) + 0.32 * Math.cos(y * 4.7), -1, 1);

    const directionRadians = (config.flowDirectionDegrees * Math.PI) / 180;
    const baseEast = Math.sin(directionRadians);
    const baseNorth = Math.cos(directionRadians);
    const normalEast = baseNorth;
    const normalNorth = -baseEast;
    const crossFlow = 0.045 * ridge + 0.055 * (channel - 0.5) + 0.025 * Math.sin((x + y) * 3.2);
    const rawEast = baseEast + normalEast * crossFlow;
    const rawNorth = baseNorth + normalNorth * crossFlow;
    const horizontalLength = Math.hypot(rawEast, rawNorth) || 1;
    const heightFactor = 0.84 + z * 0.2;
    const speed = config.referenceSpeed * clamp(
        heightFactor * (0.86 + 0.1 * ridge + 0.13 * channel),
        0.62,
        1.18,
    );

    return {
        directionEast: rawEast / horizontalLength,
        directionNorth: rawNorth / horizontalLength,
        speed,
        verticalRate: (0.035 * terrainInfluence + 0.018 * Math.sin(x * 5.2 + y * 2.1)) * (0.72 + channel * 0.28),
        terrainInfluence,
    };
}

export function traceWindStreamline(
    config: WindFieldConfig,
    seed: WindFieldSeed,
    options?: { pathLength?: number; pathSamples?: number },
): LocalOffset[] {
    const pathSamples = clampInt(options?.pathSamples ?? config.pathSamples, 8, 32);
    const pathLength = clamp(options?.pathLength ?? config.pathLength, 240, 900);
    const stepLength = pathLength / Math.max(pathSamples - 1, 1);
    let current = clampOffset(config, seed);
    const path: LocalOffset[] = [];

    for (let index = 0; index < pathSamples; index += 1) {
        path.push({ ...current });
        const sample = sampleLocalWindField(config, current);
        const speedFactor = clamp(sample.speed / Math.max(config.referenceSpeed, 0.01), 0.78, 1.2);
        const step = stepLength * speedFactor;
        current = clampOffset(config, {
            east: current.east + sample.directionEast * step,
            north: current.north + sample.directionNorth * step,
            up: current.up + sample.verticalRate * step,
        });
    }

    return path;
}

export function interpolateWindPath(path: readonly LocalOffset[], progress: number): LocalOffset {
    if (path.length === 0) return { east: 0, north: 0, up: 0 };
    if (path.length === 1) return { ...path[0] };
    const normalized = fractional(progress) * (path.length - 1);
    const lowerIndex = Math.floor(normalized);
    const upperIndex = Math.min(lowerIndex + 1, path.length - 1);
    const amount = normalized - lowerIndex;
    const lower = path[lowerIndex];
    const upper = path[upperIndex];
    return {
        east: lower.east + (upper.east - lower.east) * amount,
        north: lower.north + (upper.north - lower.north) * amount,
        up: lower.up + (upper.up - lower.up) * amount,
    };
}

export function isWithinWindFieldBounds(config: WindFieldConfig, point: LocalOffset): boolean {
    const { bounds } = config;
    return point.east >= bounds.eastMin
        && point.east <= bounds.eastMax
        && point.north >= bounds.northMin
        && point.north <= bounds.northMax
        && point.up >= bounds.upMin
        && point.up <= bounds.upMax;
}

function clampOffset(config: WindFieldConfig, point: LocalOffset): LocalOffset {
    const { bounds } = config;
    return {
        east: clamp(point.east, bounds.eastMin, bounds.eastMax),
        north: clamp(point.north, bounds.northMin, bounds.northMax),
        up: clamp(point.up, bounds.upMin, bounds.upMax),
    };
}

function halton(index: number, base: number): number {
    let value = 0;
    let fraction = 1 / base;
    let remainder = index;
    while (remainder > 0) {
        value += (remainder % base) * fraction;
        remainder = Math.floor(remainder / base);
        fraction /= base;
    }
    return value;
}

function fractional(value: number): number {
    return value - Math.floor(value);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function clampInt(value: number, min: number, max: number): number {
    return Math.min(Math.max(Math.floor(value), min), max);
}
