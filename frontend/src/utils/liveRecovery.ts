import type { Cue } from '@/types/cue'
import type { Fixture } from '@/types/fixture'
import type { CueLevel } from '@/types/level'
import { cueTotalSeconds, formatSeconds, round1 } from '@/utils/fade'
import { sortCues } from '@/utils/cueOrder'
import type {
  LiveChannelFrame,
  LiveConflict,
  LiveConflictField,
  LiveCueSnapshot,
  LiveExecutedCue,
  LiveRun,
  LiveScheduleItem
} from '@/types/live'

/* ---------------- 快照构造 ---------------- */

/** 由主表 Cue 构造现场 Cue 快照 */
export function snapshotCue(cue: Cue): LiveCueSnapshot {
  return {
    cueId: cue.id,
    cueNo: cue.cueNo,
    label: cue.label,
    trigger: cue.trigger,
    fadeInSec: cue.fadeInSec,
    fadeOutSec: cue.fadeOutSec,
    holdSec: cue.holdSec,
    note: cue.note
  }
}

/** 由一条 Cue 的计划电平 + 主表配接构造现场通道帧（按通道号升序） */
export function buildFrameFromPlan(sessionFixtures: readonly Fixture[], levels: readonly CueLevel[]): LiveChannelFrame[] {
  const levelByFixture = new Map(levels.map((level) => [level.fixtureId, level]))
  const frames: LiveChannelFrame[] = []
  sortFixturesLocal(sessionFixtures).forEach((fixture) => {
    const level = levelByFixture.get(fixture.id)
    if (!level) return
    frames.push({
      fixtureId: fixture.id,
      channel: fixture.channel,
      position: fixture.position,
      fixtureType: fixture.fixtureType,
      intensity: level.intensity,
      colorTempK: level.colorTempK,
      focusNote: level.focusNote
    })
  })
  return frames
}

/** 由一帧电平 + 当前主表配接重新校准通道号 / 灯位快照（通道改配接后以主表为准） */
export function recalibrateFrame(frame: readonly LiveChannelFrame[], sessionFixtures: readonly Fixture[]): LiveChannelFrame[] {
  const fixtureById = new Map(sessionFixtures.map((fixture) => [fixture.id, fixture]))
  return frame.map((item) => {
    const fixture = fixtureById.get(item.fixtureId)
    if (!fixture) return item
    return { ...item, channel: fixture.channel, position: fixture.position, fixtureType: fixture.fixtureType }
  })
}

function sortFixturesLocal(input: readonly Fixture[]): Fixture[] {
  return [...input].sort((a, b) => a.channel - b.channel || a.createdAt - b.createdAt)
}

/* ---------------- Cue 字段两版对照 ---------------- */

const CUE_FIELD_LABEL: Array<{ key: keyof LiveCueSnapshot; label: string }> = [
  { key: 'cueNo', label: '编号' },
  { key: 'label', label: '提示语' },
  { key: 'trigger', label: '触发方式' },
  { key: 'fadeInSec', label: '渐亮' },
  { key: 'holdSec', label: '保持' },
  { key: 'fadeOutSec', label: '渐暗' },
  { key: 'note', label: '备注' }
]

function cueFieldText(snapshot: LiveCueSnapshot, key: keyof LiveCueSnapshot): string {
  const value = snapshot[key]
  if (key === 'fadeInSec' || key === 'fadeOutSec' || key === 'holdSec') {
    return formatSeconds(Number(value))
  }
  return String(value ?? '')
}

function cueSignature(kind: 'cue', cueId: string, snapshot: LiveCueSnapshot): string {
  return [
    kind,
    cueId,
    snapshot.cueNo,
    snapshot.label,
    snapshot.trigger,
    snapshot.fadeInSec,
    snapshot.holdSec,
    snapshot.fadeOutSec,
    snapshot.note
  ].join('|')
}

/** 同一 Cue 计划版与现场版的冲突；任一侧删除 / 无差异时返回 null */
function compareCue(live: LiveCueSnapshot, planned: Cue | null): LiveConflict | null {
  const cueLabel = live.label || planned?.label || '（未命名 Cue）'
  if (!planned) {
    return {
      signature: cueSignature('cue', live.cueId, live),
      kind: 'cue',
      cueId: live.cueId,
      cueNo: live.cueNo,
      cueLabel,
      fixtureId: null,
      channel: null,
      plannedMissing: true,
      liveMissing: false,
      fields: CUE_FIELD_LABEL.map(({ key, label }) => ({
        label,
        planned: null,
        live: cueFieldText(live, key) || '—'
      }))
    }
  }

  const plannedSnapshot = snapshotCue(planned)
  const fields: LiveConflictField[] = []
  CUE_FIELD_LABEL.forEach(({ key, label }) => {
    const liveText = cueFieldText(live, key)
    const plannedText = cueFieldText(plannedSnapshot, key)
    if (liveText !== plannedText) fields.push({ label, planned: plannedText, live: liveText })
  })

  if (fields.length === 0) return null
  return {
    signature: [cueSignature('cue', live.cueId, live), cueSignature('cue', planned.id, plannedSnapshot)].join('||'),
    kind: 'cue',
    cueId: live.cueId,
    cueNo: live.cueNo,
    cueLabel,
    fixtureId: null,
    channel: null,
    plannedMissing: false,
    liveMissing: false,
    fields
  }
}

/* ---------------- 通道电平两版对照 ---------------- */

function channelSignature(
  cueId: string,
  fixtureId: string,
  planned: { intensity: number; colorTempK: number; focusNote: string } | null,
  live: Pick<LiveChannelFrame, 'intensity' | 'colorTempK' | 'focusNote'> | null
): string {
  return [
    'channel',
    cueId,
    fixtureId,
    planned ? `p:${planned.intensity}:${planned.colorTempK}:${planned.focusNote}` : 'p:missing',
    live ? `l:${live.intensity}:${live.colorTempK}:${live.focusNote}` : 'l:missing'
  ].join('|')
}

interface ChannelCompareContext {
  run: LiveRun
  /** 主表全部 Cue（id 索引） */
  cueById: Map<string, Cue>
  /** 主表配接（id 索引） */
  fixtureById: Map<string, Fixture>
  /** (cueId, fixtureId) → 计划电平 */
  planLevel: (cueId: string, fixtureId: string) => CueLevel | null
  /** cueId → 计划参与通道电平 */
  planCueLevels: (cueId: string) => CueLevel[]
}

/**
 * 同一通道在某条已走过 Cue 上的电平冲突。
 * 计划删了配接 / 现场未落帧 / 电平或色温或对焦不同即列出。
 */
function compareChannel(
  cueId: string,
  cueNo: string,
  cueLabel: string,
  live: LiveChannelFrame | null,
  fixtureId: string,
  ctx: ChannelCompareContext
): LiveConflict | null {
  const plannedCue = ctx.cueById.get(cueId)
  const fixture = ctx.fixtureById.get(fixtureId)
  const plannedLevel = plannedCue ? ctx.planLevel(plannedCue.id, fixtureId) : null

  if (live && (!fixture || (plannedCue && !plannedLevel))) {
    // 现场有、计划无：配接通道被删或该通道不再参与本 Cue
    return {
      signature: channelSignature(cueId, fixtureId, null, live),
      kind: 'channel',
      cueId,
      cueNo,
      cueLabel,
      fixtureId,
      channel: live.channel,
      plannedMissing: true,
      liveMissing: false,
      fields: [
        { label: '亮度', planned: null, live: `${live.intensity}%` },
        { label: '色温', planned: null, live: `${live.colorTempK}K` },
        { label: '对焦', planned: null, live: live.focusNote || '—' }
      ]
    }
  }

  if (!live) {
    // 计划有、现场帧中没有（主表新加参与通道）
    if (!fixture || !plannedLevel) return null
    return {
      signature: channelSignature(
        cueId,
        fixtureId,
        { intensity: plannedLevel.intensity, colorTempK: plannedLevel.colorTempK, focusNote: plannedLevel.focusNote },
        null
      ),
      kind: 'channel',
      cueId,
      cueNo,
      cueLabel,
      fixtureId,
      channel: fixture.channel,
      plannedMissing: false,
      liveMissing: true,
      fields: [
        { label: '亮度', planned: `${plannedLevel.intensity}%`, live: null },
        { label: '色温', planned: `${plannedLevel.colorTempK}K`, live: null },
        { label: '对焦', planned: plannedLevel.focusNote || '—', live: null }
      ]
    }
  }

  if (!fixture || !plannedLevel) return null
  const fields: LiveConflictField[] = []
  if (live.intensity !== plannedLevel.intensity) {
    fields.push({ label: '亮度', planned: `${plannedLevel.intensity}%`, live: `${live.intensity}%` })
  }
  if (live.colorTempK !== plannedLevel.colorTempK) {
    fields.push({ label: '色温', planned: `${plannedLevel.colorTempK}K`, live: `${live.colorTempK}K` })
  }
  if (live.focusNote !== plannedLevel.focusNote) {
    fields.push({ label: '对焦', planned: plannedLevel.focusNote || '—', live: live.focusNote || '—' })
  }
  if (fields.length === 0) return null
  return {
    signature: channelSignature(
      cueId,
      fixtureId,
      { intensity: plannedLevel.intensity, colorTempK: plannedLevel.colorTempK, focusNote: plannedLevel.focusNote },
      { intensity: live.intensity, colorTempK: live.colorTempK, focusNote: live.focusNote }
    ),
    kind: 'channel',
    cueId,
    cueNo,
    cueLabel,
    fixtureId,
    channel: fixture.channel,
    plannedMissing: false,
    liveMissing: false,
    fields
  }
}

/* ---------------- 冲突汇总 ---------------- */

/**
 * 扫描现场记录与主表之间的全部冲突：
 * - 当前 Cue（最后一帧）与各条已走过 Cue 都参与 Cue 级比对；
 * - 通道级比对以「现场帧 ∪ 计划参与通道」为并集。
 * 已确认且签名未变的冲突不再列出；没处理过的持续留到下次重开。
 */
export function detectLiveConflicts(ctx: ChannelCompareContext): LiveConflict[] {
  const { run } = ctx
  const collected: LiveConflict[] = []

  const cueRows: Array<{ snapshot: LiveCueSnapshot; frame: LiveChannelFrame[] }> = []
  run.executed.forEach((item) =>
    cueRows.push({
      snapshot: item,
      // 当前 Cue 同时在已走过列表中时（跳回后），通道帧以最后一帧为准
      frame: run.currentCue?.cueId === item.cueId ? run.frame : item.channels
    })
  )
  if (run.currentCue && !run.executed.some((item) => item.cueId === run.currentCue?.cueId)) {
    cueRows.push({ snapshot: run.currentCue, frame: run.frame })
  }

  const resolvedSignatures = new Set(run.resolutions.map((item) => item.signature))

  cueRows.forEach(({ snapshot, frame }) => {
    const plannedCue = ctx.cueById.get(snapshot.cueId) ?? null
    const cueConflict = compareCue(snapshot, plannedCue)
    if (cueConflict && !resolvedSignatures.has(cueConflict.signature)) collected.push(cueConflict)

    if (!plannedCue) return
    const frameByFixture = new Map(frame.map((item) => [item.fixtureId, item]))
    const candidateIds = new Set<string>(frame.map((item) => item.fixtureId))
    ctx.planCueLevels(plannedCue.id).forEach((level) => candidateIds.add(level.fixtureId))

    candidateIds.forEach((fixtureId) => {
      const conflict = compareChannel(
        plannedCue.id,
        snapshot.cueNo,
        snapshot.label || plannedCue.label,
        frameByFixture.get(fixtureId) ?? null,
        fixtureId,
        ctx
      )
      if (conflict && !resolvedSignatures.has(conflict.signature)) collected.push(conflict)
    })
  })

  return collected.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'cue' ? -1 : 1
    const aIndex = run.executed.findIndex((item) => item.cueId === a.cueId)
    const bIndex = run.executed.findIndex((item) => item.cueId === b.cueId)
    return bIndex - aIndex || (a.channel ?? 0) - (b.channel ?? 0)
  })
}

/* ---------------- 预计时刻推演 ---------------- */

/**
 * 复演时间轴：以 resumedAt 为基准重算预计时刻。
 * - 已走过行保留实际走出时刻，不再给预计值；
 * - 当前行预计时刻 = 复演时刻（偏移 0）；
 * - 之后按主表顺序逐行累加单条总时长；
 * - 主表删除的行按现场快照展示并排在序列末尾，不再参与后续推演。
 */
export function buildLiveSchedule(run: LiveRun, plannedCues: readonly Cue[]): LiveScheduleItem[] {
  const ordered = sortCues(plannedCues)
  const plannedById = new Map(ordered.map((cue) => [cue.id, cue]))

  const items: LiveScheduleItem[] = []
  const resumeTime = run.resumedAt ? new Date(run.resumedAt).getTime() : NaN
  let cursor = Number.isFinite(resumeTime) ? resumeTime : null
  /** 当前 Cue 在主表中的位次；主表已删（含新插入的前驱）时由 gate 兜底 */
  const currentOrderIndex = ordered.findIndex((cue) => cue.id === run.currentCueId)
  /** 当前 Cue 已不在主表时，把所有待走 Cue 视作当前之前（不单独给预计时刻） */
  let reachedCurrent = currentOrderIndex < 0

  const pushTiming = (
    base: Omit<LiveScheduleItem, 'predictedAt' | 'offsetSec' | 'dayOffset'>,
    planned: boolean,
    isCurrent: boolean
  ): void => {
    if (isCurrent) reachedCurrent = true
    let predictedAt: string | null = null
    let offsetSec: number | null = null
    let dayOffset = 0
    if (!planned && reachedCurrent && cursor !== null) {
      predictedAt = new Date(cursor).toISOString()
      offsetSec = isCurrent ? 0 : round1((cursor - resumeTime) / 1000)
      dayOffset = dayOffsetBetween(resumeTime, cursor)
      cursor = round1(cursor / 1000) * 1000 + base.totalSec * 1000
    }
    items.push({ ...base, predictedAt, offsetSec, dayOffset })
  }

  ordered.forEach((cue) => {
    const executed = run.executed.find((item) => item.cueId === cue.id)
    const isCurrent = run.currentCueId === cue.id
    pushTiming(
      {
        cueId: cue.id,
        cueNo: cue.cueNo,
        label: cue.label,
        state: isCurrent ? 'current' : executed ? 'walked' : 'upcoming',
        executedAt: executed?.executedAt ?? null,
        totalSec: cueTotalSeconds(cue)
      },
      Boolean(executed) && !isCurrent,
      isCurrent
    )
  })

  // 当前 Cue 已不在主表：现场快照作为缺失行追加，预计时刻取复演时刻
  if (run.currentCue && !plannedById.has(run.currentCue.cueId)) {
    pushTiming(
      {
        cueId: run.currentCue.cueId,
        cueNo: run.currentCue.cueNo,
        label: run.currentCue.label,
        state: 'missing',
        executedAt: null,
        totalSec: cueTotalSeconds(run.currentCue)
      },
      false,
      true
    )
  }

  // 已走过但主表已删的 Cue
  run.executed
    .filter((item) => !plannedById.has(item.cueId))
    .forEach((item) => {
      items.push({
        cueId: item.cueId,
        cueNo: item.cueNo,
        label: item.label,
        state: 'missing',
        executedAt: item.executedAt,
        predictedAt: null,
        offsetSec: null,
        dayOffset: 0,
        totalSec: cueTotalSeconds(item)
      })
    })

  return items
}

/** 两个时刻之间跨过的整天数（按 UTC 日期差，避免夏令时误差） */
export function dayOffsetBetween(fromMs: number, toMs: number): number {
  const dayMs = 24 * 60 * 60 * 1000
  return Math.floor(toMs / dayMs) - Math.floor(fromMs / dayMs)
}

/** 预计时刻展示：HH:mm:ss，跨天追加 +N 天 */
export function formatPredicted(item: LiveScheduleItem): string {
  if (!item.predictedAt) return '—'
  const date = new Date(item.predictedAt)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number): string => String(value).padStart(2, '0')
  const base = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return item.dayOffset > 0 ? `${base}（+${item.dayOffset}天）` : base
}

/** 已走过列表中最后一帧的通道快照（用于跳回时复位帧） */
export function frameOfExecuted(executed: readonly LiveExecutedCue[], cueId: string): LiveChannelFrame[] {
  return executed.find((item) => item.cueId === cueId)?.channels.map((item) => ({ ...item })) ?? []
}

/**
 * 某条计划 Cue 是否允许补走：时间轴上必须位于当前 Cue 之后（或就是当前 Cue 本身）。
 * 当前 Cue 已不在主表时只允许按现场快照走，不接受其它计划 Cue 的越序补走。
 */
export function canWalkCue(plannedCues: readonly Cue[], currentCueId: string | null, targetCueId: string): boolean {
  if (targetCueId === currentCueId) return true
  if (!currentCueId) return plannedCues.some((cue) => cue.id === targetCueId)
  const ordered = sortCues(plannedCues)
  const currentIndex = ordered.findIndex((cue) => cue.id === currentCueId)
  const targetIndex = ordered.findIndex((cue) => cue.id === targetCueId)
  if (targetIndex < 0) return false
  return currentIndex < 0 ? true : targetIndex > currentIndex
}
