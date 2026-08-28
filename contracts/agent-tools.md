# 巡界 Agent 工具与 HTTP 合同

> 模型只能调用面向任务的高层能力。底层 Cesium 控制器、SQL、任意坐标和外部系统写入不暴露给模型。

## 1. 工具目录

| 工具 | 副作用 | 说明 |
|---|---|---|
| context.get_mission_snapshot | 只读 | 当前任务、阶段、焦点、权限、待办 |
| context.get_asset_context | 只读 | 设备卡、关系、状态、告警、关键遥测和来源 |
| context.get_environment_operability | 只读 | 环境值、可作业判断、时效和警告 |
| context.get_related_assets | 只读 | 父子、相邻同类、拓扑邻居、检查点 |
| sop.get_relevant_steps | 只读 | 规程片段、版本、证据要求 |
| scene.focus_asset | 数字场景 | 按已核验语义 ID 高亮目标 |
| scene.navigate_to_checkpoint | 数字场景 | 按登记路线行走，返回到达或不可达 |
| scene.switch_form | 数字场景 | 只允许场景包登记的形态 |
| inspection.capture_evidence | 证据写入 | 保存媒体引用/结构化读数，不伪造媒体事实 |
| inspection.evaluate_evidence | 受控分析 | 返回 observation/candidate，不直接定论 |
| mission.advance | 状态写入 | 只能走合同允许的任务/巡检迁移 |
| mission.close_or_escalate | 状态写入 | 校验证据与用户确认后执行，生成收据 |

## 2. HTTP 首版接口

### 创建任务/获取提案

POST /api/agent/missions

~~~json
{
  "objective": "去看一下 B2 屋顶这个异常",
  "sceneId": "PECC-PARK-01",
  "sceneRevision": "fixture-v1",
  "operator": "运维员-演示",
  "trigger": "user",
  "anomalyId": "ANOM-DEMO-01"
}
~~~

返回 MissionState 摘要、context、结构化 proposal 和 pendingApproval。目标只能解析到语义树中的 ID；不明确时返回澄清，不猜 ID。

### 读取任务

GET /api/agent/missions/{missionId}

返回当前状态、最新上下文摘要、提案、审批和待执行场景命令。

### 审批

POST /api/agent/missions/{missionId}/approval

~~~json
{
  "approvalId": "APR-...",
  "decision": "approve",
  "contextVersion": "...",
  "planHash": "..."
}
~~~

decision 只能是 approve|reject。通过后由后端创建/复用巡检任务并返回 sceneCommands；不允许把“我同意”解析为任意未挂起动作。

### 场景事件

POST /api/agent/missions/{missionId}/events

事件体遵守 scene-events.md。事件只推进后端任务和刷新上下文，不接收逐帧按键。

## 3. 统一结果外壳

~~~json
{
  "status": "available|partial|stale|unavailable|rejected",
  "data": {},
  "sourceRefs": [],
  "truth": "MEASURED|MODELED|SIMULATED|POLICY",
  "observedAt": "...",
  "validUntil": "...",
  "warnings": [],
  "nextAllowedActions": []
}
~~~

模型不可用时，确定性引擎和固定演示流程仍应可用，但 UI 必须显示“模型不可用/使用确定性回退”，不能伪称真实 LLM 已在线。
