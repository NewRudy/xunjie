<script setup lang="ts">
// 应用骨架：顶栏 + 3D 场景 + 语义卡 + 虚构水印 + 关于面板 + 占位页
import { onMounted, ref, shallowRef } from 'vue'
import type * as Cesium from 'cesium'
import { initViewer, switchBasemap } from './cesium/viewer'
import { entityRegistry } from './cesium/parkScene'
import TopBar, { type TabKey } from './components/TopBar.vue'
import InfoCard from './components/InfoCard.vue'
import AboutPanel from './components/AboutPanel.vue'
import FictionalWatermark from './components/FictionalWatermark.vue'
import PlaceholderView from './components/PlaceholderView.vue'
import AgentPanel from './components/AgentPanel.vue'
import { initAgent, getExecutor } from './agent/controller'

const cesiumContainer = ref<HTMLElement | null>(null)
const viewerRef = shallowRef<Cesium.Viewer | null>(null)
const activeTab = ref<TabKey>('scene')
const showAbout = ref(false)

const placeholderMeta: Record<string, { title: string; stage: string }> = {
  screen: { title: '大屏', stage: 'P5' },
  control: { title: '集控中心', stage: 'P3' },
  inspection: { title: '巡检', stage: 'P4' },
  report: { title: '报告', stage: 'P5' },
}

function onToggleBasemap(): void {
  if (viewerRef.value) switchBasemap(viewerRef.value)
}

onMounted(() => {
  if (cesiumContainer.value) {
    viewerRef.value = initViewer(cesiumContainer.value)
    // 巡界 Agent：建仿真执行器并发送一次 scene_entered（无任务时缓冲）
    initAgent(viewerRef.value)
    // 调试挂钩：无头验证脚本通过 window.__pecc 读取场景状态
    ;(window as unknown as Record<string, unknown>).__pecc = {
      viewer: viewerRef.value,
      registry: entityRegistry,
      executor: getExecutor(),
    }
  }
})
</script>

<template>
  <TopBar :active-tab="activeTab" @switch="activeTab = $event" @about="showAbout = true" />

  <!-- 3D 场景常驻挂载，切 Tab 只隐藏不销毁，避免重复初始化 Cesium -->
  <div v-show="activeTab === 'scene'" ref="cesiumContainer" class="scene"></div>

  <PlaceholderView
    v-if="activeTab !== 'scene'"
    :title="placeholderMeta[activeTab].title"
    :stage="placeholderMeta[activeTab].stage"
  />

  <InfoCard v-if="activeTab === 'scene'" />
  <AgentPanel v-if="activeTab === 'scene'" />
  <FictionalWatermark />
  <AboutPanel v-if="showAbout" @close="showAbout = false" @toggle-basemap="onToggleBasemap" />
</template>

<style scoped>
.scene {
  position: fixed;
  inset: 44px 0 0 0;
}
</style>
