import type { ArchiveSessionEntry } from '../../services/chat/history/readIndex.js'

/**
 * 导入会话勾选弹窗（DOM，不依赖 React）。
 * 返回选中的会话 id 集合；取消返回 null。默认全选。
 */
export const pickImportSessions = (
  sessions: ArchiveSessionEntry[],
  fileName: string
): Promise<Set<string> | null> =>
  new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:rgba(17,24,39,.45);display:flex;align-items:center;justify-content:center'

    const panel = document.createElement('div')
    panel.style.cssText =
      'width:min(580px,92vw);max-height:80vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);border-radius:14px;padding:18px 20px;box-shadow:0 24px 64px rgba(0,0,0,.28);font:13px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;box-sizing:border-box'

    const title = document.createElement('div')
    title.textContent = '选择要导入的对话'
    title.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:6px'

    const desc = document.createElement('div')
    desc.style.cssText = 'color:#6b7280;margin-bottom:10px'
    desc.textContent = `文件：${fileName}｜共 ${sessions.length} 个对话。按 id 合并，不会删除本地对话。`

    const list = document.createElement('div')
    list.style.cssText =
      'flex:1;min-height:100px;max-height:46vh;overflow:auto;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;margin-bottom:14px'

    const selected = new Set<string>(sessions.map((session) => session.id))
    const rowRefs: { id: string; box: HTMLSpanElement }[] = []

    // ZIP 索引里的顺序是原始写入顺序，实测非常乱；按更新时间倒序，最近的排在前面
    const ordered = [...sessions].sort((a, b) => {
      const timeA = a.updated_at ? new Date(a.updated_at).getTime() : 0
      const timeB = b.updated_at ? new Date(b.updated_at).getTime() : 0
      return timeB - timeA
    })

    const setRowChecked = (id: string, on: boolean) => {
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

    for (const session of ordered) {
      const row = document.createElement('div')
      row.style.cssText =
        'display:flex;gap:10px;align-items:baseline;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#f1f2f4);cursor:pointer'
      const box = document.createElement('span')
      box.style.cssText =
        'width:15px;height:15px;flex-shrink:0;border:1.5px solid #4f46e5;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;background:#4f46e5'
      box.textContent = '✓'
      const name = document.createElement('span')
      name.style.cssText =
        'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      name.textContent = session.title || '（无标题）'
      const meta = document.createElement('span')
      meta.style.cssText = 'flex-shrink:0;color:#9ca3af;font-size:11px'
      const ms = session.updated_at ? new Date(session.updated_at).getTime() : 0
      meta.textContent = ms
        ? `${session.message_count ?? 0} 条 · ${new Date(ms).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })}`
        : `${session.message_count ?? 0} 条`
      row.addEventListener('click', () => {
        setRowChecked(session.id, !selected.has(session.id))
      })
      rowRefs.push({ id: session.id, box })
      row.append(box, name, meta)
      list.appendChild(row)
    }

    // 列表下方：全选 | 反选
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
        setRowChecked(ref.id, true)
      }
    })
    invertButton.addEventListener('click', () => {
      for (const ref of rowRefs) {
        setRowChecked(ref.id, !selected.has(ref.id))
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

    const close = (result: Set<string> | null) => {
      overlay.remove()
      resolve(result)
    }
    cancel.addEventListener('click', () => close(null))
    confirm.addEventListener('click', () => {
      if (selected.size === 0) {
        return
      }
      close(selected)
    })
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        close(null)
      }
    })

    actions.append(cancel, confirm)
    panel.append(title, desc, list, promptRow, actions)
    overlay.appendChild(panel)
    document.body.appendChild(overlay)
  })
