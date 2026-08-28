# Claude Code 后端任务：巡界 MissionRuntime 首条可恢复闭环

你负责本项目的后端，写入范围仅为 engine/。你不是独自在代码库中工作：Kimi Code 同时负责 web/，主线程负责合同与验收。不要回退其他人的改动，不要修改 contracts/、data/、web/。

开始前阅读：

- README.md
- XUNJIE_PROJECT_BRIEF.md
- XUNJIE_AGENT_ORCHESTRATION.md
- contracts/engine-io.md
- contracts/data-contracts.md
- contracts/semantic-tree.md
- contracts/agent-context.md
- contracts/agent-state.md
- contracts/agent-tools.md
- contracts/scene-events.md
- data/fixtures/park-pecc-01.json
- engine/src/inspection.ts
- engine/src/db.ts

## 目标

在现有 PECC 确定性引擎上增加一个受控 MissionRuntime：接收用户目标/异常引用，确定性装配最小上下文，生成结构化建议，等待明确审批，批准后创建/复用现有巡检任务并返回高层场景命令；场景事件到达时推进现有 inspection 状态机。后端必须可重启恢复，不能让大模型直接生成数字、ID、SQL 或真实控制动作。

## 必须完成

1. 在 engine/src/agent/ 下实现清晰分层：
   - MissionState 持久化（复用现有 SQLite，必要时由 engine/src/db.ts 增表）；
   - ContextAssembler：任务、目标设备/异常、父子与相邻设备、环境/SOP 摘要，所有数字带 truth/sourceRefs/observedAt/availability/reasonIncluded；
   - ModelAdapter 接口 + 当前可运行的确定性回退 planner；预留 OpenAI-compatible/Kimi/智谱接入边界，但没有凭据时不能调用外部服务、不能在日志打印密钥；
   - proposal/plan 校验、稳定 planHash、approval TTL/contextVersion 绑定；
   - 事件幂等和重启恢复。
2. 在 Hono 入口接入 contracts/agent-tools.md 的 API：
   - POST /api/agent/missions
   - GET /api/agent/missions/:missionId
   - POST /api/agent/missions/:missionId/approval
   - POST /api/agent/missions/:missionId/events
   - 错误格式与现有 API 一致，非法审批/非法迁移使用语义化状态码。
3. 演示路径必须以 ANOM-DEMO-01/STR-B2-07 为真实合同目标：
   - 创建 mission 时只能用请求中的 anomalyId 或明确的已登记 ID；缺少或不明确时返回 clarification，不猜 ID；
   - 提案中说明“先取得屋面证据再闭环”，返回 CP-B02-FRONT、CP-B02-ROOF 等已登记目标；
   - approve 必须同时校验 approvalId + contextVersion + planHash + 未过期；
   - 通过后调用现有 createTask，不重复造一套 inspection 状态机；再通过 pushEvent 等现有函数推进 dispatch/arrive_front/arrive_roof/submit_evidence/resolve；
   - 屋面证据不足时保持阻塞并返回 EVIDENCE_MISSING，不能用自然语言绕过；
   - close 后由现有引擎撤销异常注入，保持 /api/generation/actual 的闭环恢复语义。
4. 场景事件处理只接受 contracts/scene-events.md 的高层语义事件：
   - asset_focused/component_focused 更新 focus 并刷新上下文；
   - checkpoint_arrived 根据 CP-B02-FRONT/CP-B02-ROOF 推进对应巡检事件；
   - evidence_captured 调用 addEvidence，数据明确标 SIMULATED；
   - navigation_failed 记录 warning/blocked，不自动跳过；
   - 重复 eventId/idempotencyKey 不产生重复副作用。
5. 模型/回退输出不能新增业务数字、设备 ID、坐标、政策数字或未登记动作。LLM 不可用时返回 fallback 标识；确定性引擎仍可用。
6. 增加针对 agent runtime 的最小回放/单元测试（至少：happy path、审批版本失效、未批准拒绝、缺 roof evidence、重复事件、重启恢复/已持久化任务读取）。

## 验证

- pnpm exec tsc --noEmit（或等价类型检查）通过。
- pnpm smoke 通过，并用 curl 验证以上四个 agent 路由以及现有 inspection/generation 闭环。
- 最终说明修改了哪些 engine/ 文件、测试命令、API 示例、模型回退边界和未完成的真实 SCADA/现场安全接入。
