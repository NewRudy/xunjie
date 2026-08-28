# 巡界场景事件桥合同

> Cesium/cesium-player-controller 是执行层；本事件桥把场景中的语义事实发送给 Agent。控制器不直接理解业务状态，Agent 不直接操纵逐帧按键。

## 1. 事件包

~~~ts
type SceneEventType =
  | 'scene_entered'
  | 'asset_focused'
  | 'component_focused'
  | 'checkpoint_arrived'
  | 'environment_changed'
  | 'evidence_captured'
  | 'navigation_failed'

interface SceneEvent {
  eventId: string
  idempotencyKey: string
  missionId: string
  type: SceneEventType
  sceneId: string
  sceneRevision: string
  assetId?: string
  componentId?: string
  checkpointId?: string
 reason: string
 clientTs: string
 payload?: Record<string, unknown>
  evidence?: EvidenceInput | EvidenceInput[] // evidence_captured 时位于事件顶层，由引擎统一写入并标 SIMULATED
}

interface EvidenceInput {
  checkpointId?: string
  kind?: 'photo' | 'thermal' | 'reading' | 'note'
  value?: string
  ts?: string
}
~~~

相机位置、屏幕坐标、当前动画等只能放在 payload.debug，不能代替 assetId/checkpointId。所有语义 ID 必须来自 data/fixtures/park-pecc-01.json 和 contracts/semantic-tree.md。

## 2. 后端命令

~~~ts
type SceneCommandKind = 'focus_asset' | 'navigate_to_checkpoint' | 'switch_form' | 'show_component'

interface SceneCommand {
  commandId: string
  missionId: string
  kind: SceneCommandKind
  targetId: string
  issuedAt: string
  reason: string
}
~~~

首版允许：

- focus_asset：高亮已核验资产并打开语义卡；
- navigate_to_checkpoint：沿 fixture 的道路折线行走/飞行到检查点；
- switch_form：仅切换已登记数字形态，不宣称真实机器人具备该能力；
- show_component：高亮已登记部件或显示拆解视图。

禁止返回 W/A/S/D、每帧速度、任意欧拉角、任意坐标和任意 GLTF 节点名。

## 3. 到达和失败语义

- 前端只有在控制器真正到达登记检查点后才发送 checkpoint_arrived；开始移动不能冒充到达。
- navigation_failed 必须带 reason 和可选的替代检查点；后端进入 blocked/重新提案，不自动跳过安全约束。
- 事件重复必须幂等；断线重试不重复推进巡检状态。
- 现场动作均为本地数字演示。没有真实机器人、SCADA 或远程控制接入时，UI 必须明确“数字现场/仿真动作”。
