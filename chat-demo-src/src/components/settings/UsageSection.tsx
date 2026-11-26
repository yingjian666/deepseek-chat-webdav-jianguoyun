import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { backfillUsage, useChatStore } from '../../services/chat/store.js'
import { isPeakNow } from '../../services/peakHours.js'
import { setShowUsagePanel, useSettings } from '../../services/settings.js'
import { Select } from '../base/Select.js'

type UsageTotals = {
  input: number
  cacheHit: number
  cacheWrite: number
  output: number
  calls: number
}

type Balance = {
  ok: boolean
  total?: string
  currency?: string
  available?: boolean
  error?: string
}

type Bridge = {
  getBalance?: () => Promise<Balance>
}

type PriceTable = {
  inputMiss: { peak: number; off: number }
  inputHit: { peak: number; off: number }
  output: { peak: number; off: number }
}

const USAGE_KEY = 'chat-desktop:usage'
const USAGE_HISTORY_KEY = 'chat-desktop:usage-history'
const USAGE_SESSIONS_KEY = 'chat-desktop:usage-sessions'
const USAGE_SPEECH_KEY = 'chat-desktop:usage-speech'

/** 各模型估算价格（元/百万 token），按 DeepSeek 官方定价；高峰为工作日 9-12、14-18 点。 */
const MODEL_PRICE: Record<string, PriceTable> = {
  'deepseek-flash': {
    inputMiss: { peak: 2, off: 1 },
    inputHit: { peak: 0.04, off: 0.02 },
    output: { peak: 8, off: 4 },
  },
  'deepseek-v4-pro': {
    inputMiss: { peak: 9, off: 4.5 },
    inputHit: { peak: 0.3, off: 0.15 },
    output: { peak: 27, off: 13.5 },
  },
}

/** 语音相关：ASR 按秒（0.39 元/小时，限时折扣价）；TTS 按字符（1.5 元/万字符，限时折扣价）。 */
const ASR_PRICE_PER_SECOND = 0.39 / 3600
const TTS_PRICE_PER_CHAR = 1.5 / 10000

/** 模型显示名（与官方文档一致）；未收录的模型原样显示。 */
const MODEL_LABEL: Record<string, string> = {
  'deepseek-flash': 'DeepSeek-V4.1-Flash',
  'deepseek-v4-pro': 'DeepSeek-V4-Pro',
}

const modelLabel = (model: string) => MODEL_LABEL[model] ?? model

const DEFAULT_PRICE = MODEL_PRICE['deepseek-flash']

const formatTokens = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(2)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}K`
      : String(value)

const formatCost = (value: number) => `¥${value.toFixed(2)}`

const readJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

const emptyTotals = (): UsageTotals => ({
  input: 0,
  cacheHit: 0,
  cacheWrite: 0,
  output: 0,
  calls: 0,
})

/** 兼容旧记录：早期版本没有 cacheWrite / models 字段，统一按 0 计。 */
const normalizeTotals = (value: Partial<UsageTotals> | null | undefined): UsageTotals => ({
  input: value?.input ?? 0,
  cacheHit: value?.cacheHit ?? 0,
  cacheWrite: value?.cacheWrite ?? 0,
  output: value?.output ?? 0,
  calls: value?.calls ?? 0,
})

const addTotals = (target: UsageTotals, source: UsageTotals) => {
  target.input += source.input
  target.cacheHit += source.cacheHit
  target.cacheWrite += source.cacheWrite
  target.output += source.output
  target.calls += source.calls
}

const totalTokens = (totals: UsageTotals) =>
  totals.input + totals.cacheHit + totals.cacheWrite + totals.output

const costOf = (model: string, totals: UsageTotals, peak: boolean) => {
  const price = MODEL_PRICE[model] ?? DEFAULT_PRICE
  return (
    (totals.input * (peak ? price.inputMiss.peak : price.inputMiss.off) +
      totals.cacheHit * (peak ? price.inputHit.peak : price.inputHit.off) +
      totals.cacheWrite * (peak ? price.inputMiss.peak : price.inputMiss.off) +
      totals.output * (peak ? price.output.peak : price.output.off)) /
    1_000_000
  )
}

const cardStyle = {
  borderRadius: 12,
  border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
  padding: '14px 16px',
  marginBottom: 14,
} as const

const cardTitleStyle = {
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 10,
} as const

const rowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  padding: '4px 0',
  fontSize: 13,
} as const

const dim = 'var(--dsw-alias-label-tertiary, #8a8f99)'

/** 设置 → 余额与用量：按日期查看今日历史用量，消费按模型估算；只反映本设备。 */
export const UsageSection = () => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const showUsagePanel = useSettings((state) => state.showUsagePanel)
  const [todayRaw, setTodayRaw] = useState<{
    date: string
    models?: Record<string, UsageTotals>
    input?: number
  } | null>(null)
  const [history, setHistory] = useState<Record<string, Record<string, UsageTotals>>>({})
  const [sessionsUsage, setSessionsUsage] = useState<Record<string, UsageTotals>>({})
  const [speech, setSpeech] = useState<Record<string, { asrSeconds: number; ttsChars: number }>>(
    {}
  )
  const [balance, setBalance] = useState<Balance | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [busy, setBusy] = useState(false)
  const [selectedDate, setSelectedDate] = useState<string>('today')

  const load = () => {
    setTodayRaw(
      readJson<{ date: string; models?: Record<string, UsageTotals>; input?: number } | null>(
        USAGE_KEY,
        null
      )
    )
    const rawHistory = readJson<Record<string, Record<string, Partial<UsageTotals>>>>(
      USAGE_HISTORY_KEY,
      {}
    )
    const nextHistory: Record<string, Record<string, UsageTotals>> = {}
    for (const [date, day] of Object.entries(rawHistory)) {
      nextHistory[date] = {}
      for (const [model, totals] of Object.entries(day)) {
        nextHistory[date][model] = normalizeTotals(totals)
      }
    }
    setHistory(nextHistory)

    const rawSessions = readJson<Record<string, Partial<UsageTotals>>>(USAGE_SESSIONS_KEY, {})
    const nextSessions: Record<string, UsageTotals> = {}
    for (const [id, totals] of Object.entries(rawSessions)) {
      nextSessions[id] = normalizeTotals(totals)
    }
    setSessionsUsage(nextSessions)
    setSpeech(readJson<Record<string, { asrSeconds: number; ttsChars: number }>>(USAGE_SPEECH_KEY, {}))

    setNow(new Date())
    const bridge = (window as unknown as { __syncBridge?: Bridge }).__syncBridge
    setBusy(true)
    void (bridge?.getBalance?.() ?? Promise.resolve(null))
      .then((result) => setBalance(result))
      .catch(() => setBalance(null))
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    // 先回填历史消息里的用量（只跑一次），再加载页面数据
    void backfillUsage().then(load)
    // 轮询间隔固定 60 秒，不做设置。
    const timer = window.setInterval(load, 60_000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const todayKey = new Date().toISOString().slice(0, 10)

  /** 某天的「模型 → 用量」；今日优先从 USAGE_KEY（兼容旧格式）读。 */
  const dayModels = useMemo(() => {
    const date = selectedDate === 'today' ? todayKey : selectedDate
    if (date === todayKey && todayRaw && todayRaw.date === todayKey) {
      if (todayRaw.models) {
        const models: Record<string, UsageTotals> = {}
        for (const [model, totals] of Object.entries(todayRaw.models)) {
          models[model] = normalizeTotals(totals)
        }
        return models
      }
      // 旧格式：总计当作 deepseek-flash
      return { 'deepseek-flash': normalizeTotals(todayRaw) }
    }
    return history[date] ?? {}
  }, [selectedDate, todayKey, todayRaw, history])

  /** 可查看的日期：今日 + 30 天内有记录的日期（新到旧）。 */
  const dateOptions = useMemo(() => {
    const options = [{ value: 'today', label: t('usageTodayOption') }]
    const keys = Object.keys(history).sort((a, b) => (a < b ? 1 : -1))
    for (const key of keys.slice(0, 30)) {
      if (key === todayKey) {
        continue
      }
      const [, month, day] = key.split('-')
      options.push({ value: key, label: `${month}/${day}` })
    }
    return options
  }, [history, todayKey, t])

  const peak = isPeakNow(now)
  const totals = Object.values(dayModels).reduce(
    (sum, item) => {
      addTotals(sum, item)
      return sum
    },
    emptyTotals()
  )
  const tokens = totalTokens(totals)
  const modelCosts = Object.entries(dayModels)
    .map(([model, item]) => ({ model, cost: costOf(model, item, peak) }))
    .filter((item) => item.cost > 0.0001)
    .sort((a, b) => b.cost - a.cost)
  // 语音类：ASR 按录音秒数、TTS 按朗读字符数
  const daySpeech = speech[selectedDate === 'today' ? todayKey : selectedDate] ?? {
    asrSeconds: 0,
    ttsChars: 0,
  }
  const asrCost = daySpeech.asrSeconds * ASR_PRICE_PER_SECOND
  const ttsCost = daySpeech.ttsChars * TTS_PRICE_PER_CHAR
  const cost = modelCosts.reduce((sum, item) => sum + item.cost, 0) + asrCost + ttsCost
  // 缓存命中率 = 缓存命中 / (未命中输入 + 缓存命中)
  const inputTotal = totals.input + totals.cacheHit
  const cacheHitRate = inputTotal > 0 ? Math.round((totals.cacheHit / inputTotal) * 100) : null

  // 按主对话排名（分叉已在记录时归到主对话）
  const sessionRanking = Object.entries(sessionsUsage)
    .map(([id, item]) => ({
      id,
      title: sessions.find((session) => session.id === id)?.title || t('untitledChat'),
      tokens: totalTokens(item),
      calls: item.calls,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3)

  // 近 30 天按模型聚合
  const modelTotals = new Map<string, UsageTotals>()
  for (const day of Object.values(history)) {
    for (const [model, item] of Object.entries(day)) {
      const target = modelTotals.get(model) ?? emptyTotals()
      addTotals(target, item)
      modelTotals.set(model, target)
    }
  }
  const modelRanking = [...modelTotals.entries()]
    .map(([model, item]) => ({
      model,
      tokens: totalTokens(item),
      calls: item.calls,
    }))
    .sort((a, b) => b.tokens - a.tokens)

  const tokenCells = [
    { label: t('usageTotalTokens'), value: tokens },
    { label: t('usageInput'), value: totals.input },
    { label: t('usageOutput'), value: totals.output },
    { label: t('usageCacheRead'), value: totals.cacheHit },
    { label: t('usageCacheWrite'), value: totals.cacheWrite },
    { label: t('usageCallsLabel'), value: totals.calls },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 10,
        }}
      >
        <span style={{ fontSize: 13 }}>{t('usageLeftBottomBalance')}</span>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => setShowUsagePanel(true)}
            style={{
              padding: '4px 16px',
              borderRadius: 8,
              border: showUsagePanel
                ? '1px solid transparent'
                : '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
              background: showUsagePanel ? 'var(--dsw-alias-brand-primary, #4d6bfe)' : 'transparent',
              color: showUsagePanel ? '#fff' : 'inherit',
              font: 'inherit',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {t('usageToggleOn')}
          </button>
          <button
            type="button"
            onClick={() => setShowUsagePanel(false)}
            style={{
              padding: '4px 16px',
              borderRadius: 8,
              border: !showUsagePanel
                ? '1px solid transparent'
                : '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
              background: !showUsagePanel ? 'var(--dsw-alias-brand-primary, #4d6bfe)' : 'transparent',
              color: !showUsagePanel ? '#fff' : 'inherit',
              font: 'inherit',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {t('usageToggleOff')}
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 14,
        }}
      >
        <div style={{ fontSize: 12, color: dim, lineHeight: 1.6 }}>
          {t('usageOnlyThisDevice')}
        </div>
        <button
          type="button"
          onClick={load}
          disabled={busy}
          style={{
            flexShrink: 0,
            padding: '6px 14px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontSize: 13,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? t('usageRefreshing') : t('usageRefresh')}
        </button>
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>{t('usageTodayTitle')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: dim }}>{t('usageViewDate')}</span>
          <Select
            ariaLabel={t('usageViewDate')}
            value={selectedDate}
            options={dateOptions}
            onChange={(value) => setSelectedDate(value)}
          />
        </div>
        {tokens > 0 ? (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(6, 1fr)',
                gap: 8,
                marginBottom: 10,
              }}
            >
              {tokenCells.map((cell) => (
                <div key={cell.label}>
                  <div style={{ fontSize: 17, fontWeight: 600 }}>{formatTokens(cell.value)}</div>
                  <div style={{ fontSize: 11, color: dim, marginTop: 2, lineHeight: 1.3 }}>
                    {cell.label}
                  </div>
                </div>
              ))}
            </div>
            <div
              style={{
                ...rowStyle,
                borderTop: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06))',
                paddingTop: 10,
              }}
            >
              <span>{t('usageTodayCost')}</span>
              <span style={{ fontWeight: 600 }}>{formatCost(cost)}</span>
            </div>
            {modelCosts.map((item) => (
              <div key={item.model} style={{ ...rowStyle, fontSize: 12, color: dim }}>
                <span>{modelLabel(item.model)}</span>
                <span>{formatCost(item.cost)}</span>
              </div>
            ))}
            {asrCost > 0 ? (
              <div style={{ ...rowStyle, fontSize: 12, color: dim }}>
                <span>
                  {t('usageVoiceInput')}（{Math.round(daySpeech.asrSeconds)} {t('usageSeconds')}）
                </span>
                <span>{formatCost(asrCost)}</span>
              </div>
            ) : null}
            {ttsCost > 0 ? (
              <div style={{ ...rowStyle, fontSize: 12, color: dim }}>
                <span>
                  {t('usageReadAloud')}（{daySpeech.ttsChars} {t('usageChars')}）
                </span>
                <span>{formatCost(ttsCost)}</span>
              </div>
            ) : null}
            {cacheHitRate !== null ? (
              <div style={{ ...rowStyle, fontSize: 12, color: dim }}>
                <span>{t('usageCacheHitRate')}</span>
                <span>{cacheHitRate}%</span>
              </div>
            ) : null}
            <div style={{ fontSize: 11, color: dim, marginTop: 4 }}>
              {peak ? t('usagePeakNow') : t('usageOffPeakNow')} · {tokens.toLocaleString()} tokens
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: dim }}>{t('usageNoData')}</div>
        )}
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>{t('usageRankingTitle')}</div>
        {sessionRanking.length === 0 ? (
          <div style={{ fontSize: 12, color: dim }}>{t('usageNoData')}</div>
        ) : (
          sessionRanking.map((item, index) => (
            <div key={item.id} style={rowStyle}>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {index + 1}. {item.title}
              </span>
              <span style={{ flexShrink: 0, color: dim, fontSize: 12 }}>
                {formatTokens(item.tokens)} · {item.calls} {t('usageCallsUnit')}
              </span>
            </div>
          ))
        )}
        <div style={{ fontSize: 11, color: dim, marginTop: 6 }}>{t('usageRankingHint')}</div>
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>{t('usageBalanceTitle')}</div>
        <div style={rowStyle}>
          <span>DeepSeek</span>
          <span style={{ fontWeight: 600 }}>
            {balance?.ok && balance.total
              ? `${balance.currency === 'USD' ? '$' : '¥'}${balance.total}`
              : balance?.error
                ? t('balanceFailed')
                : '—'}
          </span>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>{t('usage30DaysTitle')}</div>
        {modelRanking.length === 0 ? (
          <div style={{ fontSize: 12, color: dim }}>{t('usageNoData')}</div>
        ) : (
          modelRanking.map((item) => (
            <div key={item.model} style={rowStyle}>
              <span>{modelLabel(item.model)}</span>
              <span style={{ flexShrink: 0, color: dim, fontSize: 12 }}>
                {formatTokens(item.tokens)} · {item.calls} {t('usageCallsUnit')}
              </span>
            </div>
          ))
        )}
        <div style={{ fontSize: 11, color: dim, marginTop: 6 }}>{t('usage30DaysHint')}</div>
      </div>

      <div style={{ fontSize: 11, color: dim }}>{t('usagePollingHint')}</div>
    </div>
  )
}
