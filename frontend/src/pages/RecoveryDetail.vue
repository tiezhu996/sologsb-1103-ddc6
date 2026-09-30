<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NDatePicker,
  NInputNumber,
  NPopconfirm,
  NRadioGroup,
  NRadio,
  NTag,
  useMessage
} from 'naive-ui'
import ChannelChip from '@/components/common/ChannelChip.vue'
import FadeBar from '@/components/common/FadeBar.vue'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'
import { useRecoveryStore } from '@/stores/recoveryStore'
import { useSessionStore } from '@/stores/sessionStore'
import { COLOR_TEMP_MAX, COLOR_TEMP_MIN } from '@/types/level'
import type { RecoveryConflict, RecoveryResolution, RecoveryTimelineEntry } from '@/types/live'
import { cueTotalSeconds, formatDateTime, formatSeconds, formatTransition } from '@/utils/fade'
import {
  buildRecoveryTimeline,
  computeRecoveryEta,
  countPendingConflicts,
  currentSnapshotOf,
  detectRecoveryConflicts,
  formatClockTime
} from '@/utils/recovery'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const sessionStore = useSessionStore()
const cueStore = useCueStore()
const fixtureStore = useFixtureStore()
const levelStore = useLevelStore()
const recoveryStore = useRecoveryStore()

const recoveryId = computed(() => String(route.params.id ?? ''))
const recovery = computed(() => recoveryStore.recoveryById(recoveryId.value))
const session = computed(() => (recovery.value ? sessionStore.sessionById(recovery.value.sessionId) : null))
const masterCues = computed(() =>
  recovery.value ? cueStore.sortedCuesOfSession(recovery.value.sessionId) : []
)

const timeline = computed<RecoveryTimelineEntry[]>(() =>
  recovery.value ? buildRecoveryTimeline(recovery.value, masterCues.value) : []
)

const etaList = computed(() =>
  recovery.value ? computeRecoveryEta(recovery.value, timeline.value) : []
)
const etaByCue = computed(() => new Map(etaList.value.map((eta) => [eta.cueId, eta])))

/** 进入页面与主表 / 恢复单变化时重算冲突，已做处置沿用上次选择 */
function refreshConflicts(): void {
  const rec = recovery.value
  if (!rec) return
  const detected = detectRecoveryConflicts(
    rec,
    cueStore.cuesOfSession(rec.sessionId),
    levelStore.levels,
    fixtureStore.fixturesOfSession(rec.sessionId),
    recoveryStore.conflictsOf(rec.id)
  )
  recoveryStore.setConflicts(rec.id, detected)
}

watch(
  recovery,
  () => refreshConflicts(),
  { immediate: true }
)

const conflicts = computed<RecoveryConflict[]>(() =>
  recovery.value ? recoveryStore.conflictsOf(recovery.value.id) : []
)
const pendingCount = computed(() => countPendingConflicts(conflicts.value))
const resolvedCount = computed(() => conflicts.value.length - pendingCount.value)

const currentEntry = computed(() =>
  timeline.value.find((entry) => entry.cueId === recovery.value?.currentCueId) ?? null
)
const currentSnapshot = computed(() => (recovery.value ? currentSnapshotOf(recovery.value) : null))

const orderedCueIds = computed(() => timeline.value.map((entry) => entry.cueId))
const nextEntry = computed<RecoveryTimelineEntry | null>(() => {
  const rec = recovery.value
  if (!rec || !rec.currentCueId) return timeline.value[0] ?? null
  const index = orderedCueIds.value.indexOf(rec.currentCueId)
  return index >= 0 ? timeline.value[index + 1] ?? null : null
})

const resumeAtMs = computed<number | null>(() => {
  const t = recovery.value ? new Date(recovery.value.resumeAt).getTime() : NaN
  return Number.isFinite(t) ? t : null
})

const playedTimelineCount = computed(() => timeline.value.filter((entry) => entry.state === 'played').length)
const pendingTimelineCount = computed(() => timeline.value.filter((entry) => entry.state === 'pending').length)

function setResolution(conflict: RecoveryConflict, resolution: RecoveryResolution): void {
  if (!recovery.value) return
  recoveryStore.setConflictResolution(recovery.value.id, conflict, resolution)
}

async function applyMerge(): Promise<void> {
  if (!recovery.value) return
  const pending = pendingCount.value
  if (conflicts.value.length > 0 && pending === conflicts.value.length) {
    message.warning('请先对冲突选择「采纳计划」或「采纳现场」，未处理项会保留到下次')
    return
  }
  const result = await recoveryStore.mergeResolved(recovery.value.id)
  refreshConflicts()
  if (result.merged > 0) {
    message.success(`已按确认结果合并 ${result.merged} 项${result.pending > 0 ? `，${result.pending} 项未处理留到下次` : ''}`)
  } else if (result.pending > 0) {
    message.info(`没有可合并的已确认项，${result.pending} 项未处理保留到下次`)
  } else {
    message.info('没有需要合并的冲突')
  }
}

async function onResumeAtChange(value: number | null): Promise<void> {
  if (!recovery.value || value === null) return
  await recoveryStore.setResumeAt(recovery.value.id, new Date(value).toISOString())
}

async function advanceCurrent(): Promise<void> {
  if (!recovery.value || !recovery.value.currentCueId) return
  const nowIso = new Date().toISOString()
  await recoveryStore.advance(recovery.value.id, nextEntry.value?.cueId ?? null, nowIso)
  message.success(nextEntry.value ? `已补走，当前 Cue → ${nextEntry.value.cueNo}` : '当前 Cue 已计入走过，本场已到末尾')
}

async function jumpTo(entry: RecoveryTimelineEntry): Promise<void> {
  if (!recovery.value) return
  await recoveryStore.jumpBack(recovery.value.id, entry.cueId)
  message.success(`已跳回 ${entry.cueNo}，其后 Cue 回退为待走`)
}

async function setCurrent(entry: RecoveryTimelineEntry): Promise<void> {
  if (!recovery.value) return
  await recoveryStore.setCurrentCue(recovery.value.id, entry.cueId)
  message.success(`已定位到 ${entry.cueNo}`)
}

async function updateIntensity(key: string, value: number | null): Promise<void> {
  if (!recovery.value) return
  await recoveryStore.updateFrameChannel(recovery.value.id, key, { intensity: value ?? 0 })
}

async function updateTemp(key: string, value: number | null): Promise<void> {
  if (!recovery.value || value === null) return
  await recoveryStore.updateFrameChannel(recovery.value.id, key, { colorTempK: value })
}

async function resetFrame(): Promise<void> {
  if (!recovery.value) return
  await recoveryStore.resetFrameToCurrent(recovery.value.id)
  message.success('末帧已重置为当前 Cue 的计划电平')
}

async function finishRecovery(): Promise<void> {
  if (!recovery.value) return
  if (pendingCount.value > 0) {
    message.warning(`还有 ${pendingCount.value} 项冲突未处理，确认后再完结；未处理项会保留`)
    return
  }
  await recoveryStore.finish(recovery.value.id)
  message.success('演出已恢复，现场恢复单归档完结')
}

async function reopen(): Promise<void> {
  if (!recovery.value) return
  await recoveryStore.reopen(recovery.value.id)
  message.success('已重新打开恢复单')
}

function frameFixture(channel: { fixtureId: string | null; channel: number }) {
  if (channel.fixtureId) {
    const fixture = fixtureStore.fixtureById(channel.fixtureId)
    if (fixture) return fixture
  }
  return fixtureStore.fixturesOfSession(recovery.value?.sessionId ?? '').find((f) => f.channel === channel.channel) ?? null
}

function goBack(): void {
  void router.push('/recoveries')
}

const litFrame = computed(() => (recovery.value ? recovery.value.frame.filter((c) => c.intensity > 0) : []))

function stateTag(state: RecoveryTimelineEntry['state']): { text: string; type: 'success' | 'warning' | 'default' } {
  if (state === 'played') return { text: '已走过', type: 'success' }
  if (state === 'current') return { text: '当前', type: 'warning' }
  return { text: '待走', type: 'default' }
}
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">现场恢复台 · {{ recovery?.title ?? '未找到记录' }}</h1>
        <p class="page__subtitle" v-if="recovery">
          {{ session ? `${session.order}. ${session.title}` : '所属场次已删除' }} ·
          拉停于 {{ formatDateTime(recovery.stoppedAt) }} ·
          <NTag size="small" :bordered="false" :type="recovery.status === '进行中' ? 'warning' : 'default'">{{ recovery.status }}</NTag>
        </p>
      </div>
      <div class="page__actions">
        <NButton @click="goBack">返回列表</NButton>
        <NButton v-if="recovery?.status === '已完结'" @click="reopen">重新打开</NButton>
        <NButton v-else type="primary" @click="finishRecovery">完结归档</NButton>
      </div>
    </header>

    <NAlert v-if="!recovery" type="warning" :bordered="false">
      该现场恢复单不存在或已被删除。
    </NAlert>

    <template v-else>
      <!-- 计划 vs 现场 冲突 -->
      <section class="panel">
        <div class="conflict-head">
          <h2 class="panel__title">
            计划 vs 现场 比对
            <span class="panel__title-tag">
              共 {{ conflicts.length }} 项 · 已确认 {{ resolvedCount }} · 未处理 {{ pendingCount }}
            </span>
          </h2>
          <NButton type="primary" size="small" :disabled="resolvedCount === 0" @click="applyMerge">
            按确认结果合并到主表
          </NButton>
        </div>

        <NAlert v-if="conflicts.length === 0" type="success" :bordered="false" class="conflict-ok">
          主表与拉停现场记录一致，无需合并；可直接从现场继续。
        </NAlert>

        <div v-else class="conflict-list">
          <article
            v-for="(conflict, index) in conflicts"
            :key="`${conflict.kind}-${conflict.cueId}-${conflict.fixtureId ?? ''}`"
            class="conflict-item"
            :class="{ 'conflict-item--pending': conflict.resolution === 'pending' }"
          >
            <div class="conflict-item__head">
              <span class="conflict-item__index mono">{{ index + 1 }}</span>
              <NTag size="tiny" :bordered="false" :type="conflict.kind.startsWith('missing') ? 'error' : 'warning'">
                {{ conflict.kind === 'cue' ? 'Cue 改动' : conflict.kind === 'channel' ? '通道电平' : conflict.kind === 'missing-cue' ? 'Cue 已删' : '通道已删' }}
              </NTag>
              <span class="conflict-item__msg">{{ conflict.message }}</span>
            </div>

            <!-- Cue 字段差异 -->
            <table v-if="conflict.fieldDiffs && conflict.fieldDiffs.length" class="diff-table">
              <thead>
                <tr><th>字段</th><th>主表（计划）</th><th>现场（拉停）</th></tr>
              </thead>
              <tbody>
                <tr v-for="diff in conflict.fieldDiffs" :key="diff.field">
                  <td class="muted">{{ diff.label }}</td>
                  <td>{{ diff.planValue === '' ? '（空）' : diff.planValue }}</td>
                  <td class="accent">{{ diff.liveValue === '' ? '（空）' : diff.liveValue }}</td>
                </tr>
              </tbody>
            </table>

            <!-- 通道电平差异 -->
            <div v-if="conflict.kind === 'channel'" class="diff-channel mono">
              <span>计划：{{ conflict.planIntensity === null ? '未设电平' : `${conflict.planIntensity}% / ${conflict.planColorTempK}K` }}</span>
              <span class="diff-arrow">↔</span>
              <span class="accent">现场：{{ conflict.liveIntensity }}% / {{ conflict.liveColorTempK }}K</span>
            </div>

            <div class="conflict-item__choice">
              <NRadioGroup
                :value="conflict.resolution"
                :disabled="recovery.status === '已完结' || conflict.kind === 'missing-fixture'"
                @update:value="(v) => setResolution(conflict, v as RecoveryResolution)"
              >
                <NRadio value="plan">采纳计划（保持主表）</NRadio>
                <NRadio value="live">采纳现场（写回主表）</NRadio>
                <NRadio value="pending">暂不处理（留到下次）</NRadio>
              </NRadioGroup>
              <span v-if="conflict.kind === 'missing-fixture'" class="muted">
                通道已不在配接表，需人工重新配接后再处理，将一直保留。
              </span>
            </div>
          </article>
        </div>
        <p class="conflict-foot muted">
          仅在点击「合并到主表」后才改写主表；选择「暂不处理」的冲突会随恢复单保留，下次打开继续处理。
        </p>
      </section>

      <!-- 当前 Cue + 复演时刻 + 末帧 -->
      <section class="panel">
        <h2 class="panel__title">拉停定格 · 现场最后一帧</h2>
        <div class="current-grid">
          <div class="current-cue">
            <p class="current-cue__label">当前 Cue</p>
            <template v-if="currentEntry">
              <p class="current-cue__no mono">{{ currentEntry.cueNo }}
                <NTag size="tiny" :bordered="false" type="warning">现场定格</NTag>
              </p>
              <p class="current-cue__text">{{ currentEntry.label || '（无提示语）' }}</p>
              <p class="current-cue__text mono">{{ formatTransition(currentSnapshot ?? currentEntry) }}</p>
              <FadeBar
                :fade-in-sec="currentEntry.fadeInSec"
                :hold-sec="currentEntry.holdSec"
                :fade-out-sec="currentEntry.fadeOutSec"
                :height="12"
                compact
              />
            </template>
            <p v-else class="muted">全部 Cue 均已走过，无当前 Cue。</p>
          </div>

          <div class="resume-box">
            <p class="current-cue__label">复演时刻（预计时刻基准）</p>
            <NDatePicker
              :value="resumeAtMs"
              type="datetime"
              clearable
              style="width: 240px"
              @update:value="onResumeAtChange"
            />
            <p class="muted resume-hint">当前 Cue 预计 {{ resumeAtMs !== null ? formatClockTime(new Date(resumeAtMs)) : '—' }} 起，其后按各 Cue 过渡时长顺推。</p>
            <div class="advance-row">
              <NButton type="primary" :disabled="!recovery.currentCueId || recovery.status === '已完结'" @click="advanceCurrent">
                {{ nextEntry ? `补走当前，前进到 ${nextEntry.cueNo}` : '补走当前（本场结束）' }}
              </NButton>
            </div>
          </div>
        </div>

        <div class="frame-head">
          <span class="current-cue__label">仍亮通道（{{ litFrame.length }}）</span>
          <NButton size="tiny" quaternary :disabled="!recovery.currentCueId" @click="resetFrame">重置为当前 Cue 电平</NButton>
        </div>
        <div v-if="recovery.frame.length === 0" class="muted">末帧无通道记录。</div>
        <div v-else class="frame-table">
          <div class="frame-table__head"><span>通道</span><span>亮度 %</span><span>色温 K</span><span></span></div>
          <div v-for="channel in recovery.frame" :key="channel.fixtureId ?? `ch:${channel.channel}`" class="frame-table__row">
            <ChannelChip
              :channel="channel.channel"
              :position="frameFixture(channel)?.position ?? channel.position"
              :intensity="channel.intensity"
              :gel="frameFixture(channel)?.gel ?? ''"
              :fixture-type="frameFixture(channel)?.fixtureType ?? ''"
              size="small"
            />
            <NInputNumber
              :value="channel.intensity"
              size="small"
              :min="0"
              :max="100"
              :show-button="false"
              :disabled="recovery.status === '已完结'"
              style="width: 96px"
              @update:value="(v) => updateIntensity(channel.fixtureId ?? `ch:${channel.channel}`, v)"
            />
            <NInputNumber
              :value="channel.colorTempK"
              size="small"
              :min="COLOR_TEMP_MIN"
              :max="COLOR_TEMP_MAX"
              :show-button="false"
              :disabled="recovery.status === '已完结'"
              style="width: 120px"
              @update:value="(v) => updateTemp(channel.fixtureId ?? `ch:${channel.channel}`, v)"
            />
            <span v-if="channel.intensity === 0" class="muted frame-off">已灭</span>
          </div>
        </div>
      </section>

      <!-- 已走过列表 + 预计时刻 -->
      <section class="panel">
        <h2 class="panel__title">
          恢复时间轴
          <span class="panel__title-tag">已走过 {{ playedTimelineCount }} · 待走 {{ pendingTimelineCount }}</span>
        </h2>
        <div class="tl-list">
          <article
            v-for="entry in timeline"
            :key="entry.cueId"
            class="tl-row"
            :class="{
              'tl-row--played': entry.state === 'played',
              'tl-row--current': entry.state === 'current',
              'tl-row--missing': entry.missingInMaster
            }"
          >
            <span class="tl-row__no mono">{{ entry.cueNo }}</span>
            <NTag size="tiny" :bordered="false" :type="stateTag(entry.state).type">{{ stateTag(entry.state).text }}</NTag>
            <NTag v-if="entry.missingInMaster" size="tiny" :bordered="false" type="error">主表已无</NTag>
            <span class="tl-row__label">{{ entry.label || '（无提示语）' }}</span>
            <span class="tl-row__dur mono">{{ formatSeconds(cueTotalSeconds(entry)) }}</span>
            <FadeBar
              :fade-in-sec="entry.fadeInSec"
              :hold-sec="entry.holdSec"
              :fade-out-sec="entry.fadeOutSec"
              :height="10"
              compact
              class="tl-row__bar"
            />
            <span class="tl-row__eta mono">
              <template v-if="etaByCue.get(entry.cueId)">
                预计 {{ formatClockTime(etaByCue.get(entry.cueId)!.time) }}
                <span class="muted">(+{{ formatSeconds(etaByCue.get(entry.cueId)!.offsetSec) }})</span>
              </template>
              <span v-else-if="entry.state === 'played'" class="muted">
                {{ entry.actualAt ? formatDateTime(entry.actualAt).slice(11) : '实际时刻未记' }}
              </span>
            </span>
            <span class="tl-row__actions">
              <NButton size="tiny" quaternary :disabled="entry.state === 'current' || recovery.status === '已完结'" @click="setCurrent(entry)">
                设为当前
              </NButton>
              <NPopconfirm @positive-click="jumpTo(entry)">
                <template #trigger>
                  <NButton size="tiny" quaternary :disabled="recovery.status === '已完结'">跳回到此</NButton>
                </template>
                将把该条及其后 Cue 全部回退为待走，当前 Cue 指向 {{ entry.cueNo }}。确定跳回？
              </NPopconfirm>
            </span>
          </article>
        </div>
        <p v-if="recovery.note" class="rec-note">备注：{{ recovery.note }}</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.conflict-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.conflict-ok {
  margin-top: 4px;
}

.conflict-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}

.conflict-item {
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(232, 168, 84, 0.4);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.conflict-item--pending {
  border-style: dashed;
}

.conflict-item__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.conflict-item__index {
  color: rgba(255, 255, 255, 0.4);
}

.conflict-item__msg {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.78);
}

.diff-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.diff-table th,
.diff-table td {
  text-align: left;
  padding: 5px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.diff-table th {
  color: rgba(255, 255, 255, 0.42);
  font-weight: 400;
}

.diff-channel {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
}

.diff-arrow {
  color: rgba(255, 255, 255, 0.4);
}

.conflict-item__choice {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.conflict-foot {
  margin: 10px 0 0;
  font-size: 12px;
}

.current-grid {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 18px;
}

.current-cue,
.resume-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.current-cue__label {
  margin: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.current-cue__no {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: #f2b544;
  display: flex;
  align-items: center;
  gap: 8px;
}

.current-cue__text {
  margin: 0;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.72);
}

.resume-hint {
  margin: 0;
  font-size: 12px;
}

.advance-row {
  margin-top: 4px;
}

.frame-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 16px 0 8px;
}

.frame-table {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.frame-table__head,
.frame-table__row {
  display: grid;
  grid-template-columns: 260px 110px 130px 1fr;
  align-items: center;
  gap: 12px;
}

.frame-table__head {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
  padding: 0 2px 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.frame-off {
  font-size: 12px;
}

.tl-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tl-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.tl-row--played {
  opacity: 0.62;
}

.tl-row--current {
  border-color: rgba(242, 181, 68, 0.6);
  background: rgba(242, 181, 68, 0.07);
}

.tl-row--missing {
  border-style: dashed;
  border-color: rgba(232, 84, 84, 0.5);
}

.tl-row__no {
  font-weight: 600;
  color: #f2b544;
  min-width: 58px;
}

.tl-row__label {
  flex: 1;
  min-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.tl-row__dur {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
  min-width: 48px;
}

.tl-row__bar {
  width: 120px;
  flex: none;
}

.tl-row__eta {
  min-width: 150px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
}

.tl-row__actions {
  display: flex;
  gap: 4px;
}

.rec-note {
  margin: 12px 0 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}
</style>
