import type { PromptItem } from '../../services/settings.js'

/** 内容前 8 个字做文件名（安全化）。 */
export const promptFileName = (content: string): string => {
  const head = content.replace(/[\\/:*?"<>|\r\n]/g, ' ').trim().slice(0, 8)
  return `${head || 'empty'}.txt`
}

/**
 * 勾选要导出的偏好/记忆条目（DOM 弹窗）。返回选中的条目或 null。
 */
export const pickPromptsForExport = (
  items: PromptItem[],
  title: string
): Promise<PromptItem[] | null> =>
  new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:rgba(17,24,39,.45);display:flex;align-items:center;justify-content:center'

    const panel = document.createElement('div')
    panel.style.cssText =
      'width:min(560px,92vw);max-height:78vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);border-radius:14px;padding:18px 20px;box-shadow:0 24px 64px rgba(0,0,0,.28);font:13px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;box-sizing:border-box'

    const heading = document.createElement('div')
    heading.textContent = `导出「${title}」到坚果云`
    heading.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:6px'

    const desc = document.createElement('div')
    desc.style.cssText = 'color:#6b7280;margin-bottom:10px'
    desc.textContent = `共 ${items.length} 条，每条导出为一个 TXT（文件名取内容前 8 个字）。默认全选。`

    const list = document.createElement('div')
    list.style.cssText =
      'flex:1;min-height:100px;max-height:48vh;overflow:auto;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;margin-bottom:8px'

    const selected = new Set<string>(items.map((item) => item.id))
    const rowRefs: { id: string; box: HTMLSpanElement }[] = []
    const setChecked = (id: string, on: boolean) => {
      if (on) {
        selected.add(id)
      } else {
        selected.delete(id)
      }
      const ref = rowRefs.find((item) => item.id === id)
      if (ref) {
        ref.box.style.background = on ? '#4f46e5' : 'transparent'
        ref.box.style.borderColor = on ? '#4f46e5' : '#c7c9d1'
        ref.box.textContent = on ? '✓' : ''
      }
    }

    for (const item of items) {
      const row = document.createElement('div')
      row.style.cssText =
        'display:flex;gap:10px;align-items:baseline;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#f1f2f4);cursor:pointer'
      const box = document.createElement('span')
      box.style.cssText =
        'width:15px;height:15px;flex-shrink:0;border:1.5px solid #4f46e5;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;background:#4f46e5'
      box.textContent = '✓'
      const text = document.createElement('span')
      text.style.cssText =
        'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      text.textContent = item.content
      const name = document.createElement('span')
      name.style.cssText = 'flex-shrink:0;color:#9ca3af;font-size:11px'
      name.textContent = promptFileName(item.content)
      row.addEventListener('click', () => {
        setChecked(item.id, !selected.has(item.id))
      })
      rowRefs.push({ id: item.id, box })
      row.append(box, text, name)
      list.appendChild(row)
    }

    const promptRow = document.createElement('div')
    promptRow.style.cssText =
      'display:flex;gap:6px;align-items:center;margin-bottom:12px;font-size:12px;color:#6b7280'
    const allButton = document.createElement('button')
    allButton.type = 'button'
    allButton.textContent = '全选'
    allButton.style.cssText =
      'border:none;background:transparent;color:var(--dsw-alias-brand-primary,#4f46e5);font:inherit;cursor:pointer;padding:0'
    const separator = document.createElement('span')
    separator.textContent = '|'
    separator.style.cssText = 'color:#c7c9d1'
    const invertButton = document.createElement('button')
    invertButton.type = 'button'
    invertButton.textContent = '反选'
    invertButton.style.cssText = allButton.style.cssText
    allButton.addEventListener('click', () => {
      for (const ref of rowRefs) {
        setChecked(ref.id, true)
      }
    })
    invertButton.addEventListener('click', () => {
      for (const ref of rowRefs) {
        setChecked(ref.id, !selected.has(ref.id))
      }
    })
    promptRow.append(allButton, separator, invertButton)

    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px'
    const cancel = document.createElement('button')
    cancel.textContent = '取消'
    cancel.style.cssText =
      'padding:8px 18px;border:1px solid #d1d5db;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer'
    const confirm = document.createElement('button')
    confirm.textContent = '导出选中'
    confirm.style.cssText =
      'padding:8px 18px;border:none;border-radius:8px;background:#4f46e5;color:#fff;font:inherit;font-weight:600;cursor:pointer'

    const close = (result: PromptItem[] | null) => {
      overlay.remove()
      resolve(result)
    }
    cancel.addEventListener('click', () => close(null))
    confirm.addEventListener('click', () => {
      if (selected.size === 0) {
        return
      }
      close(items.filter((item) => selected.has(item.id)))
    })
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(null)
    })

    actions.append(cancel, confirm)
    panel.append(heading, desc, list, promptRow, actions)
    overlay.appendChild(panel)
    document.body.appendChild(overlay)
  })

/**
 * 导入偏好/记忆：勾选云端 TXT（可多选）。返回选中的文件名或 null。
 */
export const pickTextFilesToImport = (
  files: { name: string; modified: string | null }[],
  title: string
): Promise<string[] | null> =>
  new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:rgba(17,24,39,.45);display:flex;align-items:center;justify-content:center'

    const panel = document.createElement('div')
    panel.style.cssText =
      'width:min(560px,92vw);max-height:78vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);border-radius:14px;padding:18px 20px;box-shadow:0 24px 64px rgba(0,0,0,.28);font:13px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;box-sizing:border-box'

    const heading = document.createElement('div')
    heading.textContent = `从坚果云导入「${title}」`
    heading.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:6px'

    const desc = document.createElement('div')
    desc.style.cssText = 'color:#6b7280;margin-bottom:10px'
    desc.textContent = `云端共 ${files.length} 个 TXT。导入会按内容去重（已存在的条目不会重复添加）。`

    const list = document.createElement('div')
    list.style.cssText =
      'flex:1;min-height:100px;max-height:48vh;overflow:auto;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;margin-bottom:8px'

    const selected = new Set<string>(files.map((file) => file.name))
    const rowRefs: { name: string; box: HTMLSpanElement }[] = []
    const setChecked = (name: string, on: boolean) => {
      if (on) {
        selected.add(name)
      } else {
        selected.delete(name)
      }
      const ref = rowRefs.find((item) => item.name === name)
      if (ref) {
        ref.box.style.background = on ? '#4f46e5' : 'transparent'
        ref.box.style.borderColor = on ? '#4f46e5' : '#c7c9d1'
        ref.box.textContent = on ? '✓' : ''
      }
    }

    for (const file of files) {
      const row = document.createElement('div')
      row.style.cssText =
        'display:flex;gap:10px;align-items:baseline;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#f1f2f4);cursor:pointer'
      const box = document.createElement('span')
      box.style.cssText =
        'width:15px;height:15px;flex-shrink:0;border:1.5px solid #4f46e5;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;background:#4f46e5'
      box.textContent = '✓'
      const name = document.createElement('span')
      name.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      name.textContent = file.name
      const meta = document.createElement('span')
      meta.style.cssText = 'flex-shrink:0;color:#9ca3af;font-size:11px'
      meta.textContent = file.modified
        ? new Date(file.modified).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })
        : ''
      row.addEventListener('click', () => {
        setChecked(file.name, !selected.has(file.name))
      })
      rowRefs.push({ name: file.name, box })
      row.append(box, name, meta)
      list.appendChild(row)
    }

    const promptRow = document.createElement('div')
    promptRow.style.cssText =
      'display:flex;gap:6px;align-items:center;margin-bottom:12px;font-size:12px;color:#6b7280'
    const allButton = document.createElement('button')
    allButton.type = 'button'
    allButton.textContent = '全选'
    allButton.style.cssText =
      'border:none;background:transparent;color:var(--dsw-alias-brand-primary,#4f46e5);font:inherit;cursor:pointer;padding:0'
    const separator = document.createElement('span')
    separator.textContent = '|'
    separator.style.cssText = 'color:#c7c9d1'
    const invertButton = document.createElement('button')
    invertButton.type = 'button'
    invertButton.textContent = '反选'
    invertButton.style.cssText = allButton.style.cssText
    allButton.addEventListener('click', () => {
      for (const ref of rowRefs) {
        setChecked(ref.name, true)
      }
    })
    invertButton.addEventListener('click', () => {
      for (const ref of rowRefs) {
        setChecked(ref.name, !selected.has(ref.name))
      }
    })
    promptRow.append(allButton, separator, invertButton)

    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px'
    const cancel = document.createElement('button')
    cancel.textContent = '取消'
    cancel.style.cssText =
      'padding:8px 18px;border:1px solid #d1d5db;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer'
    const confirm = document.createElement('button')
    confirm.textContent = '导入选中'
    confirm.style.cssText =
      'padding:8px 18px;border:none;border-radius:8px;background:#4f46e5;color:#fff;font:inherit;font-weight:600;cursor:pointer'

    const close = (result: string[] | null) => {
      overlay.remove()
      resolve(result)
    }
    cancel.addEventListener('click', () => close(null))
    confirm.addEventListener('click', () => {
      if (selected.size === 0) {
        return
      }
      close([...selected])
    })
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(null)
    })

    actions.append(cancel, confirm)
    panel.append(heading, desc, list, promptRow, actions)
    overlay.appendChild(panel)
    document.body.appendChild(overlay)
  })
