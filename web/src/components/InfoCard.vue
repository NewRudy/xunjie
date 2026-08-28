<script setup lang="ts">
// 设备语义卡：左键点击设备后右侧滑出。
// 静态字段来自 fixture；运行区只显示后端任务联动状态（引擎/任务/回执），不再写"引擎未接入"。
import { computed } from 'vue'
import { selection, clearSelection } from '../state/selection'
import { getCardInfo } from '../fixture/cards'
import { getStatus } from '../state/parkState'
import { STATUS_META, TRUTH_META } from '../constants/colors'
import { missionStore } from '../agent/missionStore'
import { fixture } from '../fixture'

const card = computed(() => (selection.id ? getCardInfo(selection.id) : null))
const status = computed(() => (selection.id ? getStatus(selection.id) : 'normal'))
const statusMeta = computed(() => STATUS_META[status.value])
const simulated = TRUTH_META.SIMULATED

const PHASE_LABEL: Record<string, string> = {
  created: '已创建',
  'context-ready': '上下文就绪',
  proposed: '已提案',
  'awaiting-approval': '待审批',
  executing: '执行中',
  'awaiting-evidence': '待证据',
  'awaiting-confirmation': '待确认',
  resolved: '已闭环',
  escalated: '已升级',
  cancelled: '已取消',
}

const receipt = computed(() => missionStore.receipt)
const task = computed(() => missionStore.inspectionTask)
const evidenceCount = computed(() =>
  Array.isArray(task.value?.evidence) ? task.value!.evidence!.length : null,
)

/** 演示目标（组串及其逆变器）在闭环后不再展示"正在故障"的静态 note */
const isDemoTarget = computed(() => {
  const id = selection.id
  if (!id) return false
  const s = fixture.strings.find((v) => v.id === fixture.demoAnomaly.targetStringId)
  return id === fixture.demoAnomaly.targetStringId || id === s?.inverterId
})
const note = computed(() => {
  if (isDemoTarget.value && receipt.value?.anomalyStatus === 'resolved') {
    return `演示异常 ${fixture.demoAnomaly.id} 已闭环（数字现场仿真）：证据、累计损失与回执见巡界面板。`
  }
  return card.value?.note
})
</script>

<template>
  <transition name="slide">
    <aside v-if="card" class="info-card">
      <header class="head">
        <div>
          <div class="title">{{ card.title }}</div>
          <div class="sid">{{ card.id }}</div>
        </div>
        <button class="close" @click="clearSelection">×</button>
      </header>

      <section class="row">
        <span class="k">类型</span>
        <span class="v">{{ card.typeLabel }}</span>
      </section>

      <section class="row">
        <span class="k">状态</span>
        <span class="v status">
          <i class="dot" :style="{ background: statusMeta.css }"></i>
          {{ statusMeta.label }}
          <em class="badge" :style="{ background: simulated.css }">{{ simulated.label }}</em>
        </span>
      </section>

      <section class="fields">
        <div v-for="f in card.fields" :key="f.label" class="row">
          <span class="k">{{ f.label }}</span>
          <span class="v">{{ f.value }}</span>
        </div>
      </section>

      <section class="daily">
        <div class="daily-title">
          任务联动
          <em class="badge" :style="{ background: simulated.css }">{{ simulated.label }}</em>
        </div>
        <div v-if="missionStore.engine === 'offline'" class="daily-body">
          引擎离线：无法获取任务状态
        </div>
        <div v-else-if="receipt" class="daily-body">
          异常已闭环：任务 {{ receipt.taskId ?? '（未返回）' }}
          <template v-if="receipt.taskStatus"> · {{ receipt.taskStatus }}</template>
          <template v-if="evidenceCount !== null">；证据 {{ evidenceCount }} 件</template>
        </div>
        <div v-else-if="missionStore.mission" class="daily-body">
          任务 {{ missionStore.mission.missionId }} ·
          {{ PHASE_LABEL[missionStore.mission.phase] ?? missionStore.mission.phase }}
          <template v-if="task?.status">；工单 {{ task.status }}</template>
        </div>
        <div v-else class="daily-body">等待任务：在巡界面板下达巡检任务后此处显示任务联动状态</div>
      </section>

      <p v-if="note" class="note">{{ note }}</p>
    </aside>
  </transition>
</template>

<style scoped>
.info-card {
  position: fixed;
  top: 56px;
  right: 12px;
  z-index: 25;
  width: 320px;
  max-height: calc(100% - 120px);
  overflow-y: auto;
  background: rgba(22, 30, 39, 0.95);
  color: #e8ecef;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  padding: 14px 16px;
  font-size: 13px;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 10px;
}
.title {
  font-size: 15px;
  font-weight: 600;
}
.sid {
  font-size: 12px;
  color: #8fa3b5;
  font-family: monospace;
  margin-top: 2px;
}
.close {
  background: none;
  border: none;
  color: #8fa3b5;
  font-size: 20px;
  cursor: pointer;
  line-height: 1;
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.08);
}
.k {
  color: #8fa3b5;
  white-space: nowrap;
}
.v {
  text-align: right;
  word-break: break-all;
}
.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
.badge {
  font-style: normal;
  font-size: 11px;
  color: #1a1a1a;
  border-radius: 3px;
  padding: 1px 6px;
  margin-left: 6px;
  font-weight: 600;
}
.fields {
  margin-top: 6px;
}
.daily {
  margin-top: 12px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  padding: 10px;
}
.daily-title {
  font-weight: 600;
  margin-bottom: 6px;
}
.daily-body {
  color: #8fa3b5;
}
.note {
  margin-top: 10px;
  color: #f9a825;
  font-size: 12px;
  line-height: 1.6;
}
.slide-enter-active,
.slide-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease;
}
.slide-enter-from,
.slide-leave-to {
  transform: translateX(30px);
  opacity: 0;
}
</style>
