import type { Cue } from '@/types/cue'
import type { Fixture } from '@/types/fixture'
import type { CueLevel } from '@/types/level'
import type { LiveRun } from '@/types/live'
import { buildFrameFromPlan, canWalkCue, detectLiveConflicts, buildLiveSchedule, formatPredicted } from '@/utils/liveRecovery'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`PASS ${name}`)
  } else {
    failures += 1
    console.error(`FAIL ${name}`, detail ?? '')
  }
}

const now = Date.now()
const fixtures: Fixture[] = [
  {
    id: 'fix1', sessionId: 's1', channel: 1, position: '面光', fixtureType: '成像灯',
    gel: '', patchNote: '', createdAt: now, updatedAt: now
  },
  {
    id: 'fix2', sessionId: 's1', channel: 2, position: '顶排', fixtureType: '聚光灯',
    gel: '', patchNote: '', createdAt: now, updatedAt: now
  }
]

function cue(id: string, cueNo: string, orderIndex: number, fadeInSec = 3, holdSec = 5, fadeOutSec = 2): Cue {
  return {
    id, sessionId: 's1', cueNo, label: `${cueNo} label`, trigger: '手动',
    fadeInSec, fadeOutSec, holdSec, note: '', orderIndex, createdAt: now, updatedAt: now
  }
}

const cues: Cue[] = [cue('c1', 'Q1', 1), cue('c2', 'Q2', 2), cue('c3', 'Q3', 3)]

const levels: CueLevel[] = [
  { id: 'l1', cueId: 'c1', fixtureId: 'fix1', intensity: 60, colorTempK: 3200, focusNote: '', updatedAt: now },
  { id: 'l2', cueId: 'c1', fixtureId: 'fix2', intensity: 40, colorTempK: 3200, focusNote: '', updatedAt: now }
]

const frameC1 = buildFrameFromPlan(fixtures, levels)
check('frame from plan has 2 channels', frameC1.length === 2)
check('frame sorted by channel', frameC1[0].channel === 1 && frameC1[1].channel === 2)

/** 现场记录：Q1 已走且为当前 Cue（拉停），复演 19:30:00 */
const run: LiveRun = {
  id: 'live1', sessionId: 's1', title: 't', status: 'halted',
  startedAt: '2026-09-30T11:00:00.000Z', stoppedAt: '2026-09-30T11:20:00.000Z',
  resumedAt: '2026-09-30T11:30:00.000Z',
  currentCueId: 'c1',
  currentCue: {
    cueId: 'c1', cueNo: 'Q1', label: 'Q1 label', trigger: '手动',
    fadeInSec: 3, fadeOutSec: 2, holdSec: 5, note: ''
  },
  executed: [
    {
      cueId: 'c1', cueNo: 'Q1', label: 'Q1 label', trigger: '手动',
      fadeInSec: 3, fadeOutSec: 2, holdSec: 5, note: '',
      executedAt: '2026-09-30T11:05:00.000Z', channels: frameC1.map((f) => ({ ...f }))
    }
  ],
  frame: frameC1.map((f) => ({ ...f })),
  resolutions: [], note: '', createdAt: now, updatedAt: now
}

const cueById = new Map(cues.map((c) => [c.id, c]))
const fixtureById = new Map(fixtures.map((f) => [f.id, f]))
const planLevel = (cueId: string, fixtureId: string): CueLevel | null =>
  levels.find((l) => l.cueId === cueId && l.fixtureId === fixtureId) ?? null
const planCueLevels = (cueId: string): CueLevel[] => levels.filter((l) => l.cueId === cueId)

// 无改动：无冲突
const noConflicts = detectLiveConflicts({ run, cueById, fixtureById, planLevel, planCueLevels })
check('no conflicts when master unchanged', noConflicts.length === 0, noConflicts)

// 主表改了 Q1 的 fadeIn → Cue 冲突
const modifiedCues = cues.map((c) => (c.id === 'c1' ? { ...c, fadeInSec: 9 } : c))
const cueConflicts = detectLiveConflicts({
  run,
  cueById: new Map(modifiedCues.map((c) => [c.id, c])),
  fixtureById,
  planLevel,
  planCueLevels
})
check('cue conflict detected after fadeIn change', cueConflicts.length === 1 && cueConflicts[0].kind === 'cue', cueConflicts)
check('cue conflict shows fadeIn 9s vs 3s', cueConflicts[0]?.fields.some((f) => f.label === '渐亮' && f.planned === '9s' && f.live === '3s'))

// 主表改了 CH1 在 Q1 的亮度 → channel 冲突
const modifiedLevels = levels.map((l) => (l.id === 'l1' ? { ...l, intensity: 80 } : l))
const channelConflicts = detectLiveConflicts({
  run,
  cueById,
  fixtureById,
  planLevel: (c, f) => modifiedLevels.find((l) => l.cueId === c && l.fixtureId === f) ?? null,
  planCueLevels: (c) => modifiedLevels.filter((l) => l.cueId === c)
})
const chConflict = channelConflicts.find((c) => c.kind === 'channel')
check('channel conflict detected after intensity change', Boolean(chConflict), channelConflicts)
check('channel conflict is CH1 80% vs 60%', chConflict?.channel === 1 && chConflict.fields.some((f) => f.label === '亮度' && f.planned === '80%' && f.live === '60%'))

// 已确认且签名未变 → 不再出现
const resolved: LiveRun = {
  ...run,
  resolutions: cueConflicts.map((c) => ({ signature: c.signature, choice: 'keep-live' as const, resolvedAt: now }))
}
const afterResolve = detectLiveConflicts({
  run: resolved,
  cueById: new Map(modifiedCues.map((c) => [c.id, c])),
  fixtureById,
  planLevel,
  planCueLevels
})
check('resolved conflict disappears', afterResolve.length === 0, afterResolve)

// 主表再次改同一字段 → 签名变化 → 冲突重新浮现
const modifiedAgain = modifiedCues.map((c) => (c.id === 'c1' ? { ...c, fadeInSec: 12 } : c))
const reappear = detectLiveConflicts({
  run: resolved,
  cueById: new Map(modifiedAgain.map((c) => [c.id, c])),
  fixtureById,
  planLevel,
  planCueLevels
})
check('conflict reappears after further master change', reappear.length === 1, reappear)

// 主表删除当前 Cue → plannedMissing 冲突
const deletedC1 = cues.filter((c) => c.id !== 'c1')
const missing = detectLiveConflicts({
  run,
  cueById: new Map(deletedC1.map((c) => [c.id, c])),
  fixtureById,
  planLevel,
  planCueLevels
})
check('deleted cue yields plannedMissing cue conflict', missing.some((c) => c.kind === 'cue' && c.plannedMissing), missing)

// 预计时刻：当前 Q1 = 11:30:00（UTC）；Q2 = +10s=11:30:10；Q3 = 再 +10s = 11:30:20
const schedule = buildLiveSchedule(run, cues)
const byId = Object.fromEntries(schedule.map((i) => [i.cueId, i]))
check('current cue predicted at resume time', formatPredicted(byId.c1) === '11:30:00')
check('Q2 predicted +10s', formatPredicted(byId.c2) === '11:30:10', formatPredicted(byId.c2))
check('Q3 predicted +20s', formatPredicted(byId.c3) === '11:30:20', formatPredicted(byId.c3))
check('walked Q1 shows state current (current wins)', byId.c1.state === 'current')

// 复演时刻 23:59:55 + 10s 跨天
const lateRun: LiveRun = { ...run, resumedAt: '2026-09-30T23:59:55.000Z' }
const lateSchedule = buildLiveSchedule(lateRun, cues)
const lateC3 = lateSchedule.find((i) => i.cueId === 'c3')
check('cross-day gets +1天 suffix', lateC3 ? formatPredicted(lateC3).includes('+1天') : false, lateC3 && formatPredicted(lateC3))

// 补走门禁：当前 Q1 时只能走 Q1/Q2/Q3，不能走到前驱；当前 Cue 删除后仍允许后续补走
check('can walk current cue', canWalkCue(cues, 'c1', 'c1'))
check('can walk next cue', canWalkCue(cues, 'c1', 'c2'))
check('cannot walk predecessor', !canWalkCue(cues, 'c2', 'c1'))
check('current cue deleted: successor walkable', canWalkCue(cues, 'cX', 'c1'))
check('unknown cue not walkable', !canWalkCue(cues, 'c1', 'cX'))

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
if (failures > 0) process.exit(1)
