# 巡界 Agent 编排与上下文工程基线

> 调研与决策日期：2026-08-28
>
> 用途：供 Kimi、Claude Code、智谱和 Codex 共同实现巡界。本文只冻结 Agent 编排、上下文、工具和验收边界；不替代 `contracts/` 中已有的场景、引擎和数据合同。
>
> 当前状态：架构基线，待在现有 PECC 场景上实现一条纵向切片。

## 0. 先给结论

巡界不应该是“把整个三维场景、所有传感器数据和全部历史聊天记录塞给大模型”，也不应该是“让大模型逐帧控制小人”。

巡界应采用：

```text
语音/文字任务或场站异常
        ↓
确定性目标解析与场景语义解析
        ↓
按事件装配最小高信号上下文
        ↓
大模型输出结构化研判/建议/高层计划
        ↓
能力目录 + 数据新鲜度 + 安全策略确定性校验
        ↓
需要授权？──是──> 持久化等待用户确认
        │                    ↓
        └────否────────> 高层工具执行
                              ↓
             场景事件/遥测/证据回流，重新装配上下文
                              ↓
                       闭环、升级或补证据
```

核心原则：

1. **运行时状态、任务状态和 LLM 上下文分离**。Cesium 的相机、人物坐标、动画帧属于运行时；任务阶段、审批、证据引用属于可持久化任务状态；每次模型调用的 prompt 是由状态按需生成的临时视图。
2. **场景上下文按语义事件注入，不按渲染帧注入**。场景进入、设备聚焦、到达检查点、部件聚焦、环境变化、证据提交才触发上下文刷新。
3. **模型只提出结构化计划，确定性程序负责事实、权限、路线、状态和副作用**。
4. **读操作可自动执行，改变任务状态、模拟检修或未来接入真实设备的动作必须经过明确授权**。
5. **首版使用一个受控编排器，不做多智能体群聊**。不同能源类型通过场景包和业务适配器提供能力，不通过多个 Agent 互相聊天解决问题。

## 1. 管网智能体中已经验证的可复用模式

当前权威管网代码位于 `/Users/rudy/Documents/work/14 管网平台出报告/pipe-report-agent`，其展示 worktree 位于 `/Users/rudy/Documents/work/14 管网平台出报告/pipe-report-agent-expo-ui`。我在展示 worktree 针对 Agent 图、上下文、持久化、数据查询和报告动作运行了 62 个相关测试，结果为 `62 passed`。

值得迁移到巡界的不是它的业务词表，而是以下结构：

| 管网实现 | 对巡界的启发 |
|---|---|
| `AgentRuntime.reply()` 是唯一业务入口 | 对外只暴露 `MissionRuntime.start/resume`，不要让前端直接拼 prompt 或直接调多个内部服务 |
| `load_context → interpret → reduce_scope → route → pipeline → finalize` 单图 | 巡界采用 `load_mission → resolve_target → gather_context → propose → validate → approve → execute → observe → close` |
| `CapabilityRegistry` 是能力、参数、可用性和帮助的单一来源 | 场景、设备、环境、证据和动作都登记到能力目录；模型不能自创动作或参数 |
| 模型产出结构化意图/任务片段，不产出 SQL、事实数字和设施 ID | 模型产出 `MissionProposal`；`assetId/componentId/checkpointId` 必须由场景语义目录核验 |
| `BusinessRequest → QueryRecipe → ResultBundle` | `MissionRequest → ContextBundle → ObservationBundle`；结果带来源、时间、可用性和截断/缺失状态 |
| `ConversationContext` 分离范围、任务、结果引用和最近压缩历史 | 巡界分离任务目标、当前聚焦设备、场景修订号、证据引用和少量对话摘要；不把聊天记录当现场事实 |
| checkpoint 支持重启恢复、会话隔离、过期和并发测试 | 审批等待、网络中断、到场后继续和跨天任务必须能恢复；状态中不能放密钥和不可序列化对象 |
| 结构化 `actions[]` 由确定性数据生成 | 场景动作由已核验的 ID 和能力生成；正文只负责解释，不让模型自由生成 `pipeId` 或坐标 |
| `available=false` 与“零条数据”严格区分 | 设备遥测、气象、历史工单不可用时显示“不可用/过期”，不能当作正常、零损失或无风险 |
| 62 个相关测试覆盖上下文引用、错误和持久化 | 巡界必须把事件序列、审批绕过、上下文泄漏、过期数据和非法状态迁移写成回放评测 |

管网智能体的边界也必须保留：它是“受控的业务查询/诊断助手”，不是实时具身执行器。它目前没有场景帧循环、可达性规划、设备模型节点控制和巡界任务的语义事件总线，不能直接当成巡界后端照搬。

## 2. 近期一手实践归纳

### 2.1 从 Prompt Engineering 转向 Context Engineering

Anthropic 在 2025 年的实践文章把重点从“写一个更长的系统提示”转向“每次推理前选择最有用的上下文”。它特别强调上下文会产生注意力稀释和 context rot，因此应保留高信号信息，采用 just-in-time retrieval、渐进披露、压缩和结构化笔记，而不是无差别塞入全部数据。[来源见文末]

对应巡界：场景本身只提供语义引用和能力索引；当模型需要逆变器详情、某段曲线、某个部件或 SOP 片段时，再通过受控工具取回。

### 2.2 Workflow 优先，Agent 只负责不确定的局部

Anthropic 的 Agent 设计建议是先从简单、透明、可测的工作流开始；LangGraph 的最新文档也把 workflow 定义为预定路径，把 agent 定义为由模型动态决定工具和过程。巡界的路线、检查点、状态迁移和证据门槛是预定的，只有“如何解释异常、选哪些已登记证据、是否提出补充建议”存在不确定性。

因此巡界应是**受控工作流中的模型决策节点**，而不是完全开放式 ReAct 循环。

### 2.3 本地运行上下文不等于 LLM 可见上下文

OpenAI Agents SDK 当前文档明确区分两类 context：应用代码和工具可以使用的 local context，以及模型真正看到的 Agent/LLM context。local context 不会自动发送给模型；要让模型看到数据，必须把它放入输入/指令、工具结果或检索结果中。[来源见文末]

这正是巡界最重要的设计点：**引擎可以持有完整场景状态，但不等于每次都把完整场景状态发给大模型。**

### 2.4 工具应面向任务，而不是机械包 API

Anthropic 的工具实践建议少做、做清楚、返回高信号结果，必要时把多个底层读取合并成一个面向任务的工具。例如巡界应优先提供 `get_asset_context`，而不是把“查设备名称、查当前值、查告警、查父节点、查子节点”暴露成五个相互竞争的小工具。

当工具数量很多时，可采用按需发现/延迟加载；当工具结果需要大量循环、聚合或过滤时，应让代码/确定性服务处理原始结果，只把最终摘要返回给模型。巡界首版工具数量较少，不必为了追新引入复杂 Tool Search；但必须贯彻“按场景/能力域加载”的原则。

### 2.5 审批是持久化工作流中断，不是聊天口头禅

LangGraph 的 `interrupt` 和 OpenAI Agents SDK 的 HITL 都采用“保存运行状态 → 返回待审批请求 → 用户 approve/reject/edit → 从原状态恢复”的方式。审批前后都应重新校验工具参数；中断前已经发生的副作用要幂等。

所以“我同意”不能仅靠一个正则直接推进任意动作。它只能在当前任务存在唯一、未过期、上下文版本匹配的待审批建议时解析为批准；产品上应优先使用带 `suggestionId` 的按钮或结构化语音确认。

### 2.6 数字孪生应是实体/组件/关系/场景的组合

AWS IoT TwinMaker 的实体-组件模型把静态属性、时序、告警、文档和关系挂在实体上，再通过 scene/tag 将实体绑定到三维场景；Cesium 3D Tiles 本身也支持多层级的 feature metadata。这个方向说明三维模型不是业务事实，**语义实体和数据绑定才是 Agent 能理解的世界模型**。

巡界的 `ScenePackage` 应继续保留：模型、碰撞、语义 ID、路线、检查点、环境、数据绑定和许可分层管理。

## 3. 巡界的三层状态

### 3.1 Scene Runtime State：高频、前端/引擎持有

包括人物/无人机位置、速度、朝向、相机、动画、碰撞、当前可见对象和 Cesium 资源加载状态。它每帧变化，**不进入 LLM 历史**。

高频控制只允许确定性控制器执行：`setInput`、跟随路线、飞行、碰撞和相机切换。LLM 只能发出 `navigate_to_checkpoint` 这类高层请求。

### 3.2 Mission State：低频、任务级、需要持久化

建议结构：

```text
MissionState
├── missionId / conversationId
├── sceneId / sceneRevision
├── objective / trigger / operator
├── phase
│   ├── created
│   ├── context-ready
│   ├── proposed
│   ├── awaiting-approval
│   ├── executing
│   ├── awaiting-evidence
│   ├── awaiting-confirmation
│   ├── resolved / escalated / cancelled
├── focus: assetId / componentId / checkpointId
├── plan: steps + status + planHash
├── pendingApproval: approvalId + contextVersion + expiresAt
├── observationRefs / evidenceRefs / sourceRefs
└── lastEvent / timestamps / warnings
```

这里保存结构化原始状态、引用和结果，不保存拼好的长 prompt，不保存模型隐式思维链，不保存密钥。

### 3.3 LLM Context：每次调用临时生成

由 `ContextAssembler` 根据当前事件、任务阶段、能力权限、上下文预算和数据新鲜度生成。调用结束后，保留结构化 `proposal`、`toolCall`、`observation` 和 `decision`，而不是无限追加完整消息。

每个上下文项建议带：

```text
key / scope / value
sourceRef / truth / observedAt / validUntil
confidence / availability / reasonIncluded
```

`reasonIncluded` 很重要：它让评委和后续运维人员知道“为什么这个气象值、这个部件或这段历史被送进了本轮判断”。

## 4. 哪些场景上下文自动输入

“自动输入”不是全部自动塞入，而是由场景事件触发一次**确定性上下文解析**，再将结果的最小摘要提供给模型。

| 触发事件 | 自动准备给模型的内容 | 数据来源 | 不自动塞入 |
|---|---|---|---|
| `mission_created` | 用户目标、异常来源、操作者/权限、sceneId、当前时间、当前任务阶段 | 前端请求、PECC/场景适配器 | 全部聊天历史、全站遥测 |
| `scene_entered` | 场景类型、坐标/修订号、可用能力、相关区域、附近已登记资产、禁入/危险区摘要 | `ScenePackage`、语义索引、路线图 | 3D Tiles 原始内容、mesh 顶点、所有设备 |
| `asset_focused` | 目标 `assetId`、设备类型、父子关系、空间位置、当前状态、最新告警、关键遥测摘要、相邻同类对比、可用 SOP 引用 | 资产目录、SCADA/时序、告警、SOP 索引 | 未聚合的长时序、无关设备、原始 SQL/全部日志 |
| `anomaly_detected/changed` | 异常类型、发现时间、异常强度、数据质量、相关设备链路、损失/影响的确定性计算、建议验证目标 | PECC 引擎、告警、数据质量服务 | 模型自行推算金额、未经核验的故障结论 |
| `approaching_checkpoint` | 路线摘要、可达性、入口/屋面限制、当前环境可作业性、该检查点证据清单 | 路网/碰撞、场景包、环境服务、任务合同 | 每一帧位置、完整地图、无关天气历史 |
| `component_focused` | 部件 ID、部件在 BOM/拓扑中的关系、可点选节点、该部件允许的检查项、异常绑定、拆解视图能力 | BIM/GLTF 语义映射、设备 BOM、能力目录 | 让模型直接猜 node name、旋转角或坐标 |
| `environment_changed` | 风雨、雷电、辐照、温度、能见度、屋面可作业判断及数据时点 | 气象/环境适配器、确定性规则 | 过期值当作当前值、模型凭常识补天气 |
| `evidence_captured` | 证据 ID、检查点、类型、采集时间、结构化读数、媒体引用、模型观察、缺失证据、允许的下一状态 | 证据存储、视觉模型、任务状态机 | 媒体字节无条件放入每轮上下文、把观测直接当正式故障 |
| `user_follow_up` | 当前任务阶段、当前聚焦对象、待确认建议、最近一轮摘要、必要的结果引用 | MissionState、短期对话摘要 | 无限历史消息 |

有三个硬规则：

1. **相机位置只能帮助候选解析，不能直接作为设备事实。** 必须先通过拾取/语义索引解析为已登记的 `assetId`。
2. **进入检查点后重新取上下文。** 不能把任务创建时的天气、告警和设备状态一直当作当前状态。
3. **数据不可用是状态，不是数值。** `unavailable`、`stale`、`partial` 必须进入 `ObservationBundle`，模型只能据此降低建议或请求补充。

## 5. 推荐工作流

### 5.1 一条主链

以现有光伏 `STR-B2-07` 异常为例：

```text
1. PECC 发现异常并计算确定性损失
2. 用户说“去看一下 B2 屋顶这个异常”
3. resolve_target：核验 STR-B2-07 → INV-B-02 → B02 屋顶检查点
4. gather_context：并行取设备、相邻组串、环境、空间、历史和 SOP 摘要
5. propose：模型返回研判、证据需求和高层计划（结构化 JSON）
6. validate：能力目录、数据时效、屋面作业规则、证据要求、状态迁移校验
7. await_approval：展示“为什么去、看什么、需要什么证据、影响是什么”
8. execute：调用场景导航/形态切换/聚焦设备；路线和动画由引擎执行
9. arrived_checkpoint：自动刷新本地环境和检查清单上下文
10. inspect：提交模拟热成像/读数/照片；视觉结果先是 observation/candidate
11. component_focus：打开设备拆解视图，高亮已核验部件和检查点
12. user_confirm：用户确认模拟处置；状态机推进并写入证据收据
13. verify：重新读取发电曲线/异常状态，确认恢复或升级处理
```

### 5.2 快循环与慢循环

```text
快循环（每帧/每次输入）：Cesium、碰撞、路线跟随、动画、相机
慢循环（语义事件）：任务理解、上下文检索、建议、审批、证据判断
```

LLM 不参与每帧 movement loop。这样既避免延迟和 token 浪费，也避免模型输出“看起来合理但无法执行”的逐帧动作。

### 5.3 审批对象

```json
{
  "approvalId": "APR-...",
  "missionId": "MIS-...",
  "suggestionId": "SUG-...",
  "contextVersion": "scene-12|asset-INV-B-02|env-2026-08-28T10:20",
  "requestedActions": ["navigate_to_checkpoint", "inspect_component"],
  "reason": "B2 屋顶异常需要现场证据，当前环境满足数字演示条件",
  "impact": "数字现场动作；不操作真实设备",
  "expiresAt": "..."
}
```

批准时必须匹配 `approvalId + contextVersion + planHash`。如果环境或告警发生变化，旧批准失效，系统重新取上下文并请求确认。

## 6. 工具边界

首版保持少量面向任务的高层工具：

| 工具 | 类型 | 返回重点 |
|---|---|---|
| `context.get_mission_snapshot` | 只读 | 当前任务、阶段、焦点、权限和待办 |
| `context.get_asset_context` | 只读 | 设备卡、关系、状态、关键遥测摘要、告警、来源和时点 |
| `context.get_environment_operability` | 只读 | 环境值、可作业判断、过期/不可用状态 |
| `context.get_related_assets` | 只读 | 父子设备、相邻同类、拓扑邻居和已登记检查点 |
| `sop.get_relevant_steps` | 只读 | 当前异常/部件对应的规程片段、版本和证据要求 |
| `scene.focus_asset` | 场景只读动作 | 由核验 ID 定位和高亮，不改变业务状态 |
| `scene.navigate_to_checkpoint` | 数字现场动作 | 返回路线 ID、到达事件或不可达原因；不接受逐帧按键 |
| `scene.switch_form` | 数字现场动作 | 只允许场景包登记的形态和能力组合 |
| `inspection.capture_evidence` | 证据动作 | 保存证据引用和结构化值，不由模型伪造媒体事实 |
| `inspection.evaluate_evidence` | 受控分析 | 返回 observation/candidate、置信度和证据引用 |
| `mission.advance` | 状态写入 | 只能走合同允许的状态迁移，非法迁移返回稳定错误 |
| `mission.close_or_escalate` | 状态写入 | 需满足证据和用户确认条件，幂等并生成收据 |

不得把下面这些暴露给大模型：

- `moveForward`、W/A/S/D、每帧速度和相机角度；
- 任意 `assetId/componentId` 创建、任意坐标、任意 GLTF 节点名；
- 任意 SQL、任意 HTTP URL、任意外部系统写接口；
- “清除告警”“修改保护定值”“远程启停”等真实高风险动作。

每个工具结果统一返回 `Observation` 风格：

```text
status: available | partial | stale | unavailable | rejected
data: 结构化结果
sourceRefs: 来源/接口/文档/计算引用
truth: MEASURED | MODELED | SIMULATED | POLICY
observedAt / validUntil
warnings / nextAllowedActions
```

## 7. 对当前项目的落地映射

现有项目的确定性基础继续保留：

- `engine/src/inspection.ts` 继续作为巡检任务执行内核；它已有幂等创建、非法迁移、屋面证据门槛和闭环后异常恢复。
- PECC 的损失、电价、发电/负荷、异常状态和 `assetId` 继续由引擎负责；模型不重算这些数字。
- `ScenePackage` 负责场景资源、语义、路线、检查点、环境和数据绑定。
- `cesium-player-controller` 只作为人物/飞行/碰撞/动画控制底座；Agent 通过适配器调用高层能力。

建议新增或冻结的合同文件：

```text
contracts/agent-context.md       上下文层级、事件、预算、时效和来源
contracts/agent-state.md         MissionState、阶段和审批对象
contracts/agent-tools.md         工具输入输出、权限和副作用等级
contracts/scene-events.md        Cesium → Agent 的语义事件桥
data/fixtures/agent-scenarios/   异常、环境、证据和用户确认回放样例
```

场景事件桥至少要能发送：

```text
scene_entered
asset_focused
component_focused
checkpoint_arrived
environment_changed
evidence_captured
navigation_failed
```

事件中传 `sceneId、sceneRevision、assetId/componentId/checkpointId、reason、clientTs`；相机和屏幕坐标只能作为辅助字段。事件桥不把完整 Cesium 对象、模型实例或大段 JSON 直接传给模型。

当前 TypeScript + Cesium 项目首版优先实现一个类型化 `MissionRuntime`/状态机，不为了“看起来像 Agent”立刻引入一套新的多智能体框架。若后续任务需要跨进程审批、长时间等待和恢复，再评估 JS/TS LangGraph 或其他持久化编排运行时；无论采用什么框架，以上状态与工具合同不变。

当前证据边界：PECC 的确定性引擎、`inspection.ts` 任务状态机、场景语义 ID 和管网智能体的受控编排模式已在本地代码/测试中存在；巡界的语义场景事件桥、真实 LLM 结构化输出、跨进程审批恢复、真实 SCADA/气象接入和现场作业安全规则尚未验证。后续演示只能把后者标为 `SIMULATED`、`MODELED` 或 `PROPOSED`，不能写成已落地生产能力。

## 8. 多模型协作边界

| 角色 | 允许负责 | 不允许独自改变 |
|---|---|---|
| Kimi | Cesium 场景、模型、人物控制、语义拾取和事件桥 | Agent 状态、审批语义、业务数字和工具合同 |
| Claude Code | `MissionRuntime`、ContextAssembler、工具适配器、回放测试 | 随意修改场景坐标、fixture 事实和公共 UI 合同 |
| 智谱/其他模型 | SOP/故障解释、模型能力对比、局部实现建议 | 未经评测的事实、动作和安全规则 |
| Codex/人工验收 | 合同、边界、跨模块验收、证据审查 | 不把模型自评当作通过证据 |

共享合同、fixture、状态机和验收矩阵冻结后再并行改代码。模型之间不直接共享隐藏对话；以仓库中的合同、测试和结构化产物作为唯一协作事实。

## 9. 必须先做的 Agent 评测

至少建立以下回放用例：

1. 明确设备任务：只读取目标设备及其必要邻居，不读取全站无关对象。
2. 只说“去看看”：先澄清目标或使用已存在的唯一异常，不猜设备 ID。
3. 设备告警 + 环境不适合作业：提出等待/远程观察建议，不进入屋面执行。
4. 环境数据过期：标记 `stale`，重新查询或请求确认，不按旧天气执行。
5. 用户批准后告警已变化：旧 `contextVersion` 失效，必须重新研判。
6. 未批准直接要求模拟检修：状态机拒绝，不能靠自然语言绕过审批。
7. 到达屋面但缺少 ROOF 证据：不能闭环，提示缺失证据。
8. 视觉模型给出候选：显示 observation/candidate，不直接写成正式故障。
9. LLM 不可用：可继续执行确定性导航/固定检查清单，但不能编造诊断结论。
10. 场景事件重复或网络重试：动作和状态迁移幂等，不重复创建任务或证据。

发布门槛不只看“模型答得像不像”，还要记录：

- 上下文命中率与无关上下文比例；
- 未核验 ID/数字/动作的逃逸率，目标为 0；
- 审批绕过率，目标为 0；
- 工具选择和参数校验通过率；
- 从异常到形成可执行任务的时间；
- 首次证据完整率、无效到场率、闭环耗时；
- token、模型调用次数、场景事件到响应延迟；
- 进程重启、网络中断和数据源不可用后的恢复行为。

## 10. 研究来源

- Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), 2025-09-29：上下文预算、context rot、just-in-time retrieval、渐进披露、压缩和结构化笔记。
- Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)：工作流/Agent 取舍、简单性、透明计划和 ACI 工具设计。
- Anthropic, [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)：面向任务设计少量高信号工具，减少中间结果污染。
- Anthropic, [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)：工具按需发现、延迟加载和程序化编排的适用边界。
- LangChain, [Thinking in LangGraph](https://docs.langchain.com/oss/python/langgraph/thinking-in-langgraph)：离散节点、raw state、按需格式化 prompt、错误和中断进入工作流。
- LangChain, [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) 与 [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)：checkpoint、短期线程状态、持久化恢复和人工审批。
- OpenAI Agents SDK, [Context management](https://openai.github.io/openai-agents-python/context/)：local context 与 LLM context 的区别、动态能力过滤和工具侧授权。
- OpenAI Agents SDK, [Human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)：审批、拒绝、序列化运行状态和恢复。
- Model Context Protocol, [Specification](https://modelcontextprotocol.io/specification/latest)：资源、提示、工具和可组合上下文的标准化边界；MCP 是连接协议，不替代巡界任务状态机和安全策略。
- AWS, [What is AWS IoT TwinMaker](https://docs.aws.amazon.com/iot-twinmaker/latest/guide/what-is-twinmaker.html)：实体、组件、关系、时序、告警、文档和三维场景绑定的工业数字孪生参考模式。
- CesiumGS, [3D Tiles Metadata Semantics](https://github.com/CesiumGS/3d-tiles/blob/main/specification/Metadata/Semantics/README.adoc)：三维内容多层级元数据和语义 ID 的开放规范参考。

以上资料用于架构参考，不代表巡界已经完成真实场站接入或现场安全认证。
