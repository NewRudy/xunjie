# pecc-engine（P2 确定性计算引擎）

园区全部数字与任务状态的唯一来源。合同：`contracts/engine-io.md`（接口）、`contracts/data-contracts.md`（数据与仿真规则）。Agent 层可选调用结构化 LLM planner，但确定性校验和状态机不接受模型生成的合同外数字。

## 运行

```bash
pnpm install
pnpm start      # http://localhost:8787（CORS 已放开，web dev server 5173 可直连）
pnpm smoke      # §P2 验收矩阵 + 巡检闭环端到端，全绿退出码 0
```

首次启动会从 Open-Meteo 抓取 2025 整年气象做 PVGIS 标定（年累计收敛 955 kWh/kWp），结果持久化到 `var/engine.db`（SQLite，Node 24 内置 `node:sqlite`），之后离线可用。

## 结构

- `src/index.ts` — Hono 路由（合同 §1-8 全部接口）
- `src/weather.ts` — Open-Meteo forecast/archive + SQLite 缓存（历史永久/预报 6h）+ 离线确定性晴空合成降级（meta.synthetic 标注）
- `src/generation.ts` — 应发（MODELED，PVGIS 标定）/ 实发（SIMULATED，±2% 种子噪声 + 异常注入）
- `src/load.ts` — 负荷仿真器（15 分钟级，loadType 逐时系数 + 2026 节假日日历 + EV 可调窗口）
- `src/ess.ts` / `src/balance.ts` — 储能谷充峰放基线调度 / 逐时发用电平衡（残差闭合）
- `src/tariff.ts` — 政策包电价（唯一电价来源：`../data/policy/gz-2026-08.json`）
- `src/strategy.ts` — 四张策略卡（deltaYuan 确定性可手算复核，basis.inputs 程序可重算）
- `src/anomalies.ts` / `src/anomalyState.ts` — demo 异常注入与闭环撤销
- `src/inspection.ts` — 巡检任务状态机（非法跃迁 409；屋面异常须 CP-xxx-ROOF 证据才能 resolve；close 即撤销注入）
- `src/agent/` — 巡界 MissionRuntime、上下文装配、确定性 planner/LLM 适配器、SQLite 状态与场景事件路由
- `src/report.ts` — 月度报告 JSON（分账/储能/EV/需量/异常闭环，全带 truth+basis）
- `scripts/smoke.mjs` — 验收脚本
- `scripts/agent-test.mjs` — 巡界 Agent 回放/集成测试（临时 SQLite，覆盖审批绑定、事件幂等、证据门槛、重启恢复）

## 合同外附加端点（调试用，UI 可忽略）

- `GET /api/health` — 健康检查
- `GET /api/generation/annual-yield?year=YYYY` — 年产自检（验收 P2-2：955 kWh/kWp ±5%）
- `POST /api/debug/reset` — 演示复位：清空巡检任务、重新注入 demo 异常（不动气象缓存与标定）

## Agent 回放

```bash
pnpm test:agent
```

该测试会自动拉起独立引擎实例，验证 `POST /api/agent/missions`、审批三元组、`checkpoint_arrived`、批量 `evidence_captured`、闭环回执和 SQLite 重启恢复；默认不需要 LLM 凭据，结果中的 planner 会明确标记为 `deterministic-fallback`。

## 确定性约定

同参数两次调用逐字节一致（`/api/weather` 的 `meta.fetchedAt` 为缓存抓取时间，属合同豁免字段）。所有随机性来自 `seed = hash(nodeId + date)`（FNV-1a + mulberry32）。
