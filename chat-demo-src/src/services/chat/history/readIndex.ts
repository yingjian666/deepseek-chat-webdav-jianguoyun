import { unzip } from 'fflate'
import { INDEX_PATH } from './paths.js'

/** ZIP 索引里的一项（勾选弹窗只需要这几个字段）。 */
export type ArchiveSessionEntry = {
  id: string
  title?: string
  updated_at?: string
  message_count?: number
}

/** 只读 ZIP 里的会话索引，用于导入前勾选会话。失败时返回空数组。 */
export const readArchiveIndex = (data: Uint8Array): Promise<ArchiveSessionEntry[]> =>
  new Promise((resolve) => {
    try {
      unzip(data, { filter: (entry) => entry.name === INDEX_PATH }, (error, files) => {
        const file = error ? null : files[INDEX_PATH]
        if (!file) {
          resolve([])
          return
        }
        try {
          const parsed = JSON.parse(new TextDecoder().decode(file))
          resolve(Array.isArray(parsed) ? parsed : [])
        } catch {
          resolve([])
        }
      })
    } catch {
      resolve([])
    }
  })
