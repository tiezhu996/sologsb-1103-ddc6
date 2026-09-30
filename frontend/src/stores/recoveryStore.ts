import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  LiveFrameChannel,
  LiveRecovery,
  LiveRecoveryDraft,
  RecoveryConflict,
  RecoveryStatus
} from '@/types/live'
import { INTENSITY_MAX, INTENSITY_MIN } from '@/types/level'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'
import { buildRecoverySnapshots } from '@/utils/recovery'

/** 末帧通道电平补丁 */
export interface FramePatch {
  intensity?: number
  colorTempK?: number
}

function clampIntensity(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(INTENSITY_MAX, Math.max(INTENSITY_MIN, Math.round(value)))
}

/**
 * 现场恢复仓库：登记拉停记录、维护当前 Cue / 已走过列表 / 末帧电平，
 * 并在重开时把「计划 vs 现场」冲突逐条确认后合并回主表。
 */
export const useRecoveryStore = defineStore('recovery', () => {
  const recoveries = ref<LiveRecovery[]>([])
  /** 各恢复单当前检出的冲突（页面打开时计算并缓存，处置结果落库前留在这里） */
  const conflictsByRecovery = ref<Record<string, RecoveryConflict[]>>({})
  const hydrated = ref(false)

  const recoveriesSorted = computed(() =>
    [...recoveries.value].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
  )

  function recoveriesOfSession(sessionId: string): LiveRecovery[] {
    return recoveriesSorted.value.filter((recovery) => recovery.sessionId === sessionId)
  }

  function recoveryById(id: string): LiveRecovery | null {
    return recoveries.value.find((recovery) => recovery.id === id) ?? null
  }

  /** 该场次是否存在进行中的恢复单（用于导航角标提示） */
  function activeRecoveryOfSession(sessionId: string): LiveRecovery | null {
    return recoveriesSorted.value.find((recovery) => recovery.sessionId === sessionId && recovery.status === '进行中') ?? null
  }

  function conflictsOf(id: string): RecoveryConflict[] {
    return conflictsByRecovery.value[id] ?? []
  }

  function setConflicts(id: string, conflicts: RecoveryConflict[]): void {
    conflictsByRecovery.value = { ...conflictsByRecovery.value, [id]: conflicts }
  }

  async function hydrate(): Promise<void> {
    recoveries.value = await db.recoveries.toArray()
    hydrated.value = true
  }

  async function persist(recovery: LiveRecovery): Promise<void> {
    const next: LiveRecovery = { ...recovery, updatedAt: Date.now() }
    await db.recoveries.put(next)
    recoveries.value = recoveries.value.map((item) => (item.id === next.id ? next : item))
  }

  /** 登记一次拉停：记录当前 Cue、已走过列表，并对整场 Cue 留拉停时刻现场快照 */
  async function createRecovery(draft: LiveRecoveryDraft, frame: LiveFrameChannel[]): Promise<LiveRecovery | null> {
    const cueStore = useCueStore()
    const levelStore = useLevelStore()
    const fixtureStore = useFixtureStore()

    // 现场定格覆盖整场（含尚未走到的 Cue），作为后续「计划 vs 现场」比对与跳回定序的基准
    const snapshotCues = cueStore.sortedCuesOfSession(draft.sessionId)
    const current = draft.currentCueId ? cueStore.cueById(draft.currentCueId) : null
    const playedSet = new Set(draft.playedCueIds)
    const playedCues = snapshotCues.filter((cue) => playedSet.has(cue.id))

    const fixturesById = new Map(
      fixtureStore.fixturesOfSession(draft.sessionId).map((fixture) => [fixture.id, fixture])
    )
    const snapshotLevels = levelStore.levels.filter(
      (level) => snapshotCues.some((cue) => cue.id === level.cueId) && fixturesById.has(level.fixtureId)
    )
    const { cueSnapshots, levelSnapshots } = buildRecoverySnapshots(snapshotCues, snapshotLevels, fixturesById)

    const now = Date.now()
    const created: LiveRecovery = {
      id: createId('rec'),
      sessionId: draft.sessionId,
      title: draft.title.trim() || '拉停现场恢复',
      status: '进行中',
      stoppedAt: new Date(now).toISOString(),
      resumeAt: draft.resumeAt || new Date(now).toISOString(),
      currentCueId: current?.id ?? null,
      played: playedCues.map((cue) => ({ cueId: cue.id, actualAt: null })),
      frame: frame.map((channel) => ({ ...channel })),
      cueSnapshots,
      levelSnapshots,
      note: draft.note.trim(),
      createdAt: now,
      updatedAt: now
    }
    await db.recoveries.put(created)
    recoveries.value = [...recoveries.value, created]
    return created
  }

  /** 更新复演时刻（预计时刻随之重算） */
  async function setResumeAt(id: string, iso: string): Promise<void> {
    const target = recoveryById(id)
    if (!target) return
    await persist({ ...target, resumeAt: iso })
  }

  /** 修改末帧某通道电平 */
  async function updateFrameChannel(id: string, fixtureKey: string, patch: FramePatch): Promise<void> {
    const target = recoveryById(id)
    if (!target) return
    const frame = target.frame.map((channel) => {
      const key = channel.fixtureId ?? `ch:${channel.channel}`
      if (key !== fixtureKey) return channel
      return {
        ...channel,
        intensity: patch.intensity === undefined ? channel.intensity : clampIntensity(patch.intensity),
        colorTempK: patch.colorTempK === undefined ? channel.colorTempK : Math.round(patch.colorTempK)
      }
    })
    await persist({ ...target, frame })
  }

  /** 用当前 Cue 的计划电平重置末帧 */
  async function resetFrameToCurrent(id: string): Promise<void> {
    const target = recoveryById(id)
    if (!target || !target.currentCueId) return
    const levelStore = useLevelStore()
    const fixtureStore = useFixtureStore()
    const fixturesById = new Map(
      fixtureStore.fixturesOfSession(target.sessionId).map((fixture) => [fixture.id, fixture])
    )
    const frame: LiveFrameChannel[] = levelStore
      .levelsOfCue(target.currentCueId)
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
    await persist({ ...target, frame })
  }

  /** 把某条已走过 Cue 的实际走条时刻补记下来 */
  async function setPlayedActualAt(id: string, cueId: string, iso: string | null): Promise<void> {
    const target = recoveryById(id)
    if (!target) return
    const played = target.played.map((item) => (item.cueId === cueId ? { ...item, actualAt: iso } : item))
    await persist({ ...target, played })
  }

  /** 补走下一条：当前 Cue 计入已走过（记录实际走条时刻），当前指向下一条 */
  async function advance(id: string, nextCueId: string | null, actualAtIso: string): Promise<void> {
    const target = recoveryById(id)
    if (!target || !target.currentCueId) return
    const currentId = target.currentCueId
    const played = target.played.some((item) => item.cueId === currentId)
      ? target.played.map((item) => (item.cueId === currentId ? { ...item, actualAt: actualAtIso } : item))
      : [...target.played, { cueId: currentId, actualAt: actualAtIso }]
    await persist({ ...target, played, currentCueId: nextCueId })
  }

  /** 跳回某条 Cue：其后（含该条在已走过列表中的记录）全部回退为待走，当前指向它 */
  async function jumpBack(id: string, cueId: string): Promise<void> {
    const target = recoveryById(id)
    if (!target) return
    const cueStore = useCueStore()
    // 完整顺序 = 主表 Cue（按位次）∪ 仅存在于现场快照的 Cue
    const masterIds = cueStore.sortedCuesOfSession(target.sessionId).map((cue) => cue.id)
    const orderedIds = [...masterIds]
    target.cueSnapshots.forEach((snapshot) => {
      if (!orderedIds.includes(snapshot.cueId)) orderedIds.push(snapshot.cueId)
    })
    const targetIndex = orderedIds.indexOf(cueId)
    if (targetIndex < 0) return
    const keepIds = new Set(orderedIds.slice(0, targetIndex))
    const played = target.played.filter((item) => keepIds.has(item.cueId))
    await persist({ ...target, played, currentCueId: cueId })
  }

  /** 直接指到某条 Cue（跳过/补走定位，不改动已走过列表以外的状态） */
  async function setCurrentCue(id: string, cueId: string | null): Promise<void> {
    const target = recoveryById(id)
    if (!target) return
    await persist({ ...target, currentCueId: cueId })
  }

  /** 记录对某条冲突的处置（采纳计划 / 采纳现场 / 暂不处理） */
  function setConflictResolution(id: string, conflict: RecoveryConflict, resolution: RecoveryConflict['resolution']): void {
    const list = conflictsOf(id).map((item) =>
      item.kind === conflict.kind && item.cueId === conflict.cueId && item.fixtureId === conflict.fixtureId
        ? { ...item, resolution }
        : item
    )
    setConflicts(id, list)
  }

  /**
   * 把已确认（plan / live）的冲突合并回主表；resolution 为 pending 的冲突不动，留到下次。
   * - cue / live：现场快照字段写回主表 Cue；
   * - channel / live：现场电平 upsert 到主表 CueLevel；channel / plan：删除计划侧多出的电平；
   * - missing-cue / live：按现场快照重建 Cue；missing-fixture 无法自动重建配接，始终保留为待处理。
   */
  async function mergeResolved(id: string): Promise<{ merged: number; pending: number }> {
    const target = recoveryById(id)
    if (!target) return { merged: 0, pending: 0 }
    const cueStore = useCueStore()
    const levelStore = useLevelStore()
    const fixtureStore = useFixtureStore()

    const conflicts = conflictsOf(id)
    const actionable = conflicts.filter(
      (conflict) => conflict.resolution !== 'pending' && conflict.kind !== 'missing-fixture'
    )

    // 1. Cue 本体冲突：采纳现场则写字段；missing-cue 采纳现场则重建
    for (const conflict of actionable) {
      const latest = recoveryById(id)
      if (!latest) return { merged: 0, pending: 0 }
      const snapshot = latest.cueSnapshots.find((item) => item.cueId === conflict.cueId)
      if (!snapshot) continue
      if (conflict.kind === 'cue' && conflict.resolution === 'live') {
        await cueStore.updateCue(conflict.cueId, {
          cueNo: snapshot.cueNo,
          label: snapshot.label,
          trigger: snapshot.trigger,
          fadeInSec: snapshot.fadeInSec,
          fadeOutSec: snapshot.fadeOutSec,
          holdSec: snapshot.holdSec,
          note: snapshot.note
        })
      } else if (conflict.kind === 'missing-cue' && conflict.resolution === 'live') {
        const created = await cueStore.addCue({
          sessionId: latest.sessionId,
          cueNo: snapshot.cueNo,
          label: snapshot.label,
          trigger: snapshot.trigger,
          fadeInSec: snapshot.fadeInSec,
          fadeOutSec: snapshot.fadeOutSec,
          holdSec: snapshot.holdSec,
          note: snapshot.note,
          orderIndex: snapshot.orderIndex
        })
        // 让后续通道电平恢复、推进/跳回都对上重建后的 Cue（含其现场电平快照）
        await replaceCueId(latest, conflict.cueId, created.id)
      }
    }

    // 2. 通道电平冲突
    const refreshedForLevels = recoveryById(id)
    if (!refreshedForLevels) return { merged: 0, pending: 0 }
    for (const conflict of actionable) {
      if (conflict.kind !== 'channel') continue
      const liveLevel = refreshedForLevels.levelSnapshots.find(
        (item) => item.cueId === conflict.cueId && item.fixtureId === conflict.fixtureId
      )
      if (!liveLevel || !conflict.fixtureId) continue
      const fixtureStillExists = fixtureStore.fixtureById(conflict.fixtureId) !== null
      if (!fixtureStillExists) continue
      if (conflict.resolution === 'live') {
        await levelStore.upsertLevel(conflict.cueId, conflict.fixtureId, {
          intensity: liveLevel.intensity,
          colorTempK: liveLevel.colorTempK
        })
      } else if (conflict.resolution === 'plan') {
        // 计划侧没有该电平（现场多出）时，采纳计划即删除
        if (conflict.planIntensity === null) {
          await levelStore.removeLevel(conflict.cueId, conflict.fixtureId)
        }
      }
    }

    // 已处理冲突从缓存移除；pending（含 missing-fixture）保留到下次
    const remaining = conflictsOf(id).filter(
      (conflict) => conflict.resolution === 'pending' || conflict.kind === 'missing-fixture'
    )
    setConflicts(id, remaining)

    return { merged: actionable.length, pending: remaining.length }
  }

  /** 把恢复单里对某条 Cue 的引用（当前 / 已走过 / 快照）替换为重建后的新 id */
  async function replaceCueId(target: LiveRecovery, oldId: string, newId: string): Promise<void> {
    const played = target.played.map((item) => (item.cueId === oldId ? { ...item, cueId: newId } : item))
    const cueSnapshots = target.cueSnapshots.map((snapshot) =>
      snapshot.cueId === oldId ? { ...snapshot, cueId: newId } : snapshot
    )
    const levelSnapshots = target.levelSnapshots.map((snapshot) =>
      snapshot.cueId === oldId ? { ...snapshot, cueId: newId } : snapshot
    )
    await persist({
      ...target,
      currentCueId: target.currentCueId === oldId ? newId : target.currentCueId,
      played,
      cueSnapshots,
      levelSnapshots
    })
  }

  /** 完结恢复单（演出恢复完成，归档保留现场记录） */
  async function finish(id: string): Promise<void> {
    const target = recoveryById(id)
    if (!target) return
    await persist({ ...target, status: '已完结' })
  }

  async function reopen(id: string): Promise<void> {
    const target = recoveryById(id)
    if (!target) return
    await persist({ ...target, status: '进行中' })
  }

  async function updateStatus(id: string, status: RecoveryStatus): Promise<void> {
    const target = recoveryById(id)
    if (!target) return
    await persist({ ...target, status })
  }

  async function removeRecovery(id: string): Promise<void> {
    const target = recoveryById(id)
    if (!target) return
    await db.recoveries.delete(id)
    recoveries.value = recoveries.value.filter((recovery) => recovery.id !== id)
    const next = { ...conflictsByRecovery.value }
    delete next[id]
    conflictsByRecovery.value = next
  }

  async function removeBySession(sessionId: string): Promise<void> {
    const ids = recoveriesOfSession(sessionId).map((recovery) => recovery.id)
    if (ids.length === 0) return
    await db.recoveries.bulkDelete(ids)
    recoveries.value = recoveries.value.filter((recovery) => recovery.sessionId !== sessionId)
    const next = { ...conflictsByRecovery.value }
    ids.forEach((recoveryId) => delete next[recoveryId])
    conflictsByRecovery.value = next
  }

  return {
    recoveries,
    hydrated,
    recoveriesSorted,
    recoveriesOfSession,
    recoveryById,
    activeRecoveryOfSession,
    conflictsByRecovery,
    conflictsOf,
    setConflicts,
    hydrate,
    createRecovery,
    setResumeAt,
    updateFrameChannel,
    resetFrameToCurrent,
    setPlayedActualAt,
    advance,
    jumpBack,
    setCurrentCue,
    setConflictResolution,
    mergeResolved,
    finish,
    reopen,
    updateStatus,
    removeRecovery,
    removeBySession
  }
})
