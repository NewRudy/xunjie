# 引擎接口合同（engine-io）

> 确定性引擎（TypeScript）对 UI 暴露的全部接口。UI 不得绕过本合同直接读 fixture 或外部 API。
> 通用约定：
> - 所有时间参数为 `YYYY-MM-DD` 或 ISO 8601（时区 Asia/Shanghai）。
> - 所有返回的数值字段必须带 `truth` 标签：`MEASURED | MODELED | SIMULATED | POLICY`（定义见 data-contracts.md）。
> - 所有金额单位为元（CNY），功率 kW，电量 kWh，辐照 W/m²。
> - 错误返回 `{ "error": { "code": "...", "message": "..." } }`，HTTP 状态码语义化。
> - nodeId 必须来自语义树（semantic-tree.md），未知 ID 返回 404。

## 1. 场景与资产

### GET /api/park
返回园区 fixture 全量（data/fixtures/park-pecc-01.json 的原样透传 + 引擎附加的实时状态字段）。
附加字段：`status`（每台设备当前状态机值）、`livePowerKw`（当前功率，SIMULATED）。

### GET /api/node/{nodeId}
单节点详情：语义卡字段 + 状态 + 当日发电/用电摘要 + 关联子节点列表。

## 2. 气象

### GET /api/weather?from={date}&to={date}
逐时气象序列：`[{ ts, ghi, temp, truth }]`。
- 历史与预报均来自 Open-Meteo（见 data-contracts.md），`truth: "MODELED"`。
- 引擎侧必须缓存，同一天同一地点不得重复请求外部 API。

## 3. 发电

### GET /api/generation/expected?nodeId={id}&date={date}
应发电量（无故障物理期望值）：逐时 `expectedKwh` + 当日合计，`truth: "MODELED"`。
算法：PVGIS 标定年产能 × 当日逐时辐照/温度修正，锚点 955 kWh/kWp/年（贵阳）。

### GET /api/generation/actual?nodeId={id}&date={date}
实发电量：逐时 `actualKwh` + 当日合计，`truth: "SIMULATED"`。
- 无异常时 actual == expected（允许 ±2% 噪声，种子确定）。
- 异常注入期间按 data-contracts.md 的异常规则偏离。
- **闭环验证硬要求：异常任务 close 后，该节点 actual 必须恢复到 expected ±2% 区间。**

### GET /api/generation/summary?date={date}
园区当日汇总：总装机、应发、实发、达成率 %、等效利用小时、损失电量及按节点分解。

## 4. 用电（负荷侧，必须实现）

### GET /api/load/profile?nodeId={id}&date={date}
节点 15 分钟级负荷曲线：`[{ ts, kw, truth }]`。
- 分表节点（MT-B01..B06）：`truth: "SIMULATED"`（负荷仿真器产出，规则见 data-contracts.md）。
- 支持 `?aggregate=park` 返回园区总负荷。

### GET /api/load/forecast?date={date}
明日（或指定日）逐时负荷预测：`truth: "MODELED"`。
规则基线（同日历类型历史均值 + 温度修正）即可，禁止用 LLM 生成数字。

### GET /api/load/balance?date={date}
逐时发用电平衡：`[{ ts, pvKw, loadKw, essKw, gridKw, truth }]`。
gridKw>0 为购电、<0 为上网；储能正放负充。这是"智能微电网感"的核心数据视图。

## 5. 价格与策略

### GET /api/tariff?date={date}
当日 24 段电价表：`[{ hour, period: "peak|flat|valley", priceYuanKwh, truth: "POLICY" }]`，
并附 `policyRef`（文号 + 条款，见 data-contracts.md 政策包）。

### GET /api/strategy?date={date}
策略卡数组。每张卡：
```json
{
  "id": "STRATEGY-20260828-01",
  "mode": "ess_arbitrage | ev_shift | demand_control | curtailment_guard",
  "title": "谷段充电、峰段放电",
  "description": "人类可读的一句话",
  "window": [{ "from": "00:00", "to": "08:00", "action": "charge 400kW" }],
  "deltaYuan": 512.3,
  "basis": {
    "calc": "430kWh × (0.884 - 0.240) 元/kWh × 效率0.9 ≈ ...",
    "policyRef": ["黔发改价格〔2023〕481号"],
    "dataRef": ["/api/tariff?date=...", "/api/load/forecast?date=..."]
  },
  "truth": "MODELED"
}
```
- `deltaYuan` 必须由确定性代码算出，且 `basis.calc` 能让人手算复核。
- 大模型只允许改写 `description` 的措辞，不得新增/修改任何数字。

## 6. 异常与告警

### GET /api/anomalies?date={date}&status=open|all
异常事件数组：`{ id, nodeId, type, detectedAt, severity, evidence: {...}, status, truth }`。
demo 异常：STR-B2-07 组串电流偏低 18%（fixture 中 demoAnomaly 定义）。

## 7. 巡检闭环（小人层）

### POST /api/inspection/tasks
入参 `{ anomalyId, nodeId, assignee? }` → 创建任务，状态 `created`。
### GET /api/inspection/tasks/{id}
任务详情 + 状态机当前值 + 证据列表。
### POST /api/inspection/tasks/{id}/events
推进状态机：`{ event: "dispatch|arrive_front|arrive_roof|submit_evidence|resolve|escalate", payload? }`。
非法跃迁（状态机不允许的）返回 409。
### POST /api/inspection/tasks/{id}/evidence
`{ checkpointId, kind: "photo|thermal|reading|note", value, ts }`。
- 屋面类异常必须含 CP-xxx-ROOF 检查点的证据才允许 `resolve`（否则 409）。
### POST /api/inspection/tasks/{id}/close
闭环：校验证据齐备 → 状态 `resolved` → **引擎撤销该节点异常注入**（实发曲线恢复）。

## 8. 报表

### GET /api/report/monthly?month=YYYY-MM
月度报告数据（JSON，非 LLM 文本）：
- 按屋顶/楼栋分账：各 PV 子阵发电量、自用电量、上网电量、收益（对照 POLICY 电价）。
- 储能套利收益、充电桩转移收益、需量控制估算。
- 异常与运维：事件数、闭环率、平均闭环时长、挽回电量。
- 每行数字带 truth 标签与 basis 引用。
LLM 层只能在此 JSON 之上生成叙事文本，且文本中的数字必须逐字取自 JSON。

## 非目标（本合同明确不做）

- 不提供任何"AI 估算电价/AI 预测发电量"的接口（数字只能来自确定性代码）。
- 不提供写外部系统的接口（纯本地闭环）。
- 用户认证/多租户（PoC 单用户）。
