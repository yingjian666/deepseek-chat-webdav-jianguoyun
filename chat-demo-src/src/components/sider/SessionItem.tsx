import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconEditOutline16, IconEllipsisOutline16, IconTrashOutline16 } from '../base/icons.js'
import { useMemoryLink } from '../settings/memoryLinkState.js'

/** 人形图标：关联记忆与偏好 */
const IconPersonOutline16 = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <circle cx="8" cy="5.2" r="2.6" stroke="currentColor" strokeWidth="1.2" />
    <path
      d="M3.2 13.2c.8-2.4 2.7-3.6 4.8-3.6s4 1.2 4.8 3.6"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
)
import {
  forkLimitOf,
  forkLimitReason,
  forkWholeSession,
  renameSession,
  selectSession,
  toggleSessionPinned,
  useChatStore,
} from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { showToast } from '../base/toastState.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

/** 置顶图标（图钉） */
const IconPinOutline16 = ({ filled }: { filled?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M6 2.5h4l-.7 3.2 2 2.3H4.7l2-2.3L6 2.5Z"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
      fill={filled ? 'currentColor' : 'none'}
    />
    <path d="M8 8v5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
)

/** 分叉图标（⑂） */
const IconForkOutline16 = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <circle cx="4" cy="3.6" r="1.6" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="4" cy="12.4" r="1.6" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="12" cy="8" r="1.6" stroke="currentColor" strokeWidth="1.2" />
    <path
      d="M4 5.2v5.6M5.6 3.6c3 0 4.8 1.9 4.8 4.4M5.6 12.4c3 0 4.8-1.9 4.8-4.4"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
)

export const SessionItem = memo(function SessionItem({
  session,
  active,
  depth = 0,
  hasChildren = false,
  onToggleCollapse,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  /** 血缘缩进深度：0 = 根会话，1+ = 分叉子项 */
  depth?: number
  /** 是否有分叉子项（决定是否显示折叠箭头） */
  hasChildren?: boolean
  onToggleCollapse?: (collapsed: boolean) => void
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const forkLimit = useChatStore((state) => forkLimitOf(session.id, state.sessions))
  const displayTitle = session.title || t('untitledChat')

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div
      className={clsx(styles.item, active && styles.active, depth > 0 && styles.child)}
      // 缩进最多 3 级，再深也不继续缩，避免挤出侧边栏
      style={depth > 0 ? { marginLeft: Math.min(depth, 3) * 14 } : undefined}
      onClick={() => {
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      {hasChildren ? (
        <button
          type="button"
          className={styles.collapseButton}
          aria-label={session.collapsed ? t('expandForks') : t('collapseForks')}
          onClick={(event) => {
            event.stopPropagation()
            onToggleCollapse?.(!session.collapsed)
          }}
        >
          <span
            style={{
              display: 'inline-block',
              transition: 'transform .15s',
              transform: session.collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
            }}
          >
            ▶
          </span>
        </button>
      ) : null}
      <div className={styles.title}>{displayTitle}</div>
      <Menu
          options={[
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'pin',
              label: session.pinned ? t('unpinSession') : t('pinSession'),
              icon: <IconPinOutline16 filled={Boolean(session.pinned)} />,
              onSelect: () => toggleSessionPinned(session.id, !session.pinned),
            },
            {
              key: 'memory',
              label: t('memoryLinkTitle'),
              icon: <IconPersonOutline16 />,
              onSelect: () => useMemoryLink.getState().open(session.id),
            },
            {
              key: 'fork',
              label: t('forkSession'),
              icon: <IconForkOutline16 />,
              disabled: forkLimit !== null,
              disabledHint: forkLimit
                ? t(forkLimit === 'depth' ? 'forkDepthLimit' : 'forkCountLimit')
                : undefined,
              onSelect: () => {
                const reason = forkLimitReason(session.id)
                if (reason) {
                  showToast(t(reason === 'depth' ? 'forkDepthLimit' : 'forkCountLimit'))
                  return
                }
                void forkWholeSession(session.id).then((forkId) => {
                  if (!forkId) {
                    showToast(t('forkCountLimit'))
                  }
                })
              },
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        >
          {({ open, toggle }) => (
            <div
              className={clsx(styles.action, open && styles.actionOpen)}
              onClick={(event) => event.stopPropagation()}
            >
              <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
            </div>
          )}
        </Menu>
    </div>
  )
})
