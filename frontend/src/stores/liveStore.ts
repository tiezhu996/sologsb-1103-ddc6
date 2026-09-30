import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { CueLevel } from '@/types/level'
import type {
  LiveChannelFrame,
  LiveConflict,
  LiveConflictChoice,
  LiveCueSnapshot,
  LiveRun,
  LiveRunDraft,
  LiveRunStatus
} from '@/types/live'
import type { Fixture } from '@/types/fixture'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import {
  buildFrameFromPlan,
  canWalkCue,
  detectLiveConflicts,
  frameOfExecuted,
  recalibrateFrame,
  snapshotCue
} from '@/utils/liveRecovery'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'
import { sortCues } from '@/utils/cueOrder'

/** 现场记录可更新字段 */
export type LiveRunPatch = Partial<Pick<LiveRun, 'title' | 'note' | 'resumedAt'>>

/** 通道帧手动微调补丁 */
export interface FramePatch {
  intensity?: number
  colorTempK?: number
  focusNote?: string
}

function clampIntensity(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

/**
 * 现场恢复仓库：维护每场演出的现场记录（当前 Cue、最后一帧、已走过列表）、
 * 拉停 / 复演 / 补走 / 跳回，以及计划与现场两版冲突的确认留档。
 */
export const useLiveStore = defineStore('live', () => {
  const runs = ref<LiveRun[]>([])
  const currentRunId = ref<string | null>(null)
  const hydrated = ref(false)

  const runsSorted = computed(() =>
    [...runs.value].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
  )

  function runById(id: string): LiveRun | null {
    return runs.value.find((run) => id === run.id) ?? null
  }

  function runsOfSession(sessionId: string): LiveRun[] {
    return runsSorted.value.filter((run) => run.sessionId === sessionId)
  }

  /** 一场戏当前仍可恢复（演出中 / 已拉停）的记录，至多一条 */
  function activeRunOfSession(sessionId: string): LiveRun | null {
    return runs.value.find((run) => run.sessionId === sessionId && run.status !== 'closed') ?? null
  }

  const currentRun = computed<LiveRun | null>(() => (currentRunId.value ? runById(currentRunId.value) : null))

  function setCurrentRun(id: string | null): void {
    currentRunId.value = id && runById(id) ? id : null
  }

  /** 旧数据兼容：补齐历史版本可能缺失的现场记录字段 */
  function normalize(run: LiveRun): LiveRun {
    const next: LiveRun = { ...run }
    if (!Array.isArray(next.executed)) next.executed = []
    if (!Array.isArray(next.frame)) next.frame = []
    if (!Array.isArray(next.resolutions)) next.resolutions = []
    if (!next.status || !['running', 'halted', 'closed'].includes(next.status)) next.status = 'halted'
    if (typeof next.currentCueId === 'undefined') next.currentCueId = next.currentCue?.cueId ?? null
    if (!next.note) next.note = ''
    if (!next.title) next.title = '未命名现场记录'
    if (!next.startedAt) next.startedAt = new Date(next.createdAt || Date.now()).toISOString()
    if (!next.updatedAt) next.updatedAt = next.createdAt || Date.now()
    return next
  }

  async function hydrate(): Promise<void> {
    const raw = await db.liveRuns.toArray()
    runs.value = raw.map(normalize)
    hydrated.value = true
  }

  async function persist(run: LiveRun): Promise<LiveRun> {
    const next: LiveRun = { ...run, updatedAt: Date.now() }
    await db.liveRuns.put(next)
    runs.value = runs.value.map((item) => (item.id === next.id ? next : item))
    return next
  }

  /** 开演：以主表当前编排建立现场记录，预置第一条 Cue 但不记入已走过列表 */
  async function startRun(draft: LiveRunDraft): Promise<LiveRun | null> {
    const cueStore = useCueStore()
    const fixtureStore = useFixtureStore()
    const levelStore = useLevelStore()
    const ordered = sortCues(cueStore.cuesOfSession(draft.sessionId))
    if (ordered.length === 0) return null
    const first = ordered[0]
    const now = new Date().toISOString()
    const created: LiveRun = {
      id: createId('live'),
      sessionId: draft.sessionId,
      title: draft.title.trim() || `现场记录 ${new Date().toLocaleString()}`,
      status: 'running',
      startedAt: now,
      stoppedAt: null,
      resumedAt: now,
      currentCueId: first.id,
      currentCue: snapshotCue(first),
      executed: [],
      frame: buildFrameFromPlan(fixtureStore.fixturesOfSession(draft.sessionId), levelStore.levelsOfCue(first.id)),
      resolutions: [],
      note: draft.note.trim(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    await db.liveRuns.put(created)
    runs.value = [...runs.value, created]
    currentRunId.value = created.id
    return created
  }

  async function updateRun(id: string, patch: LiveRunPatch): Promise<LiveRun | null> {
    const target = runById(id)
    if (!target) return null
    return persist({ ...target, ...patch })
  }

  /** 拉停：定格最后一帧；记录拉停时刻 */
  async function halt(id: string, frameOverride?: LiveChannelFrame[]): Promise<LiveRun | null> {
    const target = runById(id)
    if (!target || target.status === 'closed') return null
    const now = new Date().toISOString()
    return persist({
      ...target,
      status: 'halted',
      stoppedAt: now,
      resumedAt: target.resumedAt ?? now,
      frame: frameOverride ? frameOverride.map((item) => ({ ...item })) : target.frame
    })
  }

  /**
   * 复演：从现场继续。预计时刻一律按传入的复演时刻重算；
   * 通道帧用主表当前配接重新校准通道号 / 灯位快照。
   */
  async function resume(id: string, resumedAt: string): Promise<LiveRun | null> {
    const target = runById(id)
    if (!target || target.status === 'closed') return null
    const fixtureStore = useFixtureStore()
    return persist({
      ...target,
      status: 'running',
      resumedAt,
      frame: recalibrateFrame(target.frame, fixtureStore.fixturesOfSession(target.sessionId))
    })
  }

  /** 从当前 Cue 的计划电平重新取一帧（现场未手工干预时的便捷操作）；主表已删该 Cue 时拒绝清空现场帧 */
  async function resetFrameFromPlan(id: string): Promise<LiveRun | null> {
    const target = runById(id)
    if (!target || !target.currentCueId) return null
    const cueStore = useCueStore()
    if (!cueStore.cueById(target.currentCueId)) return target
    const fixtureStore = useFixtureStore()
    const levelStore = useLevelStore()
    return persist({
      ...target,
      frame: buildFrameFromPlan(
        fixtureStore.fixturesOfSession(target.sessionId),
        levelStore.levelsOfCue(target.currentCueId)
      )
    })
  }

  /** 手动修正最后一帧中某通道电平（拉停后按灯控台实际输出录入） */
  async function patchFrame(id: string, fixtureId: string, patch: FramePatch): Promise<LiveRun | null> {
    const target = runById(id)
    if (!target) return null
    const frame = target.frame.map((item) => {
      if (item.fixtureId !== fixtureId) return item
      return {
        ...item,
        intensity: patch.intensity === undefined ? item.intensity : clampIntensity(patch.intensity),
        colorTempK: patch.colorTempK === undefined ? item.colorTempK : Math.round(patch.colorTempK),
        focusNote: patch.focusNote === undefined ? item.focusNote : patch.focusNote
      }
    })
    return persist({ ...target, frame })
  }

  /** 走出一条 Cue：记入已走过列表，当前 Cue 与帧推进到目标 Cue 的计划状态 */
  async function walkCue(id: string, cueId: string): Promise<LiveRun | null> {
    const target = runById(id)
    if (!target || target.status === 'closed') return null
    const cueStore = useCueStore()
    const fixtureStore = useFixtureStore()
    const levelStore = useLevelStore()
    const cue = cueStore.cueById(cueId)
    if (!cue || cue.sessionId !== target.sessionId) return null
    if (!canWalkCue(sortCues(cueStore.cuesOfSession(target.sessionId)), target.currentCueId, cue.id)) {
      return null
    }

    const executedAt = new Date().toISOString()
    const snapshot: LiveCueSnapshot = snapshotCue(cue)
    const frame = buildFrameFromPlan(
      fixtureStore.fixturesOfSession(target.sessionId),
      levelStore.levelsOfCue(cue.id)
    )
    // 重走同一条（补走）时替换原条目，保留首次之后的最新走出时刻
    const executed = target.executed.filter((item) => item.cueId !== cue.id)
    executed.push({ ...snapshot, executedAt, channels: frame.map((item) => ({ ...item })) })

    return persist({
      ...target,
      status: 'running',
      stoppedAt: null,
      currentCueId: cue.id,
      currentCue: snapshot,
      executed,
      frame
    })
  }

  /**
   * 跳回：把当前 Cue 回退到已走过列表中的某一条，
   * 其后走过的 Cue 从已走过列表截掉（可再补走），帧复位为该条走出时快照。
   */
  async function jumpBack(id: string, cueId: string): Promise<LiveRun | null> {
    const target = runById(id)
    if (!target || target.status === 'closed') return null
    const index = target.executed.findIndex((item) => item.cueId === cueId)
    if (index < 0) return null
    const truncated = target.executed.slice(0, index + 1)
    const snapshot = truncated[index]
    return persist({
      ...target,
      status: 'running',
      stoppedAt: null,
      currentCueId: snapshot.cueId,
      currentCue: {
        cueId: snapshot.cueId,
        cueNo: snapshot.cueNo,
        label: snapshot.label,
        trigger: snapshot.trigger,
        fadeInSec: snapshot.fadeInSec,
        fadeOutSec: snapshot.fadeOutSec,
        holdSec: snapshot.holdSec,
        note: snapshot.note
      },
      executed: truncated,
      frame: frameOfExecuted(truncated, snapshot.cueId)
    })
  }

  /** 确认一条冲突：保留现场版 / 采用计划版；采用计划版时同步现场快照与帧 */
  async function resolveConflict(id: string, conflict: LiveConflict, choice: LiveConflictChoice): Promise<LiveRun | null> {
    const target = runById(id)
    if (!target) return null
    if (choice === 'take-master' && conflict.plannedMissing) return target

    const cueStore = useCueStore()
    const fixtureStore = useFixtureStore()
    const levelStore = useLevelStore()

    let next: LiveRun = {
      ...target,
      resolutions: [...target.resolutions.filter((item) => item.signature !== conflict.signature), { signature: conflict.signature, choice, resolvedAt: Date.now() }]
    }

    if (choice === 'take-master') {
      if (conflict.kind === 'cue') {
        const planned = cueStore.cueById(conflict.cueId)
        if (planned) {
          const snapshot = snapshotCue(planned)
          next = {
            ...next,
            currentCue: next.currentCue?.cueId === conflict.cueId ? snapshot : next.currentCue,
            executed: next.executed.map((item) => (item.cueId === conflict.cueId ? { ...item, ...snapshot } : item))
          }
        }
      } else if (conflict.fixtureId) {
        const fixtureId = conflict.fixtureId
        const plannedCue = cueStore.cueById(conflict.cueId)
        const fixture = fixtureStore.fixtureById(fixtureId)
        const level = plannedCue ? levelStore.levelOf(plannedCue.id, fixtureId) : null
        next = {
          ...next,
          frame: plannedCue && next.currentCueId === plannedCue.id ? applyPlanToFrame(next.frame, fixtureId, fixture, level) : next.frame,
          executed: next.executed.map((item) => {
            if (item.cueId !== conflict.cueId || !plannedCue) return item
            const itemLevel = levelStore.levelOf(plannedCue.id, fixtureId)
            return {
              ...item,
              channels: applyPlanToFrame(item.channels, fixtureId, fixture, itemLevel)
            }
          })
        }
      }
    }

    return persist(next)
  }

  /** 批量确认；计划侧已删除的冲突只能保留现场版，自动跳过 */
  async function resolveAllConflicts(id: string, conflicts: readonly LiveConflict[], choice: LiveConflictChoice): Promise<LiveRun | null> {
    let current = runById(id)
    if (!current) return null
    for (const conflict of conflicts) {
      if (choice === 'take-master' && conflict.plannedMissing) continue
      const updated = await resolveConflict(current.id, conflict, choice)
      if (updated) current = updated
    }
    return current
  }

  function applyPlanToFrame(
    frame: readonly LiveChannelFrame[],
    fixtureId: string,
    fixture: Fixture | null,
    level: CueLevel | null
  ): LiveChannelFrame[] {
    // 计划已无该通道（不参与本 Cue / 配接被删）→ 从帧中移除
    if (!fixture || !level) return frame.filter((item) => item.fixtureId !== fixtureId)
    const existing = frame.find((item) => item.fixtureId === fixtureId)
    const row: LiveChannelFrame = {
      fixtureId,
      channel: fixture.channel,
      position: fixture.position,
      fixtureType: fixture.fixtureType,
      intensity: level.intensity,
      colorTempK: level.colorTempK,
      focusNote: level.focusNote
    }
    return existing ? frame.map((item) => (item.fixtureId === fixtureId ? row : item)) : [...frame, row].sort((a, b) => a.channel - b.channel)
  }

  /** 重新计算现场记录与主表之间待处理的冲突（已确认且签名未变的不再出现） */
  function conflictsOf(run: LiveRun): LiveConflict[] {
    const cueStore = useCueStore()
    const fixtureStore = useFixtureStore()
    const levelStore = useLevelStore()
    return detectLiveConflicts({
      run,
      cueById: new Map(cueStore.cues.map((cue) => [cue.id, cue])),
      fixtureById: new Map(fixtureStore.fixtures.map((fixture) => [fixture.id, fixture])),
      planLevel: (cueId, fixtureId) => levelStore.levelOf(cueId, fixtureId),
      planCueLevels: (cueId) => levelStore.levelsOfCue(cueId)
    })
  }

  async function removeRun(id: string): Promise<void> {
    await db.liveRuns.delete(id)
    runs.value = runs.value.filter((run) => run.id !== id)
    if (currentRunId.value === id) currentRunId.value = null
  }

  /** 归档（结束）现场记录；归档后只读，不再出现在恢复入口 */
  async function closeRun(id: string): Promise<LiveRun | null> {
    const target = runById(id)
    if (!target) return null
    return persist({ ...target, status: 'closed' as LiveRunStatus })
  }

  async function removeBySession(sessionId: string): Promise<void> {
    const ids = runs.value.filter((run) => run.sessionId === sessionId).map((run) => run.id)
    if (ids.length === 0) return
    await db.liveRuns.bulkDelete(ids)
    runs.value = runs.value.filter((run) => run.sessionId !== sessionId)
    if (currentRunId.value && ids.includes(currentRunId.value)) currentRunId.value = null
  }

  return {
    runs,
    runsSorted,
    currentRunId,
    currentRun,
    hydrated,
    runById,
    runsOfSession,
    activeRunOfSession,
    setCurrentRun,
    hydrate,
    startRun,
    updateRun,
    halt,
    resume,
    resetFrameFromPlan,
    patchFrame,
    walkCue,
    jumpBack,
    resolveConflict,
    resolveAllConflicts,
    conflictsOf,
    removeRun,
    closeRun,
    removeBySession
  }
})
