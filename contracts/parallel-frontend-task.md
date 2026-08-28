# Kimi Code 前端任务：巡界首条可演示闭环

你负责本项目的前端，写入范围仅为 web/。你不是独自在代码库中工作：Claude Code 同时负责 engine/，主线程负责合同与验收。不要回退其他人的改动，不要修改 contracts/、data/、engine/。

开始前阅读：

- README.md
- XUNJIE_PROJECT_BRIEF.md
- XUNJIE_AGENT_ORCHESTRATION.md
- contracts/engine-io.md
- contracts/acceptance-matrix.md
- contracts/agent-context.md
- contracts/agent-state.md
- contracts/agent-tools.md
- contracts/scene-events.md
- data/fixtures/park-pecc-01.json

## 目标

把现有 Vue3 + Cesium 场景从 P1 骨架推进为“巡界”首条演示链：用户下达巡检任务，前端发送语义场景事件；后端返回结构化建议和待审批动作；用户明确点击“同意”后，数字运维人员沿登记道路到达 B02 楼前/屋面检查点，前端回传到达与证据事件，并把任务状态展示出来。

## 必须完成

1. 在 web/src/agent/ 建立类型安全的 API client、SceneEvent/SceneCommand 类型和前端任务状态 store。接口按 contracts/agent-tools.md：
   - POST /api/agent/missions
   - GET /api/agent/missions/{missionId}
   - POST /api/agent/missions/{missionId}/approval
   - POST /api/agent/missions/{missionId}/events
   - 引擎地址通过 VITE_ENGINE_BASE_URL 配置，默认 http://localhost:8787。
2. 场景初始化发送一次 scene_entered；设备点击发送 asset_focused。事件必须带 sceneId、sceneRevision、reason、clientTs、idempotencyKey，不能把每帧 Cesium 状态发给模型。
3. 增加“巡界”操作面板，支持：
   - 输入任务或使用“演示：检查 B2 屋顶异常”按钮；
   - 展示 context item 的 availability/truth/sourceRefs 摘要；
   - 展示 proposal 的目标、原因、证据要求和 pendingApproval；
   - “同意/拒绝”按钮严格调用审批接口，不用自然语言绕过审批；
   - 展示模型在线/确定性回退状态，禁止把回退写成真实 LLM 在线。
4. 消费后端返回的 sceneCommands，只处理高层命令 focus_asset、navigate_to_checkpoint、switch_form、show_component。不得把模型输出直接映射为 W/A/S/D、逐帧速度、任意坐标或任意 GLTF 节点名。
5. 对 navigate_to_checkpoint：若现有控制器/道路能力已存在就复用；否则实现一个明确标注“数字现场/仿真动作”的最小演示执行器，沿 fixture 的 roads 折线移动可见的数字运维人员/标记，只有真正到达 CP-B02-FRONT 或 CP-B02-ROOF 后才发送 checkpoint_arrived。不要假装接入真实机器人。
6. evidence_captured 只发送结构化的仿真照片/热成像/读数引用，证据值和状态来自后端响应；提供“提交屋面证据”操作，不在前端直接把任务标为已闭环。
7. 保留现有 P1 场景、虚构园区水印、truth 徽标和关于页；不要在 UI 硬编码另一份设备坐标或业务数字。所有数字从引擎 API 或 fixture 来。
8. 更新 P1/P4 相关前端展示，但不要为了“完整”重写所有 P3/P5 页面；优先保证主链干净、稳定、中文。

## 验证

- pnpm build 必须通过。
- 用浏览器实际启动前端后，至少验证：场景加载、点击设备、创建演示任务、看到审批卡、拒绝不会执行、同意后出现数字运维人员动作/场景命令、到达事件和证据步骤可见。
- 最终说明修改了哪些 web/ 文件、如何启动、哪些是真实 API、哪些是仿真/回退，以及未完成边界。
