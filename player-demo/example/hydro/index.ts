import {
    Cartesian2, Cartesian3, Color, CallbackProperty, DirectionalLight, Entity,
    HeadingPitchRoll, Math as CMath, Matrix3, Matrix4, Model,
    PerspectiveFrustum, ScreenSpaceEventHandler, ScreenSpaceEventType,
    Transforms, Viewer,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { playerController, type PlayerModelOptions } from "cesium-player-controller";
import type { ColliderSource } from "cesium-player-controller";

// ==================== fixture 类型 ====================

interface HydroOffset { east: number; north: number; up: number }
interface HydroUnit {
    id: string; label: string; no: number; checkpointId: string;
    offset: HydroOffset; headingDeg: number; riskLevel: "normal" | "warning" | "critical";
}
interface HydroRepairStep { id: string; label: string }
interface HydroRepairTarget {
    targetId: string; checkpointId: string; componentId: string; componentLabel: string;
    steps: HydroRepairStep[];
}
interface HydroFixture {
    sceneId: string; sceneRevision: string; name: string;
    origin: { lon: number; lat: number; heightM: number };
    assets: {
        dam: { gltfUrl: string; scale: number; credit: string };
        // 坝后厂房精细模型（CAD 风格，叠加在摄影测量坝趾处，可选）
        powerhouse?: { glbUrl: string; scale: number; offset: HydroOffset; headingDeg: number; credit: string };
        player: { glbUrl: string; scale: number };
    };
    opsPoint: { id: string; label: string; offset: HydroOffset };
    units: HydroUnit[];
    repairTargets: HydroRepairTarget[];
    credits: string[];
}

// 引擎指令（contracts/avatar-command.md）
type AvatarMovement = "walk" | "run" | "fly";
interface AvatarCommand {
    commandId?: string;
    kind: string;
    targetId?: string;
    movement?: AvatarMovement;
    direction?: "forward" | "backward" | "left" | "right" | "up" | "down";
    distanceMeters?: number;
    degrees?: number;
    checkpointId?: string;
}
interface DispatchOutcome {
    kind: string;
    status: "available" | "rejected";
    code?: string;
    message?: string;
    detail?: Record<string, unknown>;
}
interface MissionBrief {
    missionId?: string;
    phase?: string;
    receipt?: { kind?: string } | null;
}
// dispatch 逐节点 trace（engine/src/agent/dispatch.ts TraceStep）
interface TraceStep {
    label: string;
    status: "ok" | "warn" | "error";
    durationMs: number;
    detail?: string;
}
interface InterpretResponse {
    status?: string;
    data?: {
        normalizedText?: string;
        reply?: string;
        commands?: AvatarCommand[];
        dispatch?: DispatchOutcome[];
        mission?: MissionBrief | null;
        conversationId?: string;
        trace?: TraceStep[];
        /** 问答类响应标记（identity/scene/mission/object/facts-qa）：语音播报只对这类回复开启 */
        sceneBrief?: Record<string, unknown>;
    };
    planner?: { mode?: "llm" | "deterministic-fallback"; modelAvailable?: boolean; reason?: string };
    truth?: string;
    warnings?: string[];
}

// ==================== 常量与 DOM ====================

const BASE = import.meta.env.BASE_URL;
// dispatch：解释与闭环执行同端点（服务端编排收权）；水电场景闭环命令由后端显式拒绝，页面如实展示
// 部署构建注入 VITE_ENGINE_BASE（如 /xunjie/api）与 VITE_API_KEY；本地 dev 缺省直连 localhost:8787
const ENGINE_BASE = String(import.meta.env.VITE_ENGINE_BASE ?? "http://localhost:8787/api").replace(/\/+$/, "");
const API_KEY = String(import.meta.env.VITE_API_KEY ?? "");
const withKey = (path: string) => `${ENGINE_BASE}${path}${API_KEY ? `?key=${encodeURIComponent(API_KEY)}` : ""}`;
const ENGINE_URL = withKey("/agent/avatar/dispatch");
// dispatch P2 会话：轮次摘要与 trace 按会话聚合
const CONVERSATION_ID = "CONV-HYDRO-DEMO";
const DISPATCH_LABEL: Record<string, string> = {
    start_inspection: "创建巡检任务",
    decide_pending: "审批",
    capture_evidence: "采集证据",
};
const SPEED: Record<AvatarMovement, number> = { walk: 5, run: 18, fly: 30 }; // m/s（脚本插值速度）
const RISK_COLOR = { normal: Color.LIME, warning: Color.YELLOW, critical: Color.RED } as const;
const RISK_LABEL = { normal: "正常", warning: "预警", critical: "严重" } as const;

function el<T extends HTMLElement>(id: string): T {
    const e = document.getElementById(id);
    if (!e) throw new Error(`缺少 DOM 元素 #${id}`);
    return e as T;
}
const cmdForm = el<HTMLFormElement>("cmd-form");
const cmdInput = el<HTMLInputElement>("cmd-input");
const aiShell = el<HTMLDivElement>("ai-shell");
const aiOrb = el<HTMLButtonElement>("ai-orb");
const aiPanel = el<HTMLElement>("ai-panel");
const aiPanelHead = el<HTMLElement>("ai-panel-head");
const aiMsgs = el<HTMLDivElement>("ai-msgs");
const aiTtsBtn = el<HTMLButtonElement>("ai-tts");
const aiClose = el<HTMLButtonElement>("ai-close");

// 输入框按键不冒泡，避免触发人物键位
for (const type of ["keydown", "keyup", "keypress"]) {
    cmdInput.addEventListener(type, (e) => e.stopPropagation());
}

// ==================== AI 悬浮球 + 对话面板（指挥唯一入口） ====================

const ORB_SIZE = 58;
const PANEL_W = 320;
const PANEL_H = 400;
const DRAG_THRESHOLD = 6;
const ORB_POS_KEY = "xj-hydro-orb-pos";
const PANEL_POS_KEY = "xj-hydro-panel-pos";

function clampNum(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
}
function loadPos(key: string): { x: number; y: number } | null {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const p = JSON.parse(raw) as { x?: unknown; y?: unknown };
        if (typeof p.x === "number" && typeof p.y === "number") return { x: p.x, y: p.y };
    } catch { /* 忽略损坏的本地存储 */ }
    return null;
}
function savePos(key: string, p: { x: number; y: number }): void {
    try { localStorage.setItem(key, JSON.stringify(p)); } catch { /* 隐私模式等场景忽略 */ }
}

// 面板锚定在球的正下方：框顶贴球底 +8px，水平以球心居中并 clamp 进视口；
// 球+框作为一个整体 clamp：整体高度超出视口时连同球一起上移
const PANEL_GAP = 8;
function layoutOrbPanel(p: { x: number; y: number }): { orb: { x: number; y: number }; panel: { x: number; y: number } } {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const orb = {
        x: clampNum(p.x, 8, Math.max(8, vw - ORB_SIZE - 8)),
        y: clampNum(p.y, 8, Math.max(8, vh - ORB_SIZE - 8)),
    };
    const totalH = ORB_SIZE + PANEL_GAP + PANEL_H;
    if (orb.y + totalH > vh - 8) orb.y = Math.max(8, vh - 8 - totalH);
    const panel = {
        x: clampNum(orb.x + ORB_SIZE / 2 - PANEL_W / 2, 8, Math.max(8, vw - PANEL_W - 8)),
        y: orb.y + ORB_SIZE + PANEL_GAP,
    };
    return { orb, panel };
}

let orbPos = loadPos(ORB_POS_KEY) ?? { x: window.innerWidth - ORB_SIZE - 20, y: window.innerHeight - ORB_SIZE - 20 };
let panelFollowOrb = true;
let panelPos = loadPos(PANEL_POS_KEY) ?? layoutOrbPanel(orbPos).panel;

function applyOrbPos(): void {
    aiOrb.style.left = `${orbPos.x}px`;
    aiOrb.style.top = `${orbPos.y}px`;
}
function applyPanelPos(): void {
    aiPanel.style.left = `${panelPos.x}px`;
    aiPanel.style.top = `${panelPos.y}px`;
    aiPanel.style.width = `${PANEL_W}px`;
    aiPanel.style.height = `${PANEL_H}px`;
}
applyOrbPos();
applyPanelPos();

let aiOpen = false;
function openPanel(): void {
    aiOpen = true;
    panelFollowOrb = true;
    // 球+框整体 clamp：框顶贴球底放不下的场合，把球一起上移
    const g = layoutOrbPanel(orbPos);
    orbPos = g.orb;
    applyOrbPos();
    savePos(ORB_POS_KEY, orbPos);
    panelPos = g.panel;
    applyPanelPos();
    aiShell.dataset.open = "true";
    aiOrb.setAttribute("aria-expanded", "true");
    aiOrb.setAttribute("aria-label", "收起巡界 AI 助手");
}
function closePanel(): void {
    aiOpen = false;
    aiShell.dataset.open = "false";
    aiOrb.setAttribute("aria-expanded", "false");
    aiOrb.setAttribute("aria-label", "打开巡界 AI 助手");
}

// 开合走原生 click：真实点击在 pointerup 后触发，CDP/脚本的 el.click() 同样生效；
// 拖拽（位移超过阈值）结束时置 suppress 标志，抑制紧随其后的 click。
// 单击延迟 260ms 执行，用于区分双击（双击=语音输入，见下方 dblclick 处理器）。
let suppressOrbClick = false;
let orbClickTimer: number | null = null;
aiOrb.addEventListener("click", () => {
    if (suppressOrbClick) { suppressOrbClick = false; return; }
    if (orbClickTimer !== null) return; // 双击的第二次点击，交给 dblclick
    orbClickTimer = window.setTimeout(() => {
        orbClickTimer = null;
        if (aiOpen) closePanel(); else openPanel();
    }, 260);
});

let orbDragging = false;
let orbDragStartX = 0;
let orbDragStartY = 0;
let orbDragMoved = false;

aiOrb.addEventListener("pointerdown", (e) => {
    orbDragging = true;
    orbDragMoved = false;
    orbDragStartX = e.clientX;
    orbDragStartY = e.clientY;
    aiOrb.classList.add("is-dragging");
    window.addEventListener("pointermove", onOrbMove);
    window.addEventListener("pointerup", onOrbUp);
    window.addEventListener("pointercancel", onOrbUp);
});
function onOrbMove(e: PointerEvent): void {
    if (!orbDragging) return;
    if (Math.hypot(e.clientX - orbDragStartX, e.clientY - orbDragStartY) > DRAG_THRESHOLD) orbDragMoved = true;
    orbPos = {
        x: clampNum(e.clientX - ORB_SIZE / 2, 8, Math.max(8, window.innerWidth - ORB_SIZE - 8)),
        y: clampNum(e.clientY - ORB_SIZE / 2, 8, Math.max(8, window.innerHeight - ORB_SIZE - 8)),
    };
    applyOrbPos();
    if (panelFollowOrb) {
        const g = layoutOrbPanel(orbPos);
        orbPos = g.orb;
        applyOrbPos();
        panelPos = g.panel;
        applyPanelPos();
    }
}
function onOrbUp(): void {
    if (!orbDragging) return;
    orbDragging = false;
    aiOrb.classList.remove("is-dragging");
    window.removeEventListener("pointermove", onOrbMove);
    window.removeEventListener("pointerup", onOrbUp);
    window.removeEventListener("pointercancel", onOrbUp);
    savePos(ORB_POS_KEY, orbPos);
    if (orbDragMoved) suppressOrbClick = true;
}

// 面板头部拖拽（脱离跟随，位置独立记忆）
let panelDragging = false;
let panelDragStartX = 0;
let panelDragStartY = 0;
let panelDragBaseX = 0;
let panelDragBaseY = 0;
aiPanelHead.addEventListener("pointerdown", (e) => {
    if (e.target instanceof Element && e.target.closest("button, input, textarea, select, a")) return;
    panelDragging = true;
    panelFollowOrb = false;
    panelDragStartX = e.clientX;
    panelDragStartY = e.clientY;
    panelDragBaseX = panelPos.x;
    panelDragBaseY = panelPos.y;
    window.addEventListener("pointermove", onPanelMove);
    window.addEventListener("pointerup", onPanelUp);
    window.addEventListener("pointercancel", onPanelUp);
});
function onPanelMove(e: PointerEvent): void {
    if (!panelDragging) return;
    panelPos = {
        x: clampNum(panelDragBaseX + e.clientX - panelDragStartX, 8, Math.max(8, window.innerWidth - PANEL_W - 8)),
        y: clampNum(panelDragBaseY + e.clientY - panelDragStartY, 8, Math.max(8, window.innerHeight - PANEL_H - 8)),
    };
    applyPanelPos();
}
function onPanelUp(): void {
    if (!panelDragging) return;
    panelDragging = false;
    window.removeEventListener("pointermove", onPanelMove);
    window.removeEventListener("pointerup", onPanelUp);
    window.removeEventListener("pointercancel", onPanelUp);
    savePos(PANEL_POS_KEY, panelPos);
}

aiClose.addEventListener("click", closePanel);

window.addEventListener("resize", () => {
    if (panelFollowOrb) {
        const g = layoutOrbPanel(orbPos);
        orbPos = g.orb;
        panelPos = g.panel;
    } else {
        orbPos = {
            x: clampNum(orbPos.x, 8, Math.max(8, window.innerWidth - ORB_SIZE - 8)),
            y: clampNum(orbPos.y, 8, Math.max(8, window.innerHeight - ORB_SIZE - 8)),
        };
        panelPos = {
            x: clampNum(panelPos.x, 8, Math.max(8, window.innerWidth - PANEL_W - 8)),
            y: clampNum(panelPos.y, 8, Math.max(8, window.innerHeight - PANEL_H - 8)),
        };
    }
    applyOrbPos();
    applyPanelPos();
});

// ---------- 浏览器本地 TTS 语音播报 ----------
const TTS_KEY = "xj-hydro-tts-enabled";
const ttsSupported = "speechSynthesis" in window;
let ttsEnabled = ttsSupported && localStorage.getItem(TTS_KEY) !== "0";

function speak(text: string, force = false): void {
    if (!ttsSupported || (!ttsEnabled && !force) || !text) return;
    // e2e 探针：最近一次实际播报文本
    (window as unknown as { __lastSpoken?: string }).__lastSpoken = text;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "zh-CN";
    utter.rate = 1.5;
    window.speechSynthesis.speak(utter);
}

function syncTtsButton(): void {
    aiTtsBtn.setAttribute("aria-pressed", String(ttsEnabled));
    aiTtsBtn.title = ttsSupported
        ? `语音播报：${ttsEnabled ? "开" : "关"}（浏览器本地 TTS）`
        : "本浏览器不支持语音播报";
}
if (!ttsSupported) aiTtsBtn.disabled = true;
aiTtsBtn.addEventListener("click", () => {
    if (!ttsSupported) return;
    ttsEnabled = !ttsEnabled;
    try { localStorage.setItem(TTS_KEY, ttsEnabled ? "1" : "0"); } catch { /* ignore */ }
    if (!ttsEnabled) window.speechSynthesis.cancel();
    syncTtsButton();
});
syncTtsButton();

// ---------- 面板消息 ----------
function scrollAiToBottom(): void {
    aiMsgs.scrollTop = aiMsgs.scrollHeight;
}

function nowTime(): string {
    return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

// 系统气泡：仅用于需要用户知晓的异常提示（导航目标未登记/未知命令/初始化失败）；
// 场景状态与维修步骤留痕只写 console 和维修记录卡，不上消息流
function appendSystemLog(text: string): void {
    const row = document.createElement("div");
    row.className = "ai-msg sys";
    const bubble = document.createElement("div");
    bubble.className = "ai-bubble";
    const time = document.createElement("span");
    time.className = "ai-time";
    time.textContent = nowTime();
    const p = document.createElement("span");
    p.className = "ai-tx";
    p.textContent = text;
    bubble.appendChild(time);
    bubble.appendChild(p);
    row.appendChild(bubble);
    aiMsgs.appendChild(row);
    scrollAiToBottom();
}

// ==================== Viewer（无 Ion、无世界地形、全本地内容） ====================

const viewer = new Viewer("cesiumContainer", {
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    baseLayer: false, // 无底图影像：全部内容本地化，不请求 Cesium ion
});

(viewer.camera.frustum as PerspectiveFrustum).fov = CMath.toRadians(90);
viewer.scene.globe.baseColor = Color.fromCssColorString("#0d141b");
// 摄影测量模型背阳面全黑，影响巡检可读性：跟随相机的头灯（模型环境光在模型加载后单独设置）
const headlamp = new DirectionalLight({ direction: new Cartesian3(0, 0, -1), intensity: 1.8 });
viewer.scene.preRender.addEventListener(() => {
    Cartesian3.clone(viewer.camera.directionWC, headlamp.direction);
});
viewer.scene.light = headlamp;
// Retina 屏限制渲染分辨率上限：默认按 devicePixelRatio=2 渲染 GPU 压力翻倍，1.5 足够清晰
viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.5);
viewer.clock.shouldAnimate = true;

// ==================== 主流程 ====================

async function main() {
    // 1. 读取场景 fixture（唯一事实源）
    const damFixture: HydroFixture = await (await fetch(`${BASE}hydro/dam.json`)).json();
    // 页面内不展示署名行；资产许可与作者信息以仓库 player-demo/UPSTREAM.md 为准

    const { origin } = damFixture;
    const localFrame = Transforms.eastNorthUpToFixedFrame(
        Cartesian3.fromDegrees(origin.lon, origin.lat, origin.heightM), undefined, new Matrix4());
    const localFrameInv = Matrix4.inverse(localFrame, new Matrix4());
    const localToWorld = (e: number, n: number, u: number, out = new Cartesian3()): Cartesian3 =>
        Matrix4.multiplyByPoint(localFrame, new Cartesian3(e, n, u), out);
    const worldToLocal = (p: Cartesian3, out = new Cartesian3()): Cartesian3 =>
        Matrix4.multiplyByPoint(localFrameInv, p, out);
    const absHeight = (up: number) => origin.heightM + up; // ENU up ≈ 椭球高（±0.01 弧度范围内）

    // 2. 坝体摄影测量模型（glTF，含坝体+峡谷+库区；本场景唯一地形/碰撞来源，无 3D Tiles）
    // 初始俯瞰视角（人物初始化后由第三人称相机接管）
    viewer.camera.setView({
        destination: localToWorld(0, -380, 420),
        orientation: { heading: 0, pitch: CMath.toRadians(-45), roll: 0 },
    });

    // Sketchfab glTF 原点在模型几何中心之外，且整体约 5 单位见方；
    // scale 由 fixture 标定（目标：坝高约 90~100m 量级）
    const damMatrix = Matrix4.multiplyByUniformScale(
        Transforms.headingPitchRollToFixedFrame(
            localToWorld(0, 0, 0), new HeadingPitchRoll(0, 0, 0)),
        damFixture.assets.dam.scale, new Matrix4());
    try {
        const damModel = await Model.fromGltfAsync({
            url: `${BASE}${damFixture.assets.dam.gltfUrl}`,
            modelMatrix: damMatrix,
        });
        // 均匀环境光：让背阳/峡谷阴影面也可读（摄影测量模型无自发光）
        const ambient = 0.55;
        damModel.imageBasedLighting.sphericalHarmonicCoefficients = [
            new Cartesian3(ambient, ambient, ambient), new Cartesian3(), new Cartesian3(),
            new Cartesian3(), new Cartesian3(), new Cartesian3(),
            new Cartesian3(), new Cartesian3(), new Cartesian3(),
        ];
        viewer.scene.primitives.add(damModel);
    } catch (e) {
        console.error("[hydro] 坝体模型加载失败:", e);
        appendSystemLog("坝体模型加载失败，场景仅剩标记点");
    }

    // 2b. 坝后厂房精细模型（CAD 风格，叠加在摄影测量坝趾；提供 __xjPh 钩子现场标定）
    let phModel: Model | null = null;
    const phMatrixOf = (e: number, n: number, u: number, hDeg: number, scale: number) =>
        Matrix4.multiplyByUniformScale(
            Transforms.headingPitchRollToFixedFrame(
                localToWorld(e, n, u), new HeadingPitchRoll(CMath.toRadians(hDeg), 0, 0)),
            scale, new Matrix4());
    if (damFixture.assets.powerhouse) {
        const ph = damFixture.assets.powerhouse;
        try {
            phModel = await Model.fromGltfAsync({
                url: `${BASE}${ph.glbUrl}`,
                modelMatrix: phMatrixOf(ph.offset.east, ph.offset.north, ph.offset.up, ph.headingDeg, ph.scale),
            });
            viewer.scene.primitives.add(phModel);
        } catch (e) {
            console.error("[hydro] 厂房模型加载失败:", e);
        }
    }

    // 3. 设备标记（机组在坝后厂房内，泄洪闸在坝顶；只有标记点，无独立模型）
    const markerToUnit = new Map<Entity, HydroUnit>();
    for (const u of damFixture.units) {
        // 风险等级着色标记（设备上方，标签写设备名称）
        const color = RISK_COLOR[u.riskLevel];
        const marker = viewer.entities.add({
            position: localToWorld(u.offset.east, u.offset.north, u.offset.up + 25),
            point: {
                pixelSize: 11, color,
                outlineColor: Color.WHITE, outlineWidth: 2,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
                text: u.label,
                font: "13px system-ui",
                fillColor: Color.WHITE,
                showBackground: true,
                backgroundColor: color.withAlpha(0.55),
                pixelOffset: new Cartesian2(0, -18),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
        });
        markerToUnit.set(marker, u);
    }

    // 4. 人物（数字运维员）+ 坝体模型碰撞
    //
    // Model 渲染管线对 glTF 内容会应用 Y-up→Z-up 旋转，而碰撞管线把 modelMatrix 直接作用在
    // 原始顶点上，因此碰撞矩阵通常 = 模型矩阵 × RotX(+90°)（风电场景验证过的套路）。
    // 调试参数 ?collider=raw|px|nx 可切换：raw=不校正，px=RotX(+90°)（默认），nx=RotX(-90°)。
    const colliderMode = new URLSearchParams(location.search).get("collider") ?? "px";
    const rotX = (rad: number) => Matrix4.fromRotationTranslation(
        Matrix3.fromRotationX(rad), Cartesian3.ZERO, new Matrix4());
    const colliderMatrix = colliderMode === "raw" ? Matrix4.clone(damMatrix, new Matrix4())
        : Matrix4.multiply(damMatrix, rotX(colliderMode === "nx" ? -CMath.PI_OVER_TWO : CMath.PI_OVER_TWO), new Matrix4());
    const colliderArr = Matrix4.toArray(colliderMatrix); // 列主序 16 元素

    const opsOffset = damFixture.opsPoint.offset;
    const spawn = localToWorld(opsOffset.east, opsOffset.north, opsOffset.up + 3); // 抬高 3m 让物理落地

    const player = new playerController();
    let colliderDesc = `坝体 glTF 三角网（collider=${colliderMode}）`;
    const gltfCollider: ColliderSource = {
        type: "gltf",
        url: `${BASE}${damFixture.assets.dam.gltfUrl}`,
        modelMatrix: colliderArr,
    };
    // 厂房模型也入碰撞（同 px 校正约定），人物可以走上厂房楼板
    const staticColliders: ColliderSource[] = [gltfCollider];
    if (damFixture.assets.powerhouse) {
        const ph = damFixture.assets.powerhouse;
        const phColliderMatrix = Matrix4.multiply(
            phMatrixOf(ph.offset.east, ph.offset.north, ph.offset.up, ph.headingDeg, ph.scale),
            rotX(colliderMode === "nx" ? -CMath.PI_OVER_TWO : CMath.PI_OVER_TWO), new Matrix4());
        staticColliders.push({
            type: "gltf",
            url: `${BASE}${ph.glbUrl}`,
            modelMatrix: Matrix4.toArray(phColliderMatrix),
        });
        colliderDesc += "＋厂房 glTF";
    }
    const defaultPlayerModel: PlayerModelOptions = {
        url: `${BASE}${damFixture.assets.player.glbUrl}`,
        scale: damFixture.assets.player.scale,
        idleAnim: "Idle_Loop",
        walkAnim: "Walk_Loop",
        runAnim: "Sprint_Loop",
        jumpAnim: ["Jump_Start", "Jump_Loop", "Jump_Land"],
        flyAnim: "fly",
        flyIdleAnim: "flyIdle",
        flyHoverForwardAnim: "flyHoverForward",
        flyHoverBackAnim: "flyHoverBack",
        flyHoverLeftAnim: "flyHoverLeft",
        flyHoverRightAnim: "flyHoverRight",
        flyHoverUpAnim: "flyHoverUp",
        rotateY: -Math.PI / 2,
        facingOffset: Math.PI / 2,
    };
    await player.init({
        viewer,
        initPos: spawn,
        minCamDistance: 30,
        maxCamDistance: 300,
        camLookAtHeightRatio: 0.7,
        enableSpringCamera: true,
        springCameraTime: 0.07,
        thirdMouseMode: 2, // 拖拽旋转、不锁定指针，保证 HUD 输入框可用
        playerModelConfig: defaultPlayerModel,
        staticCollider: staticColliders,
    });
    player.setJumpHeight(900);
    player.setPlayerSpeed(500); // ×0.01 → 步行约 5 m/s（手动 WASD）
    player.setPlayerFlySpeed(3000); // ×0.01 → 飞行约 30 m/s

    // 库内对失败碰撞源是 allSettled 跳过（不抛错），这里实际校验碰撞体数量；
    // gltf 碰撞缺失时退化为原点周围椭球面兜底。
    const colliderCount = (player.physics as unknown as { staticColliders?: unknown[] }).staticColliders?.length ?? 0;
    if (colliderCount === 0) {
        console.warn("坝体 glTF 碰撞体未建成，退化为椭球面地形兜底");
        const half = 0.01;
        try {
            await player.physics.addStaticColliders(viewer, {
                type: "terrain",
                rectangle: [
                    CMath.toRadians(origin.lon - half), CMath.toRadians(origin.lat - half),
                    CMath.toRadians(origin.lon + half), CMath.toRadians(origin.lat + half),
                ],
                resolution: 32,
            });
            colliderDesc = "椭球面地形兜底（坝体 glTF 碰撞加载失败）";
        } catch (e) {
            console.error("兜底地形碰撞也失败:", e);
            colliderDesc = "碰撞不可用（仅动画/运动演示）";
        }
    }
    console.info(`[hydro] 碰撞：${colliderDesc}`);

    // 第一人称时隐藏人物模型
    player.onViewChange = (isFirstPerson) => {
        const m = player.getPlayerModel();
        if (m) m.show = !isFirstPerson;
    };

    // ---------- 彩蛋：牛来（对话含「牛来」时切换模型，「换回来」恢复） ----------
    let niulaiActive = false;
    let niulaiSwitching = false;
    const switchAvatarModel = async (toNiulai: boolean) => {
        if (niulaiSwitching || toNiulai === niulaiActive) return;
        niulaiSwitching = true;
        appendSystemLog(toNiulai ? "牛来加载中（模型较大，稍等）…" : "正在切回数字运维员…");
        try {
            await player.switchPlayerModel(toNiulai ? {
                url: `${BASE}glb/niulai.glb`,
                scale: damFixture.assets.player.scale, // 与默认模型同 scale：速度/重力/相机比例不动
                // 牛来无动画：全部显式置空（Cesium 对缺失动画名会抛错），模型保持静姿
                idleAnim: undefined, walkAnim: undefined, runAnim: undefined,
                leftWalkAnim: undefined, rightWalkAnim: undefined, backwardAnim: undefined,
                jumpAnim: undefined, flyAnim: undefined, flyIdleAnim: undefined,
                flyHoverForwardAnim: undefined, flyHoverBackAnim: undefined,
                flyHoverLeftAnim: undefined, flyHoverRightAnim: undefined,
                flyHoverUpAnim: undefined, flyHoverDownAnim: undefined, drivingAnim: undefined,
                rotateY: 0, facingOffset: -Math.PI / 2, // 牛来模型本地朝向 +X，补偿 -90° 对齐前进方向
            } as unknown as PlayerModelOptions : { ...defaultPlayerModel });
            niulaiActive = toNiulai;
            appendSystemLog(toNiulai ? "牛来登场。对它说「换回来」即可恢复数字运维员。" : "已切回数字运维员。");
            if (toNiulai) speak("牛来呀 牛来，它迎着行情走来了！", true);
        } catch {
            appendSystemLog("模型切换失败，保持当前模型。");
        } finally {
            niulaiSwitching = false;
        }
    };
    (window as unknown as { __xjNiulai?: (on: boolean) => Promise<void> }).__xjNiulai = switchAvatarModel;

    // 第三人称相机接管时 viewer.camera.flyTo 会被每帧覆盖；
    // focus_asset 需要真正飞相机，这里给相机系统加一个示例侧的旁路开关。
    const camAny = player.cam as unknown as { update: (delta: number) => void };
    const origCamUpdate = camAny.update.bind(player.cam);
    let cameraOverride = false;
    camAny.update = (delta: number) => { if (!cameraOverride) origCamUpdate(delta); };

    // ==================== 指令执行器（前端确定性执行） ====================

    interface Action { update(dt: number): boolean; cancel(): void }

    let pathEntities: Entity[] = [];
    let focusRing: Entity | null = null;
    let bearingMarker: Entity | null = null;

    const zeroInput = () => player.setInput({ moveX: 0, moveY: 0, jump: false, shift: false });
    const playerLocal = () => worldToLocal(player.getPosition());

    function faceTowards(de: number, dn: number, dt: number) {
        if (Math.hypot(de, dn) < 1) return;
        const desired = Math.atan2(de, dn); // 控制器约定：yaw = atan2(E, N)
        const diff = CMath.negativePiToPi(desired - player.getYaw());
        player.addYaw(diff * Math.min(1, 10 * dt));
    }

    // 采样 (x,y) 处真实地形的站立高度（胶囊中心 local z）；射线未命中回退 fallback。
    // fixture 里的 up 只是登记值，与山体网格真实高程可能差上百米（运维点实测差 ~180m），
    // 因此射线窗口不围绕 fallback，而是覆盖全高程范围（±500m）。
    function terrainStandZ(x: number, y: number, fallback: number): number {
        const top = localToWorld(x, y, 500);
        const bottom = localToWorld(x, y, -500);
        const dir = Cartesian3.subtract(bottom, top, new Cartesian3());
        Cartesian3.normalize(dir, dir);
        const d = player.physics.raycastEcef(top, dir, 1000);
        if (!Number.isFinite(d)) return fallback;
        return 500 - d + player.getCapsuleGroundHeight();
    }

    function clearPath() {
        for (const e of pathEntities) viewer.entities.remove(e);
        pathEntities = [];
    }
    function clearFocusRing() {
        if (focusRing) { viewer.entities.remove(focusRing); focusRing = null; }
    }
    function clearBearingMarker() {
        if (bearingMarker) { viewer.entities.remove(bearingMarker); bearingMarker = null; }
    }

    // ---------- 场景截图 ----------

    // 下载当前场景画面 PNG：强制重渲一帧再读 canvas（无 preserveDrawingBuffer，直接 toBlob 会拿到空图）。
    // 页面不放任何 UI 入口；后端大模型在 commands[] 里返回 { kind: "capture_scene" } 即触发，
    // 联调前也可在控制台手动调 window.xunjieCapture() 验证。
    function captureSceneShot(): void {
        viewer.scene.render();
        viewer.scene.canvas.toBlob((blob) => {
            if (!blob) { console.warn("[hydro] 截图失败：canvas.toBlob 返回空"); return; }
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `xunjie-hydro-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            console.info(`[hydro] 场景截图已下载：${a.download}`);
        }, "image/png");
    }
    (window as unknown as { xunjieCapture?: () => void }).xunjieCapture = captureSceneShot;

    // 调试钩子（不入 UI，标定/联调用）：__xjCam(e,n,u,headingDeg,pitchDeg) 切自由视角；__xjLocal() 读人物局部 ENU
    (window as unknown as { __xjCam?: (e: number, n: number, u: number, hDeg?: number, pDeg?: number) => void }).__xjCam =
        (e, n, u, hDeg = 0, pDeg = -90) => {
            cameraOverride = true;
            viewer.camera.setView({
                destination: localToWorld(e, n, u),
                orientation: { heading: CMath.toRadians(hDeg), pitch: CMath.toRadians(pDeg), roll: 0 },
            });
        };
    (window as unknown as { __xjLocal?: () => { e: number; n: number; u: number } }).__xjLocal = () => {
        const p = playerLocal();
        return { e: Math.round(p.x * 10) / 10, n: Math.round(p.y * 10) / 10, u: Math.round(p.z * 10) / 10 };
    };
    // 标定用：局部 (e,n) 处的碰撞地面高度（射线未命中返回 null）
    (window as unknown as { __xjGround?: (e: number, n: number) => number | null }).__xjGround = (e, n) => {
        const top = localToWorld(e, n, 600);
        const bottom = localToWorld(e, n, -600);
        const dir = Cartesian3.subtract(bottom, top, new Cartesian3());
        Cartesian3.normalize(dir, dir);
        const d = player.physics.raycastEcef(top, dir, 1200);
        return Number.isFinite(d) ? Math.round((600 - d) * 10) / 10 : null;
    };
    // 标定用：把人物瞬移到局部 (e,n,u+2)，让物理自然落地，第三人称截图直接验证碰撞/视觉一致性
    (window as unknown as { __xjTeleport?: (e: number, n: number, u: number) => void }).__xjTeleport = (e, n, u) => {
        executor.interrupt();
        player.reset(localToWorld(e, n, u + 2));
    };
    // 标定用：在局部坐标放一个测试钉（返回 entity 数量）
    (window as unknown as { __xjMark?: (e: number, n: number, u: number, label?: string) => void }).__xjMark = (e, n, u, label = `${e},${n}`) => {
        viewer.entities.add({
            position: localToWorld(e, n, u),
            point: { pixelSize: 9, color: Color.CYAN, outlineColor: Color.BLACK, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY },
            label: { text: label, font: "12px monospace", fillColor: Color.CYAN, pixelOffset: new Cartesian2(0, -14), disableDepthTestDistance: Number.POSITIVE_INFINITY },
        });
    };
    // 标定用：在线调整厂房模型位置/朝向/比例（视觉标定；碰撞体重建需改 fixture 后刷新）
    (window as unknown as { __xjPh?: (e: number, n: number, u: number, hDeg?: number, scale?: number) => void }).__xjPh =
        (e, n, u, hDeg = 15, scale = 13) => {
            if (!phModel) return;
            phModel.modelMatrix = phMatrixOf(e, n, u, hDeg, scale);
            console.info(`[hydro] 厂房标定: e=${e} n=${n} u=${u} heading=${hDeg} scale=${scale}`);
        };
    // 标定用：视觉真值扫描——顶视相机 + 深度缓冲 pickPosition，测的是渲染出来的模型表面（而非碰撞体）
    (window as unknown as { __xjVisualScan?: (e0: number, n0: number, span: number, alt: number) => (number | null)[][] }).__xjVisualScan =
        (e0, n0, span, alt) => {
            cameraOverride = true;
            viewer.camera.setView({
                destination: localToWorld(e0, n0, alt),
                orientation: { heading: 0, pitch: -CMath.PI_OVER_TWO, roll: 0 },
            });
            viewer.scene.render();
            const canvas = viewer.scene.canvas;
            const W = canvas.width, H = canvas.height;
            const N = 21;
            const out: (number | null)[][] = [];
            for (let r = 0; r < N; r++) {
                const row: (number | null)[] = [];
                for (let c = 0; c < N; c++) {
                    const wx = Math.floor((c + 0.5) * W / N);
                    const wy = Math.floor((r + 0.5) * H / N);
                    let v: number | null = null;
                    try {
                        const p = viewer.scene.pickPosition(new Cartesian2(wx, wy));
                        if (p) {
                            const l = worldToLocal(p);
                            v = Math.round(l.z * 10) / 10;
                        }
                    } catch { v = null; }
                    row.push(v);
                }
                out.push(row);
            }
            return out;
        };

    // 截图是指令流里的瞬时动作：入队即执行，不阻塞后续命令
    function makeCaptureScene(): Action {
        let fired = false;
        return {
            update() {
                if (!fired) { fired = true; captureSceneShot(); }
                return true;
            },
            cancel() { /* 瞬时动作，无需中断处理 */ },
        };
    }

    // 脉冲半径：每帧只算一次（两个 CallbackProperty 各自取 Date.now() 会有毫秒差，
    // 偶发 semiMajor < semiMinor 直接抛 DeveloperError 停掉渲染，E2E 实测踩到过）
    let ringRadius = 14;
    let bearingRadius = 6;

    function addFocusRing(t: HydroUnit) {
        clearFocusRing();
        const baseColor = RISK_COLOR[t.riskLevel];
        focusRing = viewer.entities.add({
            position: localToWorld(t.offset.east, t.offset.north, t.offset.up),
            ellipse: {
                semiMajorAxis: new CallbackProperty(() => ringRadius, false),
                semiMinorAxis: new CallbackProperty(() => ringRadius, false),
                height: absHeight(t.offset.up + 2),
                material: baseColor.withAlpha(0.35),
                outline: true,
                outlineColor: baseColor,
            },
        });
    }

    function addBearingPulse(t: HydroUnit, componentLabel: string) {
        clearBearingMarker();
        // 设备位置上方（机组在厂房内/闸门在坝顶，标记贴近设备即可）
        bearingMarker = viewer.entities.add({
            position: localToWorld(t.offset.east, t.offset.north, t.offset.up + 8),
            ellipsoid: {
                radii: new CallbackProperty(() => new Cartesian3(bearingRadius, bearingRadius, bearingRadius), false),
                material: Color.RED.withAlpha(0.6),
                outline: true,
                outlineColor: Color.WHITE,
            },
            label: {
                text: componentLabel,
                font: "13px system-ui",
                fillColor: Color.WHITE,
                showBackground: true,
                backgroundColor: Color.RED.withAlpha(0.7),
                pixelOffset: new Cartesian2(0, -24),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
        });
    }

    // ---------- 动作：导航 ----------

    function resolveNavTarget(targetId?: string): HydroOffset | null {
        if (!targetId) return null;
        if (targetId === damFixture.opsPoint.id) return damFixture.opsPoint.offset;
        const t = damFixture.units.find((x) => x.checkpointId === targetId || x.id === targetId);
        return t ? t.offset : null;
    }

    // 地面 walk/run：水平纯插值 reset + 竖直逐帧射线贴真实地形，不喂输入——
    // 否则控制器的速度/重力/地面吸附每帧和 reset 打架，表现为移动时上下抖动。
    // 动画由 setScriptedAnimation 覆盖（无按键输入时控制器每帧会切回 idle）
    function makeGroundNavigate(target: HydroOffset, movement: "walk" | "run"): Action {
        const speed = SPEED[movement];
        const start = playerLocal().clone();
        const end = new Cartesian3(target.east, target.north, target.up);
        const total = Math.max(1e-6, Math.hypot(end.x - start.x, end.y - start.y)); // 只算水平距离
        let s = 0;
        player.setScriptedAnimation(movement === "run" ? "running" : "walking");
        return {
            update(dt) {
                s += speed * dt;
                const t = Math.min(1, s / total);
                const x = start.x + (end.x - start.x) * t;
                const y = start.y + (end.y - start.y) * t;
                const z = terrainStandZ(x, y, start.z + (end.z - start.z) * t);
                player.reset(localToWorld(x, y, z));
                faceTowards(end.x - start.x, end.y - start.y, dt);
                const cur = playerLocal();
                const done = t >= 1 || Math.hypot(cur.x - end.x, cur.y - end.y) <= 2;
                if (done) { zeroInput(); clearPath(); player.setScriptedAnimation(null); return true; }
                return false;
            },
            cancel() { zeroInput(); clearPath(); player.setScriptedAnimation(null); },
        };
    }

    // 飞行 fly：三段式（抬升 40m → 水平巡航 → 下降到目标 up+2）
    function makeFlyNavigate(target: HydroOffset): Action {
        const start = playerLocal().clone();
        const cruise = Math.max(start.z + 40, target.up + 42);
        const pts = [
            new Cartesian3(start.x, start.y, start.z),
            new Cartesian3(start.x, start.y, cruise),
            new Cartesian3(target.east, target.north, cruise),
            new Cartesian3(target.east, target.north, target.up + 2),
        ];
        let seg = 0;
        let s = 0;
        // 语言指令不切换人物形态：纯插值 reset 送达，不喂输入——
        // 否则控制器每帧还会叠加自身的速度/重力解算，与 reset 打架造成抬升段抖动。
        // 动画按航段经 setScriptedAnimation 覆盖（优先级高于控制器按键动画，结束/中断时清除）。
        const scriptedAnim = () => {
            player.setScriptedAnimation(
                seg === 0 ? "flyHoverUp" : seg >= pts.length - 2 ? "flyidle" : "flyHoverForward",
            );
        };
        scriptedAnim();
        return {
            update(dt) {
                let done = false;
                while (seg < pts.length - 1) {
                    const a = pts[seg];
                    const b = pts[seg + 1];
                    const segLen = Cartesian3.distance(a, b);
                    const step = SPEED.fly * dt;
                    if (segLen < 1e-6 || segLen - s <= step) {
                        player.reset(localToWorld(b.x, b.y, b.z));
                        seg += 1;
                        s = 0;
                        if (seg >= pts.length - 1) { done = true; break; }
                        continue;
                    }
                    s += step;
                    const p = Cartesian3.lerp(a, b, s / segLen, new Cartesian3());
                    player.reset(localToWorld(p.x, p.y, p.z));
                    scriptedAnim();
                    // 朝向对准目标水平方向（抬升/巡航段均适用）
                    const cur = playerLocal();
                    faceTowards(target.east - cur.x, target.north - cur.y, dt);
                    break;
                }
                const cur = playerLocal();
                const horizontal = Math.hypot(cur.x - target.east, cur.y - target.north);
                const vertical = Math.abs(cur.z - (target.up + 2));
                done = done || (seg >= pts.length - 1) || (horizontal <= 2 && vertical <= 4);
                if (done) {
                    zeroInput();
                    clearPath();
                    player.setScriptedAnimation(null);
                    return true;
                }
                return false;
            },
            cancel() {
                zeroInput();
                clearPath();
                player.setScriptedAnimation(null);
            },
        };
    }

    function makeNavigate(cmd: AvatarCommand): Action | null {
        const target = resolveNavTarget(cmd.targetId);
        if (!target) {
            appendSystemLog(`导航目标未登记：${cmd.targetId ?? "(空)"}，已跳过（不猜测坐标）`);
            return null;
        }
        return cmd.movement === "fly" ? makeFlyNavigate(target) : makeGroundNavigate(target, cmd.movement ?? "walk");
    }

    // ---------- 动作：聚焦设备 ----------

    // 设备信息卡：折进对话流（卡片气泡），不再用右侧悬浮卡
    function showAssetCard(t: HydroUnit) {
        const row = document.createElement("div");
        row.className = "ai-msg bot";
        const av = document.createElement("span");
        av.className = "ai-av";
        av.textContent = "AI";
        row.appendChild(av);
        const bubble = document.createElement("div");
        bubble.className = "ai-bubble ai-bubble-card";

        const card = document.createElement("div");
        card.className = "ai-card";
        const title = document.createElement("div");
        title.className = "ai-card-title";
        title.textContent = `设备信息 · ${t.label}（${RISK_LABEL[t.riskLevel]}）`;
        card.appendChild(title);
        const rows: [string, string][] = [
            ["ID", t.id],
            ["风险等级", `${RISK_LABEL[t.riskLevel]}（${t.riskLevel}）`],
            ["headingDeg", `${t.headingDeg}°`],
            ["offset (E/N/U)", `${t.offset.east} / ${t.offset.north} / ${t.offset.up} m`],
            ["checkpointId", t.checkpointId],
            ["模型来源", damFixture.assets.dam.credit],
        ];
        for (const [k, v] of rows) {
            const div = document.createElement("div");
            div.className = "ai-card-row";
            const kk = document.createElement("span");
            kk.className = "k";
            kk.textContent = k;
            div.appendChild(kk);
            div.appendChild(document.createTextNode(v));
            card.appendChild(div);
        }
        if (cameraOverride) {
            const action = document.createElement("div");
            action.className = "ai-card-action";
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "capsule-btn";
            btn.textContent = "恢复跟随视角";
            btn.addEventListener("click", () => {
                clearFocusRing();
                cameraOverride = false;
                btn.remove();
            });
            action.appendChild(btn);
            card.appendChild(action);
        }
        bubble.appendChild(card);
        row.appendChild(bubble);
        aiMsgs.appendChild(row);
        scrollAiToBottom();
    }

    function makeFocusAsset(cmd: AvatarCommand): Action | null {
        const t = damFixture.units.find((x) => x.id === cmd.targetId);
        if (!t) {
            appendSystemLog(`聚焦目标未登记：${cmd.targetId ?? "(空)"}，已跳过`);
            return null;
        }
        cameraOverride = true; // 释放第三人称跟随，让 flyTo 生效
        const h = CMath.toRadians(t.headingDeg);
        const device = { e: t.offset.east, n: t.offset.north, u: t.offset.up + 6 };
        // 设备前方 45m、上方 22m，看向设备
        const cam = {
            e: device.e + Math.sin(h) * 45,
            n: device.n + Math.cos(h) * 45,
            u: device.u + 22,
        };
        const de = device.e - cam.e;
        const dn = device.n - cam.n;
        const du = device.u - cam.u;
        const len = Math.hypot(de, dn, du);
        viewer.camera.flyTo({
            destination: localToWorld(cam.e, cam.n, cam.u),
            orientation: { heading: Math.atan2(de, dn), pitch: Math.asin(du / len), roll: 0 },
            duration: 1.6,
        });
        addFocusRing(t);
        showAssetCard(t);
        return { update: () => true, cancel: () => undefined }; // 相机动作不阻塞后续命令
    }

    // ---------- 动作：维修仿真 ----------

    // 维修记录卡：折进对话流（卡片气泡），不再是右侧悬浮卡
    function showRepairRecord(target: HydroRepairTarget, t: HydroUnit, stamps: { id: string; label: string; time: string }[]) {
        const doneAt = new Date().toLocaleString("zh-CN", { hour12: false });
        const row = document.createElement("div");
        row.className = "ai-msg bot";
        const av = document.createElement("span");
        av.className = "ai-av";
        av.textContent = "AI";
        row.appendChild(av);
        const bubble = document.createElement("div");
        bubble.className = "ai-bubble ai-bubble-card";

        const card = document.createElement("div");
        card.className = "ai-card";
        const title = document.createElement("div");
        title.className = "ai-card-title";
        title.textContent = "维修记录卡（可追溯回执）";
        const sim = document.createElement("span");
        sim.className = "ai-badge ai-badge-warn";
        sim.textContent = "SIMULATED";
        title.appendChild(sim);
        card.appendChild(title);

        const addRow = (k: string, v: string) => {
            const div = document.createElement("div");
            div.className = "ai-card-row";
            const kk = document.createElement("span");
            kk.className = "k";
            kk.textContent = k;
            div.appendChild(kk);
            div.appendChild(document.createTextNode(v));
            card.appendChild(div);
        };
        addRow("targetId", target.targetId);
        addRow("部件", `${target.componentId} · ${target.componentLabel}`);
        addRow("checkpointId", target.checkpointId);
        addRow("操作人", "巡界数字运维员（仿真）");
        addRow("truth", "SIMULATED");
        addRow("完成时间", doneAt);
        const ol = document.createElement("ol");
        ol.className = "ai-card-steps";
        for (const s of stamps) {
            const li = document.createElement("li");
            li.textContent = `${s.id} ${s.label} — ${s.time}`;
            ol.appendChild(li);
        }
        card.appendChild(ol);
        bubble.appendChild(card);
        row.appendChild(bubble);
        aiMsgs.appendChild(row);
        scrollAiToBottom();
        console.info(`[hydro] 维修仿真完成：${t.label} ${target.componentLabel}，记录卡已生成（SIMULATED）`);
    }

    function makeRepair(cmd: AvatarCommand): Action | null {
        const target = damFixture.repairTargets.find((r) => r.targetId === cmd.targetId);
        const unit = damFixture.units.find((x) => x.id === cmd.targetId);
        if (!target || !unit) {
            appendSystemLog(`维修目标未登记：${cmd.targetId ?? "(空)"}，已跳过（本场景仅登记 HS-HU-02 · 2 号机组）`);
            return null;
        }
        // 若人物不在 checkpoint 5m 内，先自动 fly navigate 过去
        const cp = new Cartesian3(unit.offset.east, unit.offset.north, unit.offset.up);
        const needNav = Cartesian3.distance(playerLocal(), cp) > 5;
        let navAction: Action | null = needNav ? makeFlyNavigate(unit.offset) : null;

        const stamps: { id: string; label: string; time: string }[] = [];
        let stepIdx = -1;
        let stepTimer = 0;
        let started = false;
        return {
            update(dt) {
                if (navAction) {
                    if (navAction.update(dt)) navAction = null;
                    return false;
                }
                if (!started) {
                    started = true;
                    console.info(`[hydro] 维修仿真开始：${unit.label} · ${target.componentLabel}（SIMULATED）`);
                }
                stepTimer += dt;
                if (stepIdx === -1 || stepTimer >= 1.2) {
                    stepIdx += 1;
                    stepTimer = 0;
                    if (stepIdx >= target.steps.length) {
                        clearBearingMarker();
                        showRepairRecord(target, unit, stamps);
                        return true;
                    }
                    const step = target.steps[stepIdx];
                    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
                    stamps.push({ id: step.id, label: step.label, time });
                    // 步骤留痕只进 console 与最终维修记录卡，不再刷对话消息流
                    console.info(`[hydro] 维修步骤 ${step.id}：${step.label}（SIMULATED）`);
                    if (step.id === "RS-3") addBearingPulse(unit, target.componentLabel);
                }
                return false;
            },
            cancel() {
                navAction?.cancel();
                clearBearingMarker();
                console.info("[hydro] 维修仿真已中断");
            },
        };
    }

    // ---------- 动作：相对移动 / 转向 / 跳跃 / 停止 ----------

    function makeMoveRelative(cmd: AvatarCommand): Action {
        const dir = cmd.direction ?? "forward";
        const meters = Math.max(1, Math.min(2000, cmd.distanceMeters ?? 10));
        const movement: AvatarMovement = cmd.movement ?? (dir === "up" || dir === "down" ? "fly" : "walk");
        const start = playerLocal().clone();
        const yaw = player.getYaw();
        const v = { e: 0, n: 0, u: 0 };
        switch (dir) {
            case "forward": v.e = Math.sin(yaw); v.n = Math.cos(yaw); break;
            case "backward": v.e = -Math.sin(yaw); v.n = -Math.cos(yaw); break;
            case "left": v.e = -Math.cos(yaw); v.n = Math.sin(yaw); break; // 人物真左侧：forward=(sin,cos) 的左法向
            case "right": v.e = Math.cos(yaw); v.n = -Math.sin(yaw); break;
            case "up": v.u = 1; break;
            case "down": v.u = -1; break;
        }
        const end = new Cartesian3(start.x + v.e * meters, start.y + v.n * meters, start.z + v.u * meters);
        const total = Math.max(1e-6, Cartesian3.distance(start, end));
        const horizontal = Math.hypot(v.e, v.n) > 0.1;
        // 语言指令不切换人物形态（walk/fly 模式只由用户手动 F 切换）；位移由逐帧 reset 送达，不喂输入——
        // 输入会让控制器按相机朝向叠加自身移动，与 reset 打架造成抖动。
        // 水平位移贴真实地形（射线采样），竖直位移纯插值；动画脚本覆盖。
        const animKey = dir === "up" ? "flyHoverUp" : dir === "down" ? "flyidle"
            : movement === "run" ? "running" : movement === "fly" ? "flyHoverForward" : "walking";
        let s = 0;
        player.setScriptedAnimation(animKey);
        return {
            update(dt) {
                s += SPEED[movement] * dt;
                const t = Math.min(1, s / total);
                const x = start.x + (end.x - start.x) * t;
                const y = start.y + (end.y - start.y) * t;
                const zFallback = start.z + (end.z - start.z) * t;
                const z = horizontal ? terrainStandZ(x, y, zFallback) : zFallback;
                player.reset(localToWorld(x, y, z));
                if (horizontal) faceTowards(v.e, v.n, dt);
                if (t >= 1) {
                    zeroInput();
                    clearPath();
                    player.setScriptedAnimation(null);
                    return true;
                }
                return false;
            },
            cancel() {
                zeroInput();
                clearPath();
                player.setScriptedAnimation(null);
            },
        };
    }

    function makeTurn(degrees: number): Action {
        const total = CMath.toRadians(Math.max(-180, Math.min(180, degrees)));
        const rate = CMath.toRadians(120);
        let rotated = 0;
        return {
            update(dt) {
                const remain = total - rotated;
                const step = Math.sign(remain) * Math.min(Math.abs(remain), rate * dt);
                player.addYaw(step);
                rotated += step;
                return Math.abs(total - rotated) < 1e-4;
            },
            cancel() { /* 转向可瞬时中断 */ },
        };
    }

    function makeJump(): Action {
        let fired = false;
        let t = 0;
        return {
            update(dt) {
                if (!fired) { player.setInput({ jump: true }); fired = true; }
                t += dt;
                if (t > 0.3) { player.setInput({ jump: false }); return true; }
                return false;
            },
            cancel() { player.setInput({ jump: false }); },
        };
    }

    function describeCommand(c: AvatarCommand): string {
        switch (c.kind) {
            case "navigate": return `导航 → ${c.targetId}（${c.movement}）`;
            case "focus_asset": return `聚焦 ${c.targetId}`;
            case "repair_simulation": return `维修仿真 ${c.targetId} @ ${c.checkpointId}`;
            case "move_relative": return `相对移动 ${c.direction} ${c.distanceMeters ?? 10}m（${c.movement}）`;
            case "turn": return `转向 ${c.degrees}°`;
            case "jump": return "跳跃";
            case "stop": return "停止";
            case "capture_scene": return "场景截图（下载 PNG）";
            default: return c.kind;
        }
    }

    function startCommand(cmd: AvatarCommand): Action | null {
        switch (cmd.kind) {
            case "navigate": return makeNavigate(cmd);
            case "focus_asset": return makeFocusAsset(cmd);
            case "repair_simulation": return makeRepair(cmd);
            case "move_relative": return makeMoveRelative(cmd);
            case "turn": return makeTurn(cmd.degrees ?? 0);
            case "jump": return makeJump();
            case "stop": return { update: () => true, cancel: () => undefined }; // push 时已中断
            case "capture_scene": return makeCaptureScene(); // 后端约定的截图指令（合同对齐中）
            default:
                appendSystemLog(`命令 ${cmd.kind} 不属于水电场景登记范围，已跳过`);
                return null;
        }
    }

    const executor = {
        queue: [] as AvatarCommand[],
        current: null as Action | null,
        push(cmds: AvatarCommand[]) {
            this.interrupt(); // 新指令到达时中断当前动作
            this.queue = cmds.slice();
        },
        interrupt() {
            if (this.current) { try { this.current.cancel(); } catch (e) { console.warn(e); } }
            this.current = null;
            this.queue = [];
            zeroInput();
            clearPath();
            clearFocusRing();
            clearBearingMarker();
            cameraOverride = false; // 恢复第三人称跟随
        },
        tick(dt: number) {
            let guard = 0;
            while (!this.current && this.queue.length && guard++ < 8) {
                const cmd = this.queue.shift()!;
                const action = startCommand(cmd);
                if (action) {
                    this.current = action;
                }
            }
            if (!this.current) return;
            let done = false;
            try {
                done = this.current.update(dt);
            } catch (e) {
                console.error("指令执行异常:", e);
                done = true;
            }
            if (done) {
                this.current = null;
            }
        },
    };

    // ==================== 引擎指令链路 ====================

    // 悬浮球面板消息
    function appendAiUser(text: string) {
        const row = document.createElement("div");
        row.className = "ai-msg user";
        const av = document.createElement("span");
        av.className = "ai-av";
        av.textContent = "值";
        row.appendChild(av);
        const bubble = document.createElement("div");
        bubble.className = "ai-bubble";
        const p = document.createElement("p");
        p.className = "ai-tx";
        p.textContent = text;
        bubble.appendChild(p);
        row.appendChild(bubble);
        aiMsgs.appendChild(row);
        scrollAiToBottom();
    }

    function appendAiBot(opts: {
        reply: string;
        plannerMode?: string;
        commands?: AvatarCommand[];
        outcomes?: DispatchOutcome[];
        mission?: MissionBrief | null;
        trace?: TraceStep[];
        examples?: string[];
        warnings?: string[];
    }) {
        // planner / trace / outcomes 等元数据不上气泡（气泡只留 reply + 命令 chips），写 console 留底
        if (opts.plannerMode) console.info(`[hydro] planner=${opts.plannerMode}`);
        if (opts.trace?.length) {
            console.info(`[hydro] trace ${opts.trace.length} 步：${opts.trace.map((s) => `${s.label}·${s.status}·${s.durationMs}ms`).join(" → ")}`);
        }
        if (opts.outcomes?.length) {
            console.info(`[hydro] 服务端编排：${opts.outcomes.map((o) => `${DISPATCH_LABEL[o.kind] ?? o.kind}:${o.status}`).join("，")}`);
        }
        if (opts.mission?.missionId) {
            console.info(`[hydro] 任务 ${opts.mission.missionId} · 阶段 ${opts.mission.phase ?? "未知"}`);
        }
        if (opts.examples?.length) console.info(`[hydro] 示例：${opts.examples.join(" / ")}`);
        if (opts.warnings?.length) console.warn(`[hydro] ${opts.warnings.join("；")}`);

        const row = document.createElement("div");
        row.className = "ai-msg bot";
        const av = document.createElement("span");
        av.className = "ai-av";
        av.textContent = "AI";
        row.appendChild(av);
        const bubble = document.createElement("div");
        bubble.className = "ai-bubble";
        const p = document.createElement("p");
        p.className = "ai-tx";
        p.textContent = opts.reply;
        bubble.appendChild(p);
        if (opts.commands?.length) {
            const cmds = document.createElement("div");
            cmds.className = "ai-cmds";
            for (const c of opts.commands) {
                const chip = document.createElement("span");
                chip.className = "cmd-chip";
                chip.textContent = describeCommand(c);
                cmds.appendChild(chip);
            }
            bubble.appendChild(cmds);
        }
        row.appendChild(bubble);
        aiMsgs.appendChild(row);
        scrollAiToBottom();
    }

    async function sendInstruction(text: string) {
        let res: Response;
        try {
            res = await fetch(ENGINE_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text,
                    sceneId: damFixture.sceneId,
                    sceneRevision: damFixture.sceneRevision,
                    conversationId: CONVERSATION_ID,
                }),
            });
        } catch (e) {
            console.warn("引擎连接失败:", e);
            const reply = "引擎未连接（localhost:8787），仅可手动控制";
            appendAiBot({ reply });
            speak(reply);
            return;
        }
        if (!res.ok) {
            let body: {
                error?: { message?: string };
                clarification?: { message?: string; examples?: string[] };
                trace?: TraceStep[];
                planner?: { mode?: "llm" | "deterministic-fallback" };
            } | null = null;
            try { body = await res.json(); } catch { body = null; }
            const reply = body?.clarification?.message ?? body?.error?.message ?? `引擎返回 HTTP ${res.status}`;
            appendAiBot({
                reply,
                examples: body?.clarification?.examples,
                trace: body?.trace,
                plannerMode: body?.planner?.mode,
            });
            speak(reply);
            return;
        }
        const body = (await res.json()) as InterpretResponse;
        const commands = body.data?.commands ?? [];
        const outcomes = body.data?.dispatch ?? [];
        const mission = body.data?.mission;
        appendAiBot({
            reply: body.data?.reply ?? "（无回复）",
            plannerMode: body.planner?.mode,
            commands,
            outcomes,
            mission,
            trace: body.data?.trace,
            warnings: body.warnings,
        });
        // 播报规则：后端有回复就语音播报（问答与执行确认都播）
        if (body.data?.reply) speak(body.data.reply);
        if (commands.length) executor.push(commands);
    }

    function submitText(raw: string) {
        const text = raw.trim();
        if (!text) return;
        cmdInput.value = "";
        appendAiUser(text);
        // 彩蛋：「牛来」换模型；「换回来」恢复
        if (/牛来|牛奶/.test(text)) { void switchAvatarModel(true); return; }
        if (niulaiActive && /换回来|切回来|换回去|切回去|恢复/.test(text)) { void switchAvatarModel(false); return; }
        void sendInstruction(text);
    }

    cmdForm.addEventListener("submit", (e) => {
        e.preventDefault();
        submitText(cmdInput.value);
    });

    // ---------- 语音输入（豆包 ASR：面板麦克风按住说话，或快速双击悬浮球开始/再双击结束并发送） ----------
    const ENGINE_VOICE_URL = withKey("/agent/voice/asr");
    const cmdMic = el<HTMLButtonElement>("cmd-mic");
    let micRecording = false;
    let micStarting = false; // getUserMedia/AudioContext 建立中（双击停止到达过早时忽略，避免并发重复开录）
    let micFinish: (() => Promise<void>) | null = null; // 录音中的结束回调（双击悬浮球用）

    function floatToInt16(input: Float32Array): Int16Array {
        const out = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return out;
    }

    function setVoiceUi(on: boolean): void {
        micRecording = on;
        cmdMic.classList.toggle("recording", on);
        cmdMic.title = on ? "松开结束并识别…" : "按住说话（豆包语音识别）";
        aiOrb.classList.toggle("recording", on);
        aiOrb.title = on ? "录音中…再次双击结束并发送" : "";
    }

    async function startMicCapture(): Promise<void> {
        if (micRecording || micStarting) return;
        micStarting = true;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
            const ctx = new AudioContext({ sampleRate: 16000 });
            const source = ctx.createMediaStreamSource(stream);
            const processor = ctx.createScriptProcessor(4096, 1, 1);
            const chunks: Int16Array[] = [];
            processor.onaudioprocess = (ev) => {
                if (!micRecording) return;
                chunks.push(floatToInt16(ev.inputBuffer.getChannelData(0)));
            };
            source.connect(processor);
            processor.connect(ctx.destination);
            setVoiceUi(true);
            const finish = async () => {
                if (!micRecording) return; // 幂等：pointerup/pointerleave 与双击可能重复触发
                micFinish = null;
                setVoiceUi(false);
                try {
                    processor.disconnect();
                    source.disconnect();
                    stream.getTracks().forEach((t) => t.stop());
                    await ctx.close();
                } catch { /* 忽略清理异常 */ }
                const total = chunks.reduce((s, c) => s + c.length, 0);
                const pcm = new Int16Array(total);
                let off = 0;
                for (const c of chunks) { pcm.set(c, off); off += c.length; }
                if (pcm.length < 3200) { appendSystemLog("说话时间太短，没有录到内容"); return; }
                try {
                    const res = await fetch(ENGINE_VOICE_URL, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: pcm.buffer });
                    const body = await res.json();
                    const text = String(body?.data?.text ?? "").trim();
                    if (res.ok && text) {
                        submitText(text);
                    } else {
                        appendSystemLog(body?.error?.message ?? "没有听清，请再试一次");
                    }
                } catch {
                    appendSystemLog("语音服务未连接（localhost:8787），可继续使用文字指令");
                }
            };
            micFinish = finish;
            cmdMic.addEventListener("pointerup", () => { void finish(); }, { once: true });
            cmdMic.addEventListener("pointerleave", () => { void finish(); }, { once: true });
        } catch {
            appendSystemLog("无法访问麦克风：请检查浏览器权限");
        } finally {
            micStarting = false;
        }
    }
    cmdMic.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        void startMicCapture();
    });
    cmdMic.addEventListener("contextmenu", (e) => e.preventDefault());

    // 悬浮球快速双击：第一次双击开始语音输入（顺带展开面板看结果），录音中再次双击结束并发送
    aiOrb.addEventListener("dblclick", () => {
        if (suppressOrbClick) { suppressOrbClick = false; return; }
        if (orbClickTimer !== null) { clearTimeout(orbClickTimer); orbClickTimer = null; } // 吞掉第一次 click 的面板开合
        if (micRecording) { void micFinish?.(); return; }
        if (micStarting) return; // 建立麦克风中：这次"停止"到达过早，忽略（用户可稍后再双击）
        void startMicCapture(); // 只开语音，不弹对话框（结果靠语音播报，面板可手动点开）
    });

    // 快捷指令 chips：直接发送（面板未展开时顺手展开）
    document.querySelectorAll<HTMLButtonElement>("#ai-quick button[data-q]").forEach((btn) => {
        btn.addEventListener("click", () => {
            if (!aiOpen) openPanel();
            submitText(btn.dataset.q ?? "");
        });
    });

    // ==================== 点击设备标记弹信息卡（气泡） ====================

    const pickHandler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    pickHandler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
        const picked = viewer.scene.pick(e.position) as { primitive?: unknown; id?: unknown } | undefined;
        if (!picked) return;
        let t: HydroUnit | undefined;
        if (picked.id instanceof Entity) t = markerToUnit.get(picked.id);
        if (t) { addFocusRing(t); showAssetCard(t); }
    }, ScreenSpaceEventType.LEFT_CLICK);

    // ==================== 主循环 ====================

    let lastTick = performance.now();
    viewer.scene.preUpdate.addEventListener(() => {
        player.update();
        const now = performance.now();
        const dt = Math.min(0.05, Math.max(0.001, (now - lastTick) / 1000));
        lastTick = now;
        // 脉冲高亮动画（每帧单点计算，供两个 CallbackProperty 读取）
        ringRadius = 14 + 5 * (0.5 + 0.5 * Math.sin(now / 280));
        bearingRadius = 6 + 3 * (0.5 + 0.5 * Math.sin(now / 240));
        executor.tick(dt);
    });

    console.info(`[hydro] 场景就绪：${damFixture.name}（${damFixture.sceneId}@${damFixture.sceneRevision}），${damFixture.units.length} 台设备已登记`);
    console.info("[hydro] 键位：WASD 移动 / Shift 冲刺 / Space 跳跃 / F 飞行 / V 视角");
}

main().catch((e) => {
    console.error("初始化失败:", e);
    appendSystemLog(`初始化失败：${e instanceof Error ? e.message : String(e)}`);
});
