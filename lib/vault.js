/**
 * vault 直连：Obsidian 的 md 笔记就是工作台的唯一事实源。
 *
 * 三条实测过的边界（2026-10-25 在本机验的，别照抄猜测）：
 *  ① 读文件：可以；
 *  ② 写文件 / 新建：可以（dsh-obsidian 在 vault 里成功建过文件，本层用的是同一个 fs 通道）；
 *  ③ 列目录（readdir）：被拒。所以发现笔记时先试 readdir，失败退到 Spotlight（mdfind）。
 *     这条兜底不是猜测：mdfind -onlyin <dir> "kMDItemFSName == '*.md'" 在本机实测能列出全部 6 篇。
 *
 * 写入纪律：写前读旧文件算 sha1，调用方带回来的 expectedSha1 对不上就拒绝写（Obsidian 里
 * 刚改过 / 正在编辑），先留 .bak 再临时文件 + rename，任何一步失败原文件不动。
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'

/** 发现缓存：mdfind 有成本，但也不能让"刚在 Obsidian 存盘"看不见，3 秒足够。 */
const DISCOVER_TTL_MS = 3000

/** 这些目录/文件名一律不进笔记列表。 */
const SKIP_NAMES = new Set(['.obsidian', '.trash', '.git', 'node_modules'])

function sha1(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function isMarkdown(name) {
  return /\.md$/i.test(name)
}

export class VaultError extends Error {
  constructor(message, code = 'vault_error', extra = {}) {
    super(message)
    this.name = 'VaultError'
    this.code = code
    this.extra = extra
  }
}

/** 递归列目录（readdir 被拒时抛错，由上层退到 Spotlight）。 */
async function walkMarkdown(dir) {
  const files = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_NAMES.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await walkMarkdown(full))
    else if (isMarkdown(entry.name)) files.push(full)
  }
  return files
}

/** Spotlight 兜底：不依赖目录枚举权限（仅 macOS 有 Spotlight，其它平台直接报不可用）。 */
function spotlightMarkdown(dir) {
  if (process.platform !== 'darwin') {
    return Promise.reject(new VaultError('当前系统没有 Spotlight 兜底', 'spotlight_unsupported'))
  }
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/mdfind',
      ['-onlyin', dir, "kMDItemFSName == '*.md'"],
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          reject(new VaultError('Spotlight 查询失败：' + describe(error), 'spotlight_failed'))
          return
        }
        resolve(String(stdout).split('\n').map((line) => line.trim()).filter((line) => line !== ''))
      },
    )
  })
}

/**
 * 标题 = 文件名（Obsidian 里显示的就是文件名，笔记正文首行往往是某个小节名，
 * 拿它当标题会把「翻译」显示成「Claude翻译口令」，实机验证过这个问题）。
 */
function titleOf(absPath) {
  return basename(absPath).replace(/\.md$/i, '')
}

/**
 * 小节切片：`# 标题` 与 `**粗体行**` 都当小节标题，切出「标题 + 起止行 + 本节正文」。
 * 第一个标题之前若有正文，单独成一节「（开头）」；全空白的节丢掉。
 */
/** 列表用的一句话摘要：去掉 frontmatter、标题记号与多余空白。 */
export function previewOf(text, limit = 110) {
  let body = String(text ?? '')
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end > 0) body = body.slice(end + 4)
  }
  const flat = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*[*\-·>]+\s*/, '').replace(/\*\*/g, '').trim())
    .filter((line) => line !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length <= limit ? flat : flat.slice(0, limit) + '…'
}

export function sectionsOf(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const out = []
  let current = { title: '（开头）', fromLine: 1, text: [] }
  lines.forEach((line, index) => {
    const match = line.match(/^#{1,6}\s+(.+)$/) ?? line.match(/^\*\*(.+?)\*\*\s*$/)
    if (match !== null) {
      if (current.text.some((item) => item.trim() !== '')) {
        out.push({ title: current.title, fromLine: current.fromLine, toLine: index, text: current.text.join('\n').trim() })
      }
      current = { title: String(match[1] ?? '').trim(), fromLine: index + 1, text: [line] }
      return
    }
    current.text.push(line)
  })
  if (current.text.some((item) => item.trim() !== '')) {
    out.push({ title: current.title, fromLine: current.fromLine, toLine: lines.length, text: current.text.join('\n').trim() })
  }
  return out.filter((section) => section.text !== '')
}

/** 兼容旧调用：只要标题列表。 */
export function headingsOf(text) {
  return sectionsOf(text).map((section) => ({ line: section.fromLine, text: section.title }))
}

export function createVaultStore({ vaultRoot, sopDir, backupDir = '', vaultName = '' }) {
  const root = normalize(vaultRoot)
  const base = join(root, sopDir)
  /** 备份放工作台目录下的隐藏文件夹，不再散落在笔记旁边（Obsidian 里看得见、也很难看）。 */
  const backups = backupDir === '' ? '' : normalize(backupDir)
  let cache = { at: 0, notes: [], source: 'none' }

  /** 相对 vault 根的路径 → 绝对路径；越界一律拒绝（不猜、不向上逃逸）。 */
  function resolveInside(relPath, { mustBeMarkdown = true } = {}) {
    const input = String(relPath ?? '').trim()
    if (input === '') throw new VaultError('路径为空', 'bad_path')
    if (isAbsolute(input)) throw new VaultError('只接受相对 vault 根的路径', 'bad_path')
    const normalized = normalize(input)
    if (normalized.startsWith('..') || normalized.includes('..' + sep)) {
      throw new VaultError('路径越出 vault 根目录', 'bad_path')
    }
    const abs = join(root, normalized)
    if (!abs.startsWith(root + sep)) throw new VaultError('路径越出 vault 根目录', 'bad_path')
    if (mustBeMarkdown && !isMarkdown(abs)) throw new VaultError('只处理 .md 笔记', 'bad_path')
    return abs
  }

  function relOf(absPath) {
    return relative(root, absPath).split(sep).join('/')
  }

  /** 发现 SOP 目录下的全部笔记；readdir 不行就走 Spotlight。 */
  async function discover({ force = false } = {}) {
    if (!force && Date.now() - cache.at < DISCOVER_TTL_MS) return cache
    let found = []
    let source = 'fs'
    try {
      found = await walkMarkdown(base)
    } catch (error) {
      // readdir 被拒（EPERM）或目录不存在：退到 Spotlight，再不行如实报错。
      try {
        found = await spotlightMarkdown(base)
        source = 'spotlight'
      } catch (spotlightError) {
        const code = error !== null && typeof error === 'object' ? error.code : undefined
        // 目录还不存在（新用户常见）：当成空目录，别把面板打成错误页
        if (code === 'ENOENT') return { notes: [], tree: [], source: 'missing', missingDir: base }
        throw new VaultError(
          '列不出 SOP 目录，Spotlight 也没兜住：' + describe(spotlightError),
          'list_failed',
          { fsError: String(code ?? describe(error)) },
        )
      }
    }

    const notes = []
    for (const abs of found) {
      if (!abs.startsWith(base + sep)) continue
      try {
        const info = await stat(abs)
        if (!info.isFile()) continue
        const text = await readFile(abs, 'utf8')
        const rel = relOf(abs)
        const group = dirname(relative(base, abs)) === '.' ? '' : dirname(relative(base, abs)).split(sep).join('/')
        notes.push({
          path: rel,
          title: titleOf(abs),
          group,
          chars: text.length,
          sections: sectionsOf(text).length,
          mtimeMs: Math.round(info.mtimeMs),
          size: info.size,
        })
      } catch {
        // 单篇读不了（被删/权限）只丢这一篇，不影响列表。
      }
    }
    notes.sort((left, right) => (left.group === right.group ? left.title.localeCompare(right.title, 'zh') : left.group.localeCompare(right.group, 'zh')))
    cache = { at: Date.now(), notes, source }
    return cache
  }

  /**
   * vault 相对路径 → obsidian:// 深链。
   * 客户端只传路径，URI 由 Host 拼：避免把任意 scheme 交给浏览器/系统去执行。
   */
  function uriFor(relPath) {
    const abs = resolveInside(relPath)
    const rel = relOf(abs)
    // Obsidian 的 vault 名默认等于库文件夹名；库名自定义过时可配置覆盖。
    const resolvedName = typeof vaultName === 'string' && vaultName.trim() !== '' ? vaultName.trim() : basename(root)
    // Obsidian 的 file 参数用不带扩展名的路径（带 .md 多数版本也能解析，但不带更稳）。
    const file = rel.replace(/\.md$/i, '').split('/').map((segment) => encodeURIComponent(segment)).join('/')
    return 'obsidian://open?vault=' + encodeURIComponent(resolvedName) + '&file=' + file
  }

  /** 备份：优先写到工作台的隐藏备份目录；没配置备份目录就退回同目录 .bak。 */
  async function writeBackup(abs, text) {
    if (backups === '') {
      await copyFile(abs, abs + '.bak')
      return
    }
    await mkdir(backups, { recursive: true })
    const name = relative(root, abs).split(sep).join('__') + '.bak'
    await writeFile(join(backups, name), text, 'utf8')
  }

  /**
   * 目录树：按 vault 原样列出"目录 + md 笔记"，空目录也保留（界面灰显），
   * 以 . 开头或 SKIP_NAMES 里的一律跳过（.obsidian/.trash/.workbuddy 之类不进来）。
   */
  async function tree() {
    async function build(dir, relDir) {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        const code = error !== null && typeof error === 'object' ? error.code : undefined
        if (code === 'ENOENT') return []
        throw new VaultError('列不出目录：' + describe(error), 'list_failed')
      }
      const nodes = []
      for (const entry of entries) {
        if (entry.name.startsWith('.') || SKIP_NAMES.has(entry.name)) continue
        const rel = relDir === '' ? entry.name : relDir + '/' + entry.name
        if (entry.isDirectory()) {
          const children = await build(join(dir, entry.name), rel)
          nodes.push({ type: 'dir', name: entry.name, path: rel, children, count: countNotes(children) })
          continue
        }
        if (!isMarkdown(entry.name)) continue
        const abs = join(dir, entry.name)
        let preview = ''
        try {
          preview = previewOf(await readFile(abs, 'utf8'))
        } catch {
          preview = ''
        }
        nodes.push({ type: 'note', name: entry.name.replace(/\.md$/i, ''), path: relOf(abs), preview })
      }
      nodes.sort((left, right) => {
        if (left.type !== right.type) return left.type === 'dir' ? -1 : 1
        return left.name.localeCompare(right.name, 'zh')
      })
      return nodes
    }
    return build(base, '')
  }

  function countNotes(nodes) {
    let total = 0
    for (const node of nodes) total += node.type === 'note' ? 1 : countNotes(node.children)
    return total
  }

  async function readNote(relPath) {
    const abs = resolveInside(relPath)
    let info
    try {
      info = await stat(abs)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') throw new VaultError('笔记不存在：' + relPath, 'not_found')
      throw new VaultError('读不到笔记：' + describe(error), 'read_failed')
    }
    const text = await readFile(abs, 'utf8')
    return {
      path: relOf(abs),
      title: titleOf(abs),
      text,
      chars: text.length,
      sha1: sha1(text),
      mtimeMs: Math.round(info.mtimeMs),
      size: info.size,
      headings: headingsOf(text),
      sections: sectionsOf(text),
    }
  }

  /**
   * 写附件：备份 → 临时文件 → rename。
   * expectedSha1 给了就必须与当前文件一致，否则拒绝（409 conflict）。
   */
  async function writeNote(relPath, text, { expectedSha1 } = {}) {
    const abs = resolveInside(relPath)
    let current = null
    let currentMtime = null
    try {
      const info = await stat(abs)
      currentMtime = Math.round(info.mtimeMs)
      current = await readFile(abs, 'utf8')
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code !== 'ENOENT') throw new VaultError('写前读不到现有内容：' + describe(error), 'read_failed')
    }
    if (current !== null && typeof expectedSha1 === 'string' && expectedSha1 !== '' && sha1(current) !== expectedSha1) {
      throw new VaultError('文件在别处被改过了（多半是 Obsidian 里刚保存），已拒绝写入', 'conflict', {
        currentSha1: sha1(current),
        currentMtimeMs: currentMtime,
      })
    }
    await mkdir(dirname(abs), { recursive: true })
    if (current !== null) {
      try {
        await writeBackup(abs, current)
      } catch (error) {
        throw new VaultError('备份失败，已放弃写入：' + describe(error), 'backup_failed')
      }
    }
    const temp = abs + '.tmp-' + process.pid
    try {
      await writeFile(temp, text, 'utf8')
      await rename(temp, abs)
    } catch (error) {
      try {
        await unlink(temp)
      } catch {
        // 临时文件可能压根没建出来。
      }
      throw new VaultError('写入失败，原文件未改动：' + describe(error), 'write_failed')
    }
    cache.at = 0
    const info = await stat(abs)
    return { path: relOf(abs), sha1: sha1(text), mtimeMs: Math.round(info.mtimeMs), size: info.size }
  }

  /** 新建：已存在就拒绝（要覆盖请走 write，并带指纹）。 */
  async function createNote(relPath, text) {
    const abs = resolveInside(relPath)
    try {
      await stat(abs)
      throw new VaultError('同名笔记已存在：' + relPath, 'exists')
    } catch (error) {
      if (error instanceof VaultError) throw error
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code !== 'ENOENT') throw new VaultError('检查同名笔记失败：' + describe(error), 'stat_failed')
    }
    await mkdir(dirname(abs), { recursive: true })
    try {
      await writeFile(abs, text, 'utf8')
    } catch (error) {
      throw new VaultError('新建失败：' + describe(error), 'write_failed')
    }
    cache.at = 0
    const info = await stat(abs)
    return { path: relOf(abs), sha1: sha1(text), mtimeMs: Math.round(info.mtimeMs), size: info.size }
  }

  /** 全文搜索：扫已发现的笔记（不依赖 Spotlight 索引新鲜度）。 */
  async function search(query, { limit = 60 } = {}) {
    const needle = String(query ?? '').trim().toLowerCase()
    if (needle === '') return []
    const { notes } = await discover()
    const matches = []
    for (const note of notes) {
      let text
      try {
        text = await readFile(join(root, note.path), 'utf8')
      } catch {
        continue
      }
      const lines = text.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].toLowerCase().includes(needle)) continue
        matches.push({
          path: note.path,
          title: note.title,
          group: note.group,
          line: index + 1,
          snippet: lines[index].trim().slice(0, 220),
        })
        if (matches.length >= limit) return matches
      }
    }
    return matches
  }

  return {
    root,
    base,
    discover,
    readNote,
    writeNote,
    createNote,
    search,
    headingsOf,
    sectionsOf,
    tree,
    uriFor,
    invalidate() {
      cache.at = 0
    },
  }
}
