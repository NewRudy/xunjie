<script setup lang="ts">
// 占位页：大屏/集控中心/巡检/报告 为后续阶段留位（P1 不实现内容）
defineProps<{ title: string; stage: string }>()
</script>

<template>
  <div class="placeholder">
    <div class="box">
      <h2>{{ title }}</h2>
      <p>本模块为 {{ stage }} 阶段内容，P1 仅占位，尚未实现。</p>
      <p class="sub">当前阶段（P1）交付：三维数字孪生场景（"场景"标签页）。</p>
    </div>
  </div>
</template>

<style scoped>
.placeholder {
  position: fixed;
  inset: 44px 0 0 0;
  z-index: 15;
  background: #141b23;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #e8ecef;
}
.box {
  text-align: center;
  color: #8fa3b5;
}
.box h2 {
  color: #e8ecef;
}
.sub {
  font-size: 13px;
}
</style>
