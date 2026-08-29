# 巡界数字运维员指令合同（Demo v1.1）

本合同冻结“文字对话 → 大模型解释/编排 → 受控数字人动作 → `cesium-player-controller` 执行”的第一版真实链路。后续语音识别只负责把语音转成 `text`，继续调用同一接口，不改变动作执行链。

## 0. 当前优先级（2026-08-29 用户纠偏）

- 当前主入口是文字对话框；语音不作为本轮完成条件。
- 前端人物主执行器必须实际初始化并调用 npm 包 `cesium-player-controller`，不能只保留一个未来适配器接口。
- 配置 `AGENT_LLM_API_KEY` 时，`POST /api/agent/avatar/interpret` 必须真实调用 OpenAI-compatible 模型（Kimi/智谱均可），再把模型 JSON 经过确定性白名单校验后返回。
- 未配置凭据或模型失败时可回退现有确定性中文解析，但响应和界面必须明确显示 `deterministic-fallback`，不得伪称“大模型正在控制”。

## 1. 产品边界

- 目标：让观众输入一句自然语言，立即看到一个**可辨认的数字运维员**在工程场景内移动，并能完成一次设备维修仿真。
- 本版只控制数字孪生中的人物、镜头与仿真效果，不连接机器人、SCADA 或真实设备。
- 所有位置必须来自 fixture 登记对象，或是相对当前位置的有界移动；后端不得返回任意脚本、Cesium API 或未经登记的世界坐标。
- “维修”只表示 `SIMULATED` 数字现场演示：定位异常部件、拆解/高亮、维修进度、恢复外观。不得宣称真实消缺。
- 大模型只输出本合同第 3 节的高层命令；`cesium-player-controller` 只负责人物运动、动画、视角与基础物理，不理解业务 ID、审批或任务状态。

## 2. HTTP 接口

`POST /api/agent/avatar/interpret`

请求：

```json
{
  "text": "飞到 B2 屋顶维修 7 号异常组串",
  "sceneId": "PECC-PARK-01",
  "sceneRevision": "fixture-v1"
}
```

成功响应继续使用项目统一结果外壳，`data` 为：

```json
{
  "normalizedText": "飞到 B2 屋顶维修 7 号异常组串",
  "reply": "收到，飞往 B2 屋顶并执行 7 号组串维修仿真。",
  "commands": [
    {
      "commandId": "avatar-...-1",
      "kind": "navigate",
      "targetId": "CP-B02-ROOF",
      "movement": "fly"
    },
    {
      "commandId": "avatar-...-2",
      "kind": "repair_simulation",
      "targetId": "STR-B2-07",
      "checkpointId": "CP-INV-B02"
    }
  ]
}
```

响应 `truth` 必须是 `SIMULATED`，并在 `warnings` 中明确“仅数字现场仿真”。无法唯一理解时返回 `400 CLARIFICATION_NEEDED`，不猜目标。

成功响应顶层 `planner` 必须如实标明本轮解释来源：模型校验通过时为 `{ "mode": "llm", "modelAvailable": true }`；模型未配置、调用失败或输出校验失败时为 `deterministic-fallback` 并给出不含密钥/请求正文的 `reason`。

## 3. 受控命令集合

```ts
type AvatarCommand =
  | { commandId: string; kind: 'navigate'; targetId: 'OPS-01' | 'CP-B02-FRONT' | 'CP-B02-ROOF' | 'CP-INV-B02'; movement: 'walk' | 'run' | 'fly' }
  | { commandId: string; kind: 'move_relative'; direction: 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down'; distanceMeters: number; movement: 'walk' | 'run' | 'fly' }
  | { commandId: string; kind: 'turn'; degrees: number }
  | { commandId: string; kind: 'jump' }
  | { commandId: string; kind: 'stop' }
  | { commandId: string; kind: 'focus_asset'; targetId: 'STR-B2-07' | 'INV-B-02' }
  | { commandId: string; kind: 'repair_simulation'; targetId: 'STR-B2-07'; checkpointId: 'CP-INV-B02' }
  | { commandId: string; kind: 'start_inspection'; anomalyId: 'ANOM-DEMO-01' }
  | { commandId: string; kind: 'decide_pending'; decision: 'approve' | 'reject' }
  | { commandId: string; kind: 'capture_evidence'; evidenceKinds: ['photo', 'thermal', 'reading'] };
```

约束：

- `distanceMeters` 默认 10，服务端钳制到 `1..50`。
- `turn.degrees` 只允许 `-180..180`。
- `up/down` 必须使用 `movement: 'fly'`。
- 新指令可以中断当前纯数字移动；`stop` 立即停止。
- `repair_simulation` 必须确认人物已在目标检查点附近；否则前端先自动导航到 `checkpointId`。
- `start_inspection` 只允许启动 fixture 登记的 `ANOM-DEMO-01`，由前端调用既有 `/missions`，不得在 avatar 接口内另造任务状态。
- `decide_pending` 只是语言意图，前端必须读取当前唯一的 `pendingApproval`，继续调用既有审批接口并携带 `approvalId + contextVersion + planHash`；没有待审批项时拒绝执行。
- `capture_evidence` 继续调用既有证据事件；人物未到屋面检查点或任务阶段不允许时拒绝执行。
- 任务闭环已有 `/missions` 与审批接口保持不变；本接口是展厅演示控制面，不篡改 MissionState。

## 4. v1 中文映射

- “走到/去 B2 楼前” → `navigate CP-B02-FRONT walk`
- “跑到 B2 楼前” → `navigate CP-B02-FRONT run`
- “飞到/上 B2 屋顶” → `navigate CP-B02-ROOF fly`
- “去 B2 逆变器” → `navigate CP-INV-B02 walk`
- “回运维点” → `navigate OPS-01 walk`
- “向前/后/左/右走 10 米” → `move_relative`
- “上升/下降 10 米” → `move_relative up/down fly`
- “左转/右转 90 度” → `turn`
- “跳一下” → `jump`
- “停下” → `stop`
- “维修/修复 7 号异常组串” → `navigate CP-INV-B02`（若尚未到位）+ `focus_asset STR-B2-07` + `repair_simulation STR-B2-07`
- “检查/巡检 B2 屋顶异常” → `start_inspection ANOM-DEMO-01`
- “我同意/批准” → `decide_pending approve`
- “我不同意/拒绝” → `decide_pending reject`
- “采集/提交证据” → `capture_evidence photo+thermal+reading`

## 5. 前端可见验收

只验一条主路径：

1. 页面出现可辨认的数字运维员，而不是单个点；界面可见执行器为 `cesium-player-controller`，代码依赖与运行时初始化均可核查。
2. 输入“跑到 B2 楼前”，人物沿登记道路快速移动并显示 `RUN`。
3. 输入“飞到 B2 屋顶”，人物抬升飞到屋面并显示 `FLY`。
4. 输入“维修 7 号异常组串”，人物到设备附近，场景聚焦 `STR-B2-07`，展示部件拆解/报警高亮、维修进度、恢复完成。
5. 输入“停下”可中断正在进行的移动。
6. 文字对话框显示本轮是“大模型解释”还是“确定性回退”；不能用任务提案的模型状态冒充人物指令解释状态。

## 6. `cesium-player-controller` 执行边界

- 使用 `playerController.init({ viewer, initPos, playerModelConfig, ... })` 建立人物，并在 Cesium 帧循环中调用 `update()`。
- 手工键鼠与程序动作统一走控制器公开能力，如 `setInput`、`reset`、`changeView`、`getPosition`、`getIsFlying` 和动画接口；高层导航仍只能使用 fixture 登记路线/检查点。
- 本轮可不构建完整 3D Tiles 静态碰撞体，但必须保留基础胶囊体/重力/人物动画和第一、第三人称能力；不得把“未接碰撞源”表述成工程级碰撞或寻路。
- 维修拆解与业务状态仍由现有确定性仿真层负责，不让人物控制器直接写任务状态。

## 7. 语音后接方式（本轮后置）

浏览器按住说话或服务端 ASR 得到最终转写后，只调用 `POST /api/agent/avatar/interpret`。因此本版文字入口就是语音链路除 ASR 外的完整可测替身。

浏览器首版采用 Web Speech API（`zh-CN`）作为可选适配层：必须由用户点击后启动，显示听写状态和最终转写；浏览器不支持或权限失败时明确提示并保留文字输入。ASR 结果不得直接调用 Cesium 或绕过审批，仍先进入本合同的解释接口。

## 8. 任务闭环语言验收

1. “检查 B2 屋顶异常”创建现有异常任务并显示上下文与建议。
2. “我同意”只批准当前唯一且未过期的提案，数字人按后端高层命令前往楼前和屋面。
3. 到达屋面后说“采集证据”，提交 fixture 约定的 photo/thermal/reading 仿真证据。
4. 再说“我同意”，使用新的闭环审批绑定完成任务；最终状态为 `resolved`。
5. 任一步骤缺少任务、检查点或待审批项时，界面给出明确原因，不猜、不静默跳过。
