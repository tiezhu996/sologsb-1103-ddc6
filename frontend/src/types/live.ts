import type { CueTrigger } from '@/types/cue'
import type { FixturePosition, FixtureType } from '@/types/fixture'

/** 现场记录状态：演出中 / 已拉停 / 已结束（归档） */
export const LIVE_RUN_STATUSES = ['running', 'halted', 'closed'] as const
export type LiveRunStatus = (typeof LIVE_RUN_STATUSES)[number]

export const LIVE_STATUS_LABEL: Record<LiveRunStatus, string> = {
  running: '演出中',
  halted: '已拉停',
  closed: '已结束'
}

/**
 * 现场通道帧（LiveChannelFrame）：拉停后灯控台最后一帧中某个通道的实际电平。
 * 通道号 / 灯位为落帧时的快照，主表之后改配接也能对照出差异。
 */
export interface LiveChannelFrame {
  /** 对应灯位通道（主表删除后仅作历史引用） */
  fixtureId: string
  /** DMX 通道号（落帧快照） */
  channel: number
  /** 灯位方位（落帧快照，主表已删通道时为 null） */
  position: FixturePosition | null
  /** 灯具类型（落帧快照） */
  fixtureType: FixtureType | string
  /** 亮度 0-100（%） */
  intensity: number
  /** 色温（K） */
  colorTempK: number
  /** 对焦说明 */
  focusNote: string
}

/** 现场留存的 Cue 快照字段（计划侧 Cue 被改动时用于两版对照） */
export interface LiveCueSnapshot {
  cueId: string
  cueNo: string
  label: string
  trigger: CueTrigger
  fadeInSec: number
  fadeOutSec: number
  holdSec: number
  note: string
}

/** 已走过 Cue 的现场记录条目：走出该 Cue 时刻的快照 */
export interface LiveExecutedCue extends LiveCueSnapshot {
  /** 实际走出时刻，ISO 字符串 */
  executedAt: string
  /** 走出该 Cue 时上屏的通道帧 */
  channels: LiveChannelFrame[]
}

/** 冲突类别：同一 Cue 被改 / 同一通道被改 */
export type LiveConflictKind = 'cue' | 'channel'

/** 冲突处置选项 */
export type LiveConflictChoice = 'keep-live' | 'take-master'

export const LIVE_CONFLICT_CHOICE_LABEL: Record<LiveConflictChoice, string> = {
  'keep-live': '保留现场版',
  'take-master': '采用计划版'
}

/** 单字段差异，计划与现场两版并列 */
export interface LiveConflictField {
  /** 字段名，例如「渐亮」「亮度」 */
  label: string
  /** 计划（主表当前值）文本，缺失时为 null */
  planned: string | null
  /** 现场（落帧 / 走出时快照）文本，缺失时为 null */
  live: string | null
}

/**
 * 现场冲突：主表在走过之后又改过同一 Cue 或同一通道。
 * signature 覆盖双方取值，任一侧再改签名即变，会重新当作待处理冲突。
 */
export interface LiveConflict {
  /** 稳定签名：类别 + Cue + 通道 + 双方取值拼合 */
  signature: string
  kind: LiveConflictKind
  cueId: string
  cueNo: string
  cueLabel: string
  /** channel 类冲突对应灯位通道；cue 类为 null */
  fixtureId: string | null
  /** channel 类冲突的通道号（落帧值，缺失时取计划值） */
  channel: number | null
  /** 计划侧已删除（Cue 或配接通道不在主表） */
  plannedMissing: boolean
  /** 现场侧缺失（主表新增了现场未上屏的通道） */
  liveMissing: boolean
  fields: LiveConflictField[]
}

/** 已确认冲突的留档，按签名挂在现场记录上，未处理的不留档即留到下次 */
export interface LiveConflictResolution {
  signature: string
  choice: LiveConflictChoice
  resolvedAt: number
}

/**
 * 现场记录（LiveRun）：一次演出的现场恢复状态。
 * 拉停留下当前 Cue（currentCue）、各通道电平（frame）与已走过列表（executed）；
 * 重开后从现场继续，预计时刻一律以 resumedAt（复演时刻）重算。
 */
export interface LiveRun {
  /** 主键 */
  id: string
  /** 所属场次 */
  sessionId: string
  /** 记录名称，例如「首演场 · 现场记录」 */
  title: string
  status: LiveRunStatus
  /** 开演时刻，ISO 字符串 */
  startedAt: string
  /** 最近一次拉停时刻，ISO 字符串 */
  stoppedAt: string | null
  /** 复演时刻：预计时刻重算的基准，ISO 字符串 */
  resumedAt: string | null
  /** 当前 Cue id（可能已不在主表） */
  currentCueId: string | null
  /** 当前 Cue 快照 */
  currentCue: LiveCueSnapshot | null
  /** 已走过 Cue 列表（含当前 Cue，按走出顺序） */
  executed: LiveExecutedCue[]
  /** 灯控台最后一帧通道电平（对应当前 Cue） */
  frame: LiveChannelFrame[]
  /** 已确认冲突留档；签名不再匹配时会重新浮现 */
  resolutions: LiveConflictResolution[]
  /** 记录备注 */
  note: string
  createdAt: number
  updatedAt: number
}

/** 新建现场记录时提交的字段 */
export interface LiveRunDraft {
  sessionId: string
  title: string
  note: string
}

/** 现场时间轴上单条 Cue 的推演行 */
export interface LiveScheduleItem {
  /** 主表 Cue；主表已删时为 null（用现场快照展示） */
  cueId: string
  cueNo: string
  label: string
  /** 已走过 / 当前 / 待走 / 主表已删 */
  state: 'walked' | 'current' | 'upcoming' | 'missing'
  /** 实际走出时刻（ISO），未走为 null */
  executedAt: string | null
  /** 预计时刻（ISO），无法推演时为 null */
  predictedAt: string | null
  /** 相对复演时刻的偏移秒数 */
  offsetSec: number | null
  /** 跨天标记，0 = 复演当天 */
  dayOffset: number
  /** 单条总时长（秒，已走过取现场快照、待走取主表） */
  totalSec: number
}
