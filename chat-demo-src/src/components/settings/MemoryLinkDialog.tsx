import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore, setSessionLinkedPrompt } from '../../services/chat/store.js'
import {
  setMemories,
  setPreferences,
  useSettings,
  type PromptItem,
} from '../../services/settings.js'
import { createId } from '../../utils/id.js'
import { Modal } from '../base/Modal.js'
import { useMemoryLink } from './memoryLinkState.js'

const itemBox = {
  display: 'flex',
  gap: 8,
  alignItems: 'flex-start',
  padding: '8px 10px',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.03))',
  marginBottom: 6,
} as const

const dim = 'var(--dsw-alias-label-tertiary, #8a8f99)'

/** 会话级「关联记忆与偏好」弹窗：上面切换偏好/记忆，下面勾选并可在现场编辑、新建。 */
export const MemoryLinkDialog = () => {
  const t = useTranslate()
  const { sessionId, close } = useMemoryLink()
  const preferences = useSettings((state) => state.preferences)
  const memories = useSettings((state) => state.memories)
  const sessions = useChatStore((state) => state.sessions)
  const [tab, setTab] = useState<'preferences' | 'memories'>('preferences')
  const [linkedPref, setLinkedPref] = useState<string[]>([])
  const [linkedMem, setLinkedMem] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [loading, setLoading] = useState(true)

  // 打开时加载会话的关联状态
  useEffect(() => {
    if (!sessionId) {
      return
    }
    let cancelled = false
    setLoading(true)
    setEditingId(null)
    setDraft('')
    void import('../../services/chat/db.js').then(async (db) => {
      const session = await db.loadSession(sessionId)
      if (cancelled) {
        return
      }
      setLinkedPref(session?.linkedPreferences ?? [])
      setLinkedMem(session?.linkedMemories ?? [])
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  if (!sessionId) {
    return null
  }
  const title = sessions.find((session) => session.id === sessionId)?.title || t('untitledChat')
  const items = tab === 'preferences' ? preferences : memories
  const linked = tab === 'preferences' ? linkedPref : linkedMem
  const setLinked = tab === 'preferences' ? setLinkedPref : setLinkedMem
  const setItems = tab === 'preferences' ? setPreferences : setMemories

  const toggle = (id: string) => {
    setLinked(linked.includes(id) ? linked.filter((item) => item !== id) : [...linked, id])
  }
  const add = () => {
    const value = draft.trim()
    if (!value) {
      return
    }
    const next = [...items, { id: createId(), content: value }]
    setItems(next)
    setLinked([...linked, next[next.length - 1].id])
    setDraft('')
  }
  const removeItem = (id: string) => {
    setItems(items.filter((item) => item.id !== id))
    setLinked(linked.filter((item) => item !== id))
  }
  const startEdit = (item: PromptItem) => {
    setEditingId(item.id)
    setEditingValue(item.content)
  }
  const saveEdit = () => {
    if (editingId === null) {
      return
    }
    const value = editingValue.trim()
    if (value) {
      setItems(items.map((item) => (item.id === editingId ? { ...item, content: value } : item)))
    }
    setEditingId(null)
  }
  const save = () => {
    setSessionLinkedPrompt(sessionId, {
      preferences: linkedPref.length > 0 ? linkedPref : undefined,
      memories: linkedMem.length > 0 ? linkedMem : undefined,
    })
    close()
  }

  return (
    <Modal
      title={t('memoryLinkTitle')}
      onClose={close}
      width={640}
      maxHeight={620}
      closable
      footer={
        <>
          <button
            type="button"
            onClick={close}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={save}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              border: 'none',
              background: 'var(--dsw-alias-brand-primary, #4d6bfe)',
              color: '#fff',
              font: 'inherit',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {t('memoryLinkSave')}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 12, color: dim }}>
          {t('memoryLinkDesc', { title })}
        </div>

        <div
          style={{
            fontSize: 11,
            lineHeight: 1.6,
            color: 'var(--dsw-alias-label-secondary, #5c6169)',
            background: 'var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.03))',
            borderRadius: 8,
            padding: '7px 10px',
          }}
        >
          {t('memoryLinkCacheHint')}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => setTab('preferences')}
            style={{
              flex: 1,
              padding: '7px 12px',
              borderRadius: 8,
              border: '1px solid transparent',
              background:
                tab === 'preferences'
                  ? 'var(--dsw-alias-brand-primary, #4d6bfe)'
                  : 'transparent',
              color: tab === 'preferences' ? '#fff' : 'inherit',
              font: 'inherit',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {t('settingsPersonalPrompt')}
          </button>
          <button
            type="button"
            onClick={() => setTab('memories')}
            style={{
              flex: 1,
              padding: '7px 12px',
              borderRadius: 8,
              border: '1px solid transparent',
              background:
                tab === 'memories' ? 'var(--dsw-alias-brand-primary, #4d6bfe)' : 'transparent',
              color: tab === 'memories' ? '#fff' : 'inherit',
              font: 'inherit',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {t('settingsMemory')}
          </button>
        </div>

        <div style={{ maxHeight: 240, overflowY: 'auto', flexShrink: 1 }}>
          <div style={{ fontSize: 12, color: dim, lineHeight: 1.6, marginBottom: 8 }}>
            {tab === 'preferences'
              ? t('settingsPersonalPromptDetail')
              : t('settingsMemoryDetail')}
          </div>
          {loading ? (
            <div style={{ fontSize: 12, color: dim, padding: '8px 2px' }}>{t('memoryLinkLoading')}</div>
          ) : items.length === 0 ? (
            <div style={{ fontSize: 12, color: dim, padding: '8px 2px' }}>
              {t('memoryLinkEmpty')}
            </div>
          ) : (
            items.map((item) => {
              const checked = linked.includes(item.id)
              return (
                <div key={item.id} style={itemBox}>
                  <span
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => toggle(item.id)}
                    style={{
                      width: 16,
                      height: 16,
                      marginTop: 2,
                      flexShrink: 0,
                      borderRadius: 4,
                      border: checked ? '1.5px solid transparent' : '1.5px solid #c7c9d1',
                      background: checked ? 'var(--dsw-alias-brand-primary, #4d6bfe)' : 'transparent',
                      color: '#fff',
                      fontSize: 11,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                    }}
                  >
                    {checked ? '✓' : ''}
                  </span>
                  {editingId === item.id ? (
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <textarea
                        autoFocus
                        rows={12}
                        value={editingValue}
                        onChange={(event) => setEditingValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            setEditingId(null)
                          }
                        }}
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          padding: '8px 10px',
                          borderRadius: 8,
                          border: '1px solid var(--dsw-alias-border-l2)',
                          background: 'var(--dsw-alias-bg-base, #fff)',
                          color: 'inherit',
                          font: 'inherit',
                          fontSize: 12,
                          lineHeight: 1.7,
                          minHeight: 240,
                          resize: 'vertical',
                        }}
                      />
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          style={{
                            padding: '3px 12px',
                            borderRadius: 6,
                            border: '1px solid var(--dsw-alias-border-l2)',
                            background: 'transparent',
                            color: 'inherit',
                            font: 'inherit',
                            fontSize: 11,
                            cursor: 'pointer',
                          }}
                        >
                          {t('cancel')}
                        </button>
                        <button
                          type="button"
                          onClick={saveEdit}
                          style={{
                            padding: '3px 12px',
                            borderRadius: 6,
                            border: 'none',
                            background: 'var(--dsw-alias-brand-primary, #4d6bfe)',
                            color: '#fff',
                            font: 'inherit',
                            fontSize: 11,
                            cursor: 'pointer',
                          }}
                        >
                          {t('confirm')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 12,
                          lineHeight: 1.6,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          cursor: 'pointer',
                          display: '-webkit-box',
                          WebkitLineClamp: 3,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                        onClick={() => toggle(item.id)}
                      >
                        {item.content}
                      </span>
                      <button
                        type="button"
                        onClick={() => startEdit(item)}
                        style={{
                          flexShrink: 0,
                          padding: '2px 8px',
                          border: 'none',
                          background: 'transparent',
                          color: dim,
                          font: 'inherit',
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        {t('edit')}
                      </button>
                      <button
                        type="button"
                        onClick={() => removeItem(item.id)}
                        style={{
                          flexShrink: 0,
                          padding: '2px 8px',
                          border: 'none',
                          background: 'transparent',
                          color: dim,
                          font: 'inherit',
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        {t('delete')}
                      </button>
                    </>
                  )}
                </div>
              )
            })
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <textarea
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              tab === 'preferences' ? t('settingsPersonalPromptHint') : t('settingsMemoryHint')
            }
            style={{
              flex: 1,
              minWidth: 0,
              boxSizing: 'border-box',
              padding: '7px 10px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 12,
              lineHeight: 1.6,
              resize: 'vertical',
            }}
          />
          <button
            type="button"
            onClick={add}
            disabled={!draft.trim()}
            style={{
              flexShrink: 0,
              padding: '7px 14px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 12,
              cursor: draft.trim() ? 'pointer' : 'default',
              opacity: draft.trim() ? 1 : 0.5,
            }}
          >
            {t('settingsMemoryAdd')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
