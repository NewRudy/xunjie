# 园区 fixture 合同

机器可读 fixture：[`../data/fixtures/park-pecc-01.json`](../data/fixtures/park-pecc-01.json)。本文档是其字段语义说明，两者必须同步修改。

## 1. 坐标系

- `anchor`：WGS84 锚点（贵安新区一带，26.4085, 106.5225，海拔约 1280m）。
- 所有 `position` 为以锚点为原点的 ENU 局部坐标，单位米（x 东，y 北，z 高）。
- 场景组负责 ENU ↔ Cesium 世界坐标转换；引擎组只用局部坐标。

## 2. 对象清单

- `buildings[]`：6 栋建筑（厂房 A/B/C、办公楼、宿舍食堂、配电房），矩形 footprint（`center` + `size`），`floors`、`height`、屋顶参数（`tilt` 倾角、`azimuth` 方位角、可用率 `usableRatio`）。
- `roofs[]`：每栋楼一个屋顶对象。`pvArrayId` 为空表示暂未装光伏（如办公楼 RF-B04——**这是"去哪装"模块的预留扩建点**）。
- `pvArrays[]`：屋顶/车棚子阵。`peakKwp`、`panelCount`、`inverterIds`、`tilt/azimuth`、`commissionedAt` 投运日期（一期 B01/B02/B03=2024-03-28，二期 B05/P01=2024-11-20）。
- `inverters[]`：组串式逆变器，`ratedKw`、`stringCount`、`efficiency`（0.986）、所属 `pvArrayId`。
- `strings[]`：只为演示异常链路完整建模了 B 厂房 INV-B-02 下的组串（含演示目标 **STR-B2-07**；`ratedCurrentA`/`ratedVoltageV` 按 550W 组件 26 块串联口径）；其余组串按需由仿真器惰性生成，ID 规则不变。
- `ess`、`chargers[]`、`transformer`、`mainMeter`、`subMeters[]`、`weatherStation`、`opsPoint`：语义见 [semantic-tree.md](semantic-tree.md)。
- `roads[]`：折线道路（小人寻路与场景渲染共用）。
- `checkpoints[]`：巡检检查点（楼前点、屋面点），`nodeId` 指向语义树对象。

## 3. 用电侧（源网荷储的"荷"）

- 每栋楼挂一个分项电表（`subMeters[]`），各分表仿真峰值 `peakKw` 在本表声明（450/360/260/110/90/30 kW），`loadType` 决定负荷仿真曲线：
  - `production_2shift`：两班制生产（8–24 时高负荷）；
  - `office`：办公作息（工作日 8–18 时）；
  - `dormitory`：宿舍（早、晚双峰）；
  - `canteen`：食堂（三餐尖峰）；
  - `distribution`：配电房小动力。
- 充电桩 EV-01…04 是**可调负荷**（仿真类型码 `ev_charging`，作用于 EV 节点，不是楼栋 `loadType`）：车队早间到场、晚间离场，充电需求落在 9–17 时窗口内可调（evcc 逻辑的中国园区版：光伏富余优先充、谷价补电）。
- `loadProfile`（园区级）：最大需量约 1500 kW、年用电量约 520 万 kWh（两班制口径）。

## 4. 演示异常注入

- `demoAnomaly`：STR-B2-07 电流持续偏低 18%（疑似二极管击穿/热斑），从演示日 T0 起注入仿真器；巡检任务 `TASK-DEMO-01` 的触发源。消缺确认后仿真器必须恢复该组串正常出力（闭环验证）。

## 5. 虚构标注

fixture 根节点 `fictional: true`。该园区为**虚构示范园区**（原型参考贵阳贵安产业园形态），UI 与报告中必须可见此标注。
