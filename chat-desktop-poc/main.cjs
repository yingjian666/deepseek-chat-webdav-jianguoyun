const { app, BrowserWindow, Menu, dialog, shell, ipcMain, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')

/**
 * 固定数据目录。
 * Electron 默认用 package.json 的 name 拼 userData 路径；产品改名后路径会变，
 * 已保存的对话（IndexedDB）和加密凭据（secrets.json）就读不到了。
 * 这里显式指回原目录，之后无论怎么改产品名都不影响已有数据。
 */
const DATA_DIR = path.join(app.getPath('appData'), 'chat-desktop-poc')
app.setPath('userData', DATA_DIR)

/**
 * 崩溃日志。
 * 打包版没有控制台，启动失败时用户只会看到白屏、完全无从排查。
 * 只在出错时写入；超过 256 KB 就清空重写，避免长期运行把文件撑大。
 */
const ERROR_LOG = path.join(DATA_DIR, 'error.log')
const MAX_LOG_BYTES = 256 * 1024
const logError = (message) => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    if (fs.existsSync(ERROR_LOG) && fs.statSync(ERROR_LOG).size > MAX_LOG_BYTES) {
      fs.writeFileSync(ERROR_LOG, '')
    }
    fs.appendFileSync(ERROR_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* 日志失败不影响运行 */
  }
}
process.on('uncaughtException', (e) => logError(`uncaught: ${e && e.stack ? e.stack : e}`))
process.on('unhandledRejection', (e) => logError(`rejection: ${e && e.stack ? e.stack : e}`))

// 开发时用同级的 chat-demo-src/dist；打包后前端被复制进 app 目录的 dist/
const DIST_INDEX = app.isPackaged
  ? path.join(__dirname, 'dist', 'index.html')
  : path.join(__dirname, '..', 'chat-demo-src', 'dist', 'index.html')
const SETTINGS_HTML = path.join(__dirname, 'settings.html')
const DAV_BASE = 'https://dav.jianguoyun.com/dav/'
// 专属目录：/chat/chat/ ——软件只读写这里，不碰网盘其他文件
const DAV_DIR = DAV_BASE + 'chat/chat/'

let win
let settingsWin

// ---------- 加密存储（Windows 上 safeStorage 走 DPAPI，绑定当前用户） ----------

const secretsPath = () => path.join(app.getPath('userData'), 'secrets.json')

const canEncrypt = () => safeStorage.isAsyncEncryptionAvailable()

const encryptText = async (text) => {
  if (!canEncrypt()) throw new Error('系统加密不可用，无法保存凭据')
  const raw = await safeStorage.encryptStringAsync(text)
  // Electron 45 的异步 API 可能返回 Buffer、base64 字符串或 { result } 包装
  const buf = Buffer.isBuffer(raw)
    ? raw
    : typeof raw === 'string'
      ? Buffer.from(raw, 'base64')
      : Buffer.isBuffer(raw?.result)
        ? raw.result
        : typeof raw?.result === 'string'
          ? Buffer.from(raw.result, 'base64')
          : null
  if (!buf) throw new Error('加密返回了意外的结果')
  return buf.toString('base64')
}

const decryptText = async (base64) => {
  const buf = Buffer.from(base64, 'base64')
  try {
    // Electron 45 的异步 API 可能返回字符串，或 { shouldReEncrypt, result }
    const raw = await safeStorage.decryptStringAsync(buf)
    const value = typeof raw === 'string' ? raw : raw?.result
    if (typeof value === 'string') return { value }
  } catch {
    // 早期版本用同步 API 加密，异步 API 解不开；退回旧接口并标记需要迁移
  }
  try {
    return { value: safeStorage.decryptString(buf), legacy: true }
  } catch {
    return null
  }
}

const readSecrets = () => {
  try {
    return JSON.parse(fs.readFileSync(secretsPath(), 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return {}
  }
}

const writeSecrets = (secrets) => {
  fs.mkdirSync(path.dirname(secretsPath()), { recursive: true })
  fs.writeFileSync(secretsPath(), JSON.stringify(secrets, null, 2))
}

const getSecret = async (name) => {
  const secrets = readSecrets()
  const encoded = secrets[name]
  if (!encoded) return null
  const result = await decryptText(encoded)
  if (!result) return null
  if (result.legacy) {
    try {
      secrets[name] = await encryptText(result.value)
      writeSecrets(secrets)
    } catch {
      // 迁移失败时保留旧密文，下次读取再试
    }
  }
  return result.value
}

const setSecret = async (name, value) => {
  const secrets = readSecrets()
  if (value) secrets[name] = await encryptText(value)
  else delete secrets[name]
  writeSecrets(secrets)
}

/** 旧版本把坚果云账号明文写在 config.json；启动时迁移到加密存储。 */
const migrateLegacyConfig = async () => {
  const legacy = path.join(app.getPath('userData'), 'config.json')
  try {
    const raw = fs.readFileSync(legacy, 'utf8').replace(/^\uFEFF/, '')
    const cfg = JSON.parse(raw)
    if (cfg.user && cfg.pass && !(await getSecret('jianGuoYunUser'))) {
      await setSecret('jianGuoYunUser', cfg.user)
      await setSecret('jianGuoYunPass', cfg.pass)
      fs.renameSync(legacy, legacy + '.migrated')
    }
  } catch {
    // 没有旧配置或格式不对，忽略
  }
}

const ensureConfig = async () => {
  const user = await getSecret('jianGuoYunUser')
  const pass = await getSecret('jianGuoYunPass')
  if (!user || !pass) {
    throw new Error('还没有配置坚果云账号，请点菜单「账号设置」填写邮箱和应用密码')
  }
  return { user, pass }
}

// ---------- 同步 ----------

const authHeader = (cfg) => 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64')

// ---------- WebDAV 访问层：统一鉴权、超时、限流归一化 ----------

/**
 * 坚果云免费版限制 600 次 / 30 分钟。为了不给对方添麻烦，这里做三件事：
 * 1) 所有请求都带超时，避免挂起后用户重复点击造成雪崩；
 * 2) 目录创建结果在本进程内缓存，重复进目录不再发 MKCOL；
 * 3) 429/503 统一翻译成一句人话，调用方不再各自处理。
 */
const DAV_TIMEOUT_MS = 20_000
const RATE_LIMIT_MESSAGE = '请求过于频繁（坚果云免费版限制每 30 分钟 600 次），请稍后再试'

const davFetch = async (cfg, url, init = {}) => {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: authHeader(cfg), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(DAV_TIMEOUT_MS),
  })
  if (res.status === 429 || res.status === 503) {
    throw new Error(RATE_LIMIT_MESSAGE)
  }
  return res
}

/**
 * 同一时间只允许一个长同步操作（上传/下载），避免连点菜单并发打爆坚果云配额。
 * 只包长操作，不包 list/只读接口——导入流程是「逐个 downloadZip」，每次都会重新取锁，不影响。
 */
let syncBusy = false
const handleWithLock = (channel, handler) =>
  ipcMain.handle(channel, async (event, arg) => {
    if (syncBusy) throw new Error('上一个同步操作还在进行中，请稍候再试')
    syncBusy = true
    try {
      return await handler(event, arg)
    } finally {
      syncBusy = false
    }
  })

/** 解析 PROPFIND 响应里每个 <d:response> 的 href / 大小 / 修改时间。 */
const parseDavEntries = (xml) =>
  [...xml.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)].map((match) => {
    const block = match[1]
    const href = /<d:href>([^<]+)<\/d:href>/.exec(block)?.[1] ?? ''
    const name = decodeURIComponent(href.split('/').filter(Boolean).pop() ?? '')
    const size = Number(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/.exec(block)?.[1] ?? 0)
    const modified = /<d:getlastmodified>([^<]+)<\/d:getlastmodified>/.exec(block)?.[1] ?? null
    // 坚果云的目录 href 不一定以 / 结尾（实测会漏），必须同时看 <d:collection>
    const isDir = href.endsWith('/') || /<d:collection\s*\/?>/i.test(block)
    return { name, size, modified, isDir }
  })

const byModifiedDesc = (a, b) => {
  const timeA = a.modified ? new Date(a.modified).getTime() : 0
  const timeB = b.modified ? new Date(b.modified).getTime() : 0
  return timeB - timeA
}

const listRemoteNames = async (cfg) => {
  const res = await davFetch(cfg, DAV_DIR, { method: 'PROPFIND', headers: { Depth: '1' } })
  if (!res.ok) throw new Error(`列目录失败：HTTP ${res.status}`)
  return parseDavEntries(await res.text())
    .filter((entry) => !entry.isDir)
    .map((entry) => entry.name)
}

const pickRemoteFile = async (cfg) => {
  const names = await listRemoteNames(cfg)
  if (names.includes('backup.zip')) return { url: DAV_DIR + 'backup.zip', name: 'backup.zip' }
  const candidates = names
    .filter((n) => /^deepseek_data-.*\.zip$/i.test(n))
    .sort()
    .reverse()
  if (candidates.length) return { url: DAV_DIR + candidates[0], name: candidates[0] }
  throw new Error('云端没有可导入的 ZIP 备份（既没有 backup.zip，也没有 deepseek_data-*.zip）')
}

/** 确保专属目录存在：/chat/ 和 /chat/chat/（MKCOL 幂等，405 表示已存在）。成功后进程内缓存，不再重复发。 */
let remoteDirsReady = false
const ensureRemoteDirs = async (cfg) => {
  if (remoteDirsReady) return
  for (const dir of ['chat', 'chat/chat']) {
    const res = await davFetch(cfg, DAV_BASE + dir, { method: 'MKCOL' })
    if (!res.ok && res.status !== 405) throw new Error(`创建目录 ${dir} 失败：HTTP ${res.status}`)
  }
  remoteDirsReady = true
}

/** 带进度的 HTTPS PUT：分块写入并上报已发送字节数（fetch 的 PUT 拿不到进度）。 */
const putWithProgress = (url, headers, body, onProgress) =>
  new Promise((resolve, reject) => {
    const target = new URL(url)
    let settled = false
    let timer = null
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn(value)
    }
    const request = https.request(
      {
        method: 'PUT',
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        headers: { ...headers, 'Content-Length': body.length },
      },
      (response) => {
        let text = ''
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => finish(resolve, { status: response.statusCode, body: text }))
      }
    )
    /** 空闲超时：60 秒内没有任何进展就中断，避免请求悬挂导致用户反复重试。 */
    const armTimer = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        request.destroy(new Error('上传超时：网络不稳定或服务器无响应'))
      }, 60_000)
    }
    armTimer()
    request.on('error', (error) => finish(reject, error))

    const total = body.length
    const chunkSize = 256 * 1024
    let sent = 0
    let lastReport = 0

    const writeNext = () => {
      armTimer()
      while (sent < total) {
        const end = Math.min(sent + chunkSize, total)
        const chunk = body.subarray(sent, end)
        sent = end
        // 进度节流到约 150ms 一次：大文件按 256KB 逐块上报会把 IPC 刷爆
        const now = Date.now()
        if (sent >= total || now - lastReport >= 150) {
          lastReport = now
          onProgress(sent, total)
        }
        if (!request.write(chunk)) {
          request.once('drain', writeNext)
          return
        }
      }
      request.end()
    }
    writeNext()
  })

/** 列出云端目录里的 ZIP 文件（名称、大小、修改时间）。 */
const listRemoteEntries = async (cfg) => {
  // 首次访问时自动创建 /chat/chat/ 专属目录（进程内只做一次）
  await ensureRemoteDirs(cfg)
  const res = await davFetch(cfg, DAV_DIR, { method: 'PROPFIND', headers: { Depth: '1' } })
  if (!res.ok) throw new Error(`列目录失败：HTTP ${res.status}`)
  return parseDavEntries(await res.text())
    .filter((entry) => !entry.isDir && entry.name.toLowerCase().endsWith('.zip'))
    .sort(byModifiedDesc)
}

/**
 * 统计云端条目数量（用于容量提醒）。
 * 只发一次 Depth:1：早先用的 Depth:infinity 要递归整个目录，又贵又慢，而且用户也只能看个大概。
 * 结果缓存 5 分钟，避免用户连续点同步时反复请求。
 */
const COUNT_CACHE_MS = 5 * 60_000
let countCache = null
const countRemoteEntries = async (cfg) => {
  if (countCache && Date.now() - countCache.at < COUNT_CACHE_MS) return countCache.value
  await ensureRemoteDirs(cfg)
  const res = await davFetch(cfg, DAV_DIR, { method: 'PROPFIND', headers: { Depth: '1' } })
  if (!res.ok) return { files: 0, dirs: 0 }
  const entries = parseDavEntries(await res.text())
  // 第一项是目录自身，从目录计数里扣掉
  const value = {
    files: entries.filter((entry) => !entry.isDir).length,
    dirs: Math.max(0, entries.filter((entry) => entry.isDir).length - 1),
  }
  countCache = { at: Date.now(), value }
  return value
}

/** 列出云端目录里的 ZIP 文件（名称、大小、修改时间），供导入前选择。 */
ipcMain.handle('sync:list', async () => {
  const cfg = await ensureConfig()
  return listRemoteEntries(cfg)
})

ipcMain.handle('sync:count', async () => {
  const cfg = await ensureConfig()
  return countRemoteEntries(cfg)
})

handleWithLock('sync:download', async (_event, wantedName) => {
  const cfg = await ensureConfig()
  const picked = wantedName
    ? { url: DAV_DIR + wantedName, name: wantedName }
    : await pickRemoteFile(cfg)
  const { url, name } = picked
  const res = await davFetch(cfg, url)
  if (!res.ok) throw new Error(`下载 ${name} 失败：HTTP ${res.status}`)
  let total = Number(res.headers.get('content-length') ?? 0)
  // 某些情况下 GET 返回不带 content-length（chunked），用 HEAD 补一次
  if (!total) {
    try {
      const head = await davFetch(cfg, url, { method: 'HEAD' })
      total = Number(head.headers.get('content-length') ?? 0)
    } catch {
      // 拿不到就退回按已下载量展示
    }
  }
  const chunks = []
  let loaded = 0
  let lastReport = 0
  const report = (phase) => {
    if (!win || win.isDestroyed()) return
    if (total > 0) win.setProgressBar(Math.min(1, loaded / total))
    win.webContents.send('sync:progress', { phase, loaded, total, name })
  }
  if (res.body) {
    report('download')
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      loaded += value.length
      // 节流到约 150ms 一次，避免高频 IPC 把进度条刷爆
      const now = Date.now()
      if (now - lastReport >= 150) {
        lastReport = now
        report('download')
      }
    }
  } else {
    const buf = Buffer.from(await res.arrayBuffer())
    chunks.push(buf)
    loaded = buf.length
  }
  if (win && !win.isDestroyed()) win.setProgressBar(-1)
  win.webContents.send('sync:progress', {
    phase: 'done',
    loaded,
    total: total || loaded,
    name,
  })
  return { name, data: Buffer.concat(chunks) }
})

handleWithLock('sync:upload', async (_event, { name, data }) => {
  const cfg = await ensureConfig()
  const body = Buffer.from(data)
  // 坚果云 WebDAV 单文件上限 500MB，留 20MB 余量提前拦截
  if (body.length > 480 * 1024 * 1024) {
    throw new Error(
      `备份过大（${(body.length / 1024 / 1024).toFixed(0)}MB，超过 480MB 上限），请清理旧备份或减少对话后再上传`
    )
  }
  await ensureRemoteDirs(cfg)
  // 文件名由页面按时间生成（deepseek_data-YYYYMMDD-HHmmss.zip），每次新增不覆盖旧备份
  const targetName = typeof name === 'string' && name.trim() ? name.trim() : 'backup.zip'
  const result = await putWithProgress(
    DAV_DIR + targetName,
    { Authorization: authHeader(cfg), 'Content-Type': 'application/zip' },
    body,
    (sent, total) => {
      if (win && !win.isDestroyed()) {
        win.setProgressBar(sent / total)
        win.webContents.send('sync:progress', { phase: 'upload', loaded: sent, total, name: targetName })
      }
    }
  )
  if (win && !win.isDestroyed()) win.setProgressBar(-1)
  win.webContents.send('sync:progress', { phase: 'done', loaded: body.length, total: body.length, name: targetName })
  if (result.status < 200 || result.status >= 300) {
    // 429/503：坚果云对 WebDAV 请求有频率限制（免费版 600 次/30 分钟）
    if (result.status === 429 || result.status === 503) {
      throw new Error(
        `上传失败：请求过于频繁（HTTP ${result.status}），坚果云免费版限制每 30 分钟 600 次请求，请稍后再试`
      )
    }
    throw new Error(`上传失败：HTTP ${result.status}${result.body ? ` ${result.body.slice(0, 120)}` : ''}`)
  }
  return { name, bytes: body.length }
})

ipcMain.handle('sync:notify', (_event, message) => {
  dialog.showMessageBoxSync(win, { type: 'info', title: '同步', message, buttons: ['好'] })
})

// ---------- 单对话文件夹方案：日期文件夹 + 单个对话 ZIP ----------

/** 今天的日期文件夹名：2026年11月23日对话 */
const dateFolderName = (date = new Date()) =>
  `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, '0')}月${String(date.getDate()).padStart(2, '0')}日对话`

/** 确保某个日期文件夹存在（MKCOL 幂等，405 表示已存在）。按文件夹名缓存，避免每个对话都发一次。 */
const ensuredFolders = new Set()
const ensureDateFolder = async (cfg, folder) => {
  const url = DAV_DIR + encodeURIComponent(folder) + '/'
  if (ensuredFolders.has(folder)) return url
  const res = await davFetch(cfg, url, { method: 'MKCOL' })
  if (!res.ok && res.status !== 405) {
    throw new Error(`创建日期文件夹失败：HTTP ${res.status}`)
  }
  ensuredFolders.add(folder)
  return url
}

/** 列出一个日期文件夹里的 ZIP 文件（名称、大小、修改时间）。 */
ipcMain.handle('sync:listFolder', async (_event, folder) => {
  const cfg = await ensureConfig()
  const url = DAV_DIR + encodeURIComponent(folder) + '/'
  const res = await davFetch(cfg, url, { method: 'PROPFIND', headers: { Depth: '1' } })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`列目录失败：HTTP ${res.status}`)
  return parseDavEntries(await res.text())
    .filter((entry) => !entry.isDir && entry.name.toLowerCase().endsWith('.zip'))
    .sort(byModifiedDesc)
})

/** 列出 chat/chat/ 下所有日期文件夹（名称、修改时间）。 */
ipcMain.handle('sync:listDateFolders', async () => {
  const cfg = await ensureConfig()
  await ensureRemoteDirs(cfg)
  const res = await davFetch(cfg, DAV_DIR, { method: 'PROPFIND', headers: { Depth: '1' } })
  if (!res.ok) throw new Error(`列目录失败：HTTP ${res.status}`)
  return parseDavEntries(await res.text())
    // 只认日期文件夹（如 2026年11月23日对话），排除「个人偏好和记忆」等其他目录
    .filter((entry) => entry.isDir && entry.name && entry.name !== 'chat' && /年.*月.*日/.test(entry.name))
    .map((entry) => ({ name: entry.name, modified: entry.modified }))
    .sort(byModifiedDesc)
})

/** 下载日期文件夹里的一个 ZIP。 */
handleWithLock('sync:downloadZip', async (_event, { folder, name }) => {
  const cfg = await ensureConfig()
  const url = DAV_DIR + encodeURIComponent(folder) + '/' + encodeURIComponent(name)
  const res = await davFetch(cfg, url)
  if (!res.ok) {
    throw new Error(`下载失败：HTTP ${res.status}`)
  }
  const total = Number(res.headers.get('content-length') ?? 0)
  const chunks = []
  let loaded = 0
  let lastSent = 0
  for await (const chunk of res.body) {
    chunks.push(chunk)
    loaded += chunk.length
    const now = Date.now()
    if (win && !win.isDestroyed() && total > 0 && (now - lastSent > 150 || loaded >= total)) {
      lastSent = now
      win.setProgressBar(loaded / total)
      win.webContents.send('sync:progress', { phase: 'download', loaded, total, name })
    }
  }
  if (win && !win.isDestroyed()) win.setProgressBar(-1)
  win.webContents.send('sync:progress', { phase: 'done', loaded: total || loaded, total: total || loaded, name })
  return { name, data: Buffer.concat(chunks) }
})

/** 上传纯文本到坚果云（个人偏好/记忆导出用）：MKCOL 两级目录 + PUT。 */
ipcMain.handle('sync:uploadText', async (_event, { folder, subFolder, fileName, text }) => {
  const cfg = await ensureConfig()
  const baseUrl = DAV_DIR + encodeURIComponent(folder) + '/'
  const subUrl = baseUrl + encodeURIComponent(subFolder) + '/'
  for (const url of [baseUrl, subUrl]) {
    const res = await davFetch(cfg, url, { method: 'MKCOL' })
    if (!res.ok && res.status !== 405) {
      throw new Error(`创建目录失败：HTTP ${res.status}`)
    }
  }
  // 加 UTF-8 BOM，Windows 记事本打开不乱码
  const body = '\uFEFF' + text
  const res = await davFetch(cfg, subUrl + encodeURIComponent(fileName), {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body,
  })
  if (!res.ok) {
    throw new Error(`上传失败：HTTP ${res.status}`)
  }
  return { path: `${folder}/${subFolder}/${fileName}` }
})

/** 列出某个文本子文件夹里的 TXT 文件。 */
ipcMain.handle('sync:listTextFiles', async (_event, { folder, subFolder }) => {
  const cfg = await ensureConfig()
  const url = DAV_DIR + encodeURIComponent(folder) + '/' + encodeURIComponent(subFolder) + '/'
  const res = await davFetch(cfg, url, { method: 'PROPFIND', headers: { Depth: '1' } })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`列目录失败：HTTP ${res.status}`)
  return parseDavEntries(await res.text())
    .filter((entry) => !entry.isDir && entry.name.toLowerCase().endsWith('.txt'))
    .map((entry) => ({ name: entry.name, modified: entry.modified }))
    .sort(byModifiedDesc)
})

/** 读取一个 TXT 文本（去掉 BOM）。 */
ipcMain.handle('sync:downloadText', async (_event, { folder, subFolder, fileName }) => {
  const cfg = await ensureConfig()
  const url =
    DAV_DIR +
    encodeURIComponent(folder) +
    '/' +
    encodeURIComponent(subFolder) +
    '/' +
    encodeURIComponent(fileName)
  const res = await davFetch(cfg, url)
  if (!res.ok) {
    throw new Error(`读取失败：HTTP ${res.status}`)
  }
  const text = await res.text()
  return text.replace(/^\uFEFF/, '')
})

/** 更新源：version.json 的三个地址（按可用性自动选最快的）。 */
const UPDATE_SOURCES = {
  gitee: 'https://gitee.com/yingjian666/deepseek-chat-webdav-jianguoyun/raw/main/version.json',
  github:
    'https://raw.githubusercontent.com/yingjian666/deepseek-chat-webdav-jianguoyun/main/version.json',
  jsdelivr:
    'https://cdn.jsdelivr.net/gh/yingjian666/deepseek-chat-webdav-jianguoyun@main/version.json',
}

/** 当前应用版本（来自 package.json），供关于页显示，避免前端写死。 */
ipcMain.handle('app:version', () => app.getVersion())

/** 检查更新：并发请求三个源，测延迟，返回版本信息 + 各源状态。 */
ipcMain.handle('app:checkUpdate', async () => {
  const current = app.getVersion()
  // Electron 的 net.fetch 会走系统代理（加速器生效）；Node 原生 fetch 不走代理
  const { net } = require('electron')
  const fetchFn = net && typeof net.fetch === 'function' ? net.fetch.bind(net) : fetch
  const results = await Promise.all(
    Object.entries(UPDATE_SOURCES).map(async ([source, url]) => {
      const startedAt = Date.now()
      try {
        const res = await fetchFn(url, {
          headers: { 'Cache-Control': 'no-cache' },
          // 检查更新也要有超时：三个源并发，任何一个卡住都会拖慢整个弹窗
          signal: AbortSignal.timeout(10_000),
        })
        const latency = Date.now() - startedAt
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        const info = await res.json()
        return { source, latency, ok: true, info }
      } catch (error) {
        return { source, latency: null, ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  )
  const reachable = results.filter((item) => item.ok).sort((a, b) => a.latency - b.latency)
  const best = reachable[0]
  if (!best) {
    return {
      ok: false,
      current,
      error: '所有更新源都不可达（可能是网络问题）',
      sources: results.map((item) => ({ source: item.source, latency: item.latency, ok: item.ok, error: item.error })),
    }
  }
  const info = best.info ?? {}
  return {
    ok: true,
    current,
    latest: typeof info.version === 'string' ? info.version : null,
    notes: typeof info.notes === 'string' ? info.notes : '',
    downloadUrl: typeof info.downloadUrl === 'string' ? info.downloadUrl : null,
    downloads: info.downloads ?? null,
    bestSource: best.source,
    sources: results.map((item) => ({ source: item.source, latency: item.latency, ok: item.ok, error: item.error })),
  }
})

/** 下载更新包到临时目录（带进度）。只允许官方发布源，避免被任意 URL 拉取可执行文件。 */
const ALLOWED_UPDATE_HOSTS = new Set([
  'gitee.com',
  'github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'cdn.jsdelivr.net',
])

ipcMain.handle('app:downloadUpdate', async (_event, { url }) => {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    throw new Error('更新地址无效')
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_UPDATE_HOSTS.has(parsed.hostname)) {
    throw new Error(`拒绝从非官方来源下载：${parsed.hostname}`)
  }
  const fileName = 'setup-update.exe'
  const target = path.join(app.getPath('temp'), fileName)
  // 更新包可能上百 MB，用 5 分钟总超时兜底，避免网络卡住后一直挂着
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!res.ok) {
    throw new Error(`下载失败：HTTP ${res.status}`)
  }
  const total = Number(res.headers.get('content-length') ?? 0)
  const chunks = []
  let loaded = 0
  let lastSent = 0
  for await (const chunk of res.body) {
    chunks.push(chunk)
    loaded += chunk.length
    const now = Date.now()
    if (win && !win.isDestroyed() && (now - lastSent > 150 || (total > 0 && loaded >= total))) {
      lastSent = now
      win.setProgressBar(total > 0 ? loaded / total : -1)
      win.webContents.send('sync:progress', { phase: 'download', loaded, total, name: fileName })
    }
  }
  if (win && !win.isDestroyed()) win.setProgressBar(-1)
  win.webContents.send('sync:progress', { phase: 'done', loaded, total: total || loaded, name: fileName })
  fs.writeFileSync(target, Buffer.concat(chunks))
  return { path: target, bytes: loaded }
})

/** 上传单个对话/合并 ZIP 到指定日期文件夹（MKCOL + PUT，带进度）。 */
handleWithLock('sync:uploadSessionZip', async (_event, { folder, fileName, data }) => {
  const cfg = await ensureConfig()
  const body = Buffer.from(data)
  if (body.length > 480 * 1024 * 1024) {
    throw new Error(
      `文件过大（${(body.length / 1024 / 1024).toFixed(0)}MB，超过 480MB 上限），请减少对话后再上传`
    )
  }
  const folderUrl = await ensureDateFolder(cfg, folder)
  const targetUrl = folderUrl + encodeURIComponent(fileName)
  const result = await putWithProgress(
    targetUrl,
    { Authorization: authHeader(cfg), 'Content-Type': 'application/zip' },
    body,
    (sent, total) => {
      if (win && !win.isDestroyed()) {
        win.setProgressBar(sent / total)
        win.webContents.send('sync:progress', { phase: 'upload', loaded: sent, total, name: fileName })
      }
    }
  )
  if (win && !win.isDestroyed()) win.setProgressBar(-1)
  win.webContents.send('sync:progress', { phase: 'done', loaded: body.length, total: body.length, name: fileName })
  if (result.status < 200 || result.status >= 300) {
    if (result.status === 429 || result.status === 503) {
      throw new Error(
        `上传失败：请求过于频繁（HTTP ${result.status}），坚果云免费版限制每 30 分钟 600 次请求，请稍后再试`
      )
    }
    throw new Error(`上传失败：HTTP ${result.status}${result.body ? ` ${result.body.slice(0, 120)}` : ''}`)
  }
  return { name: fileName, bytes: body.length }
})

// ---------- 普通偏好（非敏感，明文 JSON） ----------

const prefsPath = () => path.join(app.getPath('userData'), 'prefs.json')

const ZOOM_MIN = 0.8
const ZOOM_MAX = 1.5
const normalizeZoom = (value) =>
  typeof value === 'number' && value >= ZOOM_MIN && value <= ZOOM_MAX ? value : 1

const readPrefs = () => {
  try {
    return JSON.parse(fs.readFileSync(prefsPath(), 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return {}
  }
}

const writePrefs = (prefs) => {
  fs.mkdirSync(path.dirname(prefsPath()), { recursive: true })
  fs.writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2))
}

ipcMain.handle('prefs:get', () => {
  const prefs = readPrefs()
  return {
    fontSizeIndex: Number.isInteger(prefs.fontSizeIndex) ? prefs.fontSizeIndex : 1,
    zoomFactor: normalizeZoom(prefs.zoomFactor),
  }
})

// ---------- 凭据读写（仅对页面暴露 API Key；坚果云凭据留在主进程内部） ----------

/**
 * 页面侧只允许读写 apiKey。坚果云账号密码由账号设置窗口直接调 setSecret，
 * 不经过这个通道——这样即使渲染层被注入，也拿不到网盘凭据。
 */
const RENDERER_SECRET_ALLOWLIST = new Set(['apiKey'])

ipcMain.handle('secret:get', (_event, name) => {
  if (!RENDERER_SECRET_ALLOWLIST.has(name)) throw new Error(`不允许读取该凭据：${name}`)
  return getSecret(name)
})
ipcMain.handle('secret:set', async (_event, name, value) => {
  if (!RENDERER_SECRET_ALLOWLIST.has(name)) throw new Error(`不允许写入该凭据：${name}`)
  await setSecret(name, value)
  return true
})

// ---------- 账号设置窗口 ----------

ipcMain.handle('settings:load', async () => {
  const prefs = readPrefs()
  return {
    user: (await getSecret('jianGuoYunUser')) ?? '',
    hasPass: Boolean(await getSecret('jianGuoYunPass')),
    canEncrypt: canEncrypt(),
    zoomFactor: normalizeZoom(prefs.zoomFactor),
  }
})

ipcMain.handle('settings:save', async (_event, { user, pass, zoomFactor }) => {
  if (typeof user === 'string' && user.trim()) await setSecret('jianGuoYunUser', user.trim())
  if (typeof pass === 'string' && pass.trim()) await setSecret('jianGuoYunPass', pass.trim())
  if (typeof zoomFactor === 'number') {
    const zoom = normalizeZoom(zoomFactor)
    writePrefs({ ...readPrefs(), zoomFactor: zoom })
    if (win && !win.isDestroyed()) win.webContents.setZoomFactor(zoom)
  }
  return true
})

const openSettings = () => {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus()
    return
  }
  settingsWin = new BrowserWindow({
    width: 520,
    height: 380,
    resizable: false,
    title: '设置',
    parent: win,
    modal: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'settings-preload.cjs'),
    },
  })
  settingsWin.setMenu(null)
  settingsWin.loadFile(SETTINGS_HTML)
  settingsWin.on('closed', () => {
    settingsWin = null
  })
}

const sendCommand = (cmd) => {
  if (win && !win.isDestroyed()) win.webContents.send('sync:command', cmd)
}

/** 同步前检查是否已配置坚果云账号，未配置时提示去设置里填写。 */
const requireAccount = async () => {
  const user = await getSecret('jianGuoYunUser')
  const pass = await getSecret('jianGuoYunPass')
  if (user && pass) return true
  dialog.showMessageBoxSync(win, {
    type: 'warning',
    title: '对话同步',
    message: '还没有配置坚果云账号。\n请打开聊天窗口的 设置 → 数据管理，填写邮箱和应用密码。',
    buttons: ['好'],
  })
  return false
}

ipcMain.handle('zoom:get', () => normalizeZoom(readPrefs().zoomFactor))
ipcMain.handle('zoom:set', (_event, value) => {
  const zoom = normalizeZoom(value)
  writePrefs({ ...readPrefs(), zoomFactor: zoom })
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(zoom)
  return zoom
})

ipcMain.handle('sync:account:get', async () => ({
  user: (await getSecret('jianGuoYunUser')) ?? '',
  hasPass: Boolean(await getSecret('jianGuoYunPass')),
}))

ipcMain.handle('sync:account:set', async (_event, { user, pass }) => {
  if (typeof user === 'string' && user.trim()) await setSecret('jianGuoYunUser', user.trim())
  if (typeof pass === 'string' && pass.trim()) await setSecret('jianGuoYunPass', pass.trim())
  return true
})

/** 查询 DeepSeek 账户余额（GET /user/balance，免费接口）。 */
ipcMain.handle('balance:get', async () => {
  const key = await getSecret('apiKey')
  if (!key) return { ok: false, error: '还没有设置 API Key' }
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const data = await res.json()
    const info = Array.isArray(data.balance_infos) ? data.balance_infos[0] : null
    if (!info) return { ok: false, error: '接口没有返回余额信息' }
    return {
      ok: true,
      total: info.total_balance,
      currency: info.currency,
      available: Boolean(data.is_available),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

const queryBalance = async () => {
  try {
    const key = await getSecret('apiKey')
    if (!key) throw new Error('还没有设置 API Key（设置 → 数据管理里填写）')
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}（Key 可能无效）`)
    const data = await res.json()
    const info = Array.isArray(data.balance_infos) ? data.balance_infos[0] : null
    if (!info) throw new Error('接口没有返回余额信息')
    dialog.showMessageBoxSync(win, {
      type: 'info',
      title: '账户余额',
      message: [
        `可用余额：${info.total_balance} ${info.currency}`,
        `充值余额：${info.topped_up_balance}`,
        `赠送余额：${info.granted_balance}`,
        '',
        data.is_available ? '状态：可正常调用' : '状态：余额不足',
      ].join('\n'),
      buttons: ['好'],
    })
  } catch (error) {
    dialog.showMessageBoxSync(win, {
      type: 'error',
      title: '查询余额失败',
      message: error instanceof Error ? error.message : String(error),
      buttons: ['好'],
    })
  }
}

const buildMenu = () =>
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '对话同步',
        submenu: [
          {
            label: '上传到坚果云',
            click: async () => {
              if (await requireAccount()) sendCommand('upload')
            },
          },
          {
            label: '从坚果云导入',
            click: async () => {
              if (await requireAccount()) sendCommand('import')
            },
          },
        ],
      },
      { label: '余额', click: () => void queryBalance() },
    ])
  )

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

app.whenReady().then(async () => {
  try {
    await migrateLegacyConfig()
  } catch (e) {
    logError(`migrate error: ${e && e.stack ? e.stack : e}`)
  }
  try {
    win = new BrowserWindow({
      width: 1180,
      height: 820,
      title: 'ChatDesktop',
      // 任务栏 / 标题栏图标：build/icon.ico 由生成脚本产出（16~256 六档）
      icon: path.join(__dirname, 'build', 'icon.ico'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'preload.cjs'),
      },
    })
    buildMenu()
    // 前端资源缺失时 loadFile 会 reject。必须接住并提示，
    // 否则用户只会看到一个空白窗口，完全不知道发生了什么。
    await win.loadFile(DIST_INDEX).catch((e) => {
      logError(`loadFile failed: ${e && e.stack ? e.stack : e}`)
      dialog.showErrorBox(
        'ChatDesktop 启动失败',
        `无法加载界面文件：\n${DIST_INDEX}\n\n请重新安装；若仍失败，把下面的日志发给开发者：\n${ERROR_LOG}`
      )
    })
    win.webContents.setZoomFactor(normalizeZoom(readPrefs().zoomFactor))
  } catch (e) {
    logError(`window error: ${e && e.stack ? e.stack : e}`)
    dialog.showErrorBox(
      'ChatDesktop 启动失败',
      `${e && e.message ? e.message : e}\n\n日志：${ERROR_LOG}`
    )
  }
})

app.on('window-all-closed', () => app.quit())
