import { create } from 'zustand'

/** 会话级「关联记忆与偏好」弹窗的开关状态。 */
type MemoryLinkState = {
  /** 正在编辑的会话 id；null 表示关闭 */
  sessionId: string | null
  open: (sessionId: string) => void
  close: () => void
}

export const useMemoryLink = create<MemoryLinkState>((set) => ({
  sessionId: null,
  open: (sessionId) => set({ sessionId }),
  close: () => set({ sessionId: null }),
}))
