import type { CueTrigger } from '@/types/cue'
import type { FixturePosition, FixtureType } from '@/types/fixture'

/**
 * 现场恢复（LiveRecovery）：演出中途拉停后留存的现场记录。
 *
 * 拉停瞬间记录：当前 Cue、已走过 Cue 列表、灯控台末帧各通道电平与复演时刻；
 * 同时对「已走过 + 当前」Cue 及其通道电平做现场快照，便于重开时与主表（计划）
 * 逐条比对。预计时刻不入库，每次按复演时刻重新累加计算。
 */

/** 现场恢复状态 */
export const RECOVERY_STATUSES = ['进行中', '已完结'] as const
export type RecoveryStatus = (typeof RECOVERY_STATUSES)[number]

/** 末帧中的一个通道电平（按 fixtureId / channel 双通道留存，兼容通道被改配的情况） */
export interface LiveFrameChannel {
  /** 当前主表灯位通道 id；通道已删除时为空 */
  fixtureId: string | null
  /** 拉停时记录的 DMX 通道号，便于人工辨认与重新配接 */
  channel: number
  /** 现场末帧亮度 0-100（%） */
  intensity: number
  /** 现场末帧色温（K） */
  colorTempK: number
  /** 拉停时的灯位方位（仅展示用快照） */
  position: FixturePosition | null
}

/** 已走过 Cue 的现场记录 */
export interface PlayedCueRecord {
  /** Cue id；Cue 已从主表删除时仍以现场快照保留 */
  cueId: string
  /** 实际走条时刻，ISO 字符串；拉停时手工勾选的走过项可空 */
  actualAt: string | null
}

/** 拉停时的 Cue 现场快照字段 */
export interface LiveCueSnapshot {
  cueId: string
  cueNo: string
  label: string
  trigger: CueTrigger
  fadeInSec: number
  fadeOutSec: number
  holdSec: number
  note: string
  /** 拉停时的时间轴位次 */
  orderIndex: number
}

/** 拉停时某条 Cue 下单个通道的电平现场快照 */
export interface LiveLevelSnapshot {
  cueId: string
  fixtureId: string
  /** 拉停时的通道号 */
  channel: number
  intensity: number
  colorTempK: number
  position: FixturePosition | null
}

/** 冲突项类型：Cue 本体被主表改动，或其通道电平被主表改动 */
export type RecoveryConflictKind = 'cue' | 'channel' | 'missing-cue' | 'missing-fixture'

/** 单个字段的计划 / 现场两版取值 */
export interface RecoveryFieldDiff {
  field: keyof LiveCueSnapshot
  label: string
  /** 主表（计划）现值；主表已删除该 Cue 时为 null */
  planValue: string | number | null
  /** 现场快照值 */
  liveValue: string | number
}

/** 冲突处置方式：采纳计划版（保持主表）/ 采纳现场版（写回主表）/ 暂不处理（留到下次） */
export type RecoveryResolution = 'plan' | 'live' | 'pending'

/** 一条待确认的冲突（计划 vs 现场） */
export interface RecoveryConflict {
  kind: RecoveryConflictKind
  cueId: string
  cueNo: string
  /** channel 类冲突对应的通道 */
  fixtureId?: string
  channel?: number
  /** cue 类冲突的字段级差异 */
  fieldDiffs?: RecoveryFieldDiff[]
  /** channel 类冲突：计划电平；主表已删除电平 / Cue 时为 null */
  planIntensity?: number | null
  planColorTempK?: number | null
  /** channel 类冲突：现场电平 */
  liveIntensity?: number
  liveColorTempK?: number
  /** 当前处置；pending 表示未处理，留到下次 */
  resolution: RecoveryResolution
  /** 冲突描述 */
  message: string
}

/** 现场恢复主记录 */
export interface LiveRecovery {
  /** 主键 */
  id: string
  /** 所属场次 */
  sessionId: string
  /** 恢复单标题，例如「首演中场拉停」 */
  title: string
  status: RecoveryStatus
  /** 拉停发生时刻，ISO 字符串 */
  stoppedAt: string
  /** 复演起点时刻（当前 Cue 的预计时刻基准），ISO 字符串 */
  resumeAt: string
  /** 当前 Cue id（拉停时正停在的那条） */
  currentCueId: string | null
  /** 已走过 Cue 列表（按时间轴先后） */
  played: PlayedCueRecord[]
  /** 灯控台末帧各通道电平 */
  frame: LiveFrameChannel[]
  /** 已走过 + 当前 Cue 的现场快照 */
  cueSnapshots: LiveCueSnapshot[]
  /** 已走过 + 当前 Cue 的通道电平现场快照 */
  levelSnapshots: LiveLevelSnapshot[]
  /** 备注 */
  note: string
  createdAt: number
  updatedAt: number
}

/** 登记拉停时提交的字段集合 */
export interface LiveRecoveryDraft {
  sessionId: string
  title: string
  resumeAt: string
  currentCueId: string | null
  /** 已走过 Cue id（按时间轴先后） */
  playedCueIds: string[]
  note: string
}

/** 时间轴上单条 Cue 在本次恢复中的归位 */
export type RecoveryCueState = 'played' | 'current' | 'pending'

/** 恢复台展示的时间轴行（主表 Cue 与现场快照合并后的视图） */
export interface RecoveryTimelineEntry {
  cueId: string
  cueNo: string
  label: string
  trigger: CueTrigger
  fadeInSec: number
  fadeOutSec: number
  holdSec: number
  note: string
  orderIndex: number
  state: RecoveryCueState
  /** 是否已不在主表（仅存于现场快照） */
  missingInMaster: boolean
  /** 已走过项的实际时刻（ISO 或 null） */
  actualAt: string | null
}

/** 时间轴上某条 Cue 的预计时刻信息 */
export interface RecoveryEta {
  cueId: string
  /** 距复演起点的累计偏移（秒） */
  offsetSec: number
  /** 预计时刻（Date） */
  time: Date
}

/** 现场快照中一个灯位的轻量信息（重建通道时用） */
export interface SnapshotFixtureLike {
  channel: number
  position: FixturePosition | null
  fixtureType: FixtureType | null
}
