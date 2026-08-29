# 场景包契约（Scene Package v1）

> 状态：已实现（engine/src/scene/registry.ts）。任何能源场景（光伏/风电/水电…）以数据 + 轻量适配器进入统一对象注册表；换场景 = 换数据，不改问答与导航代码。

## 1. 目标与边界

- 场景包回答三个问题：**这里有什么对象**（设备/运维点）、**对象有什么属性**（风险、状态说明、规格、位置、关联检查点）、**怎么称呼它**（label + 别名）。
- 注册表只做数据与匹配；**回答的组织、命令解析、审批与状态机仍在 dispatch/runtime**。
- ID/编码/来源只进结构化字段（sceneBrief）；人话回答由 dispatch 按属性组织，不得携带 ID。

## 2. 数据模型

```text
ScenePackage
├── sceneId / sceneRevision      与 routes 场景白名单一致
├── name                         人话名（含「演示仿真」标注）
├── kind                         pv | wind | hydro
├── sourceRef                    数据文件来源
├── specs                        场景级默认规格（键为中文属性名）
└── objects: SceneObject[]
    ├── id / label / aliases     登记语义 ID / 人话名 / 问句别名（最长优先匹配）
    ├── kind                     device | ops
    ├── checkpointId?            关联检查点（导航落点）
    ├── riskLevel?               normal | warning | critical
    ├── stateNote?               人可读状态说明
    ├── specs?                   对象级规格（覆盖场景级）
    └── position? / headingDeg?  ENU 位置与朝向
```

## 3. 已登记场景

| 场景 | sceneId | 数据源 | 适配器 |
|---|---|---|---|
| 光伏园区 | PECC-PARK-01 | data/fixtures/park-pecc-01.json（specs + demoAnomaly/strings/inverters/checkpoints） | registry.adaptPecc |
| 风电场站 | WIND-FARM-01 | player-demo/example/public/wind/farm.json（前端同源，单一事实源） | registry.adaptWind |

## 4. 行为合同

1. **对象问答**：问句命中对象别名（最长优先）或以指代（「它/当前对象」）回看最近三轮命令指向的对象 → 按问句类型回答：参数（`pickSpecs` 按关键词挑规格键，无命中给默认前 6 条）、位置、状态/概览（风险等级 + stateNote + 概要参数）。
2. **命令优先**：问句含命令动词（飞到/维修/检查…）时不进问答门控，仍走命令路由。
3. **人话原则**：回答不含对象 ID/检查点编码/场景编码/来源字样；回归测试在 dispatch-test 固化（`不含 ID` 断言）。
4. **装载校验**：对象 ID 重复、缺 id/label、空对象表 → 引擎启动即抛错（fail fast）。
5. **新增场景步骤**：准备数据文件 → 注册表加一个适配器函数（约 20 行）→ routes 场景白名单加一行 → 完成；问答/指代/对象导航自动生效。

## 5. 明确不做

- 注册表不存时序遥测（仍由引擎/anomalies 负责）；问答里的状态是场景包登记的演示属性（SIMULATED）。
- 不把模型原文、密钥、prompt 放进场景包。
- 不让大模型改写注册表事实——模型只可在事实之上组织语言（后续：事实托底的回答生成）。
