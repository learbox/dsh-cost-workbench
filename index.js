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
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, basename, dirname, extname, normalize, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

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
const PKG_DIR = dirname(fileURLToPath(import.meta.url))
// 允许按需下发的第三方脚本（都在包的 vendor/ 目录里，不可任意读文件）
const VENDOR_SCRIPTS = new Set(['mermaid.min.js', 'highlight.min.js'])
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
  // Obsidian 库名：默认空 = 用库文件夹名；Obsidian 里改过库名时填这里
  obsidianVaultName: '',
  // DSH 会话-工作区索引（用来把当前会话绑定的工作区当成项目根）
  workspaceIndexFile: '',
  // Obsidian 库索引（判断项目文件夹是否已是库；留空按平台探测）
  obsidianIndexFile: '',
  // 是否允许笔记里的原始 HTML 执行（默认关闭，设置页开启需二次确认）
  allowHtml: false,
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
    if (typeof config.allowHtml === 'boolean') merged.allowHtml = config.allowHtml
  }
  for (const key of Object.keys(merged)) {
    if (typeof merged[key] === 'string') merged[key] = merged[key].trim()
  }
  // 用户配置文件的优先级介于「默认值」与「profile 配置」之间
  if (configFile !== null && typeof configFile === 'object') {
    for (const key of ['vaultRoot', 'dataDir', 'sopDir', 'obsidianVaultName', 'workspaceIndexFile', 'workbenchDir', 'recordingsDir']) {
      const value = typeof configFile[key] === 'string' ? configFile[key].trim() : ''
      if (value !== '' && (merged[key] === '' || merged[key] === DEFAULT_CONFIG[key] || key === 'vaultRoot')) merged[key] = value
    }
    if (typeof configFile.allowHtml === 'boolean') merged.allowHtml = configFile.allowHtml
  }
  if (merged.dataDir === '') merged.dataDir = join(homedir(), '.dsh-workbench')
  if (merged.userConfigFile === '') merged.userConfigFile = USER_CONFIG_FILE
  if (merged.workspaceIndexFile === '') merged.workspaceIndexFile = join(homedir(), '.dsh', 'storages', 'workspace.json')
  if (merged.obsidianIndexFile === '') merged.obsidianIndexFile = defaultObsidianIndex()
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
/** 从注册表读某个协议的打开命令（Windows 协议处理器的真实定义）。返回 { exe, rest }。 */
async function readProtocolCommand(protocol) {
  const safe = /^[a-z][a-z0-9+.-]*$/i.test(protocol) ? protocol : ''
  if (safe === '') return null
  for (const root of ['HKCU', 'HKLM']) {
    const key = root + '\\Software\\Classes\\' + safe + '\\shell\\open\\command'
    const output = await new Promise((resolve) => {
      try {
        execFile('reg.exe', ['query', key, '/ve'], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
          resolve(error === null ? String(stdout) : '')
        })
      } catch {
        resolve('')
      }
    })
    const match = /"([^"]+)"\s*(.*)$/m.exec(output)
    if (match !== null) return { exe: match[1], rest: match[2].trim() }
  }
  return null
}

/** 把注册表命令里的 %1 占位换成目标 URL，返回参数数组。 */
function protocolArgs(rest, target) {
  if (rest === '' || /^"?%1"?$/.test(rest)) return [target]
  const placeholder = rest.replace(/"%1"|%1/g, '__DSH_TARGET__')
  const parts = placeholder.split(/\s+/).filter((part) => part !== '')
  return parts.map((part) => (part === '__DSH_TARGET__' ? target : part))
}

/**
 * 用系统默认程序打开一个 URI / 网页。
 * 顺序：自定义命令 → Electron 原生 shell.openExternal（桌面 Host）→
 * Windows 协议处理器（注册表读 exe 直接调用，等同系统行为）→ cmd start / explorer 兜底。
 * Windows 不能把 URL 交给 cmd：`&` 会被当命令分隔符、`%XX` 会被当变量展开（实测会报
 * 'file' is not recognized / Command failed），所以必须直接调用注册表里的处理器。
 */
async function openExternal(command, target) {
  const custom = typeof command === 'string' ? command.trim() : ''
  if (custom !== '') {
    await new Promise((resolve, reject) => {
      try {
        execFile(custom, [target], { timeout: 5000, windowsHide: true }, (error) => {
          if (error !== null) reject(Object.assign(new Error(describe(error)), { code: 'open_failed' }))
          else resolve()
        })
      } catch (error) {
        reject(Object.assign(new Error(describe(error)), { code: 'open_failed' }))
      }
    })
    return
  }
  // 桌面版 Host 在 Electron 主进程里：直接交给 Chromium 的 ShellExecute，最可靠。
  if (process.versions.electron !== undefined) {
    try {
      const electron = await import('electron')
      const shellApi = electron !== null && electron.shell !== undefined ? electron.shell : null
      if (shellApi !== null && typeof shellApi.openExternal === 'function') {
        await shellApi.openExternal(target)
        return
      }
    } catch {
      // 不是主进程或模块不可用：继续走平台回退
    }
  }
  if (process.platform === 'win32') {
    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(target)
    const handler = schemeMatch === null ? null : await readProtocolCommand(schemeMatch[1])
    if (handler !== null) {
      await new Promise((resolve, reject) => {
        try {
          execFile(handler.exe, protocolArgs(handler.rest, target), { timeout: 15000, windowsHide: true }, (error) => {
            if (error !== null) reject(Object.assign(new Error(describe(error)), { code: 'open_failed' }))
            else resolve()
          })
        } catch (error) {
          reject(Object.assign(new Error(describe(error)), { code: 'open_failed' }))
        }
      })
      return
    }
    // 没有注册处理器时的最后兜底（cmd start 的退出码对 URL 不可靠，只把起不来当失败）
    await new Promise((resolve, reject) => {
      const fallbackExplorer = () => {
        try {
          execFile('explorer.exe', [target], { timeout: 5000, windowsHide: true }, (error) => {
            if (error !== null) reject(Object.assign(new Error(describe(error)), { code: 'open_failed' }))
            else resolve()
          })
        } catch (error) {
          reject(Object.assign(new Error(describe(error)), { code: 'open_failed' }))
        }
      }
      try {
        execFile('cmd', ['/c', 'start', '', target], { timeout: 5000, windowsHide: true }, (error) => {
          if (error !== null && (error.code === 'ENOENT' || error.code === 'EPERM')) fallbackExplorer()
          else resolve()
        })
      } catch {
        fallbackExplorer()
      }
    })
    return
  }
  await new Promise((resolve, reject) => {
    try {
      execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { timeout: 5000 }, (error) => {
        if (error !== null) reject(Object.assign(new Error(describe(error)), { code: 'open_failed' }))
        else resolve()
      })
    } catch (error) {
      reject(Object.assign(new Error(describe(error)), { code: 'open_failed' }))
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

/** 各平台 Obsidian 的库索引位置。 */
function defaultObsidianIndex() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'obsidian', 'obsidian.json')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json')
  return join(homedir(), '.config', 'obsidian', 'obsidian.json')
}

/** 判断某个文件夹是否已经是 Obsidian 的库（obsidian.json 的 vaults 路径匹配，忽略大小写与尾部分隔符）。 */
async function isVaultRegistered(vaultPath, indexFile) {
  const normalize = (value) => String(value ?? '').replace(/[\\/]+$/, '').toLowerCase()
  const target = normalize(vaultPath)
  if (target === '') return false
  try {
    const parsed = JSON.parse(await readFile(indexFile, 'utf8'))
    const vaults = parsed !== null && typeof parsed === 'object' && parsed.vaults !== null && typeof parsed.vaults === 'object'
      ? parsed.vaults
      : {}
    return Object.keys(vaults).some((key) => normalize(vaults[key]?.path) === target)
  } catch {
    return false
  }
}

/** 读 DSH 的会话-工作区索引：sessionId → 工作区路径。读不到就当没有项目上下文。 */
async function readWorkspaceIndex(file) {
  const map = new Map()
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    const workspaces = parsed !== null && typeof parsed === 'object' && parsed.tables !== null && typeof parsed.tables === 'object'
      ? parsed.tables.workspaces
      : null
    if (workspaces === null || typeof workspaces !== 'object') return map
    for (const key of Object.keys(workspaces)) {
      const entry = workspaces[key]
      if (entry === null || typeof entry !== 'object') continue
      const path = typeof entry.path === 'string' ? entry.path.trim() : ''
      if (path === '') continue
      const ids = Array.isArray(entry.sessionIds) ? entry.sessionIds : []
      for (const id of ids) {
        if (typeof id !== 'string') continue
        map.set(id, path)
        if (id.startsWith('session-')) map.set(id.slice('session-'.length), path)
      }
    }
  } catch {
    // 索引读不到 = 没有项目上下文，回退公共库
  }
  return map
}

/**
 * 派生各数据目录。
 *  - 有当前会话工作区 → 项目根 = 该工作区：资料库就是项目根，三张表落 `<项目>/造价工作台/`，
 *    会议记录落 `<项目>/会议记录/`；
 *  - 没有 → 回退公共库（旧布局）。
 * 术语表始终在公共库的 `Workbench/术语表.md`，不随项目走。
 */
function buildStores(settings, workspacePath = '') {
  const projectRoot = typeof workspacePath === 'string' ? workspacePath.trim() : ''
  if (projectRoot === '') {
    // 普通工作区 / 未标记：回退公共库，绝不在工作区里写 造价工作台/会议记录
    return {
      project: '',
      projectRoot: settings.vaultRoot,
      sopDir: settings.sopDir,
      recordingsRoot: join(settings.vaultRoot, settings.recordingsDir),
      workbenchDir: join(settings.vaultRoot, settings.workbenchDir),
      backupDir: join(settings.vaultRoot, settings.workbenchDir, '.backups'),
    }
  }
  return {
    project: basename(projectRoot),
    projectRoot,
    sopDir: '',
    recordingsRoot: join(projectRoot, '会议记录'),
    workbenchDir: join(projectRoot, '造价工作台'),
    backupDir: join(projectRoot, '造价工作台', '.backups'),
  }
}

/** 工作区的项目标记文件（隐藏在工作区根）：{ project: true|false }。 */
const PROJECT_MARKER = '.dsh-cost-workbench.json'

/** 读标记：none（没标记）/ project（造价项目）/ plain（普通工作区）。 */
async function readWorkspaceMarker(workspace) {
  const text = typeof workspace === 'string' ? workspace.trim() : ''
  if (text === '') return 'none'
  try {
    const parsed = JSON.parse(await readFile(join(text, PROJECT_MARKER), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && parsed.project === true ? 'project' : 'plain'
  } catch {
    return 'none'
  }
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

/**
 * 项目模式下的目录初始化（幂等）：建 `造价工作台/`、`会议记录/`，缺哪张表就写一张空表。
 * 不覆盖已有文件；失败不阻塞面板（只是对应目录要等第一次写入时才自动创建）。
 */
async function ensureProjectLayout(stores) {
  if (stores.project === '') return { ok: true }
  try {
    await mkdir(stores.workbenchDir, { recursive: true })
    await mkdir(stores.recordingsRoot, { recursive: true })
    const tables = createCostTables({ workbenchDir: stores.workbenchDir })
    for (const kind of COST_TABLE_KINDS) {
      const table = tables[kind]
      try {
        await stat(table.file)
      } catch {
        await writeFile(table.file, table.serialize([]), 'utf8')
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, message: describe(error) }
  }
}

/** 只读附件（图片）路由支持的 MIME。 */
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
}

/**
 * 在项目根内找一张图片附件。
 * - relPath：相对项目根的路径（笔记里写的相对路径）；
 * - fileName：只给文件名时（Obsidian 的 ![[图片.png]]），在项目根内限深限量按名查找。
 * 任何越界、非图片、不存在都返回 null。
 */
async function findAttachmentFile(root, relPath, fileName) {
  const isImage = (target) => IMAGE_MIME[extname(target).toLowerCase()] !== undefined
  if (relPath !== '') {
    if (isAbsolutePath(relPath)) return null
    const normalized = normalize(relPath)
    if (normalized.startsWith('..') || normalized.includes('..' + sep)) return null
    const abs = join(root, normalized)
    if (!abs.startsWith(root + sep)) return null
    if (!isImage(abs)) return null
    try {
      const info = await stat(abs)
      return info.isFile() ? { abs, info } : null
    } catch {
      return null
    }
  }
  const target = String(fileName ?? '').split(/[\\/]/).pop()
  if (target === '' || target === undefined || !isImage(target)) return null
  const wanted = target.toLowerCase()
  const queue = [{ dir: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < 800) {
    const current = queue.shift()
    visited += 1
    let entries
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const abs = join(current.dir, entry.name)
      if (entry.isFile() && entry.name.toLowerCase() === wanted) {
        try {
          return { abs, info: await stat(abs) }
        } catch {
          return null
        }
      }
      if (entry.isDirectory() && current.depth < 6) queue.push({ dir: abs, depth: current.depth + 1 })
    }
  }
  return null
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
  /** 当前会话工作区（= 项目根）；由客户端 POST /context 告知，空则回退公共库。 */
  let sessionWorkspace = ''
  /** 当前会话的工作区路径（无论是否造价项目），标记接口用它定位。 */
  let contextWorkspace = ''
  let settings = resolveConfig(config, loadUserConfigSync(resolveUserConfigFile(config)))
  let stores = buildStores(settings, sessionWorkspace)
  let vault = createVaultStore({
    vaultRoot: stores.projectRoot,
    sopDir: stores.sopDir,
    backupDir: stores.backupDir,
    vaultName: stores.project === '' ? settings.obsidianVaultName : '',
  })
  let publicVault = createVaultStore({
    vaultRoot: settings.vaultRoot,
    sopDir: settings.sopDir,
    backupDir: join(settings.vaultRoot, settings.workbenchDir, '.backups'),
    vaultName: settings.obsidianVaultName,
  })
  let costTables = createCostTables({ workbenchDir: stores.workbenchDir })
  let recordings = createRecordingStore({ root: stores.recordingsRoot })

  /** 公共资料库的笔记在合并树里用这个前缀标识来源；项目笔记不带前缀。 */
  const PUBLIC_PREFIX = '@public/'
  function splitSource(relPath) {
    const text = String(relPath ?? '')
    if (text === '@public') return { source: 'public', rel: '' }
    if (text.startsWith(PUBLIC_PREFIX)) return { source: 'public', rel: text.slice(PUBLIC_PREFIX.length) }
    if (text === '@project') return { source: 'project', rel: '' }
    if (text.startsWith('@project/')) return { source: 'project', rel: text.slice('@project/'.length) }
    return { source: 'project', rel: text }
  }
  function vaultForSource(source) {
    return source === 'public' ? publicVault : vault
  }
  function withSource(source, relPath) {
    return source === 'public' ? PUBLIC_PREFIX + relPath : relPath
  }
  function prefixTree(nodes, prefix) {
    return (Array.isArray(nodes) ? nodes : []).map((node) => node.type === 'dir'
      ? { ...node, path: prefix + node.path, children: prefixTree(node.children, prefix) }
      : { ...node, path: prefix + node.path })
  }

  /** 给界面用的配置状态。 */
  function configStatus() {
    return {
      configured: settings.vaultRoot !== '',
      vaultRoot: settings.vaultRoot,
      sopDir: settings.sopDir,
      obsidianVaultName: settings.obsidianVaultName,
      project: stores.project,
      projectRoot: stores.projectRoot,
      workbenchDir: settings.workbenchDir,
      recordingsDir: settings.recordingsDir,
      dataDir: settings.dataDir,
      configFile: settings.userConfigFile,
      allowHtml: settings.allowHtml === true,
    }
  }

  /** 保存配置后立即重建依赖路径的部件，用户不用重启。 */
  function rebuild() {
    settings = resolveConfig(config, loadUserConfigSync(resolveUserConfigFile(config)))
    stores = buildStores(settings, sessionWorkspace)
    vault = createVaultStore({
      vaultRoot: stores.projectRoot,
      sopDir: stores.sopDir,
      backupDir: stores.backupDir,
      vaultName: stores.project === '' ? settings.obsidianVaultName : '',
    })
    publicVault = createVaultStore({
      vaultRoot: settings.vaultRoot,
      sopDir: settings.sopDir,
      backupDir: join(settings.vaultRoot, settings.workbenchDir, '.backups'),
      vaultName: settings.obsidianVaultName,
    })
    costTables = createCostTables({ workbenchDir: stores.workbenchDir })
    recordings = createRecordingStore({ root: stores.recordingsRoot })
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
    const publicFound = await publicVault.discover()
    const projectMatches = query === '' ? [] : await vault.search(query)
    const publicMatches = query === '' ? [] : await publicVault.search(query)
    const tree = query === '' ? await vault.tree() : null
    const notes = [
      ...found.notes,
      ...publicFound.notes.map((note) => ({ ...note, path: PUBLIC_PREFIX + note.path })),
    ]
    const publicTree = query === '' ? await publicVault.tree() : null
    const projectContainer = query === ''
      ? [
          {
            type: 'dir',
            name: '项目资料库',
            path: '@project',
            children: tree ?? [],
            count: found.notes.length,
          },
        ]
      : []
    const mergedTree = query === ''
      ? [
          ...(stores.project === '' ? (tree ?? []) : projectContainer),
          {
            type: 'dir',
            name: '公共资料库',
            path: PUBLIC_PREFIX.slice(0, -1),
            children: prefixTree(publicTree, PUBLIC_PREFIX),
            count: publicFound.notes.length,
          },
        ]
      : null
    const matches = [
      ...projectMatches,
      ...publicMatches.map((match) => ({ ...match, path: PUBLIC_PREFIX + match.path })),
    ]
    return {
      ok: true,
      source: found.source,
      tree: mergedTree,
      vaultRoot: stores.projectRoot,
      vaultName: basename(stores.projectRoot),
      sopDir: stores.sopDir,
      notes,
      matches,
      stats: {
        count: notes.length,
        chars: notes.reduce((total, note) => total + note.chars, 0),
        lastTouched: notes.reduce((latest, note) => Math.max(latest, note.mtimeMs), 0),
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
    // 公共资料库的笔记也一起搜（路径带 @public/ 前缀，点开时回资料库定位）
    for (const hit of await publicVault.search(query, { limit: 40 })) {
      hits.push({ source: 'sop', path: PUBLIC_PREFIX + hit.path, title: hit.title, group: hit.group, line: hit.line, snippet: hit.snippet })
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
        const publicFound = await publicVault.discover()
        const notes = [...found.notes, ...publicFound.notes]
        return {
          status: 'ready',
          stats: {
            count: notes.length,
            chars: notes.reduce((total, note) => total + note.chars, 0),
            source: found.source,
            lastTouched: notes.reduce((latest, note) => Math.max(latest, note.mtimeMs), 0),
            publicCount: publicFound.notes.length,
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

    const vaultName = basename(stores.projectRoot)
    return {
      ok: true,
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      source: cardsResult.source,
      warnings,
      vault: { root: stores.projectRoot, sopDir: stores.sopDir, workbenchDir: settings.workbenchDir, name: vaultName },
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
            obsidianVaultName: typeof body.obsidianVaultName === 'string' ? body.obsidianVaultName.trim() : '',
            workbenchDir: typeof body.workbenchDir === 'string' && body.workbenchDir.trim() !== '' ? body.workbenchDir.trim() : 'Workbench',
            recordingsDir: typeof body.recordingsDir === 'string' && body.recordingsDir.trim() !== '' ? body.recordingsDir.trim() : '会议记录',
            dataDir: typeof body.dataDir === 'string' && body.dataDir.trim() !== '' ? body.dataDir.trim() : '',
            allowHtml: body.allowHtml === true,
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

      /* ------------------------------------------------------ 会话工作区（项目上下文） */
      // 客户端打开面板时告知当前 sessionId；Host 用 DSH 的工作区索引把它映射成项目根。
      // 之后所有数据都落在该项目目录下：资料库=项目根、三张表=项目/造价工作台、会议记录=项目/会议记录。
      if (route === '/context') {
        if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
        const body = await readJsonBody(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        let workspace = ''
        if (sessionId !== '') {
          const index = await readWorkspaceIndex(settings.workspaceIndexFile)
          workspace = index.get(sessionId) ?? index.get('session-' + sessionId) ?? ''
        }
        contextWorkspace = workspace
        // 只有标记为「造价项目」的工作区才进入项目模式；未标记/普通 → 公共库
        const marked = await readWorkspaceMarker(workspace)
        sessionWorkspace = marked === 'project' ? workspace : ''
        rebuild()
        const layout = sessionWorkspace === '' ? { ok: true } : await ensureProjectLayout(stores)
        return writeJson(res, 200, {
          ok: true,
          sessionId,
          workspace,
          marked,
          project: stores.project,
          projectRoot: stores.projectRoot,
          initialized: layout.ok === true,
        })
      }

      // 工作台里「新建造价项目工作区」：对用户选的目录写标记并初始化（不依赖当前会话）
      if (route === '/project/mark') {
        if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
        const body = await readJsonBody(req)
        const target = typeof body.path === 'string' ? body.path.trim() : ''
        if (target === '' || !isAbsolutePath(target)) return writeError(res, 400, 'bad_request', '需要绝对路径')
        let info = null
        try {
          info = await stat(target)
        } catch {
          return writeError(res, 400, 'bad_path', '目录不存在：' + target)
        }
        if (!info.isDirectory()) return writeError(res, 400, 'bad_path', '不是目录：' + target)
        const enable = body.enable !== false
        try {
          await writeFile(join(target, PROJECT_MARKER), JSON.stringify({ project: enable, markedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
        } catch (error) {
          return writeError(res, 500, 'mark_failed', '写项目标记失败：' + describe(error))
        }
        const layout = enable ? await ensureProjectLayout(buildStores(settings, target)) : { ok: true }
        return writeJson(res, 200, {
          ok: true,
          path: target,
          marked: enable ? 'project' : 'plain',
          project: basename(target),
          initialized: layout.ok === true,
        })
      }

      // 只读查询：会话对应工作区的标记状态（入口按钮用它决定显示/隐藏，不触发重建）
      if (route === '/context/status') {
        if (method !== 'GET') return writeError(res, 405, 'method_not_allowed', 'GET only')
        const sessionId = (url.searchParams.get('sessionId') ?? '').trim()
        let workspace = ''
        if (sessionId !== '') {
          const index = await readWorkspaceIndex(settings.workspaceIndexFile)
          workspace = index.get(sessionId) ?? index.get('session-' + sessionId) ?? ''
        }
        return writeJson(res, 200, { ok: true, workspace, marked: await readWorkspaceMarker(workspace) })
      }

      // 首次询问的答案：把当前会话工作区标记成造价项目或普通工作区（写隐藏文件到工作区根）
      if (route === '/context/mark') {
        if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
        if (contextWorkspace === '') return writeError(res, 400, 'bad_request', '还没有识别到当前会话的工作区')
        const body = await readJsonBody(req)
        const enable = body.enable === true
        try {
          const markFile = join(contextWorkspace, PROJECT_MARKER)
          await writeFile(markFile, JSON.stringify({ project: enable, markedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
        } catch (error) {
          return writeError(res, 500, 'mark_failed', '写项目标记失败：' + describe(error))
        }
        sessionWorkspace = enable ? contextWorkspace : ''
        rebuild()
        const layout = enable ? await ensureProjectLayout(stores) : { ok: true }
        return writeJson(res, 200, {
          ok: true,
          workspace: contextWorkspace,
          marked: enable ? 'project' : 'plain',
          project: stores.project,
          projectRoot: stores.projectRoot,
          initialized: layout.ok === true,
        })
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
      /* ------------------------------------------------------ Obsidian 库状态 */
      if (route === '/obsidian-status') {
        if (method !== 'GET') return writeError(res, 405, 'method_not_allowed', 'GET only')
        const registered = await isVaultRegistered(stores.projectRoot, settings.obsidianIndexFile)
        return writeJson(res, 200, { ok: true, registered, project: stores.project, projectRoot: stores.projectRoot })
      }

      if (route === '/open-obsidian-app') {
        if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
        // 直接启动 Obsidian（Windows 读注册表拿 exe），让用户去「打开文件夹作为库」
        if (process.platform === 'win32') {
          const handler = await readProtocolCommand('obsidian')
          if (handler !== null) {
            await new Promise((resolve, reject) => {
              try {
                execFile(handler.exe, [], { timeout: 8000, windowsHide: true }, (error) => {
                  if (error !== null) reject(Object.assign(new Error(describe(error)), { code: 'open_failed' }))
                  else resolve()
                })
              } catch (error) {
                reject(Object.assign(new Error(describe(error)), { code: 'open_failed' }))
              }
            })
            return writeJson(res, 200, { ok: true })
          }
        }
        await openExternal(settings.openCommand, 'obsidian://open')
        return writeJson(res, 200, { ok: true })
      }

      if (route === '/open-obsidian') {
        if (method !== 'POST') return writeError(res, 405, 'method_not_allowed', 'POST only')
        const body = await readJsonBody(req)
        if (typeof body.path !== 'string' || body.path === '') return writeError(res, 400, 'bad_request', '需要 path')
        const { source, rel } = splitSource(body.path)
        const targetVault = vaultForSource(source)
        const targetRoot = source === 'public' ? settings.vaultRoot : stores.projectRoot
        const uri = targetVault.uriFor(rel)
        const registered = await isVaultRegistered(targetRoot, settings.obsidianIndexFile)
        if (registered) {
          await openExternal(settings.openCommand, uri)
          return writeJson(res, 200, { ok: true, mode: 'obsidian', uri })
        }
        // 项目文件夹还不是 Obsidian 库：用系统默认程序打开这篇笔记，别让「打开」直接失败
        const note = await targetVault.readNote(rel)
        const absolute = join(targetRoot, ...String(note.path).split('/'))
        await openExternal(settings.openCommand, absolute)
        return writeJson(res, 200, { ok: true, mode: 'file', path: absolute, reason: 'vault-not-registered' })
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

      /* ---------------------------------------------------------- 第三方脚本（按需加载） */
      if (route === '/vendor') {
        if (method !== 'GET') return writeError(res, 405, 'method_not_allowed', 'GET only')
        const name = url.searchParams.get('name') ?? ''
        if (!VENDOR_SCRIPTS.has(name)) return writeError(res, 404, 'not_found', '未知脚本')
        const file = join(PKG_DIR, 'vendor', name)
        try {
          const info = await stat(file)
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'content-length': String(info.size),
            'cache-control': 'no-store',
          })
          createReadStream(file).pipe(res)
        } catch {
          return writeError(res, 404, 'not_found', '脚本不存在：' + name)
        }
        return
      }

      /* ---------------------------------------------------------- 附件（图片） */
      if (route === '/attachment') {
        if (method !== 'GET') return writeError(res, 405, 'method_not_allowed', 'GET only')
        const { source, rel } = splitSource(url.searchParams.get('path') ?? '')
        const attachmentRoot = source === 'public' ? settings.vaultRoot : stores.projectRoot
        const found = await findAttachmentFile(
          attachmentRoot,
          rel.trim(),
          (url.searchParams.get('name') ?? '').trim(),
        )
        if (found === null) return writeError(res, 404, 'not_found', '找不到图片附件')
        res.writeHead(200, {
          'content-type': IMAGE_MIME[extname(found.abs).toLowerCase()] ?? 'application/octet-stream',
          'content-length': String(found.info.size),
          'cache-control': 'no-store',
        })
        createReadStream(found.abs).pipe(res)
        return
      }

      /* ------------------------------------------------------------- SOP */
      if (route === '/sop') {
        if (method !== 'GET') return writeError(res, 405, 'method_not_allowed', 'GET only')
        const notePath = url.searchParams.get('note')
        if (notePath !== null && notePath !== '') {
          const { source, rel } = splitSource(notePath)
          const note = await vaultForSource(source).readNote(rel)
          return writeJson(res, 200, { ok: true, note: { ...note, path: withSource(source, note.path) } })
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
        publicVault.invalidate()
        return writeJson(res, 200, await sopListing((url.searchParams.get('q') ?? '').trim()))
      }
      if (route === '/sop/note') {
        if (method === 'PUT') {
          const body = await readJsonBody(req)
          if (typeof body.path !== 'string' || typeof body.text !== 'string') {
            return writeError(res, 400, 'bad_request', '需要 path 与 text')
          }
          const { source, rel } = splitSource(body.path)
          const written = await vaultForSource(source).writeNote(rel, body.text, { expectedSha1: body.expectedSha1 })
          return writeJson(res, 200, { ok: true, note: { ...written, path: withSource(source, written.path) } })
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (typeof body.path !== 'string' || typeof body.text !== 'string') {
            return writeError(res, 400, 'bad_request', '需要 path 与 text')
          }
          const { source, rel } = splitSource(body.path)
          const created = await vaultForSource(source).createNote(rel, body.text)
          return writeJson(res, 200, { ok: true, note: { ...created, path: withSource(source, created.path) } })
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
          return writeJson(res, 200, { ok: true, items, dir: stores.recordingsRoot })
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
