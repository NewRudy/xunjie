# 巡界 XUNJIE · 设备超级巡检人

贵客松赛道二「传统行业 AI 解决方案」之 AI × 能源（新能源场站运维）可运行 Demo。

运维人员用一句中文（文字或语音）下达任务，巡界汇集异常、设备、空间、环境和规程上下文，给出可追溯的检查建议；经用户授权，数字运维员在 Cesium 三维现场完成移动、定位、取证和维修推演，最后生成闭环回执。大模型负责理解与组织语言，路线、状态、审批与全部数字由确定性程序把关。

## 双场景与主链

- **风电场站（老鸦岭，WIND-FARM-01）**：沉浸式场景页。山地 3D Tiles + 10 台机组 + 第三人称数字运维员，支持文字/语音指挥移动、维修推演推演，以及「你是谁 / 当前啥场景 / 3 号风机什么状态 / 有啥巡检任务」等上下文问答（回答为口语化中文，自动语音播报）。
- **光伏园区（PECC-PARK-01）**：完整业务闭环链路（任务状态机、审批绑定、证据门槛、闭环回执），通过 `POST /api/agent/avatar/dispatch` 服务端编排驱动：

```text
检查 B2 屋顶异常 →（服务端：复位 + 建任务 + 提案，等待批准）
我同意          →（审批四重绑定，签发聚焦/导航命令，创建巡检工单）
采集证据        →（photo/thermal/reading；过早取证自动暂存，缺屋面证据保持阻塞）
我同意          →（闭环回执：工单 resolved、证据、时间、累计损失及来源固化）
```

场景以「场景包」数据登记（`contracts/scene-package.md`）：对象、别名、风险、状态说明、规格、检查点全部数据化——换场景 = 换数据，问答与导航代码不变。

## 快速启动

```bash
# 终端 1：后端确定性引擎 + Agent 编排（:8787）
cd engine
pnpm install
pnpm dev

# 终端 2：沉浸式前端（player-demo 多页站点）
cd player-demo
npm install
npm run dev
```

浏览器打开风电场景页（vite 输出的 `/cesium-player-controller/wind/`，默认端口见终端输出，当前为 5210）。右下角悬浮球打开「巡界 AI 助手」面板，文字输入或按住麦克风说话；WASD/Shift/Space/F/V 可手动控制人物。

演示数据自动复位；需要手动复位时：`curl -X POST http://localhost:8787/api/debug/reset`。

> 旧版 Vue 演示面板（`web/`）保留为光伏闭环的可视化参考，不再是主前端，后续由 player-demo 光伏页替代。

## AI 与确定性程序的边界

- 大模型适配器（OpenAI-compatible）负责任务理解、意图编排与回答组织；模型输出必须通过语义 ID、能力目录、证据门槛和安全白名单校验，人物路径校验失败单次即回退，提案路径带一次修复重试。
- 路线、人物动作、任务状态、审批绑定、证据门槛和业务数字由确定性程序负责；模型不能逐帧控制人物、不能生成数字、不能绕过授权。
- 问答三层：确定性门控（身份/场景/任务/对象，零延迟零token）→ 事实托底 LLM（门控没接住的问句，把场景包事实喂给模型组织语言，回答不得含 ID、数字必须逐字来自事实）→ 软化澄清（引导可问的问题）。
- 审批绑定 `approvalId + contextVersion + planHash + TTL`；上下文变化或证据不足时旧授权自动作废。
- 语音播报规则：业务/场景问答才播报，操作数字人的执行确认静默（画面已反馈）。

### 可选：接入现场真实模型

后端已提供 OpenAI-compatible 适配器。若现场有 Kimi、智谱或其他兼容服务的临时凭据，可在启动后端的同一终端设置：

```bash
export AGENT_LLM_API_KEY='<临时密钥>'
export AGENT_LLM_BASE_URL='<OpenAI-compatible API 根地址>'
export AGENT_LLM_MODEL='<模型 ID>'
pnpm dev
```

人物命令和任务提案都要通过语义 ID、数字溯源、证据和动作白名单校验；调用失败或校验不通过会显式回退。面板会独立显示本轮是「大模型」还是「确定性回退」。不要把密钥写入仓库、文档、日志或截图。

### 可选：语音输入（豆包 ASR）

场景页 AI 面板的麦克风按钮为「按住说话」。协议移植自管网智能体（pipe-report-agent），需要豆包语音凭据：

```bash
export DOUBAO_ASR_RESOURCE_ID='<豆包 ASR resource id>'
export DOUBAO_ASR_API_KEY='<X-Api-Key>'            # 或 APP_KEY/ACCESS_KEY 二元组
# 可选：DOUBAO_ASR_ENDPOINT / DOUBAO_ASR_HOTWORD_TABLE_ID / DOUBAO_ASR_CORRECT_TABLE_ID
pnpm dev
```

未配置时接口返回 `VOICE_NOT_CONFIGURED`，页面提示改用文字指令，主链不受影响。回复播报使用浏览器本地 TTS。

## 当前已实现

- **风电沉浸式场景页**（player-demo/example/wind）：山地 3D Tiles + glTF 机组 + GPU 风场流线，人物走/跑/飞/跳跃/转向/第三人称跟随（`cesium-player-controller@0.2.0` + Rapier）；语言指令不切换人物形态。
- **双场景统一解析**：光伏/风电命令词表、简式运动（上/下/左/右/前/后 + 距离）、飞行动词（起飞/降落/悬停）、转向约定与渲染器一致；确定性解析优先，大模型输出过能力目录白名单校验，失败显式回退。
- **服务端受控编排**（dispatch）：闭环命令服务端执行（复位+建任务原子化、审批服务端绑定、证据状态机裁决），会话轮次记忆、逐节点 trace 入库并随响应返回。
- **上下文问答**：身份/场景/任务/对象（状态·参数·位置）人话回答（无 ID、数字可溯源），支持「它」指代；对象属性来自场景包注册表。
- **语音输入**：豆包 Seed ASR（协议移植自管网智能体），按住说话；播报规则按回复类型自动区分。
- **光伏业务闭环**：MissionRuntime 十阶段状态机、审批四重绑定、SQLite 持久化与重启恢复、证据门槛、闭环回执。
- **质量防线**：7 个测试套件全部本地化（不访问公网），含路由评测语料与「回答不带 ID」回归断言。

## 最小验证

```bash
cd engine
pnpm test:avatar        # 110/110（确定性解析：两场景词表、简式运动、钳制与澄清）
pnpm test:avatar-llm    # 98/98（LLM 编排路径，本地 mock 不访问公网）
pnpm test:model-gateway # 32/32（结构化网关：提取/GLM 解包/修复重试/错误分级）
pnpm test:dispatch      # 56/56（服务端编排：闭环、问答、会话、trace，拉起真实引擎）
pnpm test:evals         # 40/40（确定性路由评测：39 条语料 + 跨场景泄漏）
pnpm test:voice         # 14/14（豆包 ASR 协议：帧打包/解析/文本提取/未配置守卫）
pnpm test:agent         # 72/72（MissionRuntime 回放与重启恢复）
npx tsc --noEmit

cd ../player-demo
npx tsc -p example/tsconfig.json --noEmit
```

最终浏览器验收只跑一次主链，不在比赛现场执行长测试。

## 数据与真实性

- 场景坐标、设备运行、异常、机组状态和证据是带标签的演示仿真；三维位置不是工程测量成果。
- 环境上下文来自公开天气接口并标为模型数据；SOP 标为政策/规则依据。
- 人物移动、取证和维修均为数字现场仿真，不代表机器人或真实设备已执行物理操作。
- 真实 PoC 的第一步是接入一个场站的一类高频告警、匿名 SCADA/告警导出、资产映射、现行 SOP 和历史工单，再用研判耗时、无效派工率、证据完整率、响应/修复时间和闭环率验证价值。

模型与资产署名：风机/山体模型与人物模型许可见 `player-demo/example/public/wind/farm.json` 的 credits 与各场景页页脚。

## 关键文档

- [`SUBMISSION_ONE_PAGER.md`](SUBMISSION_ONE_PAGER.md)：一页作品说明。
- [`DEMO_SCRIPT_90S.md`](DEMO_SCRIPT_90S.md)：演示脚本（已按新前端更新）。
- [`contracts/scene-package.md`](contracts/scene-package.md)：场景包契约（换场景不换大脑）。
- [`contracts/avatar-command.md`](contracts/avatar-command.md)：人物命令合同（含 dispatch 编排 §10、风电 §9）。
- [`PROJECT_MEMORY.md`](PROJECT_MEMORY.md)：项目重大决策与真实性边界。
- [`XUNJIE_PROJECT_BRIEF.md`](XUNJIE_PROJECT_BRIEF.md)：巡界产品定义。
- [`XUNJIE_AGENT_ORCHESTRATION.md`](XUNJIE_AGENT_ORCHESTRATION.md)：上下文与工作流设计。
- [`TEAM_PPT_BRIEF.md`](TEAM_PPT_BRIEF.md) / [`PPT_CONTENT.md`](PPT_CONTENT.md)：汇报材料素材与 PPT 内容成稿。
- [`contracts/`](contracts/)：共同合同、fixture、状态机和验收矩阵。
