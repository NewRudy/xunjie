// 将 cesium 预构建静态资源拷入 public/cesium（dev / build 前执行）。
// 只拷运行时必需的四个目录，避免把整包（含未压缩源码）塞进产物。
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.join(here, '..', 'node_modules', 'cesium', 'Build', 'Cesium')
const dstRoot = path.join(here, '..', 'public', 'cesium')

if (!existsSync(srcRoot)) {
  console.error('[copy-cesium] 未找到 cesium 构建产物，请先 pnpm install')
  process.exit(1)
}

for (const dir of ['Workers', 'Assets', 'Widgets', 'ThirdParty']) {
  const src = path.join(srcRoot, dir)
  const dst = path.join(dstRoot, dir)
  if (existsSync(src)) {
    mkdirSync(dstRoot, { recursive: true })
    cpSync(src, dst, { recursive: true })
  }
}
console.log('[copy-cesium] 静态资源已就绪 → public/cesium')
