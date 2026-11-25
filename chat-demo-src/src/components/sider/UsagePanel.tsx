import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'

type Usage = {
  date: string
  input: number
  cacheHit: number
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

const USAGE_KEY = 'chat-desktop:usage'

/** deepseek-flash 价格（元 / 百万 token）。高峰为工作日 9–12、14–18 点。 */
const PRICE = {
  inputMiss: { peak: 2, off: 1 },
  inputHit: { peak: 0.04, off: 0.02 },
  output: { peak: 8, off: 4 },
}

const isPeakNow = (now: Date) => {
  const day = now.getDay()
  if (day === 0 || day === 6) return false
  const hour = now.getHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

const formatTokens = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}K`
      : String(value)

const dim = 'var(--dsw-alias-label-tertiary, #8a8f99)'
const faint = 'var(--dsw-alias-label-tertiary, #a0a5ad)'

/** 侧边栏底部的今日用量与余额；每分钟刷新一次。 */
export const UsagePanel = () => {
  const t = useTranslate()
  const [usage, setUsage] = useState<Usage | null>(null)
  const [balance, setBalance] = useState<Balance | null>(null)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const bridge = (window as unknown as { __syncBridge?: Bridge }).__syncBridge
    const load = () => {
      try {
        const raw = localStorage.getItem(USAGE_KEY)
        const saved = raw ? JSON.parse(raw) : null
        // 兼容新版按模型存储（{ date, models }）与旧版单条记录
        if (saved && saved.models) {
          const totals = { input: 0, cacheHit: 0, output: 0, calls: 0 }
          for (const item of Object.values(saved.models) as Array<Partial<Usage>>) {
            totals.input += item.input ?? 0
            totals.cacheHit += item.cacheHit ?? 0
            totals.output += item.output ?? 0
            totals.calls += item.calls ?? 0
          }
          setUsage({ date: saved.date, ...totals })
        } else if (saved && saved.input !== undefined) {
          setUsage(saved)
        } else {
          setUsage(null)
        }
      } catch {
        setUsage(null)
      }
      setNow(new Date())
      void bridge?.getBalance?.().then(setBalance)
    }
    load()
    const timer = window.setInterval(load, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const today = now.toISOString().slice(0, 10)
  const data = usage && usage.date === today ? usage : null
  const peak = isPeakNow(now)
  const tokens = data ? data.input + data.cacheHit + data.output : 0
  const cost = data
    ? (data.input * (peak ? PRICE.inputMiss.peak : PRICE.inputMiss.off) +
        data.cacheHit * (peak ? PRICE.inputHit.peak : PRICE.inputHit.off) +
        data.output * (peak ? PRICE.output.peak : PRICE.output.off)) /
      1_000_000
    : 0
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

  return (
    <div
      style={{
        boxSizing: 'border-box',
        width: '100%',
        margin: '0 2px',
        padding: '8px 10px',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.03))',
        fontSize: 12,
        lineHeight: 1.65,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          fontWeight: 600,
          color: 'var(--dsw-alias-label-primary)',
        }}
      >
        <span>{t('usageToday')}</span>
        <span>¥{cost.toFixed(2)}</span>
      </div>
      <div style={{ color: dim }}>
        {formatTokens(tokens)} tokens · {data?.calls ?? 0} {t('usageCalls')}
      </div>
      <div style={{ color: dim }}>
        {balance?.ok && balance.total
          ? `DeepSeek ¥${balance.total}`
          : balance?.error
            ? 'DeepSeek —'
            : 'DeepSeek …'}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: dim }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: peak ? '#f59e0b' : '#10b981',
            flexShrink: 0,
          }}
        />
        {peak ? t('usagePeak') : `${t('usageOffPeak')} 09:00 ${t('usageEnterPeak')}`}
      </div>
      <div style={{ color: faint, fontSize: 11, marginTop: 1 }}>
        {t('usageUpdated')} {time}
      </div>
    </div>
  )
}
