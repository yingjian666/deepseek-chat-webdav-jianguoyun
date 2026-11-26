import { useEffect, useMemo, useRef, useState } from 'react'
import { getVisibleMessages } from '../../services/chat/branches.js'
import type { Session, UserMessage } from '../../services/chat/types.js'

/** 收起时只显示最近这么多轮，避免长会话把横线挤成一条缝。 */
const RECENT_LIMIT = 15

/** 隐藏导航面板自己的滚动条，避免压住文字。 */
const scrollbarStyle = `[aria-label="对话快速到达"]::-webkit-scrollbar { display: none; width: 0; height: 0; }`

/**
 * 右侧对话导航：
 * 收起时只显示最近 15 轮横线；鼠标移入后向左展开成方框，
 * 里面是全部轮次的中文摘要（默认滚到最近），滚轮向前翻历史，点击任意行跳转。
 */
export const MessageNav = ({ session }: { session: Session }) => {
  const [expanded, setExpanded] = useState(false)
  const navRef = useRef<HTMLDivElement>(null)
  const items = useMemo(
    () =>
      getVisibleMessages(session).filter(
        (message): message is UserMessage =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.trim().length > 0
      ),
    [session]
  )

  // 展开后等列表渲染完，再滚到最近一轮
  useEffect(() => {
    if (!expanded) return
    const frame = requestAnimationFrame(() => {
      const nav = navRef.current
      if (nav) nav.scrollTop = nav.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [expanded, session.id])

  if (items.length < 2) {
    return null
  }

  const jump = (id: string) => {
    const element = document.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(id)}"]`
    )
    if (!element) return
    // 只滚动消息列表自身的滚动容器，避免整页跟着跳
    let scroller: HTMLElement | null = element.parentElement
    while (scroller) {
      const style = getComputedStyle(scroller)
      const scrollable = style.overflowY === 'auto' || style.overflowY === 'scroll'
      if (scrollable && scroller.scrollHeight > scroller.clientHeight + 1) break
      scroller = scroller.parentElement
    }
    if (!scroller) return
    const delta = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    scroller.scrollTo({ top: scroller.scrollTop + delta - 16, behavior: 'smooth' })
  }

  const recent = items.slice(-RECENT_LIMIT)

  return (
    <>
      <style>{scrollbarStyle}</style>
      <div
        ref={navRef}
        data-tour="nav"
        aria-label="对话快速到达"
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
        onWheel={(event) => {
          // 列表自己滚动，不把滚轮传给后面的消息区
          event.stopPropagation()
        }}
        style={{
          position: 'absolute',
          right: 8,
          top: '12%',
          bottom: 'max(16%, 200px)',
          width: expanded ? 'min(240px, 45vw)' : 22,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: expanded ? 'flex-start' : 'center',
          alignItems: expanded ? 'stretch' : 'center',
          gap: expanded ? 2 : 10,
          padding: expanded ? '8px 10px 8px 6px' : 0,
          borderRadius: 12,
          background: expanded
            ? 'var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base))'
            : 'transparent',
          border: expanded ? '1px solid var(--dsw-alias-border-l2)' : '1px solid transparent',
          boxShadow: expanded ? '0 8px 24px rgba(0, 0, 0, 0.14)' : 'none',
          overflowY: expanded ? 'auto' : 'hidden',
          overflowX: 'hidden',
          overscrollBehavior: 'contain',
          scrollbarWidth: 'none',
          transition: 'width .18s ease, background .18s ease, padding .18s ease',
          zIndex: 6,
          boxSizing: 'border-box',
        }}
      >
        {expanded
          ? items.map((message) => (
              <button
                key={message.id}
                type="button"
                aria-label="跳转到该轮对话"
                title={message.content.replace(/\s+/g, ' ').trim().slice(0, 100)}
                onClick={() => jump(message.id)}
                style={{
                  display: 'block',
                  flexShrink: 0,
                  width: '100%',
                  height: 30,
                  padding: '4px 8px',
                  border: 'none',
                  borderRadius: 6,
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-primary)',
                  fontSize: 12,
                  lineHeight: 1.6,
                  textAlign: 'left',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  cursor: 'pointer',
                  boxSizing: 'border-box',
                }}
                onMouseOver={(event) => {
                  event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'
                }}
                onMouseOut={(event) => {
                  event.currentTarget.style.background = 'transparent'
                }}
              >
                {message.content.replace(/\s+/g, ' ').trim()}
              </button>
            ))
          : recent.map((message) => (
              <span
                key={message.id}
                aria-hidden
                style={{
                  display: 'block',
                  width: 12,
                  height: 2,
                  flexShrink: 0,
                  borderRadius: 2,
                  background: 'var(--dsw-alias-label-dimmed)',
                  opacity: 0.45,
                }}
              />
            ))}
      </div>
    </>
  )
}
