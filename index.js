/**
 * dsh-cost-workbench · Host 半边（造价工作台）
 *
 * 把工作台要的数据变成同源 HTTP JSON（`/api/dsh-workbench/*`）；浏览器端只渲染与交互。
 *
 * 唯一事实源是 Obsidian vault 里的 md 笔记：
 *   · 资料库卡直接列/读/写 `00 资料库` 下的笔记，Obsidian 里改完保存，工作台下一次取数就是新内容；
 *   · 术语表落在 `Workbench/术语表.md`，计价依据/材料价格/变更签证三张表落在 `Workbench/` 下；
 *   · cards.json / prompts.json 留在本机工作区（不是笔记，不该进 vault）。
 *
 * 路由族（全部 loopback-only，失败形状统一 {ok:false, code, message}）：
 *   GET  /overview            卡片聚合状态（单卡异常写进自己的 error，不影响别的卡）
 *   GET  /cards               卡片清单（读 cards.json，坏则内置卡 + warning）
 *   GET  /prompts             prompt 模板
 *   GET  /sop[?q=|?note=]     笔记列表 / 全文搜索 / 单篇正文（含 sha1，供写回比对）
 *   POST /sop/refresh         清发现缓存重新列
 *   PUT  /sop/note            写回单篇（带 expectedSha1 冲突检查）
 *   POST /sop/note            新建笔记（同名拒绝）
 *   GET  /glossary?q=         术语条目（CRUD 同 /standards、/prices、/changes）
 *   GET  /standards|/prices|/changes          造价三张表
 *   POST /<table>、PUT/DELETE /<table>/:id    三张表的增改删
 *   GET  /usage               用量角标（DeepSeek 余额 + 火山资源包）
 */
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { readCards } from './lib/cards.js'
import { readPrompts } from './lib/prompts.js'
import {
  addGlossaryEntry as addGlossary,
  deleteGlossaryEntry as deleteGlossary,
  readGlossary,
  updateGlossaryEntry as updateGlossary,
} from './lib/glossary.js'
import { createCostTables, COST_TABLE_KINDS, entryMatches } from './lib/tables.js'
import { createVaultStore } from './lib/vault.js'
import { createRecordingStore } from './lib/recordings.js'
import { createAsrBridge } from './lib/volc-asr.js'
import { transcribeWithIflyrec } from './lib/iflyrec.js'
import { createUsageReader } from './lib/usage.js'

/** 硬依赖：没有 web 服务器就没有路由可注册（非 Web 组合下本插件保持未激活，符合预期）。 */
export const inject = ['webServer']

const API_PREFIX = '/api/dsh-workbench'
const USER_CONFIG_FILE = join(homedir(), '.dsh-workbench', 'config.json')

/** 同步读用户配置：apply 阶段就要定下路径，不能等异步。 */
function loadUserConfigSync(file = USER_CONFIG_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 用户配置文件路径：profile 配置可覆盖（测试用它隔离真实配置文件）。 */
function resolveUserConfigFile(config) {
  const raw = config !== null && typeof config === 'object' && typeof config.userConfigFile === 'string'
    ? config.userConfigFile.trim()
    : ''
  return raw !== '' ? raw : USER_CONFIG_FILE
}

/** 读用户配置（首次引导写入的那份）；读不到就当没配。 */
async function readUserConfig() {
  try {
    const text = await readFile(USER_CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
const MAX_BODY_BYTES = 1024 * 1024

const DEFAULT_CONFIG = {
  // 全部留空或取中性值：安装后由首次引导写入 ~/.dsh-workbench/config.json
  vaultRoot: '',
  sopDir: '00 资料库',
  workbenchDir: 'Workbench',
  dataDir: '',
  cardsFile: '',
  promptsFile: '',
  glossaryFile: '',
  recordingsDir: '会议记录',
  asrConfigFile: '',
  // 用户配置文件（首次引导写入）；默认 ~/.dsh-workbench/config.json，测试可覆盖
  userConfigFile: '',
  // 留空 = 按平台自动选择（Windows: cmd /c start、macOS: open、Linux: xdg-open）
  openCommand: '',
  // 文件夹选择器命令；留空 = 按平台自动（Windows: PowerShell FolderBrowserDialog）
  folderPickerCommand: '',
}

function resolveConfig(config, configFile = null) {
  const merged = { ...DEFAULT_CONFIG }
  if (config !== null && typeof config === 'object') {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (typeof config[key] === 'string') merged[key] = config[key]
    }
  }
  for (const key of Object.keys(merged)) {
    if (typeof merged[key] === 'string') merged[key] = merged[key].trim()
  }
  // 用户配置文件的优先级介于「默认值」与「profile 配置」之间
  if (configFile !== null && typeof configFile === 'object') {
    for (const key of ['vaultRoot', 'dataDir', 'sopDir', 'workbenchDir', 'recordingsDir']) {
      const value = typeof configFile[key] === 'string' ? configFile[key].trim() : ''
      if (value !== '' && (merged[key] === '' || merged[key] === DEFAULT_CONFIG[key] || key === 'vaultRoot')) merged[key] = value
    }
  }
  if (merged.dataDir === '') merged.dataDir = join(homedir(), '.dsh-workbench')
  if (merged.userConfigFile === '') merged.userConfigFile = USER_CONFIG_FILE
  if (merged.cardsFile === '') merged.cardsFile = join(merged.dataDir, 'cards.json')
  if (merged.promptsFile === '') merged.promptsFile = join(merged.dataDir, 'prompts.json')
  if (merged.glossaryFile === '') merged.glossaryFile = join(merged.vaultRoot, merged.workbenchDir, '术语表.md')
  if (merged.asrConfigFile === '') merged.asrConfigFile = join(merged.dataDir, 'asr.json')
  return merged
}

/** Loopback 围栏：只服务本机浏览器（判据与 DSH 内置 Web 路由一致）。 */
function isLoopbackRequest(req) {
  const address = req.socket === undefined ? undefined : req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  const name = hostUrl.hostname
  if (name !== '127.0.0.1' && name !== 'localhost' && name !== '[::1]') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

function writeError(res, status, code, message) {
  writeJson(res, status, { ok: false, code, message })
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 用系统默认程序打开一个 URI / 网页。
 * Windows 没有 `/usr/bin/open`：走 `cmd /c start "" <target>`；macOS 用 open，Linux 用 xdg-open。
 * openCommand 配了值就优先用配置的命令（跨平台自定义时用）。
 */
function openExternal(command, target) {
  const custom = typeof command === 'string' ? command.trim() : ''
  return new Promise((resolve, reject) => {
    const done = (error) => {
      if (error !== null) reject(Object.assign(new Error('打开失败：' + describe(error)), { code: 'open_failed' }))
      else resolve()
    }
    try {
      if (custom !== '') {
        execFile(custom, [target], { timeout: 5000, windowsHide: true }, done)
        return
      }
      if (process.platform === 'win32') {
        execFile('cmd', ['/c', 'start', '', target], { timeout: 5000, windowsHide: true }, done)
        return
      }
      execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { timeout: 5000 }, done)
    } catch (error) {
      // 某些受限环境里 execFile 会同步抛（如 EPERM）；统一成 open_failed 交给上层。
      done(error)
    }
  })
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('请求体过大'), { code: 'too_large' })
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'bad_json' })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('请求体必须是 JSON 对象'), { code: 'bad_json' })
  }
  return parsed
}

/**
 * 术语表 / 句式库共用的 CRUD 路由。
 * api = { read, add, update, remove, keys }，形状与 lib/table.js 导出的函数一致。
 */
async function handleEntryTable({ req, res, url, method, route, base, file, api }) {
  if (route === base) {
    if (method === 'GET') {
      const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const current = await api.read(file)
      const entries = query === ''
        ? current.entries
        : current.entries.filter((entry) => api.keys.some((key) => String(entry[key] ?? '').toLowerCase().includes(query)))
      return writeJson(res, 200, {
        ok: true,
        entries,
        total: current.entries.length,
        exists: current.exists,
        warning: current.warning,
        file,
      })
    }
    if (method === 'POST') {
      const body = await readJsonBody(req)
      const result = await api.add(file, body)
      if (result.ok !== true) return writeError(res, 400, result.code ?? 'invalid_entry', result.error)
      return writeJson(res, 200, { ok: true, entry: result.entry, total: result.entries.length })
    }
    return writeError(res, 405, 'method_not_allowed', 'GET or POST')
  }

  const match = new RegExp('^' + base + '/([A-Za-z0-9]+)$').exec(route)
  if (match === null) return writeError(res, 404, 'not_found', route)
  const id = match[1]
  if (method === 'PUT') {
    const body = await readJsonBody(req)
    const result = await api.update(file, id, body)
    if (result.ok !== true) {
      const status = result.code === 'not_found' ? 404 : 400
      return writeError(res, status, result.code ?? 'invalid_entry', result.error)
    }
    return writeJson(res, 200, { ok: true, entry: result.entry, total: result.entries.length })
  }
  if (method === 'DELETE') {
    const result = await api.remove(file, id)
    if (result.ok !== true) {
      const status = result.code === 'not_found' ? 404 : 400
      return writeError(res, status, result.code ?? 'delete_failed', result.error)
    }
    return writeJson(res, 200, { ok: true, total: result.entries.length })
  }
  return writeError(res, 405, 'method_not_allowed', 'PUT or DELETE')
}

/**
 * 弹系统文件夹选择框，返回用户选中的绝对路径（取消则返回空串）。
 * Windows 走 PowerShell 5.1 的 FolderBrowserDialog（需要 STA）；
 * macOS 走 osascript choose folder；Linux 走 zenity。folderPickerCommand 配了值就优先用配置的命令。
 */
function pickFolder(command, timeoutMs = 300000) {
  const custom = typeof command === 'string' ? command.trim() : ''
  // 用临时文件回传结果：PowerShell 5.1 的 stdout 是控制台代码页（GBK），
  // 直接按 UTF-8 解码会把中文路径变成乱码；写 UTF-8 文件再读，跟控制台编码无关。
  const outFile = join(tmpdir(), 'dsh-cost-workbench-pick-' + randomUUID() + '.txt')
  const WIN_SCRIPT = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = '选择造价工作台的 Obsidian 库目录'",
    '$d.ShowNewFolderButton = $true',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [System.IO.File]::WriteAllText($env:DSH_PICK_OUT, $d.SelectedPath, (New-Object System.Text.UTF8Encoding($false))) }',
  ].join('; ')
  return new Promise((resolve, reject) => {
    const options = { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, DSH_PICK_OUT: outFile } }
    const finish = async (error, stdout) => {
      let picked = ''
      try {
        picked = String(await readFile(outFile, 'utf8')).trim()
      } catch {
        picked = ''
      }
      try {
        await rm(outFile, { force: true })
      } catch {
        // 临时文件可能根本没创建
      }
      if (picked !== '') {
        resolve(picked)
        return
      }
      if (error !== null && error !== undefined) {
        reject(Object.assign(new Error('打开文件夹选择器失败：' + describe(error)), { code: 'picker_failed' }))
        return
      }
      // 自定义命令没写临时文件时，退回 stdout（编码由该命令自己负责）
      const lines = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
      resolve(lines.length === 0 ? '' : lines[lines.length - 1])
    }
    try {
      if (custom !== '') {
        execFile(custom, [], options, (error, stdout) => { void finish(error, stdout) })
        return
      }
      if (process.platform === 'win32') {
        execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', WIN_SCRIPT], options, (error, stdout) => { void finish(error, stdout) })
        return
      }
      if (process.platform === 'darwin') {
        execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择造价工作台的 Obsidian 库目录")'], options, (error, stdout) => { void finish(error, stdout) })
        return
      }
      execFile('zenity', ['--file-selection', '--directory', '--title=选择造价工作台的 Obsidian 库目录'], options, (error, stdout) => { void finish(error, stdout) })
    } catch (error) {
      void finish(error, '')
    }
  })
}

/** 绝对路径判断：POSIX、Windows 盘符、Windows UNC。 */
function isAbsolutePath(value) {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/** 读 asr.json（凭据文件）；读不到当空对象。只在 Host 内使用，绝不返回明文。 */
async function readAsrSettings(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 凭据状态：只告诉界面"配没配"，不吐任何密钥。 */
function credentialStatus(asr) {
  const volc = asr !== null && typeof asr === 'object' && asr.volcengine !== null && typeof asr.volcengine === 'object' ? asr.volcengine : {}
  const deepseek = asr !== null && typeof asr === 'object' && asr.deepseek !== null && typeof asr.deepseek === 'object' ? asr.deepseek : {}
  const present = (value) => typeof value === 'string' && value.trim() !== ''
  return {
    volcengine: {
      apiKey: present(volc.apiKey),
      accessKey: present(volc.accessKey),
      secretKey: present(volc.secretKey),
      resourceIdStreaming: typeof volc.resourceIdStreaming === 'string' ? volc.resourceIdStreaming : '',
      boostingTableId: present(volc.boostingTableId),
    },
    deepseek: { apiKey: present(deepseek.apiKey) },
  }
}

/** 读原始字节体（音频分片用），超过上限直接拒绝。 */
async function readRawBody(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error('音频分片过大'), { code: 'too_large' })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * 按 Range 输出音频。一定要支持 Range：否则拖进度条会从头下载整段，
 * 一小时的录音就是 115MB。
 */
async function serveAudio(req, res, filePath) {
  let info
  try {
    info = await stat(filePath)
  } catch {
    writeError(res, 404, 'not_found', '录音不存在')
    return
  }
  const total = info.size
  const range = req.headers.range
  const base = {
    'content-type': 'audio/wav',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }
  if (typeof range === 'string') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match !== null) {
      let start = match[1] === '' ? null : Number(match[1])
      let end = match[2] === '' ? null : Number(match[2])
      if (start === null && end !== null) {
        start = Math.max(0, total - end)
        end = total - 1
      }
      if (start !== null && end === null) end = total - 1
      if (start !== null && end !== null && start <= end && start < total) {
        end = Math.min(end, total - 1)
        res.writeHead(206, {
          ...base,
          'content-range': `bytes ${start}-${end}/${total}`,
          'content-length': String(end - start + 1),
        })
        createReadStream(filePath, { start, end }).pipe(res)
        return
      }
      res.writeHead(416, { ...base, 'content-range': `bytes */${total}` })
      res.end()
      return
    }
  }
  res.writeHead(200, { ...base, 'content-length': String(total) })
  createReadStream(filePath).pipe(res)
}

/** 路径存在性探测：缺文件是"卡片自己报错"的事，不抛。 */

export function apply(ctx, config) {
  let settings = resolveConfig(config, loadUserConfigSync(resolveUserConfigFile(config)))
  let vault = createVaultStore({
    vaultRoot: settings.vaultRoot,
    sopDir: settings.sopDir,
    backupDir: join(settings.vaultRoot, settings.workbenchDir, '.backups'),
  })
  let costTables = createCostTables({ workbenchDir: join(settings.vaultRoot, settings.workbenchDir) })
  let recordings = createRecordingStore({ root: join(settings.vaultRoot, settings.recordingsDir) })

  /** 给界面用的配置状态。 */
  function configStatus() {
    return {
      configured: settings.vaultRoot !== '',
      vaultRoot: settings.vaultRoot,
      sopDir: settings.sopDir,
      workbenchDir: settings.workbenchDir,
      recordingsDir: settings.recordingsDir,
      dataDir: settings.dataDir,
      configFile: settings.userConfigFile,
    }
  }

  /** 保存配置后立即重建依赖路径的部件，用户不用重启。 */
  function rebuild() {
    settings = resolveConfig(config, loadUserConfigSync(resolveUserConfigFile(config)))
    vault = createVaultStore({
      vaultRoot: settings.vaultRoot,
      sopDir: settings.sopDir,
      backupDir: join(settings.vaultRoot, settings.workbenchDir, '.backups'),
    })
    costTables = createCostTables({ workbenchDir: join(settings.vaultRoot, settings.workbenchDir) })
    recordings = createRecordingStore({ root: join(settings.vaultRoot, settings.recordingsDir) })
  }
  /** ASR 会话的事件订阅者：sessionId → SSE 响应对象。 */
  const asrSubscribers = new Map()
  /** 每个 ASR 会话的最终结果，收尾时用来落盘转写稿。 */
  const asrResults = new Map()
  /** 用量角标：DeepSeek 余额 + 火山资源包剩余（Host 侧缓存 5 分钟）。 */
  const usageReader = createUsageReader({ getConfigFile: () => settings.asrConfigFile })

  const asrBridge = createAsrBridge({
    getConfigFile: () => settings.asrConfigFile,
    onEvent: (id, event) => {
      if (event.type === 'final' || event.type === 'error') {
        const waiter = asrWaiters.get(id)
        if (waiter !== undefined) {
          asrWaiters.delete(id)
          if (event.type === 'final') waiter.resolve(event)
          else waiter.reject(new Error(event.message ?? '转写失败'))
        }
      }
      if (event.type === 'final') {
        asrResults.set(id, event)
        const recordingId = asrRecording.get(id)
        const offsetMs = asrOffset.get(id) ?? 0
        if (typeof recordingId === 'string') {
          void writeTranscript(recordingId, event, '火山豆包流式 2.0', { offsetMs, append: offsetMs > 0 }).catch(() => {})
        }
        asrOffset.delete(id)
      }
      const subscriber = asrSubscribers.get(id)
      if (subscriber === undefined) return
      try {
        subscriber.write('data: ' + JSON.stringify(event) + '\n\n')
      } catch {
        // 客户端已经断开。
      }
      if (event.type === 'final' || event.type === 'error') {
        try {
          subscriber.end()
        } catch {
          // 同上。
        }
        asrSubscribers.delete(id)
        asrRecording.delete(id)
        asrBridge.cancel(id)
      }
    },
  })
  /** ASR 会话 → 录音 id，定稿时据此把 转写.md 写到对应文件夹。 */
  const asrRecording = new Map()
  /** ASR 会话 → 该段音频在整条录音里的起点（毫秒），续写时用来接时间戳。 */
  const asrOffset = new Map()
  /** 服务端发起的转写：sessionId → {resolve, reject}，等定稿用。 */
  const asrWaiters = new Map()

  function formatClock(ms) {
    const total = Math.max(0, Math.round((ms ?? 0) / 1000))
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0')
  }

  /**
   * 用已落盘的 audio.wav 转写（导入、或事后补转）。
   * 节奏 ~30ms 一包（200ms 音频），比实时快几倍，又不至于把服务端灌爆。
   */
  async function transcribeRecordingFile(recordingId) {
    const wav = await readFile(recordings.audioPath(recordingId))
    if (wav.length <= 44) throw Object.assign(new Error('这条录音还没有音频数据'), { code: 'empty_audio' })
    const pcm = wav.subarray(44)
    const sessionId = await asrBridge.start()
    let waiterTimer = null
    const finalPromise = new Promise((resolve, reject) => {
      asrWaiters.set(sessionId, { resolve, reject })
      waiterTimer = setTimeout(() => {
        if (asrWaiters.delete(sessionId)) reject(new Error('转写超时'))
      }, 10 * 60 * 1000)
      if (typeof waiterTimer?.unref === 'function') waiterTimer.unref()
    })
    asrRecording.set(sessionId, recordingId)
    try {
      for (let offset = 0; offset < pcm.length; offset += 3200) {
        asrBridge.push(sessionId, pcm.subarray(offset, offset + 3200))
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      asrBridge.finish(sessionId)
      const result = await finalPromise
      await writeTranscript(recordingId, result)
      return result
    } finally {
      asrWaiters.delete(sessionId)
      if (waiterTimer !== null) clearTimeout(waiterTimer)
    }
  }

  /** 读 asr.json 里的听见 MCP 配置（只在 Host 内部用）。 */
  async function readIflyrecConfig() {
    const parsed = JSON.parse(await readFile(settings.asrConfigFile, 'utf8'))
    const mcp = parsed?.iflyrecMcp
    const endpoint = typeof mcp?.endpoint === 'string' && mcp.endpoint !== '' ? mcp.endpoint : 'http://127.0.0.1:3000/sse'
    const apiKey = typeof mcp?.apiKey === 'string' ? mcp.apiKey : ''
    if (apiKey === '') throw Object.assign(new Error('asr.json 里没有听见的 apiKey'), { code: 'no_iflyrec_key' })
    return { endpoint, apiKey }
  }

  /** 用听见转写已落盘的一条录音。 */
  async function transcribeWithIflyrecFile(recordingId) {
    const config = await readIflyrecConfig()
    const result = await transcribeWithIflyrec({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      filePath: recordings.audioPath(recordingId),
    })
    await writeTranscript(recordingId, result, '讯飞听见（本机 MCP）')
    // 听见会把结果文件写进录音目录，留着只会让文件夹变乱。
    await recordings.cleanForeignArtifacts(recordingId)
    return result
  }

  /** 转写稿落盘：带 frontmatter 与时间戳行，Obsidian 里直接可读。 */
  async function writeTranscript(recordingId, result, engineLabel = '火山豆包流式 2.0', options = {}) {
    const offsetMs = Number.isFinite(options.offsetMs) ? options.offsetMs : 0
    const utterances = Array.isArray(result.utterances) && result.utterances.length > 0
      ? result.utterances
      : [{ text: result.text, start: 0, end: 0 }]
    const lines = utterances
      .filter((utterance) => String(utterance.text ?? '').trim() !== '')
      .map((utterance) => '- **[' + formatClock((Number(utterance.start) || 0) + offsetMs) + ']** ' + String(utterance.text).trim())
    if (lines.length === 0) return

    // 静音切段后的续写：只追加句子、刷新时间，不重写整篇。
    if (options.append === true) {
      const existing = await recordings.readTranscript(recordingId)
      if (existing !== null && existing.includes('\n# 转写稿')) {
        const refreshed = existing
          .replace(/转写时间:.*/, '转写时间: ' + new Date().toISOString())
          .replace(/\n$/, '')
        await recordings.writeTranscript(recordingId, refreshed + '\n' + lines.join('\n') + '\n')
        return
      }
    }

    const markdown = [
      '---',
      '录音: ' + recordingId,
      '转写引擎: ' + engineLabel,
      '转写时间: ' + new Date().toISOString(),
      '---',
      '',
      '# 转写稿',
      '',
      ...lines,
      '',
    ].join('\n')
    await recordings.writeTranscript(recordingId, markdown)
  }

  async function sopListing(query) {
    const found = await vault.discover()
    const matches = query === '' ? [] : await vault.search(query)
    const tree = query === '' ? await vault.tree() : null
    return {
      ok: true,
      source: found.source,
      tree,
      vaultRoot: settings.vaultRoot,
      vaultName: basename(settings.vaultRoot),
      sopDir: settings.sopDir,
      notes: found.notes,
      matches,
      stats: {
        count: found.notes.length,
        chars: found.notes.reduce((total, note) => total + note.chars, 0),
        lastTouched: found.notes.reduce((latest, note) => Math.max(latest, note.mtimeMs), 0),
        source: found.source,
      },
    }
  }

  /** 全局搜索：笔记正文 + 术语表 + 造价三张表 + 录音，混排并标注来源。 */
  async function globalSearch(rawQuery) {
    const query = String(rawQuery ?? '').trim()
    if (query === '') return { ok: true, query: '', hits: [], counts: { sop: 0, glossary: 0, recording: 0, standards: 0, prices: 0, changes: 0 } }
    const lower = query.toLowerCase()
    const hits = []
    const counts = { sop: 0, glossary: 0, recording: 0, standards: 0, prices: 0, changes: 0 }

    for (const hit of await vault.search(query, { limit: 40 })) {
      hits.push({ source: 'sop', path: hit.path, title: hit.title, group: hit.group, line: hit.line, snippet: hit.snippet })
      counts.sop += 1
    }

    const glossary = await readGlossary(settings.glossaryFile)
    for (const entry of glossary.entries) {
      if (![entry.zh, entry.en, entry.field, entry.note].some((cell) => String(cell).toLowerCase().includes(lower))) continue
      hits.push({
        source: 'glossary',
        id: entry.id,
        title: entry.zh !== '' ? entry.zh : entry.en,
        detail: [entry.en, entry.field, entry.note].filter((part) => part !== '').join(' · '),
      })
      counts.glossary += 1
    }

    // 录音：转写稿逐行 + 批注正文
    try {
      const items = await recordings.list()
      for (const item of items.slice(0, 300)) {
        let text = null
        try {
          text = await recordings.readTranscript(item.id)
        } catch {
          text = null
        }
        if (typeof text === 'string') {
          const lines = text.split('\n')
          for (let index = 0; index < lines.length; index += 1) {
            if (!lines[index].toLowerCase().includes(lower)) continue
            const stamp = /^-\s+\*\*\[(\d{2}):(\d{2})\]\*\*\s*(.*)$/.exec(lines[index].trim())
            hits.push({
              source: 'recording',
              path: item.id,
              title: item.title,
              date: (/^(\d{4}-\d{2}-\d{2})/.exec(item.id) ?? [])[1] ?? new Date(item.createdAt).toISOString().slice(0, 10),
              line: index,
              time: stamp === null ? null : Number(stamp[1]) * 60 + Number(stamp[2]),
              snippet: (stamp === null ? lines[index].trim() : stamp[3]).slice(0, 220),
            })
            counts.recording += 1
            if (hits.length > 150) break
          }
        }
        try {
          for (const annotation of await recordings.readAnnotations(item.id)) {
            const haystack = (annotation.quote + ' ' + annotation.note).toLowerCase()
            if (!haystack.includes(lower)) continue
            hits.push({
              source: 'recording',
              path: item.id,
              title: item.title,
              date: (/^(\d{4}-\d{2}-\d{2})/.exec(item.id) ?? [])[1] ?? new Date(item.createdAt).toISOString().slice(0, 10),
              time: annotation.time ?? null,
              note: annotation.note,
              snippet: '批注：' + (annotation.note !== '' ? annotation.note : annotation.quote),
            })
            counts.recording += 1
          }
        } catch {
          // 单条录音的批注读不了不影响整次搜索。
        }
      }
    } catch {
      // 录音目录读不了不影响其它来源。
    }

    // 造价三张表：计价依据 / 材料价格 / 变更签证（落盘在 Workbench/ 下的 md）
    for (const kind of COST_TABLE_KINDS) {
      const table = costTables[kind]
      if (table === undefined) continue
      try {
        const current = await table.api.read(table.file)
        for (const entry of current.entries) {
          if (!entryMatches(entry, table.keys, lower)) continue
          if (hits.length > 150) break
          const title = [entry.name, entry.code, entry.project, entry.reason, entry.quote]
            .find((part) => typeof part === 'string' && part.trim() !== '') ?? kind
          const detail = [entry.category, entry.spec, entry.unit, entry.region, entry.version, entry.status, entry.note, entry.source]
            .filter((part) => typeof part === 'string' && part.trim() !== '')
            .join(' · ')
          hits.push({ source: kind, id: entry.id, title, detail })
          counts[kind] += 1
        }
      } catch {
        // 单张表读不了不影响其它来源。
      }
    }

    return { ok: true, query, hits, counts }
  }

  /** 卡片摘要：每个 kind 一个，异常只写进该卡片的 error。 */
  async function cardSummary(card) {
    switch (card.kind) {
      case 'sop': {
        const found = await vault.discover()
        return {
          status: 'ready',
          stats: {
            count: found.notes.length,
            chars: found.notes.reduce((total, note) => total + note.chars, 0),
            source: found.source,
            lastTouched: found.notes.reduce((latest, note) => Math.max(latest, note.mtimeMs), 0),
          },
          warning: found.source === 'spotlight' ? '目录枚举被系统挡住，笔记列表走 Spotlight' : undefined,
        }
      }
      case 'standards':
      case 'prices':
      case 'changes': {
        const table = costTables[card.kind]
        if (table === undefined) {
          return { status: 'error', error: { code: 'no_table', message: '没有这张表：' + card.kind } }
        }
        const current = await table.api.read(table.file)
        return {
          status: 'ready',
          stats: { count: current.entries.length, exists: current.exists },
          warning: current.warning,
        }
      }
      case 'glossary': {
        const current = await readGlossary(settings.glossaryFile)
        return {
          status: 'ready',
          stats: { count: current.entries.length, exists: current.exists },
          warning: current.warning,
        }
      }
      case 'prompt': {
        const prompts = await readPrompts(settings.promptsFile)
        const promptId = card.promptId ?? card.id
        const prompt = prompts.prompts[promptId]
        return prompt === undefined
          ? { status: 'error', error: { code: 'missing_prompt', message: 'prompts.json 里没有 ' + promptId } }
          : { status: 'ready', prompt: { promptId, title: prompt.title } }
      }
      default:
        // 录音 / 搜索 / 查找 / 提示词 / 计算器这几类由界面自己渲染，服务端没有可汇总的东西
        if (['recorder', 'search', 'find', 'prompt', 'calc'].includes(card.kind)) return { status: 'ready' }
        return { status: 'unsupported', hint: '暂不支持这个卡片类型：' + card.kind }
    }
  }

  async function buildOverview() {
    const cardsResult = await readCards(settings.cardsFile)
    const warnings = []
    if (cardsResult.warning !== undefined) warnings.push(cardsResult.warning)

    const cards = []
    for (const card of cardsResult.cards) {
      try {
        cards.push({ ...card, ...(await cardSummary(card)) })
      } catch (error) {
        cards.push({ ...card, status: 'error', error: { code: 'card_failed', message: describe(error) } })
      }
    }

    const vaultName = basename(settings.vaultRoot)
    return {
      ok: true,
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      source: cardsResult.source,
      warnings,
      vault: { root: settings.vaultRoot, sopDir: settings.sopDir, workbenchDir: settings.workbenchDir, name: vaultName },
      dataDir: settings.dataDir,
      cards,
    }
  }

  const handler = async (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeError(res, 403, 'forbidden', 'loopback-only')
      return
    }
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      writeError(res, 400, 'bad_request', 'invalid url')
      return
    }
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    const method = req.method ?? 'GET'

    try {
      /* ---------------------------------------------------------- 首次配置 */
      if (route === '/config') {
        if (method === 'GET') return writeJson(res, 200, { ok: true, ...configStatus() })
        if (method === 'PUT') {
          const body = await readJsonBody(req)
          const vaultRoot = typeof body.vaultRoot === 'string' ? body.vaultRoot.trim() : ''
          if (vaultRoot === '') return writeError(res, 400, 'bad_request', '请填写笔记文件夹的绝对路径')
          // 绝对路径的三种写法：POSIX（/…）、Windows 盘符（D:\… 或 D:/…）、Windows UNC（\\服务器\共享）
          const isAbsolute = isAbsolutePath(vaultRoot)
          if (!isAbsolute) return writeError(res, 400, 'bad_request', '请填写绝对路径：macOS 以 / 开头，Windows 形如 D:\\文件夹')
          const next = {
            vaultRoot,
            sopDir: typeof body.sopDir === 'string' && body.sopDir.trim() !== '' ? body.sopDir.trim() : '00 资料库',
            workbenchDir: typeof body.workbenchDir === 'string' && body.workbenchDir.trim() !== '' ? body.workbenchDir.trim() : 'Workbench',
            recordingsDir: typeof body.recordingsDir === 'string' && body.recordingsDir.trim() !== '' ? body.recordingsDir.trim() : '会议记录',
            dataDir: typeof body.dataDir === 'string' && body.dataDir.trim() !== '' ? body.dataDir.trim() : '',
          }
          await mkdir(dirname(settings.userConfigFile), { recursive: true })
          // 把该有的目录先建出来：用户不需要自己去 Finder 里新建
          for (const dir of [next.sopDir, next.workbenchDir, next.recordingsDir]) {
            try {
              await mkdir(join(vaultRoot, dir), { recursive: true })
            } catch {
              // 建不了（权限）不影响保存，界面会提示读不到
            }
          }
          await writeFile(settings.userConfigFile, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
          rebuild()
          return writeJson(res, 200, { ok: true, ...configStatus() })
        }
        return writeError(res, 405, 'method_not_allowed', 'GET or PUT')
      }

      /* ------------------------------------------------------ 语音凭据 */
      // 只告诉界面配置状态；明文只在 Host 内部用于调用语音服务，永不回传。
      if (route === '/credentials') {
        if (method === 'GET') {
          return writeJson(res, 200, { ok: true, ...credentialStatus(await readAsrSettings(settings.asrConfigFile)) })
        }
        if (method === 'PUT') {
          const body = await readJsonBody(req)
          const current = await readAsrSettings(settings.asrConfigFile)
          const next = { ...current }
          const volc = { ...(current.volcengine !== null && typeof current.volcengine === 'object' ? current.volcengine : {}) }
          const deepseek = { ...(current.deepseek !== null && typeof current.deepseek === 'object' ? current.deepseek : {}) }
          const setIf = (target, key, value) => {
            if (typeof value === 'string' && value.trim() !== '') target[key] = value.trim()
          }
          if (body.volcengine !== null && typeof body.volcengine === 'object') {
            setIf(volc, 'apiKey', body.volcengine.apiKey)
            setIf(volc, 'accessKey', body.volcengine.accessKey)
            setIf(volc, 'secretKey', body.volcengine.secretKey)
            setIf(volc, 'resourceIdStreaming', body.volcengine.resourceIdStreaming)
            setIf(volc, 'boostingTableId', body.volcengine.boostingTableId)
          }
          if (body.deepseek !== null && typeof body.deepseek === 'object') {
            setIf(deepseek, 'apiKey', body.deepseek.apiKey)
          }
          // 显式清除：body.clear = ['volcengine.apiKey', 'deepseek.apiKey', ...]
          if (Array.isArray(body.clear)) {
            for (const item of body.clear) {
              if (item === 'volcengine.apiKey') delete volc.apiKey
              if (item === 'volcengine.accessKey') delete volc.accessKey
              if (item === 'volcengine.secretKey') delete volc.secretKey
              if (item === 'volcengine.resourceIdStreaming') delete volc.resourceIdStreaming
              if (item === 'volcengine.boostingTableId') delete volc.boostingTableId
              if (item === 'deepseek.apiKey') delete deepseek.apiKey
            }
          }
          next.volcengine = volc
          next.deepseek = deepseek
          await mkdir(dirname(settings.asrConfigFile), { recursive: true })
          await writeFile(settings.asrConfigFile, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
          return writeJson(res, 200, { ok: true, ...credentialStatus(next) })
        }
        return writeError(res, 405, 'method_not_allowed', 'GET or PUT')
      }

      /* ------------------------------------------------------ 文件夹选择器 */
      if (route === '/pick-folder') {
        if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
        const picked = await pickFolder(settings.folderPickerCommand)
        if (picked === '') return writeJson(res, 200, { ok: true, path: '', cancelled: true })
        if (!isAbsolutePath(picked)) return writeError(res, 400, 'bad_path', '选择器返回的不是绝对路径：' + picked)
        let created = false
        try {
          const info = await stat(picked)
          if (!info.isDirectory()) return writeError(res, 400, 'bad_path', '选中的是文件，不是文件夹')
        } catch {
          await mkdir(picked, { recursive: true })
          created = true
        }
        return writeJson(res, 200, { ok: true, path: picked, created })
      }

      // 没配 vault 之前，除了 /config 之外一律拒绝，避免满屏报错
      if (settings.vaultRoot === '') return writeError(res, 409, 'not_configured', '还没有配置 Obsidian 库路径')

      /* ---------------------------------------------------------- 只读 */
      if (route === '/overview') {
        if (method !== 'GET') return writeError(res, 405, 'method_not_allowed', 'GET only')
        return writeJson(res, 200, await buildOverview())
      }
      if (route === '/cards') {
        if (method !== 'GET') return writeError(res, 405, 'method_not_allowed', 'GET only')
        return writeJson(res, 200, { ok: true, ...(await readCards(settings.cardsFile)) })
      }
      if (route === '/prompts') {
        if (method !== 'GET') return writeError(res, 405, 'method_not_allowed', 'GET only')
        return writeJson(res, 200, { ok: true, ...(await readPrompts(settings.promptsFile)) })
      }
      if (route === '/open-obsidian') {
        if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
        const body = await readJsonBody(req)
        if (typeof body.path !== 'string' || body.path === '') return writeError(res, 400, 'bad_request', '需要 path')
        const uri = vault.uriFor(body.path)
        await openExternal(settings.openCommand, uri)
        return writeJson(res, 200, { ok: true, uri })
      }
      // 打开外部控制台（只放行白名单域名，避免变成任意 URL 的执行器）
      if (route === '/open-url') {
        if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
        const body = await readJsonBody(req)
        const target = typeof body.url === 'string' ? body.url.trim() : ''
        const ALLOWED = ['https://console.volcengine.com/', 'https://api.deepseek.com/', 'https://www.volcengine.com/']
        if (!ALLOWED.some((prefix) => target.startsWith(prefix))) {
          return writeError(res, 400, 'bad_request', '只允许打开火山的控制台页面')
        }
        await openExternal(settings.openCommand, target)
        return writeJson(res, 200, { ok: true, url: target })
      }

      /* ------------------------------------------------------------- SOP */
      if (route === '/sop') {
        if (method !== 'GET') return writeError(res, 405, 'method_not_allowed', 'GET only')
        const notePath = url.searchParams.get('note')
        if (notePath !== null && notePath !== '') {
          return writeJson(res, 200, { ok: true, note: await vault.readNote(notePath) })
        }
        return writeJson(res, 200, await sopListing((url.searchParams.get('q') ?? '').trim()))
      }
      if (route === '/search') {
        if (method !== 'GET') return writeError(res, 405, 'method_not_allowed', 'GET only')
        return writeJson(res, 200, await globalSearch(url.searchParams.get('q') ?? ''))
      }
      if (route === '/sop/refresh') {
        if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
        vault.invalidate()
        return writeJson(res, 200, await sopListing((url.searchParams.get('q') ?? '').trim()))
      }
      if (route === '/sop/note') {
        if (method === 'PUT') {
          const body = await readJsonBody(req)
          if (typeof body.path !== 'string' || typeof body.text !== 'string') {
            return writeError(res, 400, 'bad_request', '需要 path 与 text')
          }
          return writeJson(res, 200, { ok: true, note: await vault.writeNote(body.path, body.text, { expectedSha1: body.expectedSha1 }) })
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (typeof body.path !== 'string' || typeof body.text !== 'string') {
            return writeError(res, 400, 'bad_request', '需要 path 与 text')
          }
          return writeJson(res, 200, { ok: true, note: await vault.createNote(body.path, body.text) })
        }
        return writeError(res, 405, 'method_not_allowed', 'PUT or POST')
      }

      /* ------------------------------------------------- 客户端日志 */
      if (route === '/client-log') {
        if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
        const body = await readJsonBody(req)
        const line = [
          new Date().toISOString(),
          String(body.where ?? 'client'),
          String(body.message ?? '').slice(0, 800),
          String(body.stack ?? '').slice(0, 2000),
        ].join(' | ')
        try {
          await appendFile(join(settings.dataDir, 'client-errors.log'), line + '\n', 'utf8')
        } catch {
          // 日志写不进去不影响客户端
        }
        return writeJson(res, 200, { ok: true })
      }

      if (route === '/usage') {
        if (method !== 'GET') return writeError(res, 405, 'method_not_allowed', 'GET only')
        const force = url.searchParams.get('refresh') === '1'
        return writeJson(res, 200, { ok: true, ...(await usageReader.get(force)) })
      }

      /* -------------------------------------------------- 术语表 / 造价三表 */
      const entryTables = {
        '/glossary': {
          file: settings.glossaryFile,
          api: { read: readGlossary, add: addGlossary, update: updateGlossary, remove: deleteGlossary, keys: ['zh', 'en', 'field', 'tag', 'note'] },
        },
        '/standards': { file: costTables.standards.file, api: costTables.standards.api },
        '/prices': { file: costTables.prices.file, api: costTables.prices.api },
        '/changes': { file: costTables.changes.file, api: costTables.changes.api },
      }
      for (const [base, config] of Object.entries(entryTables)) {
        if (route === base || route.startsWith(base + '/')) {
          await handleEntryTable({ req, res, url, method, route, base, file: config.file, api: config.api })
          return
        }
      }

      /* ------------------------------------------------------------ 录音 */
      if (route === '/recordings') {
        if (method === 'GET') {
          const items = await recordings.list()
          return writeJson(res, 200, { ok: true, items, dir: join(settings.vaultRoot, settings.recordingsDir) })
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          const created = await recordings.create({ title: typeof body.title === 'string' ? body.title : '' })
          return writeJson(res, 200, { ok: true, id: created.id, durationMs: 0 })
        }
        return writeError(res, 405, 'method_not_allowed', 'GET or POST')
      }

      const recordingMatch = /^\/recordings\/([^/]+)\/(chunk|finalize|audio|transcript|peaks|transcribe|rename|annotations)$/.exec(route)
      const recordingOne = /^\/recordings\/([^/]+)$/.exec(route)
      if (recordingMatch !== null) {
        const id = decodeURIComponent(recordingMatch[1])
        const action = recordingMatch[2]
        if (action === 'chunk') {
          if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
          const pcm = await readRawBody(req, 8 * 1024 * 1024)
          const written = await recordings.appendPcm(id, pcm)
          const asrId = url.searchParams.get('asr')
          if (asrId !== null && asrId !== '') asrBridge.push(asrId, pcm)
          return writeJson(res, 200, { ok: true, ...written })
        }
        if (action === 'annotations') {
          if (method === 'GET') {
            return writeJson(res, 200, { ok: true, annotations: await recordings.readAnnotations(id) })
          }
          if (method === 'PUT') {
            const body = await readJsonBody(req)
            if (!Array.isArray(body.annotations)) return writeError(res, 400, 'bad_request', '需要 annotations 数组')
            const saved = await recordings.writeAnnotations(id, body.annotations)
            return writeJson(res, 200, { ok: true, annotations: saved })
          }
          return writeError(res, 405, 'method_not_allowed', 'GET or PUT')
        }
        if (action === 'rename') {
          if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
          const body = await readJsonBody(req)
          const renamed = await recordings.renameRecording(id, typeof body.title === 'string' ? body.title : '')
          return writeJson(res, 200, { ok: true, id: renamed.id })
        }
        if (action === 'transcribe') {
          if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
          const body = await readJsonBody(req)
          const engine = body.engine === 'iflyrec' ? 'iflyrec' : 'volc'
          const result = engine === 'iflyrec' ? await transcribeWithIflyrecFile(id) : await transcribeRecordingFile(id)
          return writeJson(res, 200, { ok: true, engine, text: result.text, utterances: result.utterances?.length ?? 0 })
        }
        if (action === 'finalize') {
          if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
          return writeJson(res, 200, { ok: true, ...(await recordings.finalize(id)) })
        }
        if (action === 'peaks') {
          if (method !== 'GET') return writeError(res, 405, 'method_not_allowed', 'GET only')
          return writeJson(res, 200, { ok: true, peaks: await recordings.readPeaks(id) })
        }
        if (action === 'audio') {
          if (method !== 'GET') return writeError(res, 405, 'method_not_allowed', 'GET only')
          return serveAudio(req, res, recordings.audioPath(id))
        }
        // transcript
        if (method === 'GET') {
          const text = await recordings.readTranscript(id)
          return writeJson(res, 200, { ok: true, exists: text !== null, text: text ?? '' })
        }
        if (method === 'PUT') {
          const body = await readJsonBody(req)
          if (typeof body.text !== 'string') return writeError(res, 400, 'bad_request', '需要 text')
          await recordings.writeTranscript(id, body.text)
          return writeJson(res, 200, { ok: true })
        }
        return writeError(res, 405, 'method_not_allowed', 'GET or PUT')
      }

      if (recordingOne !== null) {
        const id = decodeURIComponent(recordingOne[1])
        if (method !== 'DELETE') return writeError(res, 405, 'method_not_allowed', 'DELETE only')
        const moved = await recordings.remove(id)
        return writeJson(res, 200, { ok: true, movedTo: moved.movedTo })
      }

      if (route === '/recording/asr/start') {
        if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
        const body = await readJsonBody(req)
        const sessionId = await asrBridge.start()
        if (typeof body.recordingId === 'string' && body.recordingId !== '') {
          asrRecording.set(sessionId, body.recordingId)
        }
        if (Number.isFinite(body.offsetMs) && body.offsetMs > 0) {
          asrOffset.set(sessionId, Math.round(body.offsetMs))
        }
        return writeJson(res, 200, { ok: true, sessionId })
      }

      const asrMatch = /^\/recording\/asr\/([^/]+)\/(events|chunk|finish)$/.exec(route)
      if (asrMatch !== null) {
        const sessionId = decodeURIComponent(asrMatch[1])
        const action = asrMatch[2]
        if (action === 'chunk') {
          if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
          const pcm = await readRawBody(req, 8 * 1024 * 1024)
          const accepted = asrBridge.push(sessionId, pcm)
          return writeJson(res, 200, { ok: true, accepted })
        }
        if (action === 'finish') {
          if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
          const pcm = await readRawBody(req, 8 * 1024 * 1024)
          const accepted = asrBridge.finish(sessionId, pcm)
          return writeJson(res, 200, { ok: true, accepted })
        }
        // events：SSE，一直开到定稿或出错
        if (method !== 'GET') return writeError(res, 405, 'method_not_allowed', 'GET only')
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
          'referrer-policy': 'no-referrer',
        })
        res.write(': connected\n\n')
        asrSubscribers.set(sessionId, res)
        const result = asrResults.get(sessionId)
        if (result !== undefined) {
          res.write('data: ' + JSON.stringify(result) + '\n\n')
          res.end()
          asrSubscribers.delete(sessionId)
          return
        }
        await new Promise((resolve) => {
          req.on('close', () => {
            asrSubscribers.delete(sessionId)
            resolve()
          })
          res.on('close', () => {
            asrSubscribers.delete(sessionId)
            resolve()
          })
        })
        return
      }

      return writeError(res, 404, 'not_found', 'unknown route: ' + route)
    } catch (error) {
      const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'internal_error'
      let status = 500
      if (code === 'bad_json' || code === 'too_large' || code === 'bad_path' || code === 'bad_request' || code === 'bad_id') status = 400
      if (code === 'no_asr_config' || code === 'no_asr_key' || code === 'asr_config_failed') status = 503
      if (code === 'not_found') status = 404
      if (code === 'conflict' || code === 'exists') status = 409
      // 顶层兜底：绝不让异常落到 webserver 的空体 400（客户端会报"响应不是合法 JSON"并丢掉真因）。
      writeError(res, status, code, describe(error))
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }))
  ctx.logger?.info?.('dsh-workbench: routes mounted at %s', API_PREFIX)
}
