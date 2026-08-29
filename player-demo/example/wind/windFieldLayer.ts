// GPU 粒子风场层接缝（移植自黔风智维 apps/web/src/scene/windFieldLayer.ts，参数原样照抄）。
// 把局部 ENU 风场模型采样成 lon/lat 纹理网格，交给 vendored cesium-wind-layer 渲染。
import { Matrix4 } from "cesium";
import type { Viewer } from "cesium";
import { WindLayer } from "./vendor/cesiumWindLayer";
import type { WindData } from "./vendor/cesiumWindLayer";
import type { WindFieldConfig } from "./windFieldConfig";
import {
    createWindFieldSeeds,
    sampleLocalWindField,
    traceWindStreamline,
    type LocalWindSample,
    type WindFieldSeed,
} from "./windFieldModel";

export {
    createWindFieldSeeds,
    interpolateWindPath,
    isWithinWindFieldBounds,
    sampleLocalWindField,
    traceWindStreamline,
    type LocalWindSample,
    type WindFieldSeed,
} from "./windFieldModel";

export interface WindFieldLayer {
    setVisible: (visible: boolean) => void;
    setPaused: (paused: boolean) => void;
    isVisible: () => boolean;
    destroy: () => void;
}

export interface WindFieldOrigin {
    longitude: number;
    latitude: number;
    height: number;
}

export interface CreateWindFieldLayerOptions {
    viewer: Viewer;
    /** Kept at the scene seam; the GPU layer consumes the equivalent lon/lat rectangle. */
    localFrame: Matrix4;
    origin: WindFieldOrigin;
    config: WindFieldConfig;
    reducedMotion?: boolean;
}

export interface WindGrid {
    width: number;
    height: number;
    sampleUp: number;
    bounds: WindData["bounds"];
    u: Float32Array;
    v: Float32Array;
    speed: Float32Array;
}

export interface BuildWindGridOptions {
    width?: number;
    height?: number;
    /** The single render altitude used by the reference 2D U/V texture pipeline. */
    sampleUp?: number;
}

const DEFAULT_GRID_WIDTH = 40;
const DEFAULT_GRID_HEIGHT = 32;
const DEFAULT_SAMPLE_UP_FRACTION = 0.58;
const PARTICLES_TEXTURE_SIZE = 84;

/**
 * Build a deterministic U/V texture grid from the existing local ENU model.
 * The reference renderer consumes a lon/lat texture, so ENU metres are mapped
 * to a small geodetic rectangle centered on the scene origin.
 */
export function buildWindGrid(
    config: WindFieldConfig,
    origin: WindFieldOrigin,
    options: BuildWindGridOptions = {},
): WindGrid {
    const width = clampInteger(options.width ?? DEFAULT_GRID_WIDTH, 8, 96);
    const height = clampInteger(options.height ?? DEFAULT_GRID_HEIGHT, 8, 96);
    const bounds = enuBoundsToRectangle(config, origin);
    const upSpan = Math.max(config.bounds.upMax - config.bounds.upMin, 1);
    const sampleUp = clamp(
        options.sampleUp ?? config.bounds.upMin + upSpan * DEFAULT_SAMPLE_UP_FRACTION,
        config.bounds.upMin,
        config.bounds.upMax,
    );
    const u = new Float32Array(width * height);
    const v = new Float32Array(width * height);
    const speed = new Float32Array(width * height);

    for (let row = 0; row < height; row += 1) {
        const northUnit = row / (height - 1);
        const north = lerp(config.bounds.northMin, config.bounds.northMax, northUnit);
        for (let column = 0; column < width; column += 1) {
            const eastUnit = column / (width - 1);
            const east = lerp(config.bounds.eastMin, config.bounds.eastMax, eastUnit);
            const sample = sampleLocalWindField(config, { east, north, up: sampleUp });
            const index = row * width + column;
            u[index] = sample.directionEast * sample.speed;
            v[index] = sample.directionNorth * sample.speed;
            speed[index] = sample.speed;
        }
    }

    return { width, height, sampleUp, bounds, u, v, speed };
}

/** Adapt the deterministic grid to the reference package's GPU texture contract. */
export function buildWindData(
    config: WindFieldConfig,
    origin: WindFieldOrigin,
    options: BuildWindGridOptions = {},
): WindData {
    const grid = buildWindGrid(config, origin, options);
    return {
        width: grid.width,
        height: grid.height,
        bounds: grid.bounds,
        u: { array: grid.u, ...rangeOf(grid.u) },
        v: { array: grid.v, ...rangeOf(grid.v) },
        speed: { array: grid.speed, ...rangeOf(grid.speed) },
    };
}

export function createWindFieldLayer({
    viewer,
    localFrame,
    origin,
    config,
    reducedMotion = false,
}: CreateWindFieldLayerOptions): WindFieldLayer {
    void localFrame;
    const windData = buildWindData(config, origin);
    const speedData = windData.speed;
    if (!speedData || speedData.min === undefined || speedData.max === undefined) {
        throw new Error("Wind data adapter must provide a speed range.");
    }
    const windLayer = new WindLayer(viewer, windData, {
        particlesTextureSize: PARTICLES_TEXTURE_SIZE,
        particleHeight: particleHeightFor(origin, config),
        lineWidth: { min: 0.32, max: 0.72 },
        lineLength: { min: 2.4, max: 6.8 },
        // The operational wind direction is opposite to the source grid's
        // particle travel convention; keep U/V values intact and reverse the
        // GPU integration direction at the layer boundary.
        speedFactor: -0.00045,
        dropRate: 0.008,
        dropRateBump: 0.018,
        colors: [
            "rgba(38, 132, 58, 0.38)",
            "rgba(66, 176, 66, 0.5)",
            "rgba(106, 214, 78, 0.64)",
            "rgba(166, 238, 112, 0.78)",
        ],
        flipY: false,
        useViewerBounds: false,
        domain: { min: speedData.min, max: speedData.max },
        displayRange: { min: speedData.min * 0.8, max: speedData.max * 1.08 },
        dynamic: true,
        windOrigin: {
            longitude: origin.longitude,
            latitude: origin.latitude,
            height: origin.height,
            metersPerDegreeLongitude: metersPerDegreeLongitude(origin.latitude),
            metersPerDegreeLatitude: metersPerDegreeLatitude(origin.latitude),
        },
    });

    let visible = true;
    let paused = false;
    let destroyed = false;

    const syncDynamic = () => {
        windLayer.updateOptions({ dynamic: visible && !paused && !reducedMotion });
    };

    return {
        setVisible: (nextVisible) => {
            if (destroyed) return;
            visible = nextVisible;
            windLayer.show = nextVisible;
            syncDynamic();
        },
        setPaused: (nextPaused) => {
            if (destroyed) return;
            paused = nextPaused;
            syncDynamic();
        },
        isVisible: () => visible,
        destroy: () => {
            if (destroyed) return;
            destroyed = true;
            windLayer.show = false;
            windLayer.updateOptions({ dynamic: false });
            windLayer.destroy();
        },
    };
}

function enuBoundsToRectangle(config: WindFieldConfig, origin: WindFieldOrigin): WindData["bounds"] {
    const latitudeMeters = metersPerDegreeLatitude(origin.latitude);
    const longitudeMeters = metersPerDegreeLongitude(origin.latitude);
    return {
        west: origin.longitude + config.bounds.eastMin / longitudeMeters,
        east: origin.longitude + config.bounds.eastMax / longitudeMeters,
        south: origin.latitude + config.bounds.northMin / latitudeMeters,
        north: origin.latitude + config.bounds.northMax / latitudeMeters,
    };
}

function particleHeightFor(origin: WindFieldOrigin, config: WindFieldConfig): number {
    const upSpan = config.bounds.upMax - config.bounds.upMin;
    return origin.height + config.bounds.upMin + upSpan * 0.72;
}

function metersPerDegreeLatitude(latitude: number): number {
    const radians = (latitude * Math.PI) / 180;
    return 111132.92
        - 559.82 * Math.cos(2 * radians)
        + 1.175 * Math.cos(4 * radians)
        - 0.0023 * Math.cos(6 * radians);
}

function metersPerDegreeLongitude(latitude: number): number {
    const radians = (latitude * Math.PI) / 180;
    return Math.max(
        1,
        111412.84 * Math.cos(radians)
            - 93.5 * Math.cos(3 * radians)
            + 0.118 * Math.cos(5 * radians),
    );
}

function rangeOf(array: Float32Array): { min: number; max: number } {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of array) {
        min = Math.min(min, value);
        max = Math.max(max, value);
    }
    return { min, max };
}

function lerp(start: number, end: number, amount: number): number {
    return start + (end - start) * amount;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function clampInteger(value: number, min: number, max: number): number {
    return Math.min(Math.max(Math.floor(value), min), max);
}
