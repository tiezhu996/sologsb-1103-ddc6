import type { Cue } from '@/types/cue'
import type { CueLevel } from '@/types/level'
import type { Fixture } from '@/types/fixture'
import type {
  LiveCueSnapshot,
  LiveFrameChannel,
  LiveLevelSnapshot,
  LiveRecovery,
  PlayedCueRecord,
  RecoveryConflict,
  RecoveryConflictKind,
  RecoveryEta,
  RecoveryFieldDiff,
  RecoveryTimelineEntry
} from '@/types/live'
import { cueTotalSeconds } from '@/utils/fade'
import { compareCueNo, sortCues } from '@/utils/cueOrder'

/** 参与「计划 vs 现场」比对的 Cue 可编辑字段及中文名 */
const CUE_FIELDS: Array<{ field: keyof LiveCueSnapshot; label: string }> = [
  { field: 'cueNo', label: 'Cue 编号' },
  { field: 'label', label: '提示语' },
  { field: 'trigger', label: '触发方式' },
  { field: 'fadeInSec', label: '渐亮(s)' },
  { field: 'fadeOutSec', label: '渐暗(s)' },
  { field: 'holdSec', label: '保持(s)' },
  { field: 'note', label: '备注' }
]

function snapshotValue(snapshot: LiveCueSnapshot, field: keyof LiveCueSnapshot): string | number {
  const value = snapshot[field]
  return typeof value === 'number' ? value : String(value ?? '')
}

function cueValue(cue: Cue, field: keyof LiveCueSnapshot): string | number {
  const value = cue[field as keyof Cue]
  return typeof value === 'number' ? value : String(value ?? '')
}

/** 由主表 Cue 生成现场 Cue 快照 */
export function buildCueSnapshot(cue: Cue): LiveCueSnapshot {
  return {
    cueId: cue.id,
    cueNo: cue.cueNo,
    label: cue.label,
    trigger: cue.trigger,
    fadeInSec: cue.fadeInSec,
    fadeOutSec: cue.fadeOutSec,
    holdSec: cue.holdSec,
    note: cue.note,
    orderIndex: cue.orderIndex
  }
}

/**
 * 依据「已走过 + 当前」Cue 与主表现有数据构建现场快照。
 * 即使某条 Cue 已从主表删除，只要拉停登记时传入了 Cue，也会按当时数据留快照。
 */
export function buildRecoverySnapshots(
  snapshotCues: readonly Cue[],
  levels: readonly CueLevel[],
  fixturesById: ReadonlyMap<string, Fixture>
): { cueSnapshots: LiveCueSnapshot[]; levelSnapshots: LiveLevelSnapshot[] } {
  const cueIds = new Set(snapshotCues.map((cue) => cue.id))
  const cueSnapshots = sortCues(snapshotCues).map(buildCueSnapshot)
  const levelSnapshots: LiveLevelSnapshot[] = levels
    .filter((level) => cueIds.has(level.cueId))
    .map((level) => {
      const fixture = fixturesById.get(level.fixtureId)
      return {
        cueId: level.cueId,
        fixtureId: level.fixtureId,
        channel: fixture?.channel ?? 0,
        intensity: level.intensity,
        colorTempK: level.colorTempK,
        position: fixture?.position ?? null
      }
    })
    .sort((a, b) => a.cueId.localeCompare(b.cueId) || a.channel - b.channel)
  return { cueSnapshots, levelSnapshots }
}

/**
 * 以当前 Cue 的计划电平预填末帧：灯控台拉停时停在最后一帧，
 * 默认即当前 Cue 的通道电平，登记时可再逐通道修正。
 */
export function buildInitialFrame(
  currentCueId: string | null,
  levels: readonly CueLevel[],
  fixtures: readonly Fixture[]
): LiveFrameChannel[] {
  if (!currentCueId) return []
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]))
  return levels
    .filter((level) => level.cueId === currentCueId)
    .map((level) => {
      const fixture = fixturesById.get(level.fixtureId)
      return {
        fixtureId: fixture?.id ?? null,
        channel: fixture?.channel ?? 0,
        intensity: level.intensity,
        colorTempK: level.colorTempK,
        position: fixture?.position ?? null
      }
    })
    .sort((a, b) => a.channel - b.channel)
}

/** 冲突唯一键，用于把上次的处置结果沿用到重算后的冲突列表 */
function conflictKey(kind: RecoveryConflictKind, cueId: string, fixtureId?: string | null): string {
  return `${kind}:${cueId}:${fixtureId ?? ''}`
}

type ResolutionMap = Map<string, RecoveryConflict['resolution']>

/** 比对一条快照 Cue 与主表 Cue，产出计划 / 现场两版字段差异 */
function diffCueFields(snapshot: LiveCueSnapshot, cue: Cue): RecoveryFieldDiff[] {
  const diffs: RecoveryFieldDiff[] = []
  CUE_FIELDS.forEach(({ field, label }) => {
    const liveValue = snapshotValue(snapshot, field)
    const planValue = cueValue(cue, field)
    if (liveValue !== planValue) {
      diffs.push({ field, label, planValue, liveValue })
    }
  })
  return diffs
}

/**
 * 检测计划（主表）与现场（快照）的冲突：
 * - cue：同一条 Cue 本体字段被主表改过；
 * - missing-cue：现场走过的 Cue 已从主表删除；
 * - channel：同一 Cue 同一通道电平被主表改过（含计划侧已清空）；
 * - missing-fixture：现场通道已从配接表删除。
 *
 * 已做过处置（plan / live）的冲突沿用上次结果；新增冲突默认为 pending（留到下次）。
 */
export function detectRecoveryConflicts(
  recovery: LiveRecovery,
  cues: readonly Cue[],
  levels: readonly CueLevel[],
  fixtures: readonly Fixture[],
  previous: readonly RecoveryConflict[] = []
): RecoveryConflict[] {
  const cuesById = new Map(cues.map((cue) => [cue.id, cue]))
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]))
  const levelByPair = new Map(levels.map((level) => [`${level.cueId}:${level.fixtureId}`, level]))
  const prior: ResolutionMap = new Map(previous.map((item) => [conflictKey(item.kind, item.cueId, item.fixtureId), item.resolution]))

  // 只比对拉停时已经发生过的现场：已走过 + 当前 Cue；未走到的未来 Cue 仍按主表计划执行
  const liveCueIds = new Set<string>(recovery.played.map((item) => item.cueId))
  if (recovery.currentCueId) liveCueIds.add(recovery.currentCueId)

  const conflicts: RecoveryConflict[] = []
  const push = (conflict: Omit<RecoveryConflict, 'resolution'>): void => {
    conflicts.push({ ...conflict, resolution: prior.get(conflictKey(conflict.kind, conflict.cueId, conflict.fixtureId)) ?? 'pending' })
  }

  recovery.cueSnapshots
    .filter((snapshot) => liveCueIds.has(snapshot.cueId))
    .forEach((snapshot) => {
    const cue = cuesById.get(snapshot.cueId)
    if (!cue) {
      push({
        kind: 'missing-cue',
        cueId: snapshot.cueId,
        cueNo: snapshot.cueNo,
        message: `现场记录里的 ${snapshot.cueNo} 已不在主表，需确认恢复时重建还是放弃`
      })
      return
    }

    const fieldDiffs = diffCueFields(snapshot, cue)
    if (fieldDiffs.length > 0) {
      push({
        kind: 'cue',
        cueId: cue.id,
        cueNo: cue.cueNo,
        fieldDiffs,
        message: `${cue.cueNo} 的 ${fieldDiffs.map((diff) => diff.label).join('、')} 与现场记录不一致`
      })
    }

    recovery.levelSnapshots
      .filter((item) => item.cueId === snapshot.cueId)
      .forEach((liveLevel) => {
        const fixture = fixturesById.get(liveLevel.fixtureId)
        if (!fixture) {
          push({
            kind: 'missing-fixture',
            cueId: cue.id,
            cueNo: cue.cueNo,
            fixtureId: liveLevel.fixtureId,
            channel: liveLevel.channel,
            message: `${cue.cueNo} 的 CH${liveLevel.channel}（现场电平 ${liveLevel.intensity}%）已不在灯位配接表`
          })
          return
        }
        const planLevel = levelByPair.get(`${cue.id}:${fixture.id}`)
        const planIntensity = planLevel?.intensity ?? null
        const planColorTempK = planLevel?.colorTempK ?? null
        const differs =
          planLevel === undefined ||
          planLevel.intensity !== liveLevel.intensity ||
          planLevel.colorTempK !== liveLevel.colorTempK
        if (differs) {
          push({
            kind: 'channel',
            cueId: cue.id,
            cueNo: cue.cueNo,
            fixtureId: fixture.id,
            channel: fixture.channel,
            planIntensity,
            planColorTempK,
            liveIntensity: liveLevel.intensity,
            liveColorTempK: liveLevel.colorTempK,
            message:
              planLevel === undefined
                ? `${cue.cueNo} · CH${fixture.channel} 计划侧已清空电平，现场为 ${liveLevel.intensity}%/${liveLevel.colorTempK}K`
                : `${cue.cueNo} · CH${fixture.channel} 计划 ${planIntensity}%/${planColorTempK}K ↔ 现场 ${liveLevel.intensity}%/${liveLevel.colorTempK}K`
          })
        }
      })
  })

  return conflicts
}

/** 未处理（留到下次）的冲突数量 */
export function countPendingConflicts(conflicts: readonly RecoveryConflict[]): number {
  return conflicts.filter((conflict) => conflict.resolution === 'pending').length
}

/** 合并主表 Cue 与现场快照，生成按时间轴排序的恢复视图（两者取并集） */
export function buildRecoveryTimeline(
  recovery: LiveRecovery,
  masterCues: readonly Cue[]
): RecoveryTimelineEntry[] {
  const playedMap = new Map(recovery.played.map((item) => [item.cueId, item]))

  const toEntry = (
    cueId: string,
    cue: Cue | undefined,
    snapshot: LiveCueSnapshot | undefined
  ): RecoveryTimelineEntry => {
    const played: PlayedCueRecord | undefined = playedMap.get(cueId)
    return {
      cueId,
      cueNo: cue?.cueNo ?? snapshot?.cueNo ?? 'Q?',
      label: cue?.label ?? snapshot?.label ?? '',
      trigger: cue?.trigger ?? snapshot?.trigger ?? '手动',
      fadeInSec: cue?.fadeInSec ?? snapshot?.fadeInSec ?? 0,
      fadeOutSec: cue?.fadeOutSec ?? snapshot?.fadeOutSec ?? 0,
      holdSec: cue?.holdSec ?? snapshot?.holdSec ?? 0,
      note: cue?.note ?? snapshot?.note ?? '',
      orderIndex: cue?.orderIndex ?? snapshot?.orderIndex ?? Number.MAX_SAFE_INTEGER,
      state: played !== undefined ? 'played' : cueId === recovery.currentCueId ? 'current' : 'pending',
      missingInMaster: cue === undefined,
      actualAt: played?.actualAt ?? null
    }
  }

  const seen = new Set<string>()
  const entries: RecoveryTimelineEntry[] = []
  masterCues.forEach((cue) => {
    seen.add(cue.id)
    entries.push(toEntry(cue.id, cue, recovery.cueSnapshots.find((snapshot) => snapshot.cueId === cue.id)))
  })
  recovery.cueSnapshots.forEach((snapshot) => {
    if (seen.has(snapshot.cueId)) return
    seen.add(snapshot.cueId)
    entries.push(toEntry(snapshot.cueId, undefined, snapshot))
  })

  return entries.sort(
    (a, b) => a.orderIndex - b.orderIndex || compareCueNo(a.cueNo, b.cueNo) || a.cueId.localeCompare(b.cueId)
  )
}

/**
 * 预计时刻按复演时刻重算：
 * 当前 Cue 预计时刻 = resumeAt；其后每条按上一条的（渐亮 + 保持 + 渐暗）累计偏移。
 * 已走过 Cue 不参与预计，返回空。
 */
export function computeRecoveryEta(recovery: LiveRecovery, timeline: readonly RecoveryTimelineEntry[]): RecoveryEta[] {
  const base = new Date(recovery.resumeAt).getTime()
  if (!Number.isFinite(base)) return []

  const ordered = [...timeline].sort(
    (a, b) => a.orderIndex - b.orderIndex || compareCueNo(a.cueNo, b.cueNo)
  )
  const currentIndex = ordered.findIndex((entry) => entry.cueId === recovery.currentCueId)
  if (currentIndex < 0) return []

  const result: RecoveryEta[] = []
  let offsetSec = 0
  for (let index = currentIndex; index < ordered.length; index += 1) {
    const entry = ordered[index]
    result.push({ cueId: entry.cueId, offsetSec, time: new Date(base + offsetSec * 1000) })
    offsetSec += cueTotalSeconds({ fadeInSec: entry.fadeInSec, fadeOutSec: entry.fadeOutSec, holdSec: entry.holdSec })
  }
  return result
}

/** Date / ISO → `HH:mm:ss`，用于预计时刻展示 */
export function formatClockTime(time: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`
}

/** 当前 Cue 的现场快照（拉停定格的那条） */
export function currentSnapshotOf(recovery: LiveRecovery): LiveCueSnapshot | null {
  if (!recovery.currentCueId) return null
  return recovery.cueSnapshots.find((snapshot) => snapshot.cueId === recovery.currentCueId) ?? null
}
