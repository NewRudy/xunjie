# 巡界数字运维员指令合同（Demo v1）

本合同冻结“自然语言文字 → 受控数字人动作”的第一版接口。后续语音识别只负责把语音转成 `text`，继续调用同一接口，不改变动作执行链。

## 1. 产品边界

- 目标：让观众输入一句自然语言，立即看到一个**可辨认的数字运维员**在工程场景内移动，并能完成一次设备维修仿真。
- 本版只控制数字孪生中的人物、镜头与仿真效果，不连接机器人、SCADA 或真实设备。
- 所有位置必须来自 fixture 登记对象，或是相对当前位置的有界移动；后端不得返回任意脚本、Cesium API 或未经登记的世界坐标。
- “维修”只表示 `SIMULATED` 数字现场演示：定位异常部件、拆解/高亮、维修进度、恢复外观。不得宣称真实消缺。

## 2. HTTP 接口

`POST /api/agent/avatar/interpret`

请求：

```json
{
  "text": "飞到 B2 屋顶维修 7 号异常组串",
  "sceneId": "PECC-PARK-01",
  "sceneRevision": "fixture-v1"
}
```

成功响应继续使用项目统一结果外壳，`data` 为：

```json
{
  "normalizedText": "飞到 B2 屋顶维修 7 号异常组串",
  "reply": "收到，飞往 B2 屋顶并执行 7 号组串维修仿真。",
  "commands": [
    {
      "commandId": "avatar-...-1",
      "kind": "navigate",
      "targetId": "CP-B02-ROOF",
      "movement": "fly"
    },
    {
      "commandId": "avatar-...-2",
      "kind": "repair_simulation",
      "targetId": "STR-B2-07",
      "checkpointId": "CP-INV-B02"
    }
  ]
}
```

响应 `truth` 必须是 `SIMULATED`，并在 `warnings` 中明确“仅数字现场仿真”。无法唯一理解时返回 `400 CLARIFICATION_NEEDED`，不猜目标。

## 3. 受控命令集合

```ts
type AvatarCommand =
  | { commandId: string; kind: 'navigate'; targetId: 'OPS-01' | 'CP-B02-FRONT' | 'CP-B02-ROOF' | 'CP-INV-B02'; movement: 'walk' | 'run' | 'fly' }
  | { commandId: string; kind: 'move_relative'; direction: 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down'; distanceMeters: number; movement: 'walk' | 'run' | 'fly' }
  | { commandId: string; kind: 'turn'; degrees: number }
  | { commandId: string; kind: 'jump' }
  | { commandId: string; kind: 'stop' }
  | { commandId: string; kind: 'focus_asset'; targetId: 'STR-B2-07' | 'INV-B-02' }
  | { commandId: string; kind: 'repair_simulation'; targetId: 'STR-B2-07'; checkpointId: 'CP-INV-B02' };
```

约束：

- `distanceMeters` 默认 10，服务端钳制到 `1..50`。
- `turn.degrees` 只允许 `-180..180`。
- `up/down` 必须使用 `movement: 'fly'`。
- 新指令可以中断当前纯数字移动；`stop` 立即停止。
- `repair_simulation` 必须确认人物已在目标检查点附近；否则前端先自动导航到 `checkpointId`。
- 任务闭环已有 `/missions` 与审批接口保持不变；本接口是展厅演示控制面，不篡改 MissionState。

## 4. v1 中文映射

- “走到/去 B2 楼前” → `navigate CP-B02-FRONT walk`
- “跑到 B2 楼前” → `navigate CP-B02-FRONT run`
- “飞到/上 B2 屋顶” → `navigate CP-B02-ROOF fly`
- “去 B2 逆变器” → `navigate CP-INV-B02 walk`
- “回运维点” → `navigate OPS-01 walk`
- “向前/后/左/右走 10 米” → `move_relative`
- “上升/下降 10 米” → `move_relative up/down fly`
- “左转/右转 90 度” → `turn`
- “跳一下” → `jump`
- “停下” → `stop`
- “维修/修复 7 号异常组串” → `navigate CP-INV-B02`（若尚未到位）+ `focus_asset STR-B2-07` + `repair_simulation STR-B2-07`

## 5. 前端可见验收

只验一条主路径：

1. 页面出现可辨认的数字运维员，而不是单个点。
2. 输入“跑到 B2 楼前”，人物沿登记道路快速移动并显示 `RUN`。
3. 输入“飞到 B2 屋顶”，人物抬升飞到屋面并显示 `FLY`。
4. 输入“维修 7 号异常组串”，人物到设备附近，场景聚焦 `STR-B2-07`，展示部件拆解/报警高亮、维修进度、恢复完成。
5. 输入“停下”可中断正在进行的移动。

## 6. 语音后接方式

浏览器按住说话或服务端 ASR 得到最终转写后，只调用 `POST /api/agent/avatar/interpret`。因此本版文字入口就是语音链路除 ASR 外的完整可测替身。
