import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'
import { createId } from '../utils/id.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 思考语言策略：auto 跟随模型，thinking 思考用中文，all 思考与回答都用中文。 */
export type ThinkingLanguage = 'auto' | 'thinking' | 'all'
export type SelectedModel = 'deepseek-flash' | 'deepseek-v4-pro'

/** 一条偏好或记忆：带 id，供会话按 id 关联。 */
export type PromptItem = { id: string; content: string }

/**
 * 偏好与记忆的数量/字数上限。
 * 系统提示过长会明显拖慢首字并浪费上下文，所以超出的部分既不创建也不注入。
 */
export const MAX_PREFERENCES = 50
export const MAX_PREFERENCE_CHARS = 100
export const MAX_MEMORIES = 30
export const MAX_MEMORY_CHARS = 2000

/** 按类型取数量上限 / 单条字数上限。 */
export const promptLimitsOf = (kind: 'preferences' | 'memories') =>
  kind === 'preferences'
    ? { maxItems: MAX_PREFERENCES, maxChars: MAX_PREFERENCE_CHARS }
    : { maxItems: MAX_MEMORIES, maxChars: MAX_MEMORY_CHARS }

/** 会话关联的偏好/记忆 id（undefined = 不注入任何内容）。 */
export type LinkedPromptIds = { preferences?: string[]; memories?: string[] }

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、对话字号、思考语言、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  fontSize: number
  thinkingLanguage: ThinkingLanguage
  showUsagePanel: boolean
  /** 对话底部是否显示输出速度（token/s） */
  showOutputSpeed: boolean
  /** 上传前是否提示覆盖确认（云端已有同对话时） */
  confirmOverwrite: boolean
  /** 对话底部是否显示本对话缓存命中率 */
  showCacheHit: boolean
  remoteSizeWarning: boolean
  preferences: PromptItem[]
  preferencesEnabled: boolean
  memories: PromptItem[]
  memoryEnabled: boolean
  model: SelectedModel
  driftSuppression: boolean
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  fontSize: 'chat-demo:font-size',
  thinkingLanguage: 'chat-demo:thinking-language',
  showUsagePanel: 'chat-demo:show-usage-panel',
  showOutputSpeed: 'chat-demo:show-output-speed',
  confirmOverwrite: 'chat-demo:confirm-overwrite',
  showCacheHit: 'chat-demo:show-cache-hit',
  remoteSizeWarning: 'chat-demo:remote-size-warning',
  preferences: 'chat-demo:preferences',
  preferencesEnabled: 'chat-demo:preferences-enabled',
  // 旧键：仅用于把旧的单条偏好迁移成列表
  legacyPersonalPrompt: 'chat-demo:personal-prompt',
  memories: 'chat-demo:memories',
  memoryEnabled: 'chat-demo:memory-enabled',
  model: 'chat-demo:model',
  driftSuppression: 'chat-demo:drift-suppression',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 桌面壳（Electron）提供的系统加密存储；网页版没有这个桥，退回 localStorage。 */
type SecretBridge = {
  getSecret?: (name: string) => Promise<string | null>
  setSecret?: (name: string, value: string) => Promise<boolean>
}

const secretBridge = () => (window as unknown as { __syncBridge?: SecretBridge }).__syncBridge

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 对话正文字号，范围 10–24px；未保存过时沿用 chat-demo 默认的 16px。 */
export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 24
const initialFontSize = (): number => {
  const saved = Number(read(KEYS.fontSize))
  return Number.isFinite(saved) && saved >= FONT_SIZE_MIN && saved <= FONT_SIZE_MAX ? saved : 16
}

/** 思考语言默认「思考用中文」；用户显式选择过才用保存值。 */
const initialThinkingLanguage = (): ThinkingLanguage => {
  const saved = read(KEYS.thinkingLanguage)
  return saved === 'auto' || saved === 'all' ? saved : 'thinking'
}

/** 读取偏好/记忆列表，兼容旧格式（string[]），迁移后写回带 id 的新格式。 */
const readPromptList = (key: string): PromptItem[] => {
  const raw = read(key)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    if (parsed.length > 0 && typeof parsed[0] === 'string') {
      const items = parsed
        .filter((item): item is string => typeof item === 'string')
        .map((content) => ({ id: createId(), content }))
      write(key, JSON.stringify(items))
      return items
    }
    return parsed.filter(
      (item): item is PromptItem =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as PromptItem).id === 'string' &&
        typeof (item as PromptItem).content === 'string'
    )
  } catch {
    return []
  }
}

export const useSettings = create<Settings>(() => ({
  // 桌面壳下 API Key 由系统加密存储持有，启动时异步注入；网页版仍读 localStorage。
  apiKey: secretBridge()?.getSecret ? null : read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  fontSize: initialFontSize(),
  thinkingLanguage: initialThinkingLanguage(),
  // 左下角用量面板默认开启，用户可关闭
  showUsagePanel: read(KEYS.showUsagePanel) !== 'false',
  // 对话底部统计默认开启
  showOutputSpeed: read(KEYS.showOutputSpeed) !== 'false',
  // 上传前是否提示覆盖（默认提示）
  confirmOverwrite: read(KEYS.confirmOverwrite) !== 'false',
  showCacheHit: read(KEYS.showCacheHit) !== 'false',
  // 云端文件过多提醒默认开启
  remoteSizeWarning: read(KEYS.remoteSizeWarning) !== 'false',
  // 个人偏好与记忆都是带 id 的列表；会话里按 id 关联后才注入
  preferences: (() => {
    const items = readPromptList(KEYS.preferences)
    if (items.length > 0) {
      return items
    }
    const legacy = read(KEYS.legacyPersonalPrompt)
    return legacy && legacy.trim() ? [{ id: createId(), content: legacy }] : []
  })(),
  preferencesEnabled: read(KEYS.preferencesEnabled) !== 'false',
  memories: readPromptList(KEYS.memories),
  memoryEnabled: read(KEYS.memoryEnabled) !== 'false',
  // 默认 flash；用户可在输入框旁切换
  model: read(KEYS.model) === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash',
  // 思维链漂移抑制（实验中），默认关闭
  driftSuppression: read(KEYS.driftSuppression) === 'true',
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setFontSize = (fontSize: number) => {
  const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(fontSize)))
  write(KEYS.fontSize, String(clamped))
  useSettings.setState({ fontSize: clamped })
}

export const setThinkingLanguage = (thinkingLanguage: ThinkingLanguage) => {
  write(KEYS.thinkingLanguage, thinkingLanguage)
  useSettings.setState({ thinkingLanguage })
}

export const setShowUsagePanel = (showUsagePanel: boolean) => {
  write(KEYS.showUsagePanel, String(showUsagePanel))
  useSettings.setState({ showUsagePanel })
}

export const setShowOutputSpeed = (showOutputSpeed: boolean) => {
  write(KEYS.showOutputSpeed, String(showOutputSpeed))
  useSettings.setState({ showOutputSpeed })
}

export const setShowCacheHit = (showCacheHit: boolean) => {
  write(KEYS.showCacheHit, String(showCacheHit))
  useSettings.setState({ showCacheHit })
}

export const setConfirmOverwrite = (confirmOverwrite: boolean) => {
  write(KEYS.confirmOverwrite, String(confirmOverwrite))
  useSettings.setState({ confirmOverwrite })
}

export const setRemoteSizeWarning = (remoteSizeWarning: boolean) => {
  write(KEYS.remoteSizeWarning, String(remoteSizeWarning))
  useSettings.setState({ remoteSizeWarning })
}

export const setPreferences = (preferences: PromptItem[]) => {
  write(KEYS.preferences, JSON.stringify(preferences))
  useSettings.setState({ preferences })
}

export const setPreferencesEnabled = (preferencesEnabled: boolean) => {
  write(KEYS.preferencesEnabled, String(preferencesEnabled))
  useSettings.setState({ preferencesEnabled })
}

export const setMemories = (memories: PromptItem[]) => {
  write(KEYS.memories, JSON.stringify(memories))
  useSettings.setState({ memories })
}

export const setMemoryEnabled = (memoryEnabled: boolean) => {
  write(KEYS.memoryEnabled, String(memoryEnabled))
  useSettings.setState({ memoryEnabled })
}

export const setModel = (model: SelectedModel) => {
  write(KEYS.model, model)
  useSettings.setState({ model })
}

export const setDriftSuppression = (driftSuppression: boolean) => {
  write(KEYS.driftSuppression, String(driftSuppression))
  useSettings.setState({ driftSuppression })
}

/** 把个人偏好、记忆与实验性提示拼成附加系统提示；没有内容时返回空串。 */
export const extraContextPrompt = (linked?: LinkedPromptIds): string => {
  const { preferences, memories, driftSuppression } = useSettings.getState()
  /**
   * 只注入会话关联的条目；没关联（undefined）就不注入任何偏好/记忆。
   * 超出上限的部分（条数、单条字数）一律跳过，和界面上的限制保持一致。
   */
  const pick = (
    items: PromptItem[],
    ids: string[] | undefined,
    maxItems: number,
    maxChars: number
  ): string[] =>
    ids === undefined
      ? []
      : items
          .filter((item) => ids.includes(item.id))
          .slice(0, maxItems)
          .map((item) => item.content.trim())
          .filter((content) => content.length > 0 && content.length <= maxChars)
  const prefs = pick(preferences, linked?.preferences, MAX_PREFERENCES, MAX_PREFERENCE_CHARS)
  const facts = pick(memories, linked?.memories, MAX_MEMORIES, MAX_MEMORY_CHARS)

  const lines: string[] = []
  if (prefs.length > 0) {
    lines.push(`个人偏好：\n${prefs.map((item) => `- ${item}`).join('\n')}`)
  }
  if (facts.length > 0) lines.push(`关于用户的事实：\n${facts.map((item) => `- ${item}`).join('\n')}`)

  const parts: string[] = []
  if (lines.length > 0) {
    parts.push(`\n\n以下是用户提供的背景信息，回答时请参考：\n${lines.join('\n')}`)
  }
  if (driftSuppression) {
    parts.push('\n\n推理过程中如果发现偏离了用户的原始问题，先回到问题本身再继续。')
  }
  return parts.join('')
}

export const setApiKey = (apiKey: string | null) => {
  const bridge = secretBridge()
  if (bridge?.setSecret) {
    // 桌面壳：只进系统加密存储，不把 Key 明文写进 localStorage。
    void bridge.setSecret('apiKey', apiKey ?? '')
  } else {
    write(KEYS.apiKey, apiKey)
  }
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
