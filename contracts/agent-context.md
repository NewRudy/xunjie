# 巡界 Agent 上下文合同

> 本文件定义“场景/设备/环境/任务信息如何进入模型”。前端、引擎和模型适配器都必须遵守；它不是把整个三维场景序列化给大模型的许可。

## 1. 三层边界

| 层 | 持有者 | 进入模型？ | 内容 |
|---|---|---|---|
| SceneRuntimeState | Cesium/人物控制器 | 否 | 每帧位置、速度、朝向、相机、碰撞、动画、资源加载 |
| MissionState | 引擎/SQLite | 按需摘要 | 任务目标、阶段、焦点、计划、审批、证据引用、最近事件 |
| LLMContext | ContextAssembler | 是 | 当前事件所需的最小、高信号、带来源和时效的数据 |

SceneRuntimeState 不进入聊天历史。相机位置和屏幕坐标只能作为候选解析辅助，不能直接变成设备事实。

## 2. 上下文项

所有送入模型的事实都包装为上下文项；不可用和过期也是明确状态，不得用空字符串或猜测值替代。

~~~ts
type ContextAvailability = 'available' | 'partial' | 'stale' | 'unavailable'
type TruthTag = 'MEASURED' | 'MODELED' | 'SIMULATED' | 'POLICY'

interface ContextItem {
  key: string
  scope: 'mission' | 'scene' | 'asset' | 'component' | 'environment' | 'anomaly' | 'sop' | 'evidence'
  availability: ContextAvailability
  data: unknown
  sourceRefs: string[]
  truth?: TruthTag
  observedAt?: string
  validUntil?: string
  reasonIncluded: string
}
~~~

模型可以改写人类可读叙述，但不得新增确定性数字、设备 ID、坐标、告警事实、政策数字或未登记动作。

## 3. 自动准备规则

| 语义事件 | 本轮最小上下文 |
|---|---|
| mission_created | 用户目标、操作者、场景 ID/修订号、当前时间、已有异常引用 |
| scene_entered | 场景能力、相关区域、附近已登记资产、危险/禁入摘要 |
| asset_focused | 设备卡、父子关系、状态、最新告警、关键遥测摘要、相邻同类、SOP 引用 |
| anomaly_changed | 异常类型/时间/强度、数据质量、影响数字的引擎引用、待验证目标 |
| approaching_checkpoint | 路线/可达性、入口与屋面限制、环境可作业性、检查点清单 |
| component_focused | 已登记部件、BOM/拓扑关系、允许检查项、异常绑定、拆解能力 |
| environment_changed | 风雨/雷电/辐照/温度/能见度、可作业判定、观测时间和新鲜度 |
| evidence_captured | 证据引用、检查点、类型、结构化读数、观察结果、缺失项、下一允许状态 |
| user_follow_up | 当前阶段、当前焦点、待审批建议、最近摘要和必要结果引用 |

每次进入检查点或环境显著变化后重新取环境和设备上下文；不能沿用任务创建时的旧值。

## 4. 禁止注入

- 原始 3D Tiles、mesh 顶点、完整 GLTF 对象、每帧坐标和按键事件；
- 全站未聚合遥测、无关设备、完整日志和无限聊天历史；
- 任意 SQL、任意 URL、任意外部系统写接口；
- 由模型自行计算的发电量、损失、电价、收益或故障定论。

## 5. 预算与来源

首版按事件只装配一个任务摘要、一个目标资产摘要、最多三个相关资产摘要、一个环境摘要、最多两个 SOP 片段和证据引用。超过预算时先由确定性代码压缩，不由模型自行删事实。

每个数字必须可以沿 sourceRefs 回到引擎接口、fixture、政策包或证据；每个建议必须能说明 reasonIncluded。所有模拟场景数据继续带 SIMULATED，虚构园区继续在 UI 常驻标明。
