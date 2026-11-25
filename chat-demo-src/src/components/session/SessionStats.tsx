import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { getRecentCacheHitRate, getSessionCacheHitRate, getSessionSpeed } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'

const dim = 'var(--dsw-alias-label-tertiary, #8a8f99)'
const valueColor = 'var(--dsw-alias-label-secondary, #5c6169)'

/**
 * 对话底部统计：输出速度 / 本对话缓存命中。
 * 位置用真实测量：读取「深度思考」「智能搜索」按钮的中心坐标，
 * 把文字居中到按钮正下方（运行时测量，窗口变化后重新对齐）。
 * 标签是纯文字，数值单独显示；没有数据时显示 0。
 */
export const SessionStats = ({ sessionId, streaming }: { sessionId: string; streaming: boolean }) => {
  const t = useTranslate()
  const showSpeed = useSettings((state) => state.showOutputSpeed)
  const showCache = useSettings((state) => state.showCacheHit)
  const [pos, setPos] = useState<{ speed: number; cache: number } | null>(null)

  useEffect(() => {
    const measure = () => {
      const caveat = document.querySelector('[data-caveat]') as HTMLElement | null
      if (!caveat) {
        return
      }
      const buttons = [...document.querySelectorAll('button')]
      const speedBtn = buttons.find((b) => (b.textContent ?? '').trim() === '深度思考')
      const cacheBtn = buttons.find((b) => (b.textContent ?? '').trim() === '智能搜索')
      if (!speedBtn || !cacheBtn) {
        return
      }
      const caveatRect = caveat.getBoundingClientRect()
      const speedRect = speedBtn.getBoundingClientRect()
      const cacheRect = cacheBtn.getBoundingClientRect()
      setPos({
        speed: speedRect.left + speedRect.width / 2 - caveatRect.left,
        cache: cacheRect.left + cacheRect.width / 2 - caveatRect.left,
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [streaming])

  if (pos === null) {
    return null
  }
  const speed = showSpeed ? getSessionSpeed(sessionId) : null
  // 主数值用「最近一轮」：底部是即时状态，和 DeepSeek 官方单次请求口径一致。
  // 悬停再给「最近 5 轮」（趋势）和「累计」（dsh-usage 的计价口径）。
  const lastRate = showCache ? getRecentCacheHitRate(sessionId, 1) : null
  const recentRate = showCache ? getRecentCacheHitRate(sessionId, 5) : null
  const totalRate = showCache ? getSessionCacheHitRate(sessionId) : null
  const cacheHit = lastRate ?? recentRate ?? totalRate
  // 没有数据时显示 0
  const speedText = speed !== null ? speed.toFixed(1) : '0'
  const cacheText = cacheHit !== null ? cacheHit.toFixed(1) : '0'
  const cacheTitle =
    [
      recentRate !== null ? `${t('usageCacheHitRecent')} ${recentRate.toFixed(1)}%` : null,
      totalRate !== null ? `${t('usageCacheHitTotal')} ${totalRate.toFixed(1)}%` : null,
      t('cacheHitResetHint'),
    ]
      .filter(Boolean)
      .join('\n') || undefined

  const labelStyle = { color: dim }
  const valueStyle = { color: valueColor, fontWeight: 500 }

  return (
    <>
      {showSpeed ? (
        <span
          style={{
            position: 'absolute',
            left: pos.speed,
            transform: 'translateX(-50%)',
            top: 0,
            lineHeight: '16px',
            fontSize: 11,
            whiteSpace: 'nowrap',
          }}
        >
          <span style={labelStyle}>{t('outputSpeedLabel')}：</span>
          <span style={valueStyle}>{speedText}</span>
          <span style={labelStyle}> tok/s</span>
        </span>
      ) : null}
      {showCache ? (
        <span
          title={cacheTitle}
          style={{
            position: 'absolute',
            left: pos.cache,
            transform: 'translateX(-50%)',
            top: 0,
            lineHeight: '16px',
            fontSize: 11,
            whiteSpace: 'nowrap',
          }}
        >
          <span style={labelStyle}>{t('usageCacheHitRate')}：</span>
          <span style={valueStyle}>{cacheText}</span>
          <span style={labelStyle}>%</span>
        </span>
      ) : null}
    </>
  )
}
