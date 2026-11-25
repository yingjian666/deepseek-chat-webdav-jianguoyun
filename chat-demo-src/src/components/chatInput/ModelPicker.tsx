import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { setModel, useSettings, type SelectedModel } from '../../services/settings.js'
import { IconChevronDownOutline14, IconCheckOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'

/** 模型选项：名称 + 特性说明。 */
const options: { value: SelectedModel; name: string; descKey: TranslationKey }[] = [
  { value: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', descKey: 'modelFlashDesc' },
  { value: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', descKey: 'modelProDesc' },
]

/**
 * 输入框右下角的模型选择器：点箭头后，按钮左侧直接展开两个模型按钮
 * （上面 flash、下面 pro），每项带特性说明。
 * 菜单用 portal 渲染到 body，避免被对话内容或输入框层级压住。
 */
export const ModelPicker = () => {
  const t = useTranslate()
  const model = useSettings((state) => state.model)
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const [anchor, setAnchor] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const current = options.find((option) => option.value === model) ?? options[0]

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    const modelRect = rootRef.current?.getBoundingClientRect()
    const searchRect = document
      .querySelector('[data-tour="search"]')
      ?.getBoundingClientRect()
    const inputRect = document
      .querySelector('[data-tour="input"]')
      ?.getBoundingClientRect()
    if (modelRect && searchRect && inputRect) {
      // 固定区域：左右在智能搜索右侧到模型按钮左侧之间，上下在输入框边框之内
      const left = Math.round(searchRect.right + 8)
      const right = Math.round(modelRect.left - 8)
      setAnchor({
        left,
        top: Math.round(inputRect.top + 1),
        width: Math.max(120, right - left),
        height: Math.max(60, Math.round(inputRect.height - 2)),
      })
    }
    setHighlighted(Math.max(0, options.findIndex((option) => option.value === model)))
    setOpen(true)
  }

  useEffect(() => {
    if (!open) {
      return
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return
      }
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const choose = (value: SelectedModel) => {
    setOpen(false)
    if (value === model) {
      return
    }
    setModel(value)
    if (value === 'deepseek-v4-pro') {
      showToast(t('modelNoVision'))
    }
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlighted((index) => Math.min(index + 1, options.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlighted((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(options[highlighted].value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
  }

  const rowStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '4px 8px',
    border: 'none',
    borderRadius: 8,
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    font: 'inherit',
    fontSize: 13,
    textAlign: 'left',
    cursor: 'pointer',
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }} onKeyDown={onKeyDown}>
      <button
        type="button"
        data-tour="model"
        aria-label={t('modelLabel')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          height: 28,
          padding: '0 10px',
          border: 'none',
          borderRadius: 14,
          background: 'var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.04))',
          color: 'var(--dsw-alias-label-primary)',
          font: 'inherit',
          fontSize: 12,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {current.name}
        <IconChevronDownOutline14 />
      </button>

      {open && anchor
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label={t('modelLabel')}
              style={{
                position: 'fixed',
                left: anchor.left,
                top: anchor.top,
                width: anchor.width,
                height: anchor.height,
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                gap: 0,
                padding: 2,
                overflowY: 'auto',
                borderRadius: 10,
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-specific-menu, #ffffff)',
                boxShadow: '0 10px 28px rgba(0, 0, 0, 0.18)',
                zIndex: 2147483000,
              }}
            >
              {options.map((option, index) => {
                const selected = option.value === model
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onMouseEnter={() => setHighlighted(index)}
                    onClick={() => choose(option.value)}
                    style={{
                      ...rowStyle,
                      flex: '0 0 auto',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'stretch',
                      gap: 2,
                      background:
                        index === highlighted
                          ? 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05))'
                          : 'transparent',
                    }}
                  >
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        fontWeight: 500,
                      }}
                    >
                      <span>{option.name}</span>
                      {selected ? <IconCheckOutline16 /> : null}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 10,
                        lineHeight: 1.35,
                        color: 'var(--dsw-alias-label-tertiary, #8a8f99)',
                      }}
                    >
                      {t(option.descKey)}
                    </span>
                  </button>
                )
              })}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
