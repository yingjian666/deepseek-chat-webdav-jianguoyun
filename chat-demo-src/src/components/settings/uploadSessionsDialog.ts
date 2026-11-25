/** 本地会话（勾选上传用）。 */
export type LocalSessionItem = {
  id: string
  title: string
  updatedAt: number
  /** 分叉来源（父会话 id） */
  forkedFrom?: string
}

/** 按父子关系展平：父在前、子缩进；孤儿（父不存在）按根处理。 */
const flattenForPicker = (sessions: LocalSessionItem[]) => {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const children = new Map<string, LocalSessionItem[]>()
  const roots: LocalSessionItem[] = []
  for (const session of sessions) {
    if (session.forkedFrom && byId.has(session.forkedFrom)) {
      const list = children.get(session.forkedFrom) ?? []
      list.push(session)
      children.set(session.forkedFrom, list)
    } else {
      roots.push(session)
    }
  }
  const rows: { session: LocalSessionItem; depth: number }[] = []
  const walk = (session: LocalSessionItem, depth: number) => {
    rows.push({ session, depth })
    for (const child of children.get(session.id) ?? []) {
      walk(child, depth + 1)
    }
  }
  for (const root of roots) {
    walk(root, 0)
  }
  return rows
}

/**
 * 上传前选择要备份的对话（DOM 弹窗，不依赖 React）。
 * - 分叉缩进显示 + id 后 4 位区分同名
 * - 勾选分叉自动勾选父对话；取消父对话自动取消其分叉
 * 返回选中的会话 id 集合；取消返回 null。默认全选。
 */
export const pickSessionsForUpload = (sessions: LocalSessionItem[]): Promise<Set<string> | null> =>
  new Promise((resolve) => {
    const byId = new Map(sessions.map((session) => [session.id, session]))
    const childrenOf = (id: string): string[] =>
      sessions.filter((session) => session.forkedFrom === id).map((session) => session.id)
    const parentOf = (id: string): string | undefined => byId.get(id)?.forkedFrom

    const overlay = document.createElement('div')
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:rgba(17,24,39,.45);display:flex;align-items:center;justify-content:center'

    const panel = document.createElement('div')
    panel.style.cssText =
      'width:min(640px,94vw);max-height:82vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);border-radius:14px;padding:18px 20px;box-shadow:0 24px 64px rgba(0,0,0,.28);font:13px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;box-sizing:border-box'

    const title = document.createElement('div')
    title.textContent = '选择要上传的对话'
    title.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:6px'

    const desc = document.createElement('div')
    desc.style.cssText = 'color:#6b7280;margin-bottom:10px'
    desc.textContent = `共 ${sessions.length} 个对话，默认全选；未勾选的不会进入本次备份 ZIP。分叉对话会自动带上父对话。`

    const list = document.createElement('div')
    list.style.cssText =
      'flex:1;min-height:100px;max-height:52vh;overflow:auto;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;margin-bottom:8px'

    const selected = new Set<string>(sessions.map((session) => session.id))
    const rowRefs: { id: string; box: HTMLSpanElement; depth: number }[] = []

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

    /** 勾选：连同所有父级一起勾上 */
    const checkWithParents = (id: string) => {
      let current: string | undefined = id
      while (current) {
        setRowChecked(current, true)
        current = parentOf(current)
      }
    }

    /** 取消：连同所有分叉子项一起取消 */
    const uncheckWithChildren = (id: string) => {
      setRowChecked(id, false)
      for (const child of childrenOf(id)) {
        uncheckWithChildren(child)
      }
    }

    for (const { session, depth } of flattenForPicker(sessions)) {
      const row = document.createElement('div')
      row.style.cssText = `display:flex;gap:10px;align-items:baseline;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#f1f2f4);cursor:pointer;padding-left:${
        10 + depth * 22
      }px`
      const box = document.createElement('span')
      box.style.cssText =
        'width:15px;height:15px;flex-shrink:0;border:1.5px solid #4f46e5;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;background:#4f46e5'
      box.textContent = '✓'
      const name = document.createElement('span')
      name.style.cssText =
        'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      const isFork = Boolean(session.forkedFrom)
      name.textContent = `${isFork ? '↳ ' : ''}${session.title || '（无标题）'}${
        isFork ? ` ·${session.id.slice(-4)}` : ''
      }`
      if (isFork) {
        name.style.color = 'var(--dsw-alias-label-secondary, #5c6169)'
      }
      const meta = document.createElement('span')
      meta.style.cssText = 'flex-shrink:0;color:#9ca3af;font-size:11px'
      meta.textContent = session.updatedAt
        ? new Date(session.updatedAt).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })
        : ''
      row.addEventListener('click', () => {
        if (selected.has(session.id)) {
          uncheckWithChildren(session.id)
        } else {
          checkWithParents(session.id)
        }
      })
      rowRefs.push({ id: session.id, box, depth })
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
      // 反选：先全部清空，再勾选原来未选中的（勾选时自动带父）
      const wasUnselected = rowRefs.filter((ref) => !selected.has(ref.id)).map((ref) => ref.id)
      for (const ref of rowRefs) {
        setRowChecked(ref.id, false)
      }
      for (const id of wasUnselected) {
        checkWithParents(id)
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
    confirm.textContent = '上传选中'
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
