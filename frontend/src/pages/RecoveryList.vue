<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NCheckbox,
  NDatePicker,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSwitch,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui'
import BlankHint from '@/components/common/BlankHint.vue'
import ChannelChip from '@/components/common/ChannelChip.vue'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'
import { useRecoveryStore } from '@/stores/recoveryStore'
import { useSessionStore } from '@/stores/sessionStore'
import { COLOR_TEMP_MAX, COLOR_TEMP_MIN, COLOR_TEMP_STEP } from '@/types/level'
import type { LiveFrameChannel } from '@/types/live'
import { cueTotalSeconds, formatDateTime, formatSeconds } from '@/utils/fade'
import { buildInitialFrame } from '@/utils/recovery'

const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const sessionStore = useSessionStore()
const cueStore = useCueStore()
const fixtureStore = useFixtureStore()
const levelStore = useLevelStore()
const recoveryStore = useRecoveryStore()

const showAllSessions = ref(false)
const showCreate = ref(false)
const selectedSessionId = ref<string>('')

const createForm = reactive({
  title: '',
  currentCueId: null as string | null,
  playedIds: [] as string[],
  resumeAt: Date.now(),
  note: ''
})
const frame = ref<LiveFrameChannel[]>([])

const sessionOptions = computed(() =>
  sessionStore.sortedSessions.map((session) => ({ label: `${session.order}. ${session.title}`, value: session.id }))
)

const sessionCues = computed(() =>
  selectedSessionId.value ? cueStore.sortedCuesOfSession(selectedSessionId.value) : []
)

const sessionFixtures = computed(() =>
  selectedSessionId.value ? fixtureStore.sortedFixturesOfSession(selectedSessionId.value) : []
)

const currentCue = computed(() =>
  createForm.currentCueId ? cueStore.cueById(createForm.currentCueId) : null
)

const frameFixturesMissing = computed(() => {
  const present = new Set(frame.value.map((channel) => channel.fixtureId))
  return sessionFixtures.value.filter((fixture) => !present.has(fixture.id))
})

const recoveries = computed(() =>
  showAllSessions.value
    ? recoveryStore.recoveriesSorted
    : recoveryStore.recoveriesOfSession(selectedSessionId.value || (sessionStore.currentSessionId ?? ''))
)

function openCreate(): void {
  const firstSession = selectedSessionId.value || sessionStore.currentSessionId || sessionStore.sortedSessions[0]?.id || ''
  selectedSessionId.value = firstSession
  const cues = cueStore.sortedCuesOfSession(firstSession)
  createForm.title = ''
  createForm.playedIds = []
  createForm.currentCueId = cues[0]?.id ?? null
  createForm.resumeAt = Date.now()
  createForm.note = ''
  frame.value = buildInitialFrame(
    createForm.currentCueId,
    createForm.currentCueId ? levelStore.levelsOfCue(createForm.currentCueId) : [],
    fixtureStore.fixturesOfSession(firstSession)
  )
  showCreate.value = true
}

function handleSessionChange(value: string | number | Array<string | number> | null): void {
  if (typeof value !== 'string') return
  selectedSessionId.value = value
  const cues = cueStore.sortedCuesOfSession(value)
  createForm.playedIds = []
  createForm.currentCueId = cues[0]?.id ?? null
  rebuildFrame()
}

function togglePlayed(cueId: string, checked: boolean): void {
  createForm.playedIds = checked
    ? [...new Set([...createForm.playedIds, cueId])]
    : createForm.playedIds.filter((id) => id !== cueId)
  if (checked && createForm.currentCueId === cueId) {
    createForm.currentCueId = null
    rebuildFrame()
  }
}

function isPlayed(cueId: string): boolean {
  return createForm.playedIds.includes(cueId)
}

/** 选择当前 Cue 时，把它从已走过列表中排除（一条 Cue 不能既走过又停在原地） */
function handleCurrentChange(value: string | number | Array<string | number> | null): void {
  const next = typeof value === 'string' ? value : null
  createForm.currentCueId = next
  if (next) createForm.playedIds = createForm.playedIds.filter((id) => id !== next)
  rebuildFrame()
}

/** 以所选当前 Cue 的计划电平重填末帧（仍可逐通道修正） */
function rebuildFrame(): void {
  frame.value = buildInitialFrame(
    createForm.currentCueId,
    createForm.currentCueId ? levelStore.levelsOfCue(createForm.currentCueId) : [],
    fixtureStore.fixturesOfSession(selectedSessionId.value)
  )
}

/** 勾选到某条为止（含）全部标记为已走过，并把当前 Cue 指向其后一条 */
function markPlayedUntil(cueId: string): void {
  const index = sessionCues.value.findIndex((cue) => cue.id === cueId)
  if (index < 0) return
  createForm.playedIds = sessionCues.value.slice(0, index + 1).map((cue) => cue.id)
  createForm.currentCueId = sessionCues.value[index + 1]?.id ?? null
  rebuildFrame()
}

function addFrameChannel(fixtureId: string): void {
  const fixture = fixtureStore.fixtureById(fixtureId)
  if (!fixture) return
  frame.value = [
    ...frame.value,
    { fixtureId: fixture.id, channel: fixture.channel, intensity: 0, colorTempK: 3200, position: fixture.position }
  ].sort((a, b) => a.channel - b.channel)
}

function updateFrameIntensity(key: string, value: number | null): void {
  frame.value = frame.value.map((channel) =>
    (channel.fixtureId ?? `ch:${channel.channel}`) === key
      ? { ...channel, intensity: Math.max(0, Math.min(100, Math.round(value ?? 0))) }
      : channel
  )
}

function updateFrameTemp(key: string, value: number | null): void {
  frame.value = frame.value.map((channel) =>
    (channel.fixtureId ?? `ch:${channel.channel}`) === key
      ? { ...channel, colorTempK: Math.round(value ?? 3200) }
      : channel
  )
}

function removeFrameChannel(key: string): void {
  frame.value = frame.value.filter((channel) => (channel.fixtureId ?? `ch:${channel.channel}`) !== key)
}

const litCount = computed(() => frame.value.filter((channel) => channel.intensity > 0).length)

async function submitCreate(): Promise<void> {
  if (!selectedSessionId.value) {
    message.warning('请先选择场次')
    return
  }
  if (!createForm.currentCueId && createForm.playedIds.length === 0) {
    message.warning('请指定拉停时所在的当前 Cue（或至少勾选已走过 Cue）')
    return
  }
  const resumeIso = new Date(createForm.resumeAt).toISOString()
  const created = await recoveryStore.createRecovery(
    {
      sessionId: selectedSessionId.value,
      title: createForm.title,
      resumeAt: resumeIso,
      currentCueId: createForm.currentCueId,
      playedCueIds: createForm.playedIds,
      note: createForm.note
    },
    frame.value
  )
  if (!created) {
    message.error('登记失败')
    return
  }
  message.success('拉停记录已登记，可进入现场恢复台')
  showCreate.value = false
  void router.push(`/recoveries/${created.id}`)
}

function sessionTitleOf(sessionId: string): string {
  const session = sessionStore.sessionById(sessionId)
  return session ? `${session.order}. ${session.title}` : '（场次已删除）'
}

function cueNoList(recoveryCueIds: string[]): string {
  return recoveryCueIds
    .map((cueId) => cueStore.cueById(cueId)?.cueNo)
    .filter((no): no is string => Boolean(no))
    .join('、')
}

function goDetail(id: string): void {
  void router.push(`/recoveries/${id}`)
}

function confirmRemove(id: string): void {
  dialog.warning({
    title: '删除现场恢复单',
    content: '将删除该拉停记录（含末帧与现场快照），不影响主表 Cue 与历史排演表。',
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await recoveryStore.removeRecovery(id)
      message.success('现场恢复单已删除')
    }
  })
}

function goCues(): void {
  const id = selectedSessionId.value || sessionStore.currentSessionId
  if (id) void router.push(`/sessions/${id}/cues`)
  else void router.push('/sessions')
}
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">现场恢复</h1>
        <p class="page__subtitle">
          演出中途拉停后，登记当前 Cue、已走过列表与灯控台末帧电平；重开从现场继续，可补走或跳回，
          预计时刻按复演时刻重算。主表与现场不一致时先比对两版再合并。
        </p>
      </div>
      <div class="page__actions">
        <NButton @click="goCues">Cue 时间轴</NButton>
        <NButton type="primary" :disabled="sessionStore.sortedSessions.length === 0" @click="openCreate">
          登记拉停
        </NButton>
      </div>
    </header>

    <NAlert v-if="sessionStore.sortedSessions.length === 0" type="info" :bordered="false">
      还没有场次。请先在场次编排中创建场次并插入 Cue，演出拉停后再来登记现场恢复。
    </NAlert>

    <template v-else>
      <section class="panel">
        <div class="rec-head">
          <h2 class="panel__title">拉停记录<span class="panel__title-tag">共 {{ recoveries.length }} 单</span></h2>
          <span class="rec-head__switch">
            <NSelect
              :value="selectedSessionId || sessionStore.currentSessionId || null"
              :options="sessionOptions"
              placeholder="选择场次"
              size="small"
              style="width: 220px"
              @update:value="handleSessionChange"
            />
            <span class="muted">显示全部场次</span>
            <NSwitch :value="showAllSessions" size="small" @update:value="(v) => (showAllSessions = v === true)" />
          </span>
        </div>

        <BlankHint
          v-if="recoveries.length === 0"
          title="还没有拉停记录"
          description="演出中途拉停后点击「登记拉停」，留存当前 Cue、已走过 Cue 与末帧各通道电平，重开时从现场继续。"
          tip="恢复单只在确认后才会改写主表；历史排演表始终保留生成时的内容。"
        />

        <div v-else class="rec-list">
          <article
            v-for="recovery in recoveries"
            :key="recovery.id"
            class="rec-card"
            :class="{ 'rec-card--done': recovery.status === '已完结' }"
            @click="goDetail(recovery.id)"
          >
            <div class="rec-card__head">
              <span class="rec-card__title">{{ recovery.title }}</span>
              <NTag size="small" :bordered="false" :type="recovery.status === '进行中' ? 'warning' : 'default'">
                {{ recovery.status }}
              </NTag>
              <span class="toolbar__spacer" />
              <span class="rec-card__time mono">{{ formatDateTime(recovery.stoppedAt) }}</span>
            </div>
            <div class="rec-card__session">{{ sessionTitleOf(recovery.sessionId) }}</div>
            <div class="rec-card__meta">
              <span>已走过 {{ recovery.played.length }} 条</span>
              <span>末帧 {{ recovery.frame.filter((c) => c.intensity > 0).length }} 通道亮</span>
              <span>复演 {{ formatDateTime(recovery.resumeAt).slice(11) }}</span>
            </div>
            <p class="rec-card__cues mono">{{ cueNoList(recovery.played.map((p) => p.cueId)) || '（尚无已走过 Cue）' }}</p>
            <div class="rec-card__actions" @click.stop>
              <NButton size="tiny" type="primary" ghost @click="goDetail(recovery.id)">进入恢复台</NButton>
              <NButton size="tiny" quaternary type="error" @click="confirmRemove(recovery.id)">删除</NButton>
            </div>
          </article>
        </div>
      </section>
    </template>

    <NModal v-model:show="showCreate" preset="card" title="登记拉停 · 留存现场" class="rec-modal" :mask-closable="false">
      <div class="rec-form">
        <div class="rec-form__row">
          <label class="rec-form__field">
            <span class="rec-form__label">所属场次</span>
            <NSelect :value="selectedSessionId || null" :options="sessionOptions" @update:value="handleSessionChange" />
          </label>
          <label class="rec-form__field">
            <span class="rec-form__label">恢复单标题</span>
            <NInput v-model:value="createForm.title" placeholder="如：首演中场拉停" />
          </label>
        </div>

        <div class="rec-form__block">
          <div class="rec-form__block-head">
            <span class="rec-form__label">已走过 Cue（拉停前完成）</span>
            <span class="muted">点击「到此为止」可快速勾选</span>
          </div>
          <div v-if="sessionCues.length === 0" class="muted">该场次还没有 Cue。</div>
          <div v-else class="played-list">
            <label v-for="cue in sessionCues" :key="cue.id" class="played-item" :class="{ 'played-item--on': isPlayed(cue.id) }">
              <NCheckbox
                :checked="isPlayed(cue.id)"
                :disabled="createForm.currentCueId === cue.id"
                @update:checked="(v) => togglePlayed(cue.id, v === true)"
              />
              <span class="played-item__no mono">{{ cue.cueNo }}</span>
              <span class="played-item__label">{{ cue.label || '（无提示语）' }}</span>
              <span v-if="createForm.currentCueId === cue.id" class="played-item__current">即当前 Cue</span>
              <span class="played-item__dur mono">{{ formatSeconds(cueTotalSeconds(cue)) }}</span>
              <NButton size="tiny" quaternary @click.prevent="markPlayedUntil(cue.id)">到此为止</NButton>
            </label>
          </div>
        </div>

        <div class="rec-form__row">
          <label class="rec-form__field">
            <span class="rec-form__label">拉停时所在（当前）Cue</span>
            <NSelect
              :value="createForm.currentCueId"
              :options="sessionCues.map((cue) => ({ label: `${cue.cueNo} · ${cue.label || '（无提示语）'}`, value: cue.id }))"
              placeholder="选择当前停在的 Cue"
              clearable
              @update:value="handleCurrentChange"
            />
          </label>
          <label class="rec-form__field">
            <span class="rec-form__label">复演时刻（预计时刻基准）</span>
            <NDatePicker v-model:value="createForm.resumeAt" type="datetime" clearable style="width: 100%" />
          </label>
        </div>

        <div class="rec-form__block">
          <div class="rec-form__block-head">
            <span class="rec-form__label">灯控台末帧 · 各通道电平（{{ litCount }} 个仍亮）</span>
            <NButton size="tiny" quaternary :disabled="!currentCue" @click="rebuildFrame">
              以当前 Cue 电平重填
            </NButton>
          </div>
          <div v-if="frame.length === 0" class="muted">
            当前 Cue 未设定通道电平。可从下方追加仍亮的通道。
          </div>
          <div v-else class="frame-grid">
            <div v-for="channel in frame" :key="channel.fixtureId ?? `ch:${channel.channel}`" class="frame-row">
              <ChannelChip :channel="channel.channel" :position="channel.position" :intensity="channel.intensity" size="small" />
              <NInputNumber
                :value="channel.intensity"
                size="small"
                :min="0"
                :max="100"
                :show-button="false"
                style="width: 78px"
                @update:value="(v) => updateFrameIntensity(channel.fixtureId ?? `ch:${channel.channel}`, v)"
              />
              <NInputNumber
                :value="channel.colorTempK"
                size="small"
                :min="COLOR_TEMP_MIN"
                :max="COLOR_TEMP_MAX"
                :step="COLOR_TEMP_STEP"
                :show-button="false"
                style="width: 104px"
                @update:value="(v) => updateFrameTemp(channel.fixtureId ?? `ch:${channel.channel}`, v)"
              />
              <NButton size="tiny" quaternary type="error" @click="removeFrameChannel(channel.fixtureId ?? `ch:${channel.channel}`)">
                移除
              </NButton>
            </div>
          </div>
          <div v-if="frameFixturesMissing.length > 0" class="frame-add">
            <span class="muted">追加仍亮通道：</span>
            <NSelect
              size="small"
              placeholder="选择灯位通道"
              :options="frameFixturesMissing.map((fixture) => ({
                label: `CH${fixture.channel} · ${fixture.position} · ${fixture.fixtureType}`,
                value: fixture.id
              }))"
              style="width: 260px"
              @update:value="(v) => { if (typeof v === 'string') addFrameChannel(v) }"
            />
          </div>
        </div>

        <label class="rec-form__field">
          <span class="rec-form__label">备注</span>
          <NInput v-model:value="createForm.note" type="textarea" :rows="2" placeholder="拉停原因、现场处理、安全提示等" />
        </label>
      </div>

      <template #footer>
        <div class="modal-footer">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" @click="submitCreate">登记并进入恢复台</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.rec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.rec-head__switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.rec-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 12px;
}

.rec-card {
  padding: 14px 16px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(242, 181, 68, 0.35);
  display: flex;
  flex-direction: column;
  gap: 8px;
  cursor: pointer;
  transition: border-color 0.16s ease, transform 0.16s ease;
}

.rec-card:hover {
  border-color: rgba(242, 181, 68, 0.7);
  transform: translateY(-1px);
}

.rec-card--done {
  border-color: rgba(255, 255, 255, 0.08);
  opacity: 0.72;
}

.rec-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.rec-card__title {
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
}

.rec-card__time {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
}

.rec-card__session {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.65);
}

.rec-card__meta {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.rec-card__cues {
  margin: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
  line-height: 1.7;
  word-break: break-all;
}

.rec-card__actions {
  display: flex;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.rec-modal {
  width: 720px;
  max-width: 95vw;
}

.rec-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.rec-form__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.rec-form__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rec-form__label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
}

.rec-form__block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.rec-form__block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.played-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
}

.played-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid transparent;
}

.played-item--on {
  background: rgba(242, 181, 68, 0.08);
  border-color: rgba(242, 181, 68, 0.3);
}

.played-item__no {
  color: #f2b544;
  font-weight: 600;
  min-width: 58px;
}

.played-item__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.played-item__current {
  font-size: 11px;
  color: #f2b544;
}

.played-item__dur {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
}

.frame-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.frame-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.frame-add {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
