<script setup lang="ts">
// 巡界操作面板：任务下达 / 提案与审批 / 上下文摘要 / 证据提交 / 事件日志。
// 所有数字与状态来自引擎 API；模型状态只显示后端显式声明，回退不伪称在线。
import { computed, ref } from 'vue'
import { missionStore } from '../agent/missionStore'
import { avatarStore } from '../agent/avatar'
import { createDemoMission, createMission, decide, sendAvatarText, submitRoofEvidence } from '../agent/controller'
import { TRUTH_META } from '../constants/colors'
import { fixture } from '../fixture'

const objective = ref('')
const avatarText = ref('')
const collapsed = ref(false)

/** 一键示例：原样发送给后端 interpret，前端不做本地语义猜测 */
const AVATAR_PRESETS = [
  { label: '跑到 B2 楼前', text: '跑到 B2 楼前' },
  { label: '飞到 B2 屋顶', text: '飞到 B2 屋顶' },
  { label: '飞到设备并维修', text: '飞到 B2 逆变器维修 7 号异常组串' },
  { label: '停下', text: '停下' },
]

function sendAvatar(text: string): void {
  const t = text.trim()
  if (!t) return
  avatarText.value = ''
  void sendAvatarText(t)
}

const AVAILABILITY_LABEL: Record<string, string> = {
  available: '可用',
  partial: '部分',
  stale: '过期',
  unavailable: '不可用',
}

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

const engineLabel = computed(() =>
  missionStore.engine === 'online' ? '引擎在线' : missionStore.engine === 'offline' ? '引擎离线' : '引擎状态未知',
)
const modelLabel = computed(() =>
  missionStore.modelMode === 'online'
    ? '模型在线'
    : missionStore.modelMode === 'fallback'
      ? '模型不可用 · 确定性回退'
      : '模型状态未知',
)
const canSubmitEvidence = computed(() => {
  const checkpoint = fixture.checkpoints.find((c) => c.id === missionStore.arrivedCheckpointId)
  return checkpoint?.kind === 'roof' && missionStore.mission?.phase === 'awaiting-evidence'
})

function truthCss(truth?: string): string {
  return (TRUTH_META as Record<string, { css: string }>)[truth ?? '']?.css ?? '#666'
}

function submit(): void {
  const text = objective.value.trim()
  if (!text) return
  objective.value = ''
  void createMission(text)
}
</script>

<template>
  <aside class="agent-panel" :class="{ collapsed }">
    <header class="head" @click="collapsed = !collapsed">
      <span class="title">巡界 · 任务闭环</span>
      <span class="sim-tag">数字现场 / 仿真动作</span>
      <span class="caret">{{ collapsed ? '▸' : '▾' }}</span>
    </header>

    <div v-show="!collapsed" class="body">
      <p class="sim-banner">数字现场仿真，不控制真实设备</p>

      <section class="avatar">
        <div class="sec-title">
          数字运维员（仿真）
          <em class="motion" :data-m="avatarStore.motion">{{ avatarStore.motion }}</em>
        </div>
        <div class="btn-row presets">
          <button v-for="p in AVATAR_PRESETS" :key="p.text" class="preset" @click="sendAvatar(p.text)">
            {{ p.label }}
          </button>
        </div>
        <input
          v-model="avatarText"
          class="avatar-input"
          placeholder="对数字运维员说话，例如：向前跑 10 米 / 回运维点"
          @keydown.enter.exact.prevent="sendAvatar(avatarText)"
        />
        <div v-if="avatarStore.reply" class="kv reply">后端回复：{{ avatarStore.reply }}</div>
        <div v-if="avatarStore.lastCommands.length" class="kv cmds">
          命令：{{ avatarStore.lastCommands.join('；') }}
        </div>
        <div v-if="avatarStore.error" class="error">{{ avatarStore.error }}</div>
        <div v-if="avatarStore.repair" class="repair">
          <div class="kv">维修仿真：{{ avatarStore.repair.targetId }} · {{ avatarStore.repair.phase }}</div>
          <div class="bar"><i :style="{ width: avatarStore.repair.progress + '%' }"></i></div>
        </div>
      </section>

      <section class="status-row">
        <span class="pill" :class="missionStore.engine">{{ engineLabel }}</span>
        <span class="pill" :class="missionStore.modelMode">{{ modelLabel }}</span>
      </section>
      <p v-if="missionStore.modelMode === 'fallback'" class="fallback-note">
        {{ missionStore.modelNote || '模型不可用，当前为确定性回退流程（非真实 LLM 输出）' }}
      </p>
      <p v-if="missionStore.error" class="error">{{ missionStore.error }}</p>

      <section class="create">
        <textarea
          v-model="objective"
          rows="2"
          placeholder="输入巡检任务，例如：去看一下 B2 屋顶这个异常"
          @keydown.enter.exact.prevent="submit"
        ></textarea>
        <div class="btn-row">
          <button :disabled="!objective.trim()" @click="submit">下达任务</button>
          <button class="demo" @click="createDemoMission">演示：检查 B2 屋顶异常</button>
        </div>
      </section>

      <section v-if="missionStore.mission" class="mission">
        <div class="sec-title">
          任务 {{ missionStore.mission.missionId }}
          <em class="phase">{{ PHASE_LABEL[missionStore.mission.phase] ?? missionStore.mission.phase }}</em>
        </div>
        <div class="kv">目标：{{ missionStore.mission.objective }}</div>
        <div v-if="missionStore.mission.inspectionTaskId" class="kv">
          巡检单：{{ missionStore.mission.inspectionTaskId }}
        </div>

        <ol v-if="missionStore.mission.plan?.steps?.length" class="steps">
          <li v-for="s in missionStore.mission.plan!.steps" :key="s.id" :class="`st-${s.status}`">
            {{ s.title }}<span v-if="s.targetId" class="tid">{{ s.targetId }}</span>
          </li>
        </ol>
      </section>

      <section v-if="missionStore.context.length" class="context">
        <div class="sec-title">上下文（{{ missionStore.context.length }}）</div>
        <div v-for="c in missionStore.context" :key="c.key" class="ctx-item">
          <span class="ctx-key">{{ c.key }}</span>
          <span class="ctx-meta">
            <em class="badge avail" :data-a="c.availability">{{ AVAILABILITY_LABEL[c.availability] ?? c.availability }}</em>
            <em v-if="c.truth" class="badge" :style="{ background: truthCss(c.truth) }">{{ c.truth }}</em>
            <span class="refs">来源 ×{{ c.sourceRefs.length }}</span>
          </span>
        </div>
      </section>

      <section v-if="missionStore.proposal" class="proposal">
        <div class="sec-title">建议提案</div>
        <div v-if="missionStore.proposal.summary" class="kv">{{ missionStore.proposal.summary }}</div>
        <div v-if="missionStore.proposal.targetId" class="kv">目标：{{ missionStore.proposal.targetId }}</div>
        <div v-if="missionStore.proposal.reason" class="kv">原因：{{ missionStore.proposal.reason }}</div>
        <div v-if="missionStore.proposal.requiredEvidence?.length" class="kv">
          证据要求：{{ missionStore.proposal.requiredEvidence.join('、') }}
        </div>

        <div v-if="missionStore.pendingApproval" class="approval">
          <div class="kv warn">
            待审批动作：{{ missionStore.pendingApproval.requestedActions.join('、') || '（后端未列出）' }}
          </div>
          <div class="kv">影响范围：仅数字仿真（digital-simulation-only）</div>
          <div class="btn-row">
            <button class="approve" @click="decide('approve')">同意</button>
            <button class="reject" @click="decide('reject')">拒绝</button>
          </div>
        </div>
      </section>

      <section class="evidence">
        <div class="sec-title">证据</div>
        <div class="kv">
          任务闭环执行器：
          <template v-if="missionStore.executorState === 'moving'">行进中（仿真）…</template>
          <template v-else-if="missionStore.arrivedCheckpointId">已到达 {{ missionStore.arrivedCheckpointId }}</template>
          <template v-else-if="missionStore.executorState === 'failed'">导航失败</template>
          <template v-else>待命于运维点</template>
        </div>
        <div class="btn-row">
          <button :disabled="!canSubmitEvidence" @click="submitRoofEvidence">提交屋面证据</button>
        </div>
        <div v-if="missionStore.mission?.evidenceRefs?.length" class="kv">
          已登记证据：{{ missionStore.mission.evidenceRefs.join('、') }}
        </div>
      </section>

      <section class="log">
        <div class="sec-title">事件日志</div>
        <div class="log-body">
          <div v-for="(l, i) in missionStore.log" :key="i" class="log-line">
            <span class="ts">{{ l.ts }}</span>{{ l.text }}
          </div>
        </div>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.agent-panel {
  position: fixed;
  top: 56px;
  left: 12px;
  z-index: 25;
  width: 340px;
  max-height: calc(100% - 120px);
  display: flex;
  flex-direction: column;
  background: rgba(22, 30, 39, 0.95);
  color: #e8ecef;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  font-size: 13px;
}
.sim-banner {
  margin: 4px 0 8px;
  padding: 6px 8px;
  border: 1px solid rgba(249, 168, 37, 0.5);
  border-radius: 6px;
  background: rgba(249, 168, 37, 0.12);
  color: #f9a825;
  font-size: 12px;
  text-align: center;
}
.avatar .sec-title {
  display: flex;
  align-items: center;
}
.motion {
  font-style: normal;
  font-size: 11px;
  font-weight: 700;
  margin-left: auto;
  border-radius: 3px;
  padding: 1px 8px;
  background: rgba(255, 255, 255, 0.1);
  color: #8fa3b5;
  letter-spacing: 1px;
}
.motion[data-m='WALK'] {
  background: rgba(76, 175, 80, 0.25);
  color: #a5d6a7;
}
.motion[data-m='RUN'] {
  background: rgba(0, 229, 255, 0.2);
  color: #00e5ff;
}
.motion[data-m='FLY'] {
  background: rgba(171, 71, 188, 0.3);
  color: #ce93d8;
}
.motion[data-m='JUMP'] {
  background: rgba(255, 179, 0, 0.25);
  color: #ffb300;
}
.motion[data-m='REPAIR'] {
  background: rgba(244, 67, 54, 0.25);
  color: #ef9a9a;
}
.presets {
  flex-wrap: wrap;
}
button.preset {
  border-color: rgba(0, 229, 255, 0.4);
  color: #b2ebf2;
  font-size: 11px;
  padding: 5px 9px;
}
.avatar-input {
  width: 100%;
  box-sizing: border-box;
  margin-top: 8px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #e8ecef;
  padding: 7px 8px;
  font-size: 12px;
  font-family: inherit;
}
.reply {
  color: #00e5ff;
}
.cmds {
  font-family: monospace;
  font-size: 11px;
  color: #8fa3b5;
}
.repair .bar {
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
  margin-top: 4px;
}
.repair .bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #f9a825, #00e5ff);
  transition: width 0.25s;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
}
.title {
  font-weight: 600;
  font-size: 14px;
}
.sim-tag {
  font-size: 11px;
  color: #00e5ff;
  border: 1px solid rgba(0, 229, 255, 0.4);
  border-radius: 3px;
  padding: 1px 6px;
}
.caret {
  margin-left: auto;
  color: #8fa3b5;
}
.body {
  overflow-y: auto;
  padding: 0 14px 12px;
}
.status-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.pill {
  font-size: 11px;
  border-radius: 10px;
  padding: 2px 10px;
  background: rgba(255, 255, 255, 0.08);
  color: #8fa3b5;
}
.pill.online {
  background: rgba(76, 175, 80, 0.2);
  color: #81c784;
}
.pill.offline {
  background: rgba(244, 67, 54, 0.2);
  color: #e57373;
}
.pill.fallback {
  background: rgba(249, 168, 37, 0.2);
  color: #f9a825;
}
.fallback-note {
  color: #f9a825;
  font-size: 12px;
  margin: 0 0 8px;
}
.error {
  color: #e57373;
  font-size: 12px;
  margin: 0 0 8px;
}
.create textarea {
  width: 100%;
  box-sizing: border-box;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #e8ecef;
  padding: 8px;
  font-size: 13px;
  resize: vertical;
  font-family: inherit;
}
.btn-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
button {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #e8ecef;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
button.demo {
  border-color: rgba(0, 229, 255, 0.5);
  color: #00e5ff;
}
button.approve {
  background: rgba(76, 175, 80, 0.25);
  border-color: rgba(76, 175, 80, 0.6);
  color: #a5d6a7;
}
button.reject {
  background: rgba(244, 67, 54, 0.2);
  border-color: rgba(244, 67, 54, 0.5);
  color: #ef9a9a;
}
section {
  margin-top: 12px;
}
.sec-title {
  font-weight: 600;
  margin-bottom: 6px;
}
.phase {
  font-style: normal;
  font-size: 11px;
  background: rgba(0, 229, 255, 0.15);
  color: #00e5ff;
  border-radius: 3px;
  padding: 1px 6px;
  margin-left: 6px;
}
.kv {
  padding: 3px 0;
  color: #c7d2dc;
  word-break: break-all;
}
.kv.warn {
  color: #f9a825;
}
.steps {
  margin: 6px 0 0;
  padding-left: 18px;
}
.steps li {
  padding: 2px 0;
  color: #8fa3b5;
}
.steps li.st-active {
  color: #00e5ff;
}
.steps li.st-done {
  color: #81c784;
}
.steps li.st-blocked {
  color: #e57373;
}
.tid {
  font-family: monospace;
  font-size: 11px;
  margin-left: 6px;
  color: #8fa3b5;
}
.ctx-item {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.08);
}
.ctx-key {
  word-break: break-all;
}
.ctx-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.badge {
  font-style: normal;
  font-size: 11px;
  color: #1a1a1a;
  border-radius: 3px;
  padding: 1px 6px;
  font-weight: 600;
}
.badge.avail {
  background: #9e9e9e;
}
.badge.avail[data-a='available'] {
  background: #81c784;
}
.badge.avail[data-a='partial'] {
  background: #f9a825;
}
.badge.avail[data-a='stale'] {
  background: #ff8a65;
}
.badge.avail[data-a='unavailable'] {
  background: #e57373;
}
.refs {
  font-size: 11px;
  color: #8fa3b5;
}
.approval {
  margin-top: 8px;
  border: 1px solid rgba(249, 168, 37, 0.4);
  border-radius: 6px;
  padding: 8px;
}
.log-body {
  max-height: 140px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 6px;
  padding: 6px 8px;
}
.log-line {
  font-size: 11px;
  color: #9fb2c2;
  padding: 1px 0;
  word-break: break-all;
}
.ts {
  color: #5c7186;
  margin-right: 6px;
  font-family: monospace;
}
</style>
