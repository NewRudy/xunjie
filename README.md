# 巡界 XUNJIE · 设备超级巡检人

贵客松赛道二「传统行业 AI 解决方案」之 AI × 能源（新能源场站运维）可运行 Demo。

运维人员用自然语言下达任务后，巡界会汇集异常、设备、空间、环境和 SOP 上下文，提出可追溯的现场检查建议；经用户授权，数字运维员在 Cesium 数字现场完成定位、巡检、取证和维修推演，最后生成闭环回执。

当前首版只打透一条光伏链路：

```text
ANOM-DEMO-01
  → STR-B2-07 / INV-B-02
  → CP-B02-FRONT
  → CP-B02-ROOF
  → photo / thermal / reading 仿真证据
  → 人工确认
  → TASK-DEMO-01 + anomaly resolved
```

## 快速启动

打开两个终端：

```bash
# 在仓库根目录分别打开两个终端
# 终端 1：后端确定性引擎与 MissionRuntime
cd engine
pnpm install
pnpm dev

# 终端 2：Vue 3 + CesiumJS 数字现场
cd web
pnpm install
pnpm dev
```

浏览器打开 [http://localhost:5173/](http://localhost:5173/)。后端默认监听 `http://localhost:8787`。

如果依赖已经安装，直接执行两条 `pnpm dev` 即可。演示数据需要手动复位时：

```bash
curl -X POST http://localhost:8787/api/debug/reset
```

语言任务入口会在每次“检查 B2 屋顶异常”前自动复位 Demo，无需现场手动调用该接口。

## 四句话跑通主链

在左侧“文字控制数字运维员”输入框依次输入：

1. `检查 B2 屋顶异常`
2. `我同意`
3. 人物到达屋面、任务显示“待证据”后：`采集证据`
4. 任务显示“待确认”后：`我同意`

最终应看到：绿色闭环回执、3 件证据、工单与异常均为 `resolved`、完成时间、闭环时累计损失（`SIMULATED`）及来源，右侧 `STR-B2-07` 设备卡由“故障”恢复为“正常”。

维修 wow moment 可单独输入：

```text
飞到 B2 逆变器维修 7 号异常组串
```

后端会签发 `navigate → focus_asset → repair_simulation` 三个受控命令，前端连续展示飞行定位、报警高亮、部件展开、维修进度和恢复。该过程是数字现场仿真，不写真实设备。

## AI 与确定性程序的边界

- 大模型适配器负责理解文字任务、把人物意图编排成受控高层命令，并选择高信号上下文提出计划；模型输出必须经过已登记语义 ID、能力、证据和安全规则校验。
- 路线、人物动作、任务状态、审批绑定、证据门槛和业务数字由确定性程序负责。模型不能逐帧控制人物，也不能直接写真实设备。
- 审批绑定 `approvalId + contextVersion + planHash`；上下文变化、审批过期或证据不足时不能沿用“同意”。
- 未配置模型凭据时，页面明确显示“模型不可用 · 确定性回退”。这不是在线 LLM 输出，但主链仍可稳定演示。
- 文字对话是当前主入口。语音仅保留为折叠的后续适配层，不属于本轮完成条件；以后 ASR 仍复用同一文字解释接口。

### 可选：接入现场真实模型

后端已提供 OpenAI-compatible 适配器。若现场有 Kimi、智谱或其他兼容服务的临时凭据，可在启动后端的同一终端设置：

```bash
export AGENT_LLM_API_KEY='<临时密钥>'
export AGENT_LLM_BASE_URL='<OpenAI-compatible API 根地址>'
export AGENT_LLM_MODEL='<模型 ID>'
pnpm dev
```

人物命令和任务提案都要通过语义 ID、数字溯源、证据和动作白名单校验；调用失败或校验不通过会显式回退。人物面板会独立显示本轮是“大模型”还是“确定性回退”。不要把密钥写入仓库、文档、日志或截图。当前仓库验收未使用用户模型凭据，因此默认截图是确定性回退态。

## 当前已实现

- Vue 3 + CesiumJS 程序化光伏园区，设备、异常、路线和检查点使用统一语义 ID。
- 实际接入 `cesium-player-controller@0.2.0` 与 Rapier，本地动画人物支持走、跑、飞、相对移动、转向、跳跃、停止和第三人称跟随；当前只加载最小地面碰撞，未接建筑/屋面/3D Tiles 工程碰撞体。
- 文字人物指令优先走 OpenAI-compatible 大模型并经过严格 JSON/命令白名单校验；无凭据或失败时如实标记确定性回退。
- 设备聚焦与维修仿真：报警脉冲、部件展开、进度和外观恢复。
- 任务上下文装配、结构化提案、绑定审批、SQLite 持久化、场景事件回流、证据门槛与闭环回执。
- 异常/设备/环境/SOP 四类研判卡及 `SIMULATED / MODELED / POLICY` 真值标签。
- 重复演示复位、设备卡/三维着色与后端闭环回执同步。

## 最小验证

```bash
cd engine
pnpm test:avatar   # 当前 86/86
pnpm test:avatar-llm # 当前 98/98（本地 mock，证明真实 HTTP 编排路径且不访问公网）
pnpm test:model-gateway # 当前 32/32（结构化输出网关：JSON 提取/GLM 解包/修复重试/错误分级）
pnpm test:dispatch # 当前 35/35（服务端编排：闭环命令、会话聚合、trace，拉起真实引擎）
pnpm test:evals    # 当前 40/40（确定性路由评测：39 条固定语料 + 跨场景泄漏检查）
pnpm test:agent    # 当前 72/72
npx tsc --noEmit

cd ../web
npx tsc --noEmit
```

最终浏览器验收应只跑一次主链，不在比赛现场执行长测试。

## 数据与真实性

- 场景坐标、设备运行、异常和证据是带标签的演示仿真；三维位置不是工程测量成果。
- 环境上下文来自公开天气接口并标为模型数据；SOP 标为政策/规则依据。
- 人物移动、取证和维修均不代表机器人或真实设备已执行物理操作。
- 真实 PoC 的第一步是接入一个场站的一类高频告警、匿名 SCADA/告警导出、资产映射、现行 SOP 和历史工单，再用研判耗时、无效派工率、证据完整率、响应/修复时间和闭环率验证价值。

人物模型许可与署名见 [`web/public/vendor/NOTICE.md`](web/public/vendor/NOTICE.md)。

## 关键文档

- [`SUBMISSION_ONE_PAGER.md`](SUBMISSION_ONE_PAGER.md)：一页作品说明。
- [`DEMO_SCRIPT_90S.md`](DEMO_SCRIPT_90S.md)：90 秒演示与故障兜底。
- [`NIGHT_RUN_PLAN.md`](NIGHT_RUN_PLAN.md)：本轮范围锁与验收检查点。
- [`PROJECT_MEMORY.md`](PROJECT_MEMORY.md)：项目重大决策与真实性边界。
- [`XUNJIE_PROJECT_BRIEF.md`](XUNJIE_PROJECT_BRIEF.md)：巡界产品定义。
- [`XUNJIE_AGENT_ORCHESTRATION.md`](XUNJIE_AGENT_ORCHESTRATION.md)：上下文与工作流设计。
- [`contracts/`](contracts/)：共同合同、fixture、状态机和验收矩阵。
