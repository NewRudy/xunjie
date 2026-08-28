import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Cesium 静态资源（Workers/Assets/Widgets/ThirdParty）由 scripts/copy-cesium.mjs
// 拷入 public/cesium，开发与构建均从 /cesium/ 路径加载，不依赖 vite-plugin-cesium。
export default defineConfig({
  plugins: [vue()],
  define: {
    // Cesium 内部以此定位静态资源；显式指定，避免默认走 ion
    CESIUM_BASE_URL: JSON.stringify('/cesium/'),
  },
  server: {
    port: 5173,
    fs: {
      // fixture JSON 在仓库根 data/ 下，需允许 dev server 访问上级目录
      allow: ['..'],
    },
  },
  build: {
    chunkSizeWarningLimit: 8000,
  },
})
