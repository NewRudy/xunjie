# 上游来源说明

本目录是 [hh-hang/cesium-player-controller](https://github.com/hh-hang/cesium-player-controller) 的完整源码副本（MIT，LICENSE 已保留），用于在本地运行其官方 example（入口页 + 3dtiles / 3dgs / gltf 三个场景），后续在其上替换水风光工程场景。

- 上游分支：`main`，tree SHA `fd8833867cf8818e48203fcd8b8088d6f6dc5473`（2026-08-29 快照，经 tarball 落地，无 .git）
- 本地运行：`npm install && npm run dev`，打开 `http://localhost:5173/cesium-player-controller/`
- 注意：`3dtiles` 场景依赖 Cesium ion 全球地形与 S3 上的 AGI HQ 瓦片，`3dgs` 依赖 ion 资产 3667783，均需外网；ion token 为上游仓库内置值
- 对本目录的修改要点：替换场景时保留 `example/` 多页结构（vite.config.ts 的 rollupOptions.input），人物控制复用上游 `playerController` API
