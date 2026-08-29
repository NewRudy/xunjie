# 上游来源说明

本目录是 [hh-hang/cesium-player-controller](https://github.com/hh-hang/cesium-player-controller) 的完整源码副本（MIT，LICENSE 已保留），用于在本地运行其官方 example（入口页 + 3dtiles / 3dgs / gltf 三个场景），后续在其上替换水风光工程场景。

- 上游分支：`main`，tree SHA `fd8833867cf8818e48203fcd8b8088d6f6dc5473`（2026-08-29 快照，经 tarball 落地，无 .git）
- 本地运行：`npm install && npm run dev`，打开 `http://localhost:5173/cesium-player-controller/`
- 注意：`3dtiles` 场景依赖 Cesium ion 全球地形与 S3 上的 AGI HQ 瓦片，`3dgs` 依赖 ion 资产 3667783，均需外网；ion token 为上游仓库内置值
- 对本目录的修改要点：替换场景时保留 `example/` 多页结构（vite.config.ts 的 rollupOptions.input），人物控制复用上游 `playerController` API

## 其他 vendored 依赖

### cesium-wind-layer（GPU 粒子风场流线）

- 位置：`example/wind/vendor/cesiumWindLayer/`（含上游 MIT LICENSE）
- 来源：[hongfaqiu/cesium-wind-layer](https://github.com/hongfaqiu/cesium-wind-layer)（MIT，Copyright (c) 2024 Hongfa Qiu），参考 revision `b1f4ac4`
- 获取路径：2026-08-29 经黔风智维仓库 `apps/web/src/scene/vendor/cesiumWindLayer/` 原样拷贝（该副本已含其本地修复：监听器/资源清理、`Pass.OVERLAY` 自定义渲染管线、ENU 局地投影适配），未从 npm 安装
- 用途：`example/wind/` 风电场景页的 GPU 粒子风场流线；接缝层 `example/wind/windFieldLayer.ts` + 局地风场模型 `windFieldModel.ts` + 参数 `windFieldConfig.ts`（均移植自黔风智维 `apps/web/src/scene/`）

## 资产许可与署名（页面内不展示署名，以本文件为准）

风电/水电场景页（`example/wind/`、`example/hydro/`）画面内不渲染任何署名行/Cesium 角标；所涉资产与库的许可、作者信息统一登记于此：

- **CesiumJS** — Apache-2.0，Cesium GS, Inc.（npm `cesium` 1.142）
- **Laoyeling Mountain（老鸦岭山体 3D Tiles/glTF）** — CC-BY-4.0，Li Yanquan（Sketchfab）
- **Wind Turbine（风机 glTF）** — CC-BY-4.0，Sket_h（https://sketchfab.com/sketch）
- **UAL1_Standard.glb（数字人模型）** — CC-BY-4.0，详见 `web/public/vendor/NOTICE.md`
- **cesium-player-controller（人物控制器，本目录整体副本）** — MIT，hh-hang（见 `LICENSE`）
- **cesium-wind-layer（GPU 粒子风场流线）** — MIT，Hongfa Qiu（见 `example/wind/vendor/cesiumWindLayer/LICENSE`）
- **Monticello Dam（水电场景坝体摄影测量 glTF）** — CC-BY-4.0，Mr. Trevor（https://sketchfab.com/tjmartin97），位于 `example/public/hydro/assets/monticello-dam/`（已 gitignore，体积约 91MB）
- **Solar Farm Array（光伏场景光伏阵列 glTF）** — Sketchfab 下载，许可待回源确认，位于 `example/public/solar/assets/solar-farm/`（已 gitignore，体积约 85MB）
