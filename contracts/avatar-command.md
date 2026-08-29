# 巡界数字运维员指令合同（Demo v1.1）

本合同冻结“文字对话 → 大模型解释/编排 → 受控数字人动作 → `cesium-player-controller` 执行”的第一版真实链路。后续语音识别只负责把语音转成 `text`，继续调用同一接口，不改变动作执行链。

## 0. 当前优先级（2026-08-29 用户纠偏）

- 主前端为 player-demo 沉浸式场景页（AI 面板为指挥入口）；旧 web/ Vue 面板保留为光伏闭环可视化参考。
- 语音输入（豆包 ASR）已实现为可选适配层（见 §7），未配置凭据时回落文字入口，不改变动作执行链。
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

响应 `truth` 必须是 `SIMULATED`（真值标签只在该字段承载；2026-08-29 起响应不再附带「仅数字现场仿真」免责 warnings 文案）。无法唯一理解时返回 `400 CLARIFICATION_NEEDED`，不猜目标。

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

- `distanceMeters` 默认 10，服务端钳制到 `1..2000`（说了多少用多少；适配风电大尺度场景）。
- `turn.degrees` 只允许 `-180..180`；符号约定与人物渲染器一致（`addYaw` 顺时针为正）：**左转 = 负角度、右转 = 正角度**（如「左转 90 度」→ `-90`）。
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

## 7. 语音链路（2026-08-29 更新：输入侧已实现）

**输入侧（已实现）**：豆包 Seed ASR（协议移植自 pipe-report-agent）——前端按住说话采集 PCM 16k，上传 `POST /api/agent/voice/asr` 得到转写文本，随后走 dispatch 同一文字链路；凭据走 `DOUBAO_ASR_*` 环境变量，未配置返回 503 并提示文字指令。ASR 结果不得直接调用 Cesium 或绕过审批。

**输出侧**：浏览器本地 `speechSynthesis`（`zh-CN`）播报，规则为——问答类响应（`data.sceneBrief` 存在：身份/场景/任务/对象/事实托底）播报 `reply`；操作数字人的执行确认静默（画面已反馈）；澄清引导播报。不联网、不调用云端 TTS；提供明显开关并如实标注「浏览器本地 TTS」。播报内容仅以合同接口的响应为源，不得合成接口之外的承诺性话术。

## 8. 任务闭环语言验收

1. “检查 B2 屋顶异常”创建现有异常任务并显示上下文与建议。
2. “我同意”只批准当前唯一且未过期的提案，数字人按后端高层命令前往楼前和屋面。
3. 到达屋面后说“采集证据”，提交 fixture 约定的 photo/thermal/reading 仿真证据。
4. 再说“我同意”，使用新的闭环审批绑定完成任务；最终状态为 `resolved`。
5. 任一步骤缺少任务、检查点或待审批项时，界面给出明确原因，不猜、不静默跳过。

## 9. 风电工程场景（WIND-FARM-01，2026-08-29 新增）

同一接口 `POST /api/agent/avatar/interpret` 按 `sceneId` 分流：`WIND-FARM-01` / `fixture-v1` 进入风电场景解析。受控命令集合与 §3 相同，仅登记目标不同。

### 9.1 单一事实源

`player-demo/example/public/wind/farm.json` 是风电场景的唯一事实源（场景包与语义同源）：engine 的 `src/agent/windFarm.ts` 只读它导出登记 ID 与标签，前端场景页读同一份文件摆放资产与解算坐标。坐标、偏移、风险等级改动只改 farm.json，两端不同步复制。

### 9.2 登记对象

- 运维点：`OPS-WIND-01`（navigate 目标）。
- 机组：`HS-WTG-01..10`（focus_asset 目标），每台对应塔下检查点 `CP-WT-01..10`（navigate 目标）。
- 维修对象：仅 `HS-WTG-07` 齿轮箱高速端轴承（`GB-HS-BEARING`）@ `CP-WT-07`，维修步骤 RS-1..RS-7 见 farm.json `repairTargets[0].steps`。
- 其他编号一律澄清，不猜。

### 9.3 v1 中文映射（风电）

- “飞到/去 N 号风机”（N=1..10）→ `navigate CP-WT-0N`；山地尺度大，未明说移动方式时默认 `fly`（与光伏默认 walk 不同）。
- “跑到 N 号风机” → `navigate CP-WT-0N run`。
- “查看/聚焦 N 号风机”（不含移动动词）→ `focus_asset HS-WTG-0N`，不触发导航。
- “回运维点” → `navigate OPS-WIND-01`（默认 fly）。
- “维修 7 号风机” → `navigate CP-WT-07` + `focus_asset HS-WTG-07` + `repair_simulation HS-WTG-07@CP-WT-07`。
- 通用动作（move_relative/turn/jump/stop）与 §3 一致。

### 9.4 边界

- `repair_simulation` 仅登记 `HS-WTG-07@CP-WT-07`；“维修 3 号风机”等 → 400 CLARIFICATION_NEEDED，示例给出风电可说集。
- 风电场景不支持任务闭环三意图（start_inspection/decide_pending/capture_evidence 仍属 PECC-PARK-01）；风电侧维修留痕由前端按 farm.json 步骤仿真，truth=SIMULATED。
- 资产许可：山体 CC-BY-4.0（Li Yanquan）、风机 CC-BY-4.0（Sket_h），署名见 farm.json `credits`，前端场景页须可见。

## 10. 服务端受控编排：`POST /api/agent/avatar/dispatch`（P1，2026-08-29）

与 `/avatar/interpret` 同一解释管线（LLM-first + 白名单校验 + 确定性回退，入参 `{ text, sceneId, sceneRevision, missionId?, reset? }`），差异在**执行权收归服务端**：

- 闭环命令（`start_inspection` / `decide_pending` / `capture_evidence`）由服务端直接执行，结果在 `data.dispatch[]`（每条 `{ kind, status: available|rejected, detail|{code,message} }`）：
  - `start_inspection`：演示复位（任务+异常+Agent 数据，与 `/api/debug/reset` 一致）+ 建任务**原子化**，重复演示不带脏状态；`reset:false` 可关。
  - `decide_pending`：服务端用当前 `pendingApproval` 补全 `approvalId/contextVersion/planHash` 四重绑定，语义与 `/missions/:id/approval` 完全一致；前端不再读取/回传审批三元组。无任务 → `NO_ACTIVE_MISSION`，无挂起审批 → `NO_PENDING_APPROVAL`。
  - `capture_evidence`：走既有状态机（过早取证自动暂存、缺 ROOF 证据保持阻塞）；`missionId` 缺省时取最近创建任务。
- 场景命令（navigate/focus_asset/repair_simulation/运动类）**原样透传**由前端执行（渲染层职责）；审批签发的 `pendingCommands` 仍随任务快照下发。
- **风电场景闭环命令显式拒绝**（`UNSUPPORTED_IN_SCENE`），场景命令不受影响。
- 响应顶层 `status`：`available` / `partial`（部分闭环被拒）/ `rejected`（全部闭环被拒）；澄清语义与 §2 相同（400 CLARIFICATION_NEEDED）。
- 本接口只加不减：`/avatar/interpret` 合同不变。验收套件 `pnpm test:dispatch`（56 项，真实 engine 实例；含上下文问答、会话聚合与 trace）。

### 10.1 会话与 trace（P2，2026-08-29）

- 入参可带 `conversationId`（缺省 `CONV-DEMO`）：轮次摘要（`agent_turns`）与逐节点 trace（`agent_trace`）按会话聚合入库。
- 最近 2 轮结构化摘要（仅 `text` + 命令 `kind/targetId`，**不含模型原文**）注入 LLM 解释 prompt；确定性回退路径不消费历史——无凭据时多轮指代（"再回来"一类）不生效，属已知边界。
- 响应携带 `conversationId` 与 `trace[]`（每节点 `{ label, status: ok|warn|error, durationMs, detail? }`，以「总计」收尾；detail 只给 planner.mode 或错误类型码，不含密钥/请求体）。
- 演示复位（`/api/debug/reset` 与 start_inspection 前置复位）同步清空会话轮次与 trace。
- 路由正确性另有离线评测守门：`pnpm test:evals`（39 条固定语料，覆盖双场景路由、未知澄清与跨场景泄漏；语料低于规模下限直接判失败）。
