import { create } from 'zustand'
import { getAbortReason, throwIfAborted } from '../../utils/abort.js'
import { createId } from '../../utils/id.js'
import { ApiError, streamMessage } from '../api/client.js'
import type { ChatModel, CreateMessageRequest, MessageUsage } from '../api/types.js'
import { extractFileIds, getFileErrorCode, isRetryableApiError } from '../api/errors.js'
import {
  cancelUpload,
  checkImageFileIds,
  describeUploadError,
  uploadAttachment,
  useUploads,
} from '../attachments.js'
import { extraContextPrompt, useSettings } from '../settings.js'
import { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
import * as db from './db.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import {
  applyEvent,
  canContinueReply,
  getContextRounds,
  settleReply,
  toRequestMessages,
} from './reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** 当前选择的模型；默认 deepseek-flash（同时支持深度思考与图片输入） */
const currentModel = (): ChatModel => useSettings.getState().model
/** 所有生成请求统一携带的助手身份说明 */
const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

/** 今日用量本机统计，供设置里的余额与用量显示；只存数字，不含任何账号信息。 */
const USAGE_KEY = 'chat-desktop:usage'
/** 近 30 天用量：{ [日期]: { [模型]: 用量 } } */
const USAGE_HISTORY_KEY = 'chat-desktop:usage-history'
/** 按主对话统计：{ [主对话 id]: 用量 }，分叉的用量归到主对话 */
const USAGE_SESSIONS_KEY = 'chat-desktop:usage-sessions'
/** 语音类用量：{ [日期]: { asrSeconds, ttsChars } } */
const USAGE_SPEECH_KEY = 'chat-desktop:usage-speech'

export type UsageTotals = {
  input: number
  cacheHit: number
  cacheWrite: number
  output: number
  calls: number
}

const emptyTotals = (): UsageTotals => ({
  input: 0,
  cacheHit: 0,
  cacheWrite: 0,
  output: 0,
  calls: 0,
})

const addUsage = (target: UsageTotals, usage: MessageUsage) => {
  target.input += usage.input_tokens ?? 0
  target.cacheHit += usage.cache_read_input_tokens ?? 0
  target.cacheWrite += usage.cache_creation_input_tokens ?? 0
  target.output += usage.output_tokens ?? 0
  target.calls += 1
}

/** 沿 forkedFrom 链走到主对话，用于把分叉的用量归到主对话。 */
const rootSessionOf = (sessionId: string): string => {
  const byId = new Map(get().sessions.map((session) => [session.id, session]))
  let cursor = byId.get(sessionId)
  let rootId = sessionId
  const guard = new Set<string>()
  while (cursor && cursor.forkedFrom && !guard.has(cursor.id)) {
    guard.add(cursor.id)
    rootId = cursor.forkedFrom
    cursor = byId.get(cursor.forkedFrom)
  }
  return rootId
}

/** 记录一次回复的用量：今日（按模型）、30 天历史（按日期+模型）、主对话维度各累加一次。 */
const recordUsage = (usage: MessageUsage, sessionId: string, model: string) => {
  try {
    const today = new Date().toISOString().slice(0, 10)

    // 今日（按模型存，供消费估算按模型分别计价）
    const raw = localStorage.getItem(USAGE_KEY)
    const saved = raw ? JSON.parse(raw) : null
    const data: { date: string; models: Record<string, UsageTotals> } =
      saved && saved.date === today
        ? { date: today, models: saved.models ?? {} }
        : { date: today, models: {} }
    // 兼容旧格式：早期只有总计字段
    if (saved && saved.date === today && !saved.models && saved.input !== undefined) {
      data.models = {
        'deepseek-flash': {
          input: saved.input ?? 0,
          cacheHit: saved.cacheHit ?? 0,
          cacheWrite: saved.cacheWrite ?? 0,
          output: saved.output ?? 0,
          calls: saved.calls ?? 0,
        },
      }
    }
    const todayModelTotals = data.models[model] ?? emptyTotals()
    addUsage(todayModelTotals, usage)
    data.models[model] = todayModelTotals
    localStorage.setItem(USAGE_KEY, JSON.stringify(data))

    // 近 30 天（按日期 + 模型），超期数据清理
    const historyRaw = localStorage.getItem(USAGE_HISTORY_KEY)
    const history: Record<string, Record<string, UsageTotals>> = historyRaw
      ? JSON.parse(historyRaw)
      : {}
    const day = history[today] ?? {}
    const modelTotals = day[model] ?? emptyTotals()
    addUsage(modelTotals, usage)
    day[model] = modelTotals
    history[today] = day
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
    for (const key of Object.keys(history)) {
      if (key < cutoff) {
        delete history[key]
      }
    }
    localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify(history))

    // 按主对话统计（分叉归主对话）
    const sessionsRaw = localStorage.getItem(USAGE_SESSIONS_KEY)
    const sessionsUsage: Record<string, UsageTotals> = sessionsRaw ? JSON.parse(sessionsRaw) : {}
    const rootId = rootSessionOf(sessionId)
    const rootTotals = sessionsUsage[rootId] ?? emptyTotals()
    addUsage(rootTotals, usage)
    sessionsUsage[rootId] = rootTotals
    localStorage.setItem(USAGE_SESSIONS_KEY, JSON.stringify(sessionsUsage))
  } catch {
    // 统计失败不影响对话
  }
}

/** 每轮输出速度（token/秒）按主对话存储。 */
const SESSIONS_SPEED_KEY = 'chat-desktop:sessions-speed'

/** 记录最近一轮的输出速度（token/秒），分叉归主对话。 */
const recordTurnSpeed = (sessionId: string, outputTokens: number, elapsedMs: number) => {
  try {
    if (outputTokens <= 0 || elapsedMs <= 0) {
      return
    }
    const rootId = rootSessionOf(sessionId)
    const raw = localStorage.getItem(SESSIONS_SPEED_KEY)
    const map: Record<string, number> = raw ? JSON.parse(raw) : {}
    map[rootId] = Math.round((outputTokens / (elapsedMs / 1000)) * 10) / 10
    localStorage.setItem(SESSIONS_SPEED_KEY, JSON.stringify(map))
  } catch {
    // 统计失败不影响对话
  }
}

/** 读取会话最近一轮输出速度（token/秒）；没有记录返回 null。 */
export const getSessionSpeed = (sessionId: string): number | null => {
  try {
    const rootId = rootSessionOf(sessionId)
    const raw = localStorage.getItem(SESSIONS_SPEED_KEY)
    if (!raw) {
      return null
    }
    const map = JSON.parse(raw)
    const value = map[rootId]
    return typeof value === 'number' ? value : null
  } catch {
    return null
  }
}

/** 读取会话的缓存命中率（0-100）；没有记录返回 null。 */
export const getSessionCacheHitRate = (sessionId: string): number | null => {
  try {
    const rootId = rootSessionOf(sessionId)
    const raw = localStorage.getItem(USAGE_SESSIONS_KEY)
    if (!raw) {
      return null
    }
    const map = JSON.parse(raw)
    const totals = map[rootId]
    if (!totals) {
      return null
    }
    const input = Number(totals.input) || 0
    const cacheHit = Number(totals.cacheHit) || 0
    const total = input + cacheHit
    if (total <= 0) {
      return null
    }
    return (cacheHit / total) * 100
  } catch {
    return null
  }
}

/** 记录语音类用量：ASR 记秒数、TTS 记字符数（按日期存，保留 30 天）。 */
export const recordSpeechUsage = (kind: 'asr' | 'tts', amount: number) => {
  if (!Number.isFinite(amount) || amount <= 0) {
    return
  }
  try {
    const today = new Date().toISOString().slice(0, 10)
    const raw = localStorage.getItem(USAGE_SPEECH_KEY)
    const data: Record<string, { asrSeconds: number; ttsChars: number }> = raw
      ? JSON.parse(raw)
      : {}
    const day = data[today] ?? { asrSeconds: 0, ttsChars: 0 }
    if (kind === 'asr') {
      day.asrSeconds += amount
    } else {
      day.ttsChars += amount
    }
    data[today] = day
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
    for (const key of Object.keys(data)) {
      if (key < cutoff) {
        delete data[key]
      }
    }
    localStorage.setItem(USAGE_SPEECH_KEY, JSON.stringify(data))
  } catch {
    // 统计失败不影响使用
  }
}
/** 按设置拼系统提示：thinking 只要求思考中文，all 连回答也要求中文；再叠加本会话关联的偏好与记忆。 */
const systemPromptFor = (mode: 'auto' | 'thinking' | 'all', sessionId?: string) => {
  const base =
    mode === 'thinking'
      ? `${SYSTEM_PROMPT} 请在思考过程中使用简体中文。`
      : mode === 'all'
        ? `${SYSTEM_PROMPT} 请在思考过程和回答中都使用简体中文。`
        : SYSTEM_PROMPT
  // 只注入本会话关联的偏好/记忆；没关联就不注入
  const session = sessionId ? getSession(sessionId) : null
  const linked = session
    ? { preferences: session.linkedPreferences, memories: session.linkedMemories }
    : undefined
  return `${base}${extraContextPrompt(linked)}`
}
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 安全审核固定开启，所有请求都走扩展模式 */
const SAFETY_CHECK = { level: 'high' } as const
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000

/** 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。 */
const serverTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

/**
 * 读取会话最近 N 轮的缓存命中率（0-100），数据取每条回复自己的 usage。
 * 累计口径会被「早期开搜索 / 中途切思考开关」的轮次长期拖住，看不出当前状态，
 * 所以底部统计改用最近几轮加权；没有 usage 时返回 null 由调用方回退。
 */
export const getRecentCacheHitRate = (sessionId: string, rounds = 5): number | null => {
  try {
    const session = getSession(sessionId)
    if (!session) {
      return null
    }
    let hit = 0
    let total = 0
    let used = 0
    for (let i = session.messages.length - 1; i >= 0 && used < rounds; i -= 1) {
      const message = session.messages[i]
      if (message.role !== 'assistant' || !message.usage) {
        continue
      }
      const miss = Number(message.usage.input_tokens) || 0
      const cached = Number(message.usage.cache_read_input_tokens) || 0
      if (miss + cached <= 0) {
        continue
      }
      hit += cached
      total += miss + cached
      used += 1
    }
    return total > 0 ? (hit / total) * 100 : null
  } catch {
    return null
  }
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
const createReply = (): AssistantMessage => {
  const { thinking, search } = useSettings.getState()
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: currentModel(),
    thinking,
    search,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const session = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      touchSession(id)
      set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
      if (session !== stored) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (write: () => Promise<void>): Promise<number> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await db.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      summaries = await db.commitStaging()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    clearAllDrafts()
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: null,
    })
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    set({ activeId: null })
    trimSessionCache()
  }
}

/** 每个会话最多允许的直接子分叉数量。 */
export const MAX_FORK_CHILDREN = 3
/** 最深允许分叉的层级：depth 0 主对话、1 第一层分叉、2 第二层分叉；depth 2 不能再分。 */
export const MAX_FORK_DEPTH = 2

/** 计算一个会话在分叉树里的层级：主对话 0、第一层分叉 1……遇到环时停止。 */
export const forkDepthOf = (sessionId: string, sessions: SessionSummary[]): number => {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  let depth = 0
  let cursor = byId.get(sessionId)
  const guard = new Set<string>()
  while (cursor && cursor.forkedFrom && !guard.has(cursor.id)) {
    guard.add(cursor.id)
    depth += 1
    cursor = byId.get(cursor.forkedFrom)
  }
  return depth
}

/** 分叉被拒绝的原因：层级到顶 / 数量到顶。 */
export type ForkLimitReason = 'depth' | 'count'

/** 纯函数：根据会话列表判断分叉限制原因（供 UI 订阅，避免依赖 get()）。 */
export const forkLimitOf = (
  sessionId: string,
  sessions: SessionSummary[]
): ForkLimitReason | null => {
  if (forkDepthOf(sessionId, sessions) >= MAX_FORK_DEPTH) {
    return 'depth'
  }
  if (sessions.filter((item) => item.forkedFrom === sessionId).length >= MAX_FORK_CHILDREN) {
    return 'count'
  }
  return null
}

/** 判断某个会话还能不能分叉：能分返回 null。 */
export const forkLimitReason = (sessionId: string): ForkLimitReason | null =>
  forkLimitOf(sessionId, get().sessions)

/**
 * 从某条消息处分叉出一条新会话：复制到该消息（含）为止的可见分支。
 * 纯本地操作，不消耗 API 算力；新会话独立发展，原会话保持不变。
 *
 * 数量规则：主对话最多 3 个分叉，每个分叉又最多再分 3 个（两层），
 * 到第二层分叉后不能再分；任一限制命中都返回 null（调用方提示）。
 */
export const forkSession = (sessionId: string, messageId: string): string | null => {
  if (get().importingHistory) {
    return null
  }
  const session = getSession(sessionId)
  if (!session) {
    return null
  }
  if (forkLimitReason(sessionId) !== null) {
    return null
  }
  const visible = getVisibleMessages(session)
  const index = visible.findIndex((message) => message.id === messageId)
  if (index < 0) {
    return null
  }
  const sliced = visible.slice(0, index + 1).map((message) => structuredClone(message))
  const now = Date.now()
  // 同一父会话的第 N 个分叉，标题带序号，列表里作为父会话的子项显示
  const forkNumber = get().sessions.filter((item) => item.forkedFrom === session.id).length + 1
  // 父标题可能已经带「（分叉 N）」，先剥掉再拼，避免出现「（分叉）（分叉 1）」
  const baseTitle = (session.title || '对话')
    .replace(/（\d+）$/, '')
    .replace(/（分叉 \d*）$/, '')
    .replace(/（分叉）$/, '')
    .trim()
  const fork: Session = {
    id: createId(),
    title: `${baseTitle || '对话'}（${forkNumber}）`,
    createdAt: now,
    updatedAt: now,
    messages: sliced,
    rootMessageId: sliced[0]?.id ?? null,
    forkedFrom: session.id,
  }
  touchSession(fork.id)
  set((state) => ({
    sessions: [toSessionSummary(fork), ...state.sessions],
    sessionCache: { ...state.sessionCache, [fork.id]: fork },
    activeId: fork.id,
  }))
  persist(fork.id)
  trimSessionCache()
  return fork.id
}

/** 从整段对话的最后一条消息分叉（会话菜单用）。 */
export const forkWholeSession = async (sessionId: string): Promise<string | null> => {
  if (get().importingHistory) {
    return null
  }
  await ensureSessionLoaded(sessionId)
  const session = getSession(sessionId)
  if (!session) {
    return null
  }
  const last = getVisibleMessages(session).at(-1)
  if (!last) {
    return null
  }
  return forkSession(sessionId, last.id)
}

/** 置顶 / 取消置顶会话。 */
export const toggleSessionPinned = (id: string, pinned: boolean) => {
  if (get().importingHistory) {
    return
  }
  set((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === id ? { ...session, pinned } : session
    ),
  }))
  updateSession(id, (session) => ({ ...session, pinned }))
  persist(id)
}

/** 折叠 / 展开某个会话的分叉子项。 */
export const setSessionCollapsed = (id: string, collapsed: boolean) => {
  if (get().importingHistory) {
    return
  }
  set((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === id ? { ...session, collapsed } : session
    ),
  }))
  updateSession(id, (session) => ({ ...session, collapsed }))
  persist(id)
}

/** 设置会话关联的偏好/记忆 id（undefined = 不注入）。 */
export const setSessionLinkedPrompt = (
  id: string,
  linked: { preferences?: string[]; memories?: string[] }
) => {
  if (get().importingHistory) {
    return
  }
  updateSession(id, (session) => ({
    ...session,
    linkedPreferences: linked.preferences,
    linkedMemories: linked.memories,
  }))
  persist(id)
}

/**
 * 从历史消息的 usage 回填用量统计（只跑一次）。
 * 统计功能晚于聊天数据上线，老对话的消息里本来就有 usage，用它补出历史。
 */
export const backfillUsage = async (): Promise<void> => {
  const marker = 'chat-desktop:usage-backfilled'
  try {
    if (localStorage.getItem(marker)) {
      return
    }
  } catch {
    return
  }
  try {
    const summaries = await db.loadSessionSummaries()
    const byId = new Map(summaries.map((summary) => [summary.id, summary]))
    const rootOf = (sessionId: string): string => {
      let cursor = byId.get(sessionId)
      let root = sessionId
      const guard = new Set<string>()
      while (cursor && cursor.forkedFrom && !guard.has(cursor.id)) {
        guard.add(cursor.id)
        root = cursor.forkedFrom
        cursor = byId.get(cursor.forkedFrom)
      }
      return root
    }
    const history: Record<string, Record<string, UsageTotals>> = JSON.parse(
      localStorage.getItem(USAGE_HISTORY_KEY) ?? '{}'
    )
    const sessionsUsage: Record<string, UsageTotals> = JSON.parse(
      localStorage.getItem(USAGE_SESSIONS_KEY) ?? '{}'
    )
    for (const summary of summaries) {
      const session = await db.loadSession(summary.id)
      if (!session) {
        continue
      }
      for (const message of session.messages) {
        if (message.role !== 'assistant' || !message.usage) {
          continue
        }
        const date = new Date(message.createdAt).toISOString().slice(0, 10)
        const model = message.model ?? 'deepseek-flash'
        const day = history[date] ?? {}
        const modelTotals = day[model] ?? emptyTotals()
        addUsage(modelTotals, message.usage)
        day[model] = modelTotals
        history[date] = day
        const rootId = rootOf(summary.id)
        const rootTotals = sessionsUsage[rootId] ?? emptyTotals()
        addUsage(rootTotals, message.usage)
        sessionsUsage[rootId] = rootTotals
      }
    }
    localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify(history))
    localStorage.setItem(USAGE_SESSIONS_KEY, JSON.stringify(sessionsUsage))
    localStorage.setItem(marker, '1')
  } catch {
    // 回填失败不影响使用
  }
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title } : session
      ),
    }))
    void db.renameSession(id, title).catch(db.reportStorageError('rename session'))
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
/**
 * 收集某个会话的所有分叉后代（只沿 forkedFrom 链）。
 *
 * 安全审计：先用 BFS 找直接/间接子项，再逐个沿 forkedFrom 链回溯，
 * 必须能走到 rootId 才算「安全删除对象」；回溯失败（环、断链）的直接跳过，
 * 保证只会删除真正属于它的分叉，绝不误删无关会话。
 */
const collectForkDescendants = (rootId: string, sessions: SessionSummary[]): string[] => {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const candidates: string[] = []
  const visited = new Set<string>([rootId])
  const queue: string[] = [rootId]
  while (queue.length > 0) {
    const parent = queue.shift() as string
    for (const session of sessions) {
      if (session.forkedFrom === parent && !visited.has(session.id)) {
        visited.add(session.id)
        candidates.push(session.id)
        queue.push(session.id)
      }
    }
  }
  return candidates.filter((candidateId) => {
    let cursor = byId.get(candidateId)
    const guard = new Set<string>()
    while (cursor && cursor.forkedFrom) {
      if (cursor.forkedFrom === rootId) {
        return true
      }
      if (guard.has(cursor.id)) {
        return false
      }
      guard.add(cursor.id)
      cursor = byId.get(cursor.forkedFrom)
    }
    return false
  })
}

export const removeSession = (id: string): Promise<boolean> => {
  // 删除父会话时一并删除它的所有分叉后代；后代列表经过审计，只含能追溯到它的会话
  const descendants = collectForkDescendants(id, get().sessions)
  const task = (async () => {
    let ok = true
    for (const target of [id, ...descendants]) {
      const removed = await removeSessionData(target)
      ok = ok && removed
    }
    return ok
  })().finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
      id,
      serverId,
      // 草稿附件已上传成功，每张图片都在上传前检查过长边，超限的已缩小。
      imageSizeChecked: isImage,
      name,
      size,
      isImage,
      mimeType,
    })),
    createdAt: now,
  }
  const reply = createReply()
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void streamReply(sessionId, reply, { history, question })
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  const { thinking, search } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    // 续写使用当前选择的模型：切换模型后继续生成也要用新模型
    model: currentModel(),
    thinking: previous.thinking ?? thinking,
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage }

/**
 * 将 serverId 写回所有引用同一附件的消息。传入 null 会清除超限旧图的 ID，触发补传。
 * 尺寸标记随有效 ID 保存，因为本地保留的是原图，刷新后可以直接复用已检查的上传副本。
 */
const saveServerIds = (sessionId: string, serverIds: ReadonlyMap<string, string | null>) => {
  if (serverIds.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) => {
              const serverId = serverIds.get(file.id)
              return serverId === undefined
                ? file
                : { ...file, serverId, imageSizeChecked: file.isImage && serverId !== null }
            }),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (apiKey: string, file: FileAttachment): Promise<string | null> => {
  if (file.serverId) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done') {
    return task.serverId
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  return uploadAttachment(apiKey, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   失败静默跳过，该附件不进入本次请求，下次发送时再试。
 */
const prepareFiles = async (sessionId: string, request: Request, signal: AbortSignal) => {
  const epoch = historyEpoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  const apiKey = useSettings.getState().apiKey ?? ''
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(getAbortReason(signal)), { once: true })
  })
  // 旧图片超限时先清除 ID，交给下方已有的附件补传流程。
  const files = [
    ...request.question.files,
    ...getContextRounds(request.history).flatMap(([user]) => user.files),
  ]
  const checked = await Promise.race([checkImageFileIds(files, signal), aborted])
  if (checked.size > 0) {
    saveServerIds(sessionId, checked)
    request = refreshRequest(sessionId, request)
  }
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const serverId = await ensureServerId(apiKey, file)
      if (serverId && serverId !== file.serverId) {
        serverIds.set(file.id, serverId)
      }
    })
  )
  void uploads.then(() => {
    if (epoch === historyEpoch) {
      saveServerIds(sessionId, serverIds)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const pending = new Map<string, FileAttachment>()
  for (const [user] of getContextRounds(request.history).reverse()) {
    for (const file of user.files) {
      if (!file.serverId && !serverIds.has(file.id) && !pending.has(file.id)) {
        pending.set(file.id, file)
      }
    }
  }
  for (const file of pending.values()) {
    throwIfAborted(signal)
    try {
      const serverId = await Promise.race([ensureServerId(apiKey, file), aborted])
      if (serverId) {
        serverIds.set(file.id, serverId)
        saveServerIds(sessionId, new Map([[file.id, serverId]]))
      }
    } catch {
      throwIfAborted(signal)
    }
  }

  // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId
  const session = getSession(sessionId)
  const resolve = <T extends Message>(message: T): T =>
    (session?.messages.find((m) => m.id === message.id) as T | undefined) ?? message
  return {
    history: request.history.map(resolve),
    question: resolve(request.question),
    prefix: request.prefix,
  }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, request: Request, error: unknown): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(refreshRequest(sessionId, request))
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const controller = new AbortController()
  let lastUsage: MessageUsage | null = null
  let requestStartedAt = 0
  if (!getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  let frame = 0
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)

  try {
    for (let attempt = 0; ; attempt += 1) {
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = true
      let receivedContent = false
      try {
        const prepared = await prepareFiles(sessionId, request, controller.signal)
        preparing = false
        // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
        const latestReminder = prepared.prefix
          ? prepared.prefix.latestReminder
          : createLatestReminder(useSettings.getState())
        reply = { ...reply, latestReminder }
        updateReply(sessionId, reply)
        persist(sessionId)
        const messages = toRequestMessages(
          prepared.history,
          prepared.question,
          prepared.prefix,
          initial.thinking ?? false,
          latestReminder
        )
        requestStartedAt = Date.now()
        const events = streamMessage(          useSettings.getState().apiKey ?? '',
          {
            model: initial.model ?? currentModel(),
            system: systemPromptFor(useSettings.getState().thinkingLanguage, sessionId),
            messages,
            thinking: { type: initial.thinking ? 'enabled' : 'disabled' },
            safety_check: SAFETY_CHECK,
            tools: serverTools(initial.search ?? false),
            ...(titleRequests.has(controller) ? { title: { enabled: true } } : {}),
          },
          controller.signal
        )
        const blockIndexes = new Map<number, number>()
        for await (const event of events) {
          receivedContent ||= event.type === 'content_block_start'
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = event.delta.title.trim()
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            titleRequests.delete(controller)
          }
          if (event.type === 'message_delta' && event.usage) {
            lastUsage = event.usage
          }
          reply = applyEvent(reply, event, Date.now(), blockIndexes)
          if (document.visibilityState === 'hidden') {
            flush()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
        }
        reply = settleReply(reply, 'done', Date.now())
        if (lastUsage) {
          recordUsage(lastUsage, sessionId, currentModel())
          recordTurnSpeed(sessionId, lastUsage.output_tokens ?? 0, Date.now() - requestStartedAt)
        }
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          if (lastUsage) {
            recordUsage(lastUsage, sessionId, currentModel())
            recordTurnSpeed(sessionId, lastUsage.output_tokens ?? 0, Date.now() - requestStartedAt)
          }
          break
        }
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        // 附件失效：重新补传后重发。收到过内容块（含丢弃的客户端工具）后不自动重发。
        if (
          attempt < FILE_RETRY_LIMIT &&
          !receivedContent &&
          reuploadInvalidatedFiles(sessionId, request, error)
        ) {
          await waitForRetry(attempt, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now())
        } else if (error instanceof ApiError) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: error.localMessage,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
  } finally {
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
  }
}
