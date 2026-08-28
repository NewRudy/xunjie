# 黔光智维 PECC · P0 共同合同

> 本目录是 Kimi / GPT / Claude 三方实现的**唯一事实基础**。任何一方的产出与合同冲突时，以合同为准；要改合同，先改这里的文件并注明日期与原因。

| 文件 | 内容 | 负责组 |
|---|---|---|
| [semantic-tree.md](semantic-tree.md) | 语义命名树：ID 规则、设备类型、状态机 | 三方共用 |
| [park-fixture.md](park-fixture.md) + `../data/fixtures/park-pecc-01.json` | 示范园区 fixture（建筑群、屋顶子阵、设备、道路、运维点） | 场景组渲染、引擎组计算都以此为输入 |
| [engine-io.md](engine-io.md) | 引擎 I/O：天气、应发、实发、策略卡、异常、巡检、月报接口 | 引擎数据组实现，UI 组消费 |
| [data-contracts.md](data-contracts.md) | 外部数据源契约 + 真值标签体系（MEASURED/MODELED/SIMULATED/POLICY） | 三方共用 |
| [acceptance-matrix.md](acceptance-matrix.md) | P1–P5 验收矩阵 + 诚实标注检查项 | 验收依据 |
| [agent-context.md](agent-context.md) | 场景/设备/环境上下文的分层、事件触发、预算与来源 | Agent 后端装配，前端只发语义事件 |
| [agent-state.md](agent-state.md) | MissionState、提案、审批绑定、回放与现有巡检状态机的关系 | Agent 后端唯一写入方 |
| [agent-tools.md](agent-tools.md) | 高层工具目录与 /api/agent/* HTTP 接口 | 前后端共同消费 |
| [scene-events.md](scene-events.md) | Cesium 场景事件桥与后端场景命令 | 场景前端实现，后端校验 |

## 不可违反的规则

1. 所有 ID 必须来自语义树，不允许界面自造名字。
2. 每个数字必须带真值标签；模拟数据不得以任何形式冒充实测。
3. 大模型不产出数字；数字只能来自确定性引擎或合同 fixture。
4. 一方修改 fixture 或接口，必须同步修改对应合同文件，否则视为未交付。
