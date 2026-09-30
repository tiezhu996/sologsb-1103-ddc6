<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NAlert,
  NButton,
  NDatePicker,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui'
import BlankHint from '@/components/common/BlankHint.vue'
import ChannelChip from '@/components/common/ChannelChip.vue'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLiveStore } from '@/stores/liveStore'
import { useSessionStore } from '@/stores/sessionStore'
import {
  LIVE_CONFLICT_CHOICE_LABEL,
  LIVE_STATUS_LABEL,
  type LiveChannelFrame,
  type LiveConflict,
  type LiveConflictChoice,
  type LiveRun
} from '@/types/live'
import { buildLiveSchedule, canWalkCue, formatPredicted } from '@/utils/liveRecovery'
import { cueTotalSeconds, formatDateTime, formatSeconds, formatTransition } from '@/utils/fade'

const message = useMessage()
const dialog = useDialog()
const sessionStore = useSessionStore()
const cueStore = useCueStore()
const fixtureStore = useFixtureStore()
const liveStore = useLiveStore()

/* ---------------- 场次与记录选择 ---------------- */
const selectedSessionId = ref<string>(sessionStore.currentSessionId ?? '')

if (!selectedSessionId.value && sessionStore.sortedSessions.length > 0) {
  selectedSessionId.value = sessionStore.sortedSessions[0].id
}

const sessionOptions = computed(() =>
  sessionStore.sortedSessions.map((session) => ({ label: `${session.order}. ${session.title}`, value: session.id }))
)

function handleSessionChange(value: string | number | Array<string | number> | null): void {
  if (typeof value === 'string') {
    selectedSessionId.value = value
    sessionStore.setCurrentSession(value)
    const active = liveStore.activeRunOfSession(value)
    liveStore.setCurrentRun(active?.id ?? null)
  }
}

const session = computed(() => (selectedSessionId.value ? sessionStore.sessionById(selectedSessionId.value) : null))
const sessionCues = computed(() => (selectedSessionId.value ? cueStore.sortedCuesOfSession(selectedSessionId.value) : []))

const sessionRuns = computed(() => (selectedSessionId.value ? liveStore.runsOfSession(selectedSessionId.value) : []))

/** 当前操作的现场记录：优先显式选中，其次该场可恢复记录 */
const activeRun = computed<LiveRun | null>(() => {
  const explicit = liveStore.currentRunId ? liveStore.runById(liveStore.currentRunId) : null
  if (explicit && explicit.sessionId === selectedSessionId.value && explicit.status !== 'closed') return explicit
  return selectedSessionId.value ? liveStore.activeRunOfSession(selectedSessionId.value) : null
})

function focusRun(run: LiveRun): void {
  liveStore.setCurrentRun(run.id)
}

/* ---------------- 新建现场记录 ---------------- */
const showCreate = ref(false)
const createTitle = ref('')
const createNote = ref('')

function openCreate(): void {
  createTitle.value = session.value ? `${session.value.title} · 现场记录` : '现场记录'
  createNote.value = ''
  showCreate.value = true
}

async function submitCreate(): Promise<void> {
  if (!selectedSessionId.value) return
  if (sessionCues.value.length === 0) {
    message.warning('该场次还没有 Cue，无法开演')
    return
  }
  const created = await liveStore.startRun({
    sessionId: selectedSessionId.value,
    title: createTitle.value,
    note: createNote.value
  })
  if (!created) {
    message.error('开演失败：主表中找不到 Cue')
    return
  }
  message.success(`已开演，预置 ${created.currentCue?.cueNo ?? ''}，从现场开始记录`)
  showCreate.value = false
  liveStore.setCurrentRun(created.id)
}

/* ---------------- 时间轴与预计时刻 ---------------- */
const schedule = computed(() => (activeRun.value ? buildLiveSchedule(activeRun.value, sessionCues.value) : []))

const STATE_TAG: Record<string, { label: string; type: 'default' | 'success' | 'warning' | 'error' }> = {
  walked: { label: '已走过', type: 'success' },
  current: { label: '当前 Cue', type: 'warning' },
  upcoming: { label: '待走', type: 'default' },
  missing: { label: '主表已删', type: 'error' }
}

/* ---------------- 拉停 / 复演 ---------------- */
const resumeTimeMs = ref<number | null>(Date.now())

function syncResumePicker(run: LiveRun | null): void {
  resumeTimeMs.value = run?.resumedAt ? new Date(run.resumedAt).getTime() : Date.now()
}

function openResume(run: LiveRun): void {
  syncResumePicker(run)
  showResume.value = true
}

const showResume = ref(false)

async function submitResume(): Promise<void> {
  if (!activeRun.value || resumeTimeMs.value === null) return
  const updated = await liveStore.resume(activeRun.value.id, new Date(resumeTimeMs.value).toISOString())
  if (!updated) {
    message.error('复演失败')
    return
  }
  message.success('已按复演时刻继续，预计时刻已重算')
  showResume.value = false
}

async function doHalt(): Promise<void> {
  if (!activeRun.value) return
  await liveStore.halt(activeRun.value.id)
  message.warning('已拉停：当前 Cue、各通道电平与已走过列表已定格')
}

/* ---------------- 补走 / 跳回 ---------------- */
async function walk(cueId: string): Promise<void> {
  if (!activeRun.value) return
  const cue = cueStore.cueById(cueId)
  if (!canWalkCue(sessionCues.value, activeRun.value.currentCueId, cueId)) {
    message.warning('该 Cue 在当前 Cue 之前；要回到它请使用「跳回」')
    return
  }
  const updated = await liveStore.walkCue(activeRun.value.id, cueId)
  if (!updated) {
    message.error('补走失败：该 Cue 已不在主表或位于当前 Cue 之前')
    return
  }
  message.success(`已补走 ${cue?.cueNo ?? ''}，帧按计划电平更新`)
}

function walkEnabled(cueId: string): boolean {
  if (!activeRun.value) return false
  return canWalkCue(sessionCues.value, activeRun.value.currentCueId, cueId)
}

function confirmJumpBack(cueId: string): void {
  if (!activeRun.value) return
  const executed = activeRun.value.executed.find((item) => item.cueId === cueId)
  dialog.warning({
    title: '跳回 Cue',
    content: `将当前 Cue 跳回 ${executed?.cueNo ?? ''}，其后走过的 Cue 会从已走过列表截掉（可再补走），最后一帧复位为该 Cue 走出时快照。`,
    positiveText: '确认跳回',
    negativeText: '取消',
    onPositiveClick: async () => {
      const updated = await liveStore.jumpBack(activeRun.value!.id, cueId)
      if (!updated) {
        message.error('跳回失败')
        return
      }
      message.success(`已跳回 ${executed?.cueNo ?? ''}`)
    }
  })
}

/** 当前 Cue 在主表中的下一条（补走按钮） */
const nextPlannedCue = computed(() => {
  if (!activeRun.value) return null
  const currentIndex = sessionCues.value.findIndex((cue) => cue.id === activeRun.value?.currentCueId)
  if (currentIndex < 0) return sessionCues.value[0] ?? null
  return sessionCues.value[currentIndex + 1] ?? null
})

function canJumpBack(item: { state: string; cueId: string }): boolean {
  if (!activeRun.value || item.state === 'missing') return false
  const index = activeRun.value.executed.findIndex((entry) => entry.cueId === item.cueId)
  return index >= 0 && item.cueId !== activeRun.value.currentCueId
}

/** 走出按钮文案：当前已走过 → 重走；当前未走过（开演预置）→ 走出；待走 → 补走 */
function walkLabel(state: string, cueId: string): string {
  if (state === 'upcoming') return '补走'
  const alreadyWalked = Boolean(activeRun.value?.executed.some((entry) => entry.cueId === cueId))
  return alreadyWalked ? '重走本条' : '走出本条'
}

/* ---------------- 最后一帧微调 ---------------- */
async function setFrameIntensity(frame: LiveChannelFrame, value: number | null): Promise<void> {
  if (!activeRun.value) return
  await liveStore.patchFrame(activeRun.value.id, frame.fixtureId, { intensity: value ?? 0 })
}

async function setFrameColorTemp(frame: LiveChannelFrame, value: number | null): Promise<void> {
  if (!activeRun.value || value === null) return
  await liveStore.patchFrame(activeRun.value.id, frame.fixtureId, { colorTempK: value })
}

const frameFocusDrafts = ref<Record<string, string>>({})

function frameFocusValue(frame: LiveChannelFrame): string {
  return frameFocusDrafts.value[frame.fixtureId] ?? frame.focusNote
}

async function commitFrameFocus(frame: LiveChannelFrame): Promise<void> {
  if (!activeRun.value) return
  const draft = frameFocusDrafts.value[frame.fixtureId]
  if (draft === undefined) return
  const next = { ...frameFocusDrafts.value }
  delete next[frame.fixtureId]
  frameFocusDrafts.value = next
  if (draft !== frame.focusNote) {
    await liveStore.patchFrame(activeRun.value.id, frame.fixtureId, { focusNote: draft })
  }
}

async function resetFrame(): Promise<void> {
  if (!activeRun.value) return
  const updated = await liveStore.resetFrameFromPlan(activeRun.value.id)
  if (updated && updated !== activeRun.value) {
    message.success('最后一帧已按当前 Cue 计划电平重置')
  } else if (activeRun.value && !currentPlannedCue.value) {
    message.warning('当前 Cue 已不在主表，无法按计划重置帧')
  }
}

function fixtureOfFrame(frame: LiveChannelFrame) {
  return fixtureStore.fixtureById(frame.fixtureId)
}

/* ---------------- 冲突确认 ---------------- */
const pendingConflicts = computed<LiveConflict[]>(() => (activeRun.value ? liveStore.conflictsOf(activeRun.value) : []))

async function resolveOne(conflict: LiveConflict, choice: LiveConflictChoice): Promise<void> {
  if (!activeRun.value) return
  if (choice === 'take-master' && conflict.plannedMissing) {
    message.warning('计划侧已删除该 Cue / 通道，只能保留现场版')
    return
  }
  await liveStore.resolveConflict(activeRun.value.id, conflict, choice)
  message.success(choice === 'keep-live' ? '已保留现场版' : '已采用计划版并合并现场')
}

const resolvingAll = ref(false)

async function resolveAll(choice: LiveConflictChoice): Promise<void> {
  if (!activeRun.value || pendingConflicts.value.length === 0) return
  resolvingAll.value = true
  try {
    const target = pendingConflicts.value.filter((conflict) => !(choice === 'take-master' && conflict.plannedMissing))
    await liveStore.resolveAllConflicts(activeRun.value.id, target, choice)
    message.success(choice === 'keep-live' ? '全部冲突已按现场版确认' : '可合并冲突已全部采用计划版')
  } finally {
    resolvingAll.value = false
  }
}

/* ---------------- 历史记录 ---------------- */
function confirmClose(run: LiveRun): void {
  dialog.warning({
    title: '结束现场记录',
    content: `结束后「${run.title}」将归档为只读，不再出现在恢复入口，但记录仍保留在本地。`,
    positiveText: '确认结束',
    negativeText: '取消',
    onPositiveClick: async () => {
      await liveStore.closeRun(run.id)
      message.success('现场记录已归档')
    }
  })
}

function confirmRemove(run: LiveRun): void {
  dialog.warning({
    title: '删除现场记录',
    content: `将删除「${run.title}」的全部现场状态（不影响主表 Cue 与历史排演表），且无法恢复。`,
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await liveStore.removeRun(run.id)
      message.success('现场记录已删除')
    }
  })
}

const currentCueSnapshot = computed(() => activeRun.value?.currentCue ?? null)
const currentPlannedCue = computed(() =>
  activeRun.value?.currentCueId ? cueStore.cueById(activeRun.value.currentCueId) : null
)

function durationTextOf(sec: number): string {
  return formatSeconds(sec)
}

function predictedOf(cueId: string): string {
  const item = schedule.value.find((entry) => entry.cueId === cueId)
  return item ? formatPredicted(item) : '—'
}
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">现场恢复</h1>
        <p class="page__subtitle">
          拉停定格当前 Cue、各通道电平与已走过列表；重开从现场继续，可补走或跳回，预计时刻按复演时刻重算。
        </p>
      </div>
      <div class="page__actions">
        <NSelect
          :value="selectedSessionId || null"
          :options="sessionOptions"
          placeholder="选择场次"
          style="width: 260px"
          @update:value="handleSessionChange"
        />
        <NButton type="primary" :disabled="!session || Boolean(activeRun)" @click="openCreate">开演 / 新建记录</NButton>
      </div>
    </header>

    <NAlert v-if="!session" type="info" :bordered="false">
      还没有可恢复的场次。请先在场次编排中创建场次并插入 Cue。
    </NAlert>

    <template v-else>
      <NAlert v-if="!activeRun && sessionRuns.length === 0" type="info" :bordered="false">
        该场次还没有现场记录（旧数据无现场记录时按无记录处理，不影响主表与历史排演表）。点击右上角「开演 / 新建记录」开始。
      </NAlert>

      <template v-if="activeRun">
        <!-- 现场状态总览 -->
        <section class="panel">
          <div class="run-head">
            <div class="run-head__titles">
              <h2 class="panel__title" style="margin-bottom: 0">
                {{ activeRun.title }}
                <NTag
                  size="small"
                  :bordered="false"
                  :type="activeRun.status === 'halted' ? 'error' : activeRun.status === 'running' ? 'success' : 'default'"
                >
                  {{ LIVE_STATUS_LABEL[activeRun.status] }}
                </NTag>
              </h2>
              <p class="run-head__meta mono">
                开演 {{ formatDateTime(activeRun.startedAt) }}
                <template v-if="activeRun.stoppedAt"> · 拉停 {{ formatDateTime(activeRun.stoppedAt) }}</template>
                <template v-if="activeRun.resumedAt"> · 复演基准 {{ formatDateTime(activeRun.resumedAt) }}</template>
              </p>
            </div>
            <div class="run-head__actions">
              <NButton v-if="activeRun.status === 'running'" type="error" ghost @click="doHalt">拉停定格</NButton>
              <template v-else>
                <NButton type="primary" @click="openResume(activeRun)">设定复演时刻并继续</NButton>
              </template>
              <NButton quaternary @click="confirmClose(activeRun)">结束归档</NButton>
            </div>
          </div>

          <div class="stat-row">
            <div class="stat">
              <span class="stat__value mono">{{ activeRun.executed.length }}</span>
              <span class="stat__label">已走过 Cue</span>
            </div>
            <div class="stat">
              <span class="stat__value mono">{{ activeRun.currentCue?.cueNo ?? '—' }}</span>
              <span class="stat__label">当前 Cue</span>
            </div>
            <div class="stat">
              <span class="stat__value mono">{{ activeRun.frame.filter((item) => item.intensity > 0).length }}/{{ activeRun.frame.length }}</span>
              <span class="stat__label">亮着的通道</span>
            </div>
            <div class="stat">
              <span class="stat__value mono">{{ pendingConflicts.length }}</span>
              <span class="stat__label">待处理冲突</span>
            </div>
          </div>
        </section>

        <!-- 冲突两版对照 -->
        <section v-if="pendingConflicts.length > 0" class="panel conflict-panel">
          <div class="conflict-panel__head">
            <h2 class="panel__title" style="margin-bottom: 0">
              计划与现场两版冲突
              <span class="panel__title-tag">主表在走过之后改过同一 Cue 或通道，确认后才合并；未处理留到下次</span>
            </h2>
            <div class="conflict-panel__bulk">
              <NButton size="small" quaternary :loading="resolvingAll" @click="resolveAll('keep-live')">
                全部保留现场版
              </NButton>
              <NButton size="small" quaternary type="primary" :loading="resolvingAll" @click="resolveAll('take-master')">
                全部采用计划版
              </NButton>
            </div>
          </div>

          <div class="conflict-list">
            <article v-for="conflict in pendingConflicts" :key="conflict.signature" class="conflict-card">
              <div class="conflict-card__head">
                <NTag size="small" :type="conflict.kind === 'cue' ? 'warning' : 'info'" :bordered="false">
                  {{ conflict.kind === 'cue' ? 'Cue 改动' : `通道 CH${conflict.channel ?? '—'}` }}
                </NTag>
                <span class="conflict-card__cue mono">{{ conflict.cueNo }}</span>
                <span class="conflict-card__label">{{ conflict.cueLabel || '（未命名 Cue）' }}</span>
                <span v-if="conflict.plannedMissing" class="conflict-card__missing">计划侧已删除</span>
                <span v-if="conflict.liveMissing" class="conflict-card__missing">现场未上屏</span>
              </div>
              <div class="conflict-card__fields">
                <div v-for="field in conflict.fields" :key="field.label" class="conflict-field">
                  <span class="conflict-field__name">{{ field.label }}</span>
                  <span class="conflict-field__planned">计划：{{ field.planned ?? '—' }}</span>
                  <span class="conflict-field__live">现场：{{ field.live ?? '—' }}</span>
                </div>
              </div>
              <div class="conflict-card__actions">
                <NButton size="tiny" @click="resolveOne(conflict, 'keep-live')">{{ LIVE_CONFLICT_CHOICE_LABEL['keep-live'] }}</NButton>
                <NButton
                  size="tiny"
                  type="primary"
                  ghost
                  :disabled="conflict.plannedMissing"
                  @click="resolveOne(conflict, 'take-master')"
                >
                  {{ LIVE_CONFLICT_CHOICE_LABEL['take-master'] }}
                </NButton>
              </div>
            </article>
          </div>
        </section>

        <!-- 复演时间轴：已走过 / 当前 / 待走 + 预计时刻 -->
        <section class="panel">
          <h2 class="panel__title">
            复演时间轴
            <span class="panel__title-tag">预计时刻以复演时刻为基准重算，可补走待走 Cue 或跳回已走过 Cue</span>
          </h2>
          <div class="schedule-list">
            <div v-for="item in schedule" :key="`${item.cueId}-${item.state}`" class="schedule-row" :class="`schedule-row--${item.state}`">
              <NTag size="small" :type="STATE_TAG[item.state].type" :bordered="false">{{ STATE_TAG[item.state].label }}</NTag>
              <span class="schedule-row__no mono">{{ item.cueNo }}</span>
              <span class="schedule-row__label">{{ item.label || '（未填写提示语）' }}</span>
              <span class="schedule-row__time mono">
                <template v-if="item.state === 'walked'">实走 {{ formatDateTime(item.executedAt ?? '') }}</template>
                <template v-else-if="item.state === 'missing' && item.executedAt">
                  实走 {{ formatDateTime(item.executedAt) }}
                </template>
                <template v-else-if="item.predictedAt">预计 {{ formatPredicted(item) }}</template>
                <template v-else>—</template>
              </span>
              <span class="schedule-row__duration mono">{{ durationTextOf(item.totalSec) }}</span>
              <span class="toolbar__spacer" />
              <span class="schedule-row__actions">
                <NButton
                  v-if="item.state === 'upcoming' || item.state === 'current'"
                  size="tiny"
                  type="primary"
                  ghost
                  :disabled="!walkEnabled(item.cueId)"
                  @click="walk(item.cueId)"
                >
                  {{ walkLabel(item.state, item.cueId) }}
                </NButton>
                <NButton v-if="canJumpBack(item)" size="tiny" quaternary @click="confirmJumpBack(item.cueId)">跳回</NButton>
              </span>
            </div>
          </div>
          <p v-if="nextPlannedCue" class="schedule-next-hint">
            现场下一条主表 Cue：<span class="mono">{{ nextPlannedCue.cueNo }}</span>
            ，预计 {{ predictedOf(nextPlannedCue.id) }}
          </p>
        </section>

        <!-- 当前 Cue 两版状态 -->
        <section class="panel">
          <h2 class="panel__title">
            当前 Cue（灯控台最后一帧）
            <span class="panel__title-tag">拉停后可按实际输出微调；与主表差异会进入上方冲突清单</span>
          </h2>
          <div v-if="currentCueSnapshot" class="current-cue">
            <div class="current-cue__info">
              <p class="current-cue__no mono">
                {{ currentCueSnapshot.cueNo }}
                <NTag v-if="!currentPlannedCue" size="tiny" type="error" :bordered="false">主表已删</NTag>
              </p>
              <p class="current-cue__label">{{ currentCueSnapshot.label || '（未填写提示语）' }}</p>
              <p class="current-cue__transition mono">
                现场：{{ formatTransition(currentCueSnapshot) }}（{{ formatSeconds(cueTotalSeconds(currentCueSnapshot)) }}）
              </p>
              <p v-if="currentPlannedCue" class="current-cue__transition mono current-cue__transition--planned">
                计划：{{ formatTransition(currentPlannedCue) }}（{{ formatSeconds(cueTotalSeconds(currentPlannedCue)) }}）
              </p>
            </div>
            <NButton size="small" quaternary :disabled="!currentPlannedCue" @click="resetFrame">按计划重置帧</NButton>
          </div>

          <BlankHint
            v-if="activeRun.frame.length === 0"
            title="最后一帧没有通道电平"
            description="当前 Cue 未设定任何参与通道。可在电平编辑补设定后点「按计划重置帧」，或直接在下方无帧状态继续。"
          />

          <div v-else class="frame-table">
            <div class="frame-table__head">
              <span>通道</span>
              <span>亮度</span>
              <span>色温</span>
              <span>对焦说明</span>
            </div>
            <div v-for="frame in activeRun.frame" :key="frame.fixtureId" class="frame-row" :class="{ 'frame-row--off': frame.intensity === 0 }">
              <div class="frame-row__chip">
                <ChannelChip
                  :channel="frame.channel"
                  :position="frame.position"
                  :intensity="frame.intensity"
                  :gel="fixtureOfFrame(frame)?.gel ?? ''"
                  :fixture-type="frame.fixtureType"
                  size="small"
                />
                <NTag v-if="!fixtureOfFrame(frame)" size="tiny" type="error" :bordered="false">配接已删</NTag>
              </div>
              <div class="frame-row__control">
                <NInputNumber
                  :value="frame.intensity"
                  size="small"
                  :min="0"
                  :max="100"
                  :show-button="false"
                  style="width: 86px"
                  @update:value="(value) => setFrameIntensity(frame, value)"
                />
                <span class="frame-row__unit">%</span>
              </div>
              <div class="frame-row__control">
                <NInputNumber
                  :value="frame.colorTempK"
                  size="small"
                  :min="2700"
                  :max="6500"
                  :step="100"
                  :show-button="false"
                  style="width: 110px"
                  @update:value="(value) => setFrameColorTemp(frame, value)"
                />
                <span class="frame-row__unit">K</span>
              </div>
              <NInput
                :value="frameFocusValue(frame)"
                size="small"
                placeholder="对焦说明（失焦保存）"
                @update:value="(value) => (frameFocusDrafts = { ...frameFocusDrafts, [frame.fixtureId]: value })"
                @blur="commitFrameFocus(frame)"
                @keyup.enter="commitFrameFocus(frame)"
              />
            </div>
          </div>
        </section>
      </template>

      <!-- 历史现场记录 -->
      <section v-if="sessionRuns.length > 0" class="panel">
        <h2 class="panel__title">
          本场现场记录
          <span class="panel__title-tag">共 {{ sessionRuns.length }} 条；归档记录只读，不影响历史排演表</span>
        </h2>
        <div class="run-list">
          <article
            v-for="run in sessionRuns"
            :key="run.id"
            class="run-card"
            :class="{ 'run-card--active': activeRun?.id === run.id }"
            @click="run.status === 'closed' ? null : focusRun(run)"
          >
            <div class="run-card__head">
              <span class="run-card__title">{{ run.title }}</span>
              <NTag size="small" :bordered="false" :type="run.status === 'halted' ? 'error' : run.status === 'running' ? 'success' : 'default'">
                {{ LIVE_STATUS_LABEL[run.status] }}
              </NTag>
            </div>
            <p class="run-card__meta mono">
              开演 {{ formatDateTime(run.startedAt) }} · 已走 {{ run.executed.length }} 条
              <template v-if="run.currentCue"> · 当前 {{ run.currentCue.cueNo }}</template>
            </p>
            <div class="run-card__actions" @click.stop>
              <NButton v-if="run.status !== 'closed'" size="tiny" type="primary" ghost @click="focusRun(run)">进入恢复</NButton>
              <NButton v-if="run.status !== 'closed'" size="tiny" quaternary @click="confirmClose(run)">归档</NButton>
              <NButton size="tiny" quaternary type="error" @click="confirmRemove(run)">删除</NButton>
            </div>
          </article>
        </div>
      </section>
    </template>

    <!-- 新建记录 -->
    <NModal v-model:show="showCreate" preset="card" title="开演 / 新建现场记录" class="form-modal" :mask-closable="false">
      <NForm label-placement="left" label-width="80">
        <NFormItem label="记录名称">
          <NInput v-model:value="createTitle" placeholder="例如：首演场 · 现场记录" />
        </NFormItem>
        <NFormItem label="备注">
          <NInput v-model:value="createNote" type="textarea" :rows="2" placeholder="现场特殊情况、备用人手等" />
        </NFormItem>
      </NForm>
      <p class="modal-tip">开演后预置主表第一条 Cue（{{ sessionCues[0]?.cueNo ?? '' }}），走出时才记入已走过列表。</p>
      <template #footer>
        <div class="modal-footer">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" @click="submitCreate">开演</NButton>
        </div>
      </template>
    </NModal>

    <!-- 复演时刻 -->
    <NModal v-model:show="showResume" preset="card" title="设定复演时刻" class="form-modal" :mask-closable="false">
      <NForm label-placement="left" label-width="80">
        <NFormItem label="复演时刻">
          <NDatePicker v-model:value="resumeTimeMs" type="datetime" format="yyyy-MM-dd HH:mm:ss" clearable style="width: 260px" />
        </NFormItem>
      </NForm>
      <p class="modal-tip">当前 Cue 预计时刻对齐到该时刻，之后各条按主表过渡时长依次重算（跨天自动 +N 天）。</p>
      <template #footer>
        <div class="modal-footer">
          <NButton @click="showResume = false">取消</NButton>
          <NButton type="primary" :disabled="resumeTimeMs === null" @click="submitResume">继续演出</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.run-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.run-head__meta {
  margin: 8px 0 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.run-head__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.conflict-panel__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.conflict-panel__bulk {
  display: flex;
  align-items: center;
  gap: 8px;
}

.conflict-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}

.conflict-card {
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(232, 168, 84, 0.06);
  border: 1px solid rgba(232, 168, 84, 0.32);
}

.conflict-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.conflict-card__cue {
  font-weight: 600;
  color: #f2b544;
}

.conflict-card__label {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.72);
}

.conflict-card__missing {
  font-size: 12px;
  color: #ff9a9a;
}

.conflict-card__fields {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 10px 0;
}

.conflict-field {
  display: flex;
  gap: 14px;
  font-size: 12px;
  flex-wrap: wrap;
}

.conflict-field__name {
  min-width: 56px;
  color: rgba(255, 255, 255, 0.5);
}

.conflict-field__planned {
  color: rgba(120, 190, 255, 0.85);
}

.conflict-field__live {
  color: rgba(242, 181, 68, 0.9);
}

.conflict-card__actions {
  display: flex;
  gap: 8px;
}

.schedule-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.schedule-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  flex-wrap: wrap;
}

.schedule-row--current {
  border-color: rgba(242, 181, 68, 0.6);
  background: rgba(242, 181, 68, 0.07);
}

.schedule-row--walked {
  opacity: 0.75;
}

.schedule-row--missing {
  border-color: rgba(232, 84, 84, 0.4);
}

.schedule-row__no {
  font-weight: 600;
  color: #f2b544;
  min-width: 56px;
}

.schedule-row__label {
  font-size: 13px;
  min-width: 160px;
}

.schedule-row__time {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
}

.schedule-row__duration {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.42);
}

.schedule-row__actions {
  display: flex;
  gap: 6px;
}

.schedule-next-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.current-cue {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.current-cue__no {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #f2b544;
  display: flex;
  align-items: center;
  gap: 8px;
}

.current-cue__label {
  margin: 6px 0;
  font-size: 13px;
}

.current-cue__transition {
  margin: 2px 0;
  font-size: 12px;
  color: rgba(242, 181, 68, 0.85);
}

.current-cue__transition--planned {
  color: rgba(120, 190, 255, 0.75);
}

.frame-table {
  margin-top: 12px;
}

.frame-table__head,
.frame-row {
  display: grid;
  grid-template-columns: 280px 150px 170px 1fr;
  align-items: center;
  gap: 12px;
  padding: 9px 4px;
}

.frame-table__head {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.42);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.frame-row {
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.frame-row--off {
  opacity: 0.55;
}

.frame-row__chip {
  display: flex;
  align-items: center;
  gap: 8px;
}

.frame-row__control {
  display: flex;
  align-items: center;
  gap: 6px;
}

.frame-row__unit {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.run-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}

.run-card {
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.run-card--active {
  border-color: rgba(242, 181, 68, 0.6);
}

.run-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.run-card__title {
  font-size: 14px;
  font-weight: 600;
}

.run-card__meta {
  margin: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.run-card__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.form-modal {
  width: 520px;
  max-width: 92vw;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.modal-tip {
  margin: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}
</style>
