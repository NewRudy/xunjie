# Third-Party Assets (vendored, offline use)

本目录存放页面运行所需的本地化第三方资产；页面运行不依赖外网。

## models/CesiumMan.glb

- 名称：Cesium Man（glTF 示例模型，含行走骨骼动画）
- 作者 / 所有者：Cesium（2017）
- 来源：https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CesiumMan
- 许可证：Creative Commons Attribution 4.0 International（CC-BY-4.0）
  https://creativecommons.org/licenses/by/4.0/legalcode
- 说明：模型中的 Cesium 标志为 Cesium 商标/标识，不属于可授权版权内容
  （LicenseRef-LegalMark-Cesium），仅随原模型保留，不作任何商标性使用。
- 用途：仅用于本虚构演示场景中“数字运维员（仿真）”角色的可视化呈现。

## models/XunjieOperator.glb

- 名称：UAL1 Standard（上游 `cesium-player-controller` 示例人物，含待机、走、跑、跳、飞行动画）
- 上游项目 / 作者：`cesium-player-controller`，hh-hang
- 来源：https://github.com/hh-hang/cesium-player-controller/blob/fd8833867cf8818e48203fcd8b8088d6f6dc5473/public/models/UAL1_Standard.glb
- 许可证：MIT（随上游仓库许可证使用）
  https://github.com/hh-hang/cesium-player-controller/blob/fd8833867cf8818e48203fcd8b8088d6f6dc5473/LICENSE
- 用途：通过 `cesium-player-controller@0.2.0` 呈现并驱动“巡界”数字运维员；本地化用于离线展演。

## models/XunjieGroundCollider.gltf

- 名称：巡界最小地面碰撞网格
- 作者：本项目
- 许可证：随本项目
- 用途：通过 `cesium-player-controller` 的公开 `addStaticColliders` 接口提供本地 z=0 平面碰撞；不包含建筑、屋面或 3D Tiles 工程碰撞。
