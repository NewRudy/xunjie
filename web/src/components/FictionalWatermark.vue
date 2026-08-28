<script setup lang="ts">
// 虚构标注水印：场景左下角常驻（验收 P1-4 硬要求，data-contracts.md §1）
import { fixture } from '../fixture'
</script>

<template>
  <div v-if="fixture.fictional" class="watermark">虚构园区 · 仿真数据</div>
</template>

<style scoped>
.watermark {
  position: fixed;
  left: 12px;
  bottom: 12px;
  z-index: 20;
  padding: 6px 14px;
  background: rgba(0, 0, 0, 0.45);
  color: rgba(255, 255, 255, 0.85);
  font-size: 14px;
  letter-spacing: 2px;
  border-radius: 4px;
  pointer-events: none;
  user-select: none;
}
</style>
