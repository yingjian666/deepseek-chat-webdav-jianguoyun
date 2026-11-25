import { translate } from '../../i18n/index.js'
import { monthKey } from '../../utils/format.js'
import type { SessionSummary } from './types.js'

const DAY = 86_400_000

const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0)

/** 会话列表的一行：会话 + 血缘缩进深度（0 = 根，1+ = 分叉子项）+ 是否有子项。 */
export type SessionRow = { session: SessionSummary; depth: number; hasChildren: boolean }

/**
 * 按 forkedFrom 把会话展平成「父后紧跟子项」的序列（参考 DSH 的 flattenLineage）：
 * 父不存在时孤儿降级为根，循环引用 fail-soft；collapsed 的会话不展开其子项。
 */
export const flattenLineage = (sessions: SessionSummary[]): SessionRow[] => {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const children = new Map<string, SessionSummary[]>()
  const roots: SessionSummary[] = []
  for (const session of sessions) {
    if (session.forkedFrom && byId.has(session.forkedFrom)) {
      const list = children.get(session.forkedFrom) ?? []
      list.push(session)
      children.set(session.forkedFrom, list)
    } else {
      roots.push(session)
    }
  }
  const rows: SessionRow[] = []
  const visited = new Set<string>()
  const walk = (session: SessionSummary, depth: number) => {
    if (visited.has(session.id)) {
      return
    }
    visited.add(session.id)
    const kids = children.get(session.id) ?? []
    rows.push({ session, depth, hasChildren: kids.length > 0 })
    // 折叠时不展开子项（子项仍参与其他根的分组，不会丢）
    if (session.collapsed) {
      return
    }
    for (const child of kids) {
      walk(child, depth + 1)
    }
  }
  for (const root of roots) {
    walk(root, 0)
  }
  return rows
}

const timelineKey = (time: number): { key: string; labelKey: string | null } => {
  const diff = Math.floor((Date.now() - startOfDay(time)) / DAY)
  if (diff <= 0) {
    return { key: 'sessionHistoryTimelineLabelToday', labelKey: 'sessionHistoryTimelineLabelToday' }
  }
  if (diff <= 1) {
    return { key: 'yesterday', labelKey: 'sessionHistoryTimelineLabelYesterday' }
  }
  if (diff < 7) {
    return { key: '7days', labelKey: 'sessionHistoryTimelineLabel7days' }
  }
  if (diff < 30) {
    return { key: '30days', labelKey: 'sessionHistoryTimelineLabel30days' }
  }
  return { key: monthKey(time) ?? '', labelKey: null }
}

/** 分组：置顶 / 今天 / 昨天 / 7 天内 / 30 天内 / 按月；分叉子项跟随父会话所在的组。 */
export const groupSessions = (sessions: SessionSummary[], _now: number, t = translate) => {
  const groups: { key: string; label: string; rows: SessionRow[] }[] = []
  // 先按更新时间倒序：导入/合并后数组顺序不一定稳定，分组顺序必须只由时间决定
  const ordered = [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const pinned = ordered.filter((session) => session.pinned)
  const rest = ordered.filter((session) => !session.pinned)

  if (pinned.length > 0) {
    groups.push({ key: 'pinned', label: t('sessionPinnedGroup'), rows: flattenLineage(pinned) })
  }

  const restRows = flattenLineage(rest)
  let currentKey = ''
  let currentLabel = ''
  for (const row of restRows) {
    // 只有根会话决定分组，子项跟随父组
    if (row.depth === 0) {
      const { key, labelKey } = timelineKey(row.session.updatedAt)
      currentKey = key
      currentLabel = labelKey ? t(labelKey) : key
    }
    const last = groups.at(-1)
    if (last && last.key === currentKey) {
      last.rows.push(row)
    } else {
      groups.push({ key: currentKey, label: currentLabel, rows: [row] })
    }
  }
  return groups
}
