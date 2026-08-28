<script setup lang="ts">
// 顶部细条：产品名 + 占位 Tab（大屏/集控中心/巡检/报告，为 P3/P4/P5 留位）+ 关于
import { fixture } from '../fixture'

export type TabKey = 'scene' | 'screen' | 'control' | 'inspection' | 'report'

defineProps<{ activeTab: TabKey }>()
const emit = defineEmits<{ (e: 'switch', tab: TabKey): void; (e: 'about'): void }>()

const tabs: { key: TabKey; label: string }[] = [
  { key: 'scene', label: '场景' },
  { key: 'screen', label: '大屏' },
  { key: 'control', label: '集控中心' },
  { key: 'inspection', label: '巡检' },
  { key: 'report', label: '报告' },
]
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="name">黔光智维 PECC</span>
      <span class="park">{{ fixture.name }}</span>
    </div>
    <nav class="tabs">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="tab"
        :class="{ active: activeTab === t.key }"
        @click="emit('switch', t.key)"
      >
        {{ t.label }}
      </button>
    </nav>
    <button class="about-btn" @click="emit('about')">关于</button>
  </header>
</template>

<style scoped>
.topbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 44px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 0 16px;
  background: rgba(18, 26, 34, 0.92);
  color: #e8ecef;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
  white-space: nowrap;
}
.name {
  font-size: 16px;
  font-weight: 600;
  color: #ffd54f;
}
.park {
  font-size: 12px;
  color: #9aa7b2;
}
.tabs {
  display: flex;
  gap: 4px;
  flex: 1;
}
.tab {
  padding: 6px 14px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: #c3ccd4;
  font-size: 14px;
  cursor: pointer;
}
.tab:hover {
  background: rgba(255, 255, 255, 0.08);
}
.tab.active {
  background: rgba(255, 213, 79, 0.15);
  color: #ffd54f;
}
.about-btn {
  padding: 6px 14px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 4px;
  color: #c3ccd4;
  font-size: 13px;
  cursor: pointer;
}
.about-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}
</style>
