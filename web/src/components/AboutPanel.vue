<script setup lang="ts">
// 关于面板：底图/地形/坐标来源列明（验收 P1-6），并提供底图在线/离线切换。
import { BASEMAP_SOURCE_TEXT } from '../cesium/basemap'
import { basemapConfig } from '../config'
import { fixture } from '../fixture'

const emit = defineEmits<{ (e: 'close'): void; (e: 'toggle-basemap'): void }>()
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="panel">
      <header class="head">
        <span>关于 · 数据来源</span>
        <button class="close" @click="emit('close')">×</button>
      </header>

      <h3>底图与地理数据</h3>
      <ul>
        <li v-for="line in BASEMAP_SOURCE_TEXT" :key="line">{{ line }}</li>
      </ul>
      <p class="switch-line">
        当前底图：<b>{{ basemapConfig.mode === 'online' ? '在线 OSM' : '离线（纯色 + 网格）' }}</b>
        <button class="btn" @click="emit('toggle-basemap')">切换底图</button>
      </p>

      <h3>园区数据</h3>
      <ul>
        <li>园区 fixture：data/fixtures/park-pecc-01.json（虚构园区，fictional: true）</li>
        <li>{{ fixture.prototypeNote }}</li>
        <li>设备状态：模拟演示数据（SIMULATED），INV-B-02 默认故障红对应演示异常 {{ fixture.demoAnomaly.id }}</li>
        <li>运行期数字（发电量/负荷/电价）：引擎未接入（P2 阶段提供）</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
}
.panel {
  width: 560px;
  max-height: 80vh;
  overflow-y: auto;
  background: rgba(22, 30, 39, 0.98);
  color: #e8ecef;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  padding: 18px 22px;
  font-size: 13px;
  line-height: 1.8;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
}
.close {
  background: none;
  border: none;
  color: #8fa3b5;
  font-size: 22px;
  cursor: pointer;
}
h3 {
  margin: 14px 0 6px;
  font-size: 14px;
  color: #ffd54f;
}
ul {
  margin: 0;
  padding-left: 20px;
}
.switch-line {
  margin: 10px 0 0;
}
.btn {
  margin-left: 10px;
  padding: 3px 12px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  color: #e8ecef;
  cursor: pointer;
}
.btn:hover {
  background: rgba(255, 255, 255, 0.1);
}
</style>
