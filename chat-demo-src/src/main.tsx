import { createRoot } from 'react-dom/client'
import { unzip } from 'fflate'
import { App } from './app/App.js'
import { Onboarding } from './components/onboarding/Onboarding.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { exportSessionsZip, importSelectedSessions } from './services/chat/backup.js'
import { pickSessionsForUpload } from './components/settings/uploadSessionsDialog.js'
import { setConfirmOverwrite, useSettings } from './services/settings.js'
import { useChatStore } from './services/chat/store.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()

declare global {
  interface Window {
    __syncBridge?: {
      onCommand: (callback: (cmd: string) => void) => void
      onProgress: (callback: (progress: { phase: string; loaded: number; total: number; name?: string }) => void) => void
      onFont: (callback: (index: number) => void) => void
      download: (name?: string) => Promise<{ name: string; data: Uint8Array }>
      listFiles: () => Promise<CloudFile[]>
      countFiles: () => Promise<{ files: number; dirs: number }>
      upload: (name: string, data: ArrayBuffer) => Promise<{ name: string; bytes: number }>
      // 单对话文件夹方案
      listDateFolders: () => Promise<{ name: string; modified: string | null }[]>
      listFolder: (folder: string) => Promise<{ name: string; size: number; modified: string | null }[]>
      uploadSessionZip: (
        folder: string,
        fileName: string,
        data: ArrayBuffer
      ) => Promise<{ name: string; bytes: number }>
      downloadZip: (folder: string, name: string) => Promise<{ name: string; data: Uint8Array }>
      uploadText: (
        folder: string,
        subFolder: string,
        fileName: string,
        text: string
      ) => Promise<{ path: string }>
      listTextFiles: (
        folder: string,
        subFolder: string
      ) => Promise<{ name: string; modified: string | null }[]>
      downloadText: (folder: string, subFolder: string, fileName: string) => Promise<string>
      // 更新与账号
      checkUpdate: () => Promise<{
        ok: boolean
        current: string
        latest?: string | null
        notes?: string
        downloadUrl?: string | null
        downloads?: Record<string, string> | null
        bestSource?: string
        sources?: { source: string; latency: number | null; ok: boolean; error?: string }[]
        error?: string
      }>
      getAppVersion: () => Promise<string>
      downloadUpdate: (url: string) => Promise<{ path: string; bytes: number }>
      notify: (message: string) => void
      getSecret: (name: string) => Promise<string | null>
      setSecret: (name: string, value: string) => Promise<boolean>
      getPrefs: () => Promise<{ fontSizeIndex?: number }>
      getZoom: () => Promise<number>
      setZoom: (value: number) => Promise<number>
      getSyncAccount: () => Promise<{ user: string; hasPass: boolean }>
      setSyncAccount: (account: { user: string; pass?: string }) => Promise<boolean>
      getBalance: () => Promise<{
        ok: boolean
        total?: string
        currency?: string
        available?: boolean
        error?: string
      }>
    }
  }
}

const size = (n: number) =>
  n / 1024 / 1024 >= 1 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 毫秒时间戳转本地时间，精确到秒。 */
const fmtDateTime = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

type ArchiveSession = {
  id: string
  title: string | null
  message_count: number
  updated_at: string
}

type CloudFile = { name: string; size: number; modified: string | null }

/** 列出云端文件，让用户挑一个导入，避免固定文件名被改后就失效。 */
const dateFolderToday = () => {
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}年${mm}月${dd}日对话`
}

/** 文件名安全化：替换文件系统/URL 敏感字符 */
const safeFileName = (name: string) =>
  (name || 'untitled').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 40) || 'untitled'

/** 选了两个以上对话时询问：合并成一个 ZIP / 每个单独。取消返回 null。 */
const confirmMergeDialog = (count: number): Promise<'merged' | 'single' | null> =>
  new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:rgba(17,24,39,.45);display:flex;align-items:center;justify-content:center'

    const panel = document.createElement('div')
    panel.style.cssText =
      'width:min(480px,92vw);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);border-radius:14px;padding:18px 20px;box-shadow:0 24px 64px rgba(0,0,0,.28);font:13px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;box-sizing:border-box'

    const title = document.createElement('div')
    title.textContent = `已选择 ${count} 个对话`
    title.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:6px'

    const desc = document.createElement('div')
    desc.style.cssText = 'color:#6b7280;margin-bottom:14px'
    desc.textContent = '要合并成一个 ZIP，还是每个对话单独一个 ZIP？'

    const makeButton = (text: string, primary: boolean, onClick: () => void) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = text
      btn.style.cssText = primary
        ? 'padding:8px 16px;border:none;border-radius:8px;background:#4f46e5;color:#fff;font:inherit;font-weight:600;cursor:pointer'
        : 'padding:8px 16px;border:1px solid #d1d5db;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer'
      btn.addEventListener('click', onClick)
      return btn
    }

    const close = (result: 'merged' | 'single' | null) => {
      overlay.remove()
      resolve(result)
    }

    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px'
    actions.append(
      makeButton('取消', false, () => close(null)),
      makeButton('每个单独', false, () => close('single')),
      makeButton('合并成一个 ZIP', true, () => close('merged'))
    )

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(null)
    })
    panel.append(title, desc, actions)
    overlay.appendChild(panel)
    document.body.appendChild(overlay)
  })

/** 选日期文件夹（单选）。返回文件夹名或 null。 */
const pickDateFolder = (
  folders: { name: string; modified: string | null }[]
): Promise<string | null> =>
  new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:rgba(17,24,39,.45);display:flex;align-items:center;justify-content:center'

    const panel = document.createElement('div')
    panel.style.cssText =
      'width:min(520px,92vw);max-height:72vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);border-radius:14px;padding:18px 20px;box-shadow:0 24px 64px rgba(0,0,0,.28);font:13px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;box-sizing:border-box'

    const title = document.createElement('div')
    title.textContent = '选择要导入的日期文件夹'
    title.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:6px'

    const desc = document.createElement('div')
    desc.style.cssText = 'color:#6b7280;margin-bottom:10px'
    desc.textContent = '云端按日期保存了多份备份，选一个查看其中的对话。'

    const list = document.createElement('div')
    list.style.cssText =
      'flex:1;min-height:80px;max-height:48vh;overflow:auto;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;margin-bottom:14px'

    let selected: string | null = folders[0]?.name ?? null
    const rows: HTMLDivElement[] = []
    for (const folder of folders) {
      const row = document.createElement('div')
      row.style.cssText =
        'padding:10px;border-bottom:1px solid var(--dsw-alias-border-l1,#f1f2f4);cursor:pointer;display:flex;gap:10px;align-items:baseline'
      const name = document.createElement('span')
      name.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      name.textContent = folder.name
      const meta = document.createElement('span')
      meta.style.cssText = 'flex-shrink:0;color:#9ca3af;font-size:11px'
      meta.textContent = folder.modified ? fmtDateTime(new Date(folder.modified).getTime()) : ''
      row.append(name, meta)
      row.addEventListener('click', () => {
        selected = folder.name
        rows.forEach((item) => {
          item.style.background = 'transparent'
        })
        row.style.background = 'rgba(79,70,229,.1)'
      })
      rows.push(row)
      list.appendChild(row)
    }
    if (rows.length > 0) {
      rows[0].click()
    }

    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px'
    const cancel = document.createElement('button')
    cancel.textContent = '取消'
    cancel.style.cssText =
      'padding:8px 18px;border:1px solid #d1d5db;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer'
    const confirm = document.createElement('button')
    confirm.textContent = '查看'
    confirm.style.cssText =
      'padding:8px 18px;border:none;border-radius:8px;background:#4f46e5;color:#fff;font:inherit;font-weight:600;cursor:pointer'

    const close = (result: string | null) => {
      overlay.remove()
      resolve(result)
    }
    cancel.addEventListener('click', () => close(null))
    confirm.addEventListener('click', () => close(selected))
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(null)
    })

    actions.append(cancel, confirm)
    panel.append(title, desc, list, actions)
    overlay.appendChild(panel)
    document.body.appendChild(overlay)
  })

/** 勾选日期文件夹里的 ZIP（多选，默认全选）。返回文件名数组或 null。 */
const pickZipFiles = (
  files: { name: string; size: number; modified: string | null }[],
  folder: string
): Promise<string[] | null> =>
  new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:rgba(17,24,39,.45);display:flex;align-items:center;justify-content:center'

    const panel = document.createElement('div')
    panel.style.cssText =
      'width:min(600px,94vw);max-height:80vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);border-radius:14px;padding:18px 20px;box-shadow:0 24px 64px rgba(0,0,0,.28);font:13px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;box-sizing:border-box'

    const title = document.createElement('div')
    title.textContent = `选择要导入的备份（${folder}）`
    title.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:6px'

    const desc = document.createElement('div')
    desc.style.cssText = 'color:#6b7280;margin-bottom:10px'
    desc.textContent = `共 ${files.length} 个 ZIP，默认全选；导入按 id 合并，不会删除本地对话。`

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
      meta.textContent = `${size(file.size)}${file.modified ? ` · ${fmtDateTime(new Date(file.modified).getTime())}` : ''}`
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
    panel.append(title, desc, list, promptRow, actions)
    overlay.appendChild(panel)
    document.body.appendChild(overlay)
  })

/** 云端已有同名对话时询问是否覆盖；返回是否覆盖。 */
const confirmOverwriteDialog = (
  fileName: string,
  cloudMs: number,
  localMs: number
): Promise<boolean> =>
  new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:rgba(17,24,39,.45);display:flex;align-items:center;justify-content:center'

    const panel = document.createElement('div')
    panel.style.cssText =
      'width:min(480px,92vw);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);border-radius:14px;padding:18px 20px;box-shadow:0 24px 64px rgba(0,0,0,.28);font:13px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;box-sizing:border-box'

    const title = document.createElement('div')
    title.textContent = '云端已有同名的对话备份'
    title.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:6px'

    const desc = document.createElement('div')
    desc.style.cssText = 'color:#374151;margin-bottom:12px;line-height:1.7'
    const diff = localMs - cloudMs
    const hint = diff > 0 ? '本地更新' : diff < 0 ? '云端更新' : '时间相同'
    desc.textContent = `文件：${fileName}\n云端：${fmtDateTime(cloudMs)}\n本地：${fmtDateTime(localMs)}（${hint}）`
    desc.style.whiteSpace = 'pre-line'

    // ☐ 以后默认覆盖
    const rememberRow = document.createElement('label')
    rememberRow.style.cssText =
      'display:flex;gap:8px;align-items:center;margin-bottom:14px;font-size:12px;color:#4b5563;cursor:pointer'
    const remember = document.createElement('input')
    remember.type = 'checkbox'
    rememberRow.append(remember, document.createTextNode('以后默认覆盖，不再提示（可在设置里重新开启）'))

    const close = (result: boolean) => {
      // 勾选了「以后默认覆盖」→ 关闭设置里的提示开关
      if (remember.checked) {
        setConfirmOverwrite(false)
      }
      overlay.remove()
      resolve(result)
    }

    const makeButton = (text: string, primary: boolean, onClick: () => void) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = text
      btn.style.cssText = primary
        ? 'padding:8px 16px;border:none;border-radius:8px;background:#4f46e5;color:#fff;font:inherit;font-weight:600;cursor:pointer'
        : 'padding:8px 16px;border:1px solid #d1d5db;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer'
      btn.addEventListener('click', onClick)
      return btn
    }

    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px'
    actions.append(
      makeButton('取消', false, () => close(false)),
      makeButton('覆盖', true, () => close(true))
    )

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(false)
    })
    panel.append(title, desc, rememberRow, actions)
    overlay.appendChild(panel)
    document.body.appendChild(overlay)
  })

/** 只解压 ZIP 里的会话索引，用于导入前核对，避免覆盖错。 */
const readArchiveIndex = (data: Uint8Array): Promise<ArchiveSession[]> =>
  new Promise((resolve) => {
    try {
      unzip(data, { filter: (entry) => entry.name === 'chat_session_index.json' }, (error, files) => {
        const file = error ? null : files['chat_session_index.json']
        if (!file) {
          resolve([])
          return
        }
        try {
          const parsed = JSON.parse(new TextDecoder().decode(file))
          resolve(Array.isArray(parsed) ? parsed : [])
        } catch {
          resolve([])
        }
      })
    } catch {
      resolve([])
    }
  })

/** 应用对话字号：把设置里的字号比例写到根元素，供 CSS 使用。 */
const applyFontSize = (size: number) => {
  const base = Number.isFinite(size) ? Math.min(24, Math.max(10, Math.round(size))) : 16
  const px = (n: number) => `${Math.round(n)}px`
  let style = document.getElementById('__chatFontSize') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = '__chatFontSize'
    document.head.appendChild(style)
  }
  style.textContent = `:root, body {
    --dsw-font-markdown-h1: 700 ${px(base * 1.5)}/${px(base * 2.1)} var(--dsw-font-family);
    --dsw-font-markdown-h2: 700 ${px(base * 1.375)}/${px(base * 2)} var(--dsw-font-family);
    --dsw-font-markdown-h3: 700 ${px(base * 1.25)}/${px(base * 1.875)} var(--dsw-font-family);
    --dsw-font-markdown-h4: 600 ${px(base)}/${px(base * 1.75)} var(--dsw-font-family);
    --dsw-font-markdown-base: ${px(base)}/${px(base * 1.75)} var(--dsw-font-family);
    --dsw-font-markdown-base-strong: 600 ${px(base)}/${px(base * 1.75)} var(--dsw-font-family);
    --dsw-font-markdown-table: ${px(base - 1)}/${px((base - 1) * 1.67)} var(--dsw-font-family);
    --dsw-font-markdown-table-head: 500 ${px(base - 1)}/${px((base - 1) * 1.67)} var(--dsw-font-family);
    --dsw-font-markdown-small: ${px(base - 2)}/${px((base - 2) * 1.71)} var(--dsw-font-family);
    --dsw-font-markdown-small-strong: 600 ${px(base - 2)}/${px((base - 2) * 1.71)} var(--dsw-font-family);
    --dsw-font-markdown-code: ${px(base - 2)}/${px((base - 2) * 1.57)} var(--ds-font-family-code);
    --dsw-font-markdown-code-block: ${px(base - 3)}/${px((base - 3) * 1.69)} var(--ds-font-family-code);
  }
  [data-chat-text] {
    font-size: ${px(base)} !important;
    line-height: 1.75 !important;
  }`
}

applyFontSize(useSettings.getState().fontSize)
useSettings.subscribe((state) => applyFontSize(state.fontSize))

const bridge = window.__syncBridge
if (bridge) {
  const bar = document.createElement('div')
  const fill = document.createElement('div')
  const label = document.createElement('div')
  bar.style.cssText =
    'position:fixed;top:0;left:0;right:0;height:3px;background:rgba(0,0,0,.08);z-index:2147483647;display:none'
  fill.style.cssText = 'height:100%;width:0;background:#4f46e5;transition:width .15s'
  label.style.cssText =
    'position:fixed;top:10px;right:14px;z-index:2147483647;background:rgba(17,24,39,.92);color:#fff;font:12px/1.7 system-ui,sans-serif;padding:3px 10px;border-radius:8px;display:none'
  bar.appendChild(fill)
  document.body.appendChild(bar)
  document.body.appendChild(label)

  const show = (text: string, pct: number) => {
    bar.style.display = 'block'
    label.style.display = 'block'
    fill.style.width = `${pct}%`
    label.textContent = text
  }
  const hide = () => {
    bar.style.display = 'none'
    label.style.display = 'none'
    fill.style.width = '0'
  }

  bridge.onProgress((p) => {
    if (p.phase === 'done') {
      hide()
      return
    }
    const pct = p.total > 0 ? Math.min(100, (p.loaded / p.total) * 100) : 0
    const verb = p.phase === 'upload' ? '上传' : '下载'
    show(`${verb} ${size(p.loaded)} / ${size(p.total)}（${pct.toFixed(0)}%）`, pct)
  })
  // 防重入：连点菜单会让同一个命令跑两遍，进而并发请求打爆坚果云配额
  let syncRunning = false
  const runSyncCommand = async (cmd: string) => {
    if (syncRunning) {
      bridge.notify('上一个同步操作还在进行中，请稍候')
      return
    }
    syncRunning = true
    try {
      if (cmd === 'upload') {
        show('正在检查云端…', 0)
        const [, stats] = await Promise.all([bridge.listFiles(), bridge.countFiles()])
        hide()
        const warningEnabled = useSettings.getState().remoteSizeWarning
        // 坚果云限制单次请求最多 750 个文件；接近上限时提醒清理（受「提醒云端文件过多」开关控制）
        if (warningEnabled && stats.files + stats.dirs > 700) {
          bridge.notify(
            `云端文件过多（${stats.files + stats.dirs} 个，坚果云上限 750 个），建议先清理旧备份再上传`
          )
        }
        const localSessions = useChatStore.getState().sessions
        // 先选要上传的对话（默认全选）
        const picked = await pickSessionsForUpload(
          localSessions.map((session) => ({
            id: session.id,
            title: session.title || '（无标题）',
            updatedAt: session.updatedAt ?? 0,
            forkedFrom: session.forkedFrom,
          }))
        )
        if (!picked || picked.size === 0) return
        // 分叉必须带父级：递归补齐 forkedFrom 链
        const withParents = (source: string[]): string[] => {
          const set = new Set(source)
          let changed = true
          while (changed) {
            changed = false
            for (const id of [...set]) {
              const parent = localSessions.find((item) => item.id === id)?.forkedFrom
              if (parent && !set.has(parent)) {
                set.add(parent)
                changed = true
              }
            }
          }
          return [...set]
        }
        const ids = withParents([...picked])
        // 选了 2 个以上：询问合并 / 单独
        const mode = ids.length >= 2 ? await confirmMergeDialog(ids.length) : 'single'
        if (!mode) return
        const folder = dateFolderToday()
        // 冲突检测：列出云端今天的日期文件夹
        let cloudFiles: { name: string; modified: string | null }[] = []
        try {
          cloudFiles = await bridge.listFolder(folder)
        } catch {
          cloudFiles = []
        }
        const confirmOverwrite = useSettings.getState().confirmOverwrite
        const now = Date.now()
        if (mode === 'merged') {
          const nowDate = new Date()
          const zipName = `${nowDate.getFullYear()}年${String(nowDate.getMonth() + 1).padStart(2, '0')}月${String(nowDate.getDate()).padStart(2, '0')}日合并.zip`
          const existing = cloudFiles.find((file) => file.name === zipName)
          if (existing && confirmOverwrite) {
            const cloudMs = existing.modified ? new Date(existing.modified).getTime() : 0
            const ok = await confirmOverwriteDialog(zipName, cloudMs, now)
            if (!ok) return
          }
          show('正在导出…', 0)
          const blob = await exportSessionsZip(ids)
          show('正在上传…', 50)
          await bridge.uploadSessionZip(folder, zipName, await blob.arrayBuffer())
          hide()
          bridge.notify(`已上传合并备份（${ids.length} 个对话）：${folder}/${zipName}`)
          return
        }
        // 每个对话单独一个 ZIP
        let uploaded = 0
        let skipped = 0
        for (let index = 0; index < ids.length; index += 1) {
          const id = ids[index]
          const session = localSessions.find((item) => item.id === id)
          const zipName = `${safeFileName(session?.title || 'untitled')}-${id.slice(0, 8)}.zip`
          const existing = cloudFiles.find((file) => file.name === zipName)
          if (existing && confirmOverwrite) {
            const cloudMs = existing.modified ? new Date(existing.modified).getTime() : 0
            const ok = await confirmOverwriteDialog(zipName, cloudMs, session?.updatedAt ?? now)
            if (!ok) {
              skipped += 1
              continue
            }
          }
          show(`正在上传 ${index + 1}/${ids.length}…`, ((index + 1) / ids.length) * 100)
          const blob = await exportSessionsZip([id])
          await bridge.uploadSessionZip(folder, zipName, await blob.arrayBuffer())
          uploaded += 1
        }
        hide()
        bridge.notify(
          `已上传 ${uploaded} 个对话到 ${folder}${skipped > 0 ? `，跳过 ${skipped} 个` : ''}`
        )
      } else if (cmd === 'import') {
        // 新流程：列日期文件夹 → 选一个 → 列 ZIP → 勾选 → 下载合并
        show('正在读取云端文件夹…', 0)
        let folders: { name: string; modified: string | null }[] = []
        try {
          folders = await bridge.listDateFolders()
        } catch (error) {
          hide()
          bridge.notify(`读取云端文件夹失败：${error instanceof Error ? error.message : String(error)}`)
          return
        }
        hide()
        if (!folders.length) {
          bridge.notify('云端还没有备份，先上传一次吧')
          return
        }
        const folder = await pickDateFolder(folders)
        if (!folder) return
        show(`正在读取 ${folder}…`, 0)
        const zips = await bridge.listFolder(folder)
        hide()
        if (!zips.length) {
          bridge.notify(`${folder} 里没有 ZIP 文件`)
          return
        }
        const chosenZips = await pickZipFiles(zips, folder)
        if (!chosenZips || chosenZips.length === 0) return
        let imported = 0
        for (let index = 0; index < chosenZips.length; index += 1) {
          const name = chosenZips[index]
          show(`正在下载 ${index + 1}/${chosenZips.length}…`, ((index + 1) / chosenZips.length) * 40)
          const remote = await bridge.downloadZip(folder, name)
          const ids = (await readArchiveIndex(remote.data)).map((session) => session.id)
          if (ids.length === 0) {
            continue
          }
          // 复制成独立的 Uint8Array<ArrayBuffer>，满足 File/Blob 对 BlobPart 的类型要求
          const file = new File([new Uint8Array(remote.data)], name, { type: 'application/zip' })
          imported += await importSelectedSessions(file, new Set(ids))
          show(`正在导入 ${index + 1}/${chosenZips.length}…`, 40 + ((index + 1) / chosenZips.length) * 60)
        }
        hide()
        bridge.notify(`已导入 ${imported} 个会话（来自 ${folder}）`)
      }
    } catch (error) {
      hide()
      bridge.notify(`同步失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      syncRunning = false
    }
  }

  bridge.onCommand(runSyncCommand)
}

/** 启动前从系统加密存储恢复 API Key，并把旧的 localStorage 明文迁移过去。 */
const boot = async () => {
  if (bridge) {
    if (bridge.getSecret) {
      try {
        const saved = await bridge.getSecret('apiKey')
        const legacy = localStorage.getItem('chat-demo:api-key')
        if (saved) {
          useSettings.setState({ apiKey: saved })
        } else if (legacy) {
          await bridge.setSecret('apiKey', legacy)
          localStorage.removeItem('chat-demo:api-key')
          useSettings.setState({ apiKey: legacy })
        }
      } catch {
        // 加密不可用时保持未设置状态
      }
    }
  }
  createRoot(document.getElementById('root') as HTMLElement).render(
    <>
      <App />
      <Onboarding />
    </>
  )
}

void boot()
