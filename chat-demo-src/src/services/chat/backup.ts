import { formatDate } from '../../utils/format.js'
import * as db from './db.js'
import type { ImportProgressCallback } from './history/importArchive.js'
import { replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 导出为历史会话导出格式的 ZIP，可再次导入。传入 sessionIds 时只导出选中的会话。 */
export const exportHistory = (sessionIds?: string[]): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    const wanted = sessionIds && sessionIds.length > 0 ? new Set(sessionIds) : null
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        if (wanted && !wanted.has(summary.id)) {
          continue
        }
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions())
    return { name: backupFileName(now), blob }
  })

/** 导出选中会话为一个 ZIP（单对话或合并；含图片原件）。 */
export const exportSessionsZip = (sessionIds: string[]): Promise<Blob> =>
  enqueueBackup(async () => {
    const { sessions, sessionCache } = useChatStore.getState()
    const wanted = new Set(sessionIds)
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        if (!wanted.has(summary.id)) {
          continue
        }
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          continue
        }
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    return exportArchive(readSessions())
  })

/**
 * 确认覆盖后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才替换原有会话与图片原件。返回导入的会话数。
 */
export const importHistory = (file: File, onProgress?: ImportProgressCallback): Promise<number> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    return replaceHistory(() => importArchive(file, onProgress))
  })

/** 部分导入：只导入 ZIP 中选中的会话（按 id 合并写入，不清空其他对话）。返回导入数。 */
export const importSelectedSessions = (
  file: File,
  selectedIds: Set<string>,
  onProgress?: (processed: number, total?: number) => void
): Promise<number> =>
  enqueueBackup(async () => {
    const { importSelectedSessions: run } = await import('./history/importArchive.js')
    const count = await run(file, selectedIds, false, onProgress)
    // 导入后刷新列表，否则界面上看不到新会话
    const summaries = await db.loadSessionSummaries()
    useChatStore.setState({ sessions: summaries })
    return count
  })

/** 合并导入整个 ZIP：全部会话按 id 合并，不删除本地对话（数据管理里的「导入」用）。 */
export const importArchiveMerged = (
  file: File,
  onProgress?: ImportProgressCallback
): Promise<number> =>
  enqueueBackup(async () => {
    const { importSelectedSessions: run } = await import('./history/importArchive.js')
    const count = await run(file, new Set(), true, onProgress)
    const summaries = await db.loadSessionSummaries()
    useChatStore.setState({ sessions: summaries })
    return count
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
