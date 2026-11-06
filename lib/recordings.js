/**
 * 录音存储：每条录音一个文件夹，放在 vault 的 `02 Work/03 录音/<日期>-<标题>/` 下。
 *
 *   audio.wav    录音本体（44 字节 RIFF 头 + 裸 PCM，16k/16bit/单声道）
 *   转写.md      转写稿（带时间戳，Obsidian 里直接可看）
 *
 * 为什么要自己拼 WAV 头：浏览器录音默认给 webm/opus，转写服务不一定收，Obsidian 也不一定播；
 * WAV 两边都认。录制时先写一个占位头，边录边追加 PCM，收尾时把长度写回——这样一小时录音
 * 也不用在内存里攒完整文件。
 */
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, stat, writeFile, appendFile, rename, unlink } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'

const SAMPLE_RATE = 16000
const CHANNELS = 1
const BITS = 16
const HEADER_BYTES = 44

const ID_PATTERN = /^[^/\\\0]{1,120}$/

/** WAV 头：44 字节，dataSize 先写 0，收尾时补。 */
function wavHeader(dataSize) {
  const header = Buffer.alloc(HEADER_BYTES)
  const byteRate = SAMPLE_RATE * CHANNELS * (BITS / 8)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(CHANNELS, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(CHANNELS * (BITS / 8), 32)
  header.writeUInt16LE(BITS, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataSize, 40)
  return header
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function stamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** 波形峰值：把音频按桶切成 160 段，取每段最大振幅（0..1），流式读，不整段进内存。 */
async function computePeaks(filePath, dataSize, buckets = 160) {
  const totalSamples = Math.max(1, Math.floor(dataSize / 2))
  const perBucket = Math.max(1, Math.ceil(totalSamples / buckets))
  const peaks = new Array(buckets).fill(0)
  let carry = Buffer.alloc(0)
  let sampleOffset = 0
  if (dataSize > 0) {
    for await (const chunk of createReadStream(filePath, { start: HEADER_BYTES, end: HEADER_BYTES + dataSize - 1 })) {
      const buffer = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk
      const usable = buffer.length - (buffer.length % 2)
      carry = buffer.subarray(usable)
      for (let offset = 0; offset < usable; offset += 2) {
        const value = Math.abs(buffer.readInt16LE(offset)) / 32768
        const bucket = Math.min(buckets - 1, Math.floor(sampleOffset / perBucket))
        if (value > peaks[bucket]) peaks[bucket] = value
        sampleOffset += 1
      }
    }
  }
  return peaks.map((value) => Math.round(value * 1000) / 1000)
}

/** 文件夹名：日期 + 标题，去掉路径分隔符与控制字符。 */
function folderName(title, date) {
  const clean = String(title ?? '').replace(/[/\\:*?"<>|\0]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
  return `${stamp(date)}${clean === '' ? '' : ' ' + clean}`
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 目标目录是否仍在 root 之内。用 path.relative 判断，不能拼 `root + '/'`：
 * Windows 的 join 产出反斜杠，拼 '/' 会把每一条录音都判成越界。
 */
function isInsideRoot(root, target) {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function createRecordingStore({ root }) {
  function resolveId(id) {
    const text = String(id ?? '')
    if (!ID_PATTERN.test(text) || text.startsWith('.')) {
      throw Object.assign(new Error('录音 id 不合法'), { code: 'bad_id' })
    }
    const dir = join(root, text)
    if (!isInsideRoot(root, dir)) throw Object.assign(new Error('录音 id 越界'), { code: 'bad_id' })
    return dir
  }

  /**
   * 修补 WAV 头：录音中途关掉 App 时，页头里声明的长度还是 0（录制时只写了占位头），
   * 这种文件播放器读不出时长、拖不动。按实际文件大小回填一次即可救回来。
   */
  async function repairWavFile(dir, size) {
    if (size <= 44) return false
    const file = join(dir, 'audio.wav')
    let handle
    try {
      handle = await open(file, 'r+')
      const head = Buffer.alloc(44)
      await handle.read(head, 0, 44, 0)
      if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return false
      if (head.readUInt32LE(40) !== 0) return false
      const payload = size - 44
      head.writeUInt32LE(36 + payload, 4)
      head.writeUInt32LE(payload, 40)
      await handle.write(head, 0, 44, 0)
      return true
    } catch {
      return false
    } finally {
      if (handle !== undefined) await handle.close().catch(() => {})
    }
  }

  async function list() {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') return []
      throw Object.assign(new Error('列不出录音目录：' + describe(error)), { code: 'list_failed' })
    }
    const items = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = join(root, entry.name)
      let info
      try {
        info = await stat(join(dir, 'audio.wav'))
      } catch {
        continue // 没有 audio.wav 的目录不算录音
      }
      // 上次被强关/刷新打断的录音，这里顺手把页头补好（幂等，已补过的直接跳过）。
      if (await repairWavFile(dir, info.size)) {
        info = await stat(join(dir, 'audio.wav'))
      }
      let transcript = null
      try {
        const md = await stat(join(dir, '转写.md'))
        transcript = { mtimeMs: Math.round(md.mtimeMs), size: md.size }
      } catch {
        transcript = null
      }
      items.push({
        id: entry.name,
        title: entry.name.replace(/^\d{4}-\d{2}-\d{2} \d{4}\s*/, '') || entry.name,
        createdAt: Math.round(info.mtimeMs),
        sizeBytes: info.size,
        durationMs: Math.max(0, Math.round(((info.size - HEADER_BYTES) / (SAMPLE_RATE * CHANNELS * (BITS / 8))) * 1000)),
        transcript,
      })
    }
    items.sort((left, right) => right.createdAt - left.createdAt)
    return items
  }

  /** 新建一条录音：写占位 WAV 头，返回 id 与目录。 */
  async function create({ title, at = new Date() } = {}) {
    await mkdir(root, { recursive: true })
    let name = folderName(title, at)
    let dir = join(root, name)
    let suffix = 1
    // 同一分钟同名就加序号，别覆盖。
    while (true) {
      try {
        await stat(dir)
        suffix += 1
        name = folderName(title, at) + ` (${suffix})`
        dir = join(root, name)
      } catch {
        break
      }
    }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'audio.wav'), wavHeader(0))
    return { id: name, dir, audioPath: join(dir, 'audio.wav') }
  }

  /** 追加裸 PCM。 */
  async function appendPcm(id, buffer) {
    const dir = resolveId(id)
    const audioPath = join(dir, 'audio.wav')
    await appendFile(audioPath, buffer)
    const info = await stat(audioPath)
    return { bytes: info.size - HEADER_BYTES, durationMs: Math.round(((info.size - HEADER_BYTES) / (SAMPLE_RATE * CHANNELS * (BITS / 8))) * 1000) }
  }

  /** 收尾：把真实 data 长度写回 RIFF 头（先写临时文件再 rename）。 */
  async function finalize(id) {
    const dir = resolveId(id)
    const audioPath = join(dir, 'audio.wav')
    const info = await stat(audioPath)
    const dataSize = Math.max(0, info.size - HEADER_BYTES)
    const handle = await readFile(audioPath)
    const fixed = Buffer.concat([wavHeader(dataSize), handle.subarray(HEADER_BYTES)])
    const temp = audioPath + '.tmp'
    await writeFile(temp, fixed)
    await rename(temp, audioPath)
    const peaks = await computePeaks(audioPath, dataSize)
    await writeFile(join(dir, 'peaks.json'), JSON.stringify(peaks))
    return { sizeBytes: fixed.length, durationMs: Math.round((dataSize / (SAMPLE_RATE * CHANNELS * (BITS / 8))) * 1000) }
  }

  function audioPath(id) {
    return join(resolveId(id), 'audio.wav')
  }

  function transcriptPath(id) {
    return join(resolveId(id), '转写.md')
  }

  async function writeTranscript(id, markdown) {
    const path = transcriptPath(id)
    await writeFile(path, markdown, 'utf8')
    return path
  }

  async function readTranscript(id) {
    try {
      return await readFile(transcriptPath(id), 'utf8')
    } catch {
      return null
    }
  }

  /** 删除：不真删，移到本目录下的 .trash/，可手动捞回。 */
  async function remove(id) {
    const dir = resolveId(id)
    const trash = join(root, '.trash')
    await mkdir(trash, { recursive: true })
    let target = join(trash, id)
    let suffix = 1
    while (true) {
      try {
        await stat(target)
        suffix += 1
        target = join(trash, id + ' (' + suffix + ')')
      } catch {
        break
      }
    }
    await rename(dir, target)
    return { movedTo: target }
  }

  /**
   * 改名：保留文件夹名前面的日期时间前缀，只换后面的标题。
   * 改完顺手把 转写.md 里 `录音:` 那一行也更新，免得 frontmatter 与目录名不一致。
   */
  async function renameRecording(id, title) {
    const dir = resolveId(id)
    const prefixMatch = /^(\d{4}-\d{2}-\d{2} \d{4})\s*/.exec(id)
    const prefix = prefixMatch === null ? null : prefixMatch[1]
    const clean = String(title ?? '').replace(/[/\\:*?"<>|\0]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
    let nextName
    if (prefix === null) nextName = clean === '' ? id : clean
    else nextName = clean === '' ? prefix : prefix + ' ' + clean
    if (nextName === id) return { id }
    const target = join(root, nextName)
    if (!isInsideRoot(root, target)) throw Object.assign(new Error('名字不合法'), { code: 'bad_id' })
    try {
      await stat(target)
      throw Object.assign(new Error('已经有同名录音：' + nextName), { code: 'exists' })
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code !== 'ENOENT') throw error
    }
    await rename(dir, target)
    try {
      const transcript = await readFile(join(target, '转写.md'), 'utf8')
      await writeFile(join(target, '转写.md'), transcript.replace(/^录音:.*$/m, '录音: ' + nextName), 'utf8')
    } catch {
      // 没有转写稿就不用改。
    }
    return { id: nextName }
  }

  /**
   * 清掉第三方转写器写在音频旁边的产物（听见会写 `xxx-转写结果.txt` 与 `xxx-转写结果.json`）。
   * 只匹配这两个后缀，绝不碰 audio.wav / 转写.md / peaks.json。
   */
  async function cleanForeignArtifacts(id) {
    const dir = resolveId(id)
    let removed = 0
    let names = []
    try {
      names = await readdir(dir)
    } catch {
      return 0
    }
    for (const name of names) {
      if (!/-转写结果\.(txt|json)$/i.test(name)) continue
      try {
        await unlink(join(dir, name))
        removed += 1
      } catch {
        // 删不掉就算了，不打断转写。
      }
    }
    return removed
  }

  /**
   * 批注：`批注.json` 是唯一事实源；每次保存后在 转写.md 末尾重新生成「## 批注」附录，
   * 这样 Obsidian 里也看得到（但那边改了不会回传——附录是生成物）。
   */
  async function readAnnotations(id) {
    const dir = resolveId(id)
    let list = []
    try {
      const parsed = JSON.parse(await readFile(join(dir, '批注.json'), 'utf8'))
      if (Array.isArray(parsed)) list = parsed
    } catch {
      list = []
    }
    // 重新定位：quote 在转写稿里还在不在
    let lines = []
    try {
      lines = (await readFile(join(dir, '转写.md'), 'utf8')).split('\n')
    } catch {
      lines = []
    }
    const annotations = list.map((item) => {
      if (item === null || typeof item !== 'object') return null
      const quote = typeof item.quote === 'string' ? item.quote : ''
      const id_ = typeof item.id === 'string' ? item.id : null
      if (id_ === null || quote === '') return null
      const located = lines.findIndex((line) => line.includes(quote))
      return {
        id: id_,
        quote,
        note: typeof item.note === 'string' ? item.note : '',
        color: ['yellow', 'green', 'blue'].includes(item.color) ? item.color : 'yellow',
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
        time: Number.isFinite(item.time) ? item.time : null,
        line: located >= 0 ? located : (Number.isFinite(item.line) ? item.line : -1),
        stale: located < 0,
      }
    }).filter((item) => item !== null)
    return annotations
  }

  /** 保存批注并重写附录。 */
  async function writeAnnotations(id, annotations) {
    const dir = resolveId(id)
    const clean = (Array.isArray(annotations) ? annotations : []).slice(0, 500).map((item) => ({
      id: String(item?.id ?? '').slice(0, 40),
      quote: String(item?.quote ?? '').slice(0, 400),
      note: String(item?.note ?? '').slice(0, 4000),
      color: ['yellow', 'green', 'blue'].includes(item?.color) ? item.color : 'yellow',
      createdAt: String(item?.createdAt ?? new Date().toISOString()),
      time: Number.isFinite(item?.time) ? item.time : null,
      line: Number.isFinite(item?.line) ? item.line : -1,
    })).filter((item) => item.id !== '' && item.quote !== '')
    await writeFile(join(dir, '批注.json'), JSON.stringify(clean, null, 2), 'utf8')
    await rewriteAnnotationAppendix(dir, clean)
    return clean
  }

  /** 把 转写.md 末尾的「## 批注」整段替换成最新内容。 */
  async function rewriteAnnotationAppendix(dir, annotations) {
    const transcriptPath = join(dir, '转写.md')
    let text
    try {
      text = await readFile(transcriptPath, 'utf8')
    } catch {
      return
    }
    const marker = '\n## 批注'
    const cut = text.indexOf(marker)
    const base = (cut >= 0 ? text.slice(0, cut) : text).replace(/\n+$/, '')
    if (annotations.length === 0) {
      await writeFile(transcriptPath, base + '\n', 'utf8')
      return
    }
    const clock = (ms) => {
      const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
      return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0')
    }
    const lines = annotations.map((item) => {
      const stamp = Number.isFinite(item.time) ? '**[' + clock(item.time) + ']** ' : ''
      const note = item.note.trim() === '' ? '（仅高亮）' : item.note.trim()
      return '- ' + stamp + '「' + item.quote + '」——' + note
    })
    await writeFile(transcriptPath, base + '\n\n## 批注\n\n' + lines.join('\n') + '\n', 'utf8')
  }

  async function readPeaks(id) {
    try {
      const parsed = JSON.parse(await readFile(join(resolveId(id), 'peaks.json'), 'utf8'))
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  return { root, list, create, appendPcm, finalize, audioPath, transcriptPath, writeTranscript, readTranscript, readPeaks, remove, cleanForeignArtifacts, renameRecording, readAnnotations, writeAnnotations }
}
