/**
 * 路由端到端：用假 webServer 直接打 HTTP handler，不启动 App。
 *
 * 两组：
 *   ① 只读组——打真实 vault（不存在则跳过），验证 overview / 树 / 单篇 / 搜索 / 卡片；
 *   ② 写入组——全部落在临时目录，验证指纹冲突、备份位置、新建、越界拦截、术语与三张表 CRUD、深链。
 *
 * 用量角标会走真实网络，默认跳过；要跑加 WB_TEST_NETWORK=1。
 */
import assert from 'node:assert/strict'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { REAL_SOP, REAL_VAULT, createReporter, mount, tempDir } from './helpers.mjs'

const { check, report } = createReporter('routes')

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/* ---------------------------------------------------------------- ① 只读 */

if (await exists(join(REAL_VAULT, REAL_SOP))) {
  const call = await mount({})

  const overview = await call('GET', '/overview')
  check('overview 200', overview.status === 200)
  check('overview 卡片数 ≥ 5', Array.isArray(overview.json?.cards) && overview.json.cards.length >= 5, overview.json?.cards?.length)
  const sopCard = overview.json.cards.find((card) => card.kind === 'sop')
  check('SOP 卡有笔记数', sopCard !== undefined && sopCard.stats.count > 0, JSON.stringify(sopCard?.stats))

  const listing = await call('GET', '/sop')
  check('SOP 走 fs', listing.json?.source === 'fs', listing.json?.source)
  check('SOP 列表与卡片计数一致', listing.json.notes.length === sopCard.stats.count, listing.json.notes.length)
  check('SOP 带目录树', Array.isArray(listing.json.tree) && listing.json.tree.length > 0)
  check('树节点带计数', listing.json.tree.every((node) => node.type === 'note' || Number.isInteger(node.count)))

  const firstNote = listing.json.notes[0]
  const single = await call('GET', '/sop?note=' + encodeURIComponent(firstNote.path))
  check('读单篇带正文与指纹', single.status === 200 && single.json.note.text.length > 0 && single.json.note.sha1.length === 40)
  check('读单篇带小节', Array.isArray(single.json.note.sections))

  const search = await call('GET', '/search?q=' + encodeURIComponent('的'))
  check('全局搜索有命中', search.status === 200 && search.json.hits.length > 0, search.json?.hits?.length)
  check('搜索命中带来源', search.json.hits.every((hit) => ['sop', 'glossary', 'recording', 'standards', 'prices', 'changes'].includes(hit.source)))

  const emptySearch = await call('GET', '/search?q=')
  check('空搜索返回空', emptySearch.json.hits.length === 0)

  const cards = await call('GET', '/cards')
  check('/cards 200', cards.status === 200 && Array.isArray(cards.json.cards))
  const prompts = await call('GET', '/prompts')
  check('/prompts 200', prompts.status === 200 && typeof prompts.json.prompts === 'object')

  const glossary = await call('GET', '/glossary')
  check('/glossary 200', glossary.status === 200 && Array.isArray(glossary.json.entries))

  const standards = await call('GET', '/standards')
  check('/standards 200', standards.status === 200 && Array.isArray(standards.json.entries))
  const prices = await call('GET', '/prices')
  check('/prices 200', prices.status === 200 && Array.isArray(prices.json.entries))
  const changes = await call('GET', '/changes')
  check('/changes 200', changes.status === 200 && Array.isArray(changes.json.entries))

  check('未知路由 404', (await call('GET', '/nope')).status === 404)
  check('错误方法 405', (await call('DELETE', '/overview')).status === 405)
} else {
  console.log('  · 跳过真实 vault 只读测试（' + join(REAL_VAULT, REAL_SOP) + ' 不存在）')
}

/* ---------------------------------------------------------------- ② 写入 */

const tmp = await tempDir()
try {
  const vaultRoot = join(tmp.dir, 'vault')
  const siteDir = '00 资料库'
  await mkdir(join(vaultRoot, siteDir, '阶段一'), { recursive: true })
  await writeFile(join(vaultRoot, siteDir, '甲.md'), '# 甲\n原文\n', 'utf8')
  const glossaryFile = join(tmp.dir, '术语表.md')
  const dataDir = join(tmp.dir, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'cards.json'), JSON.stringify({ cards: [{ id: 'sop', kind: 'sop', title: '资料库', order: 10 }] }), 'utf8')
  await writeFile(join(dataDir, 'prompts.json'), JSON.stringify({ prompts: {} }), 'utf8')

  const call = await mount({
    vaultRoot,
    sopDir: siteDir,
    workbenchDir: 'Workbench',
    recordingsDir: '会议记录',
    dataDir,
    glossaryFile,
    // 隔离真实用户配置：否则 ~/.dsh-workbench/config.json 会覆盖测试的临时库路径
    userConfigFile: join(tmp.dir, 'user-config.json'),
    // 会话-工作区索引：测试用临时文件，避免读真实 DSH 存储
    workspaceIndexFile: join(tmp.dir, 'workspace-index.json'),
    // Obsidian 库索引：临时文件（不存在 = 未注册）
    obsidianIndexFile: join(tmp.dir, 'obsidian.json'),
    // 故意给一个不存在的打开命令：验证 open_failed 分支，同时避免测试真的去拉起 Obsidian。
    openCommand: '__missing_open_command__',
    // 同理：文件夹选择器用不存在的命令，避免测试弹出系统对话框。
    folderPickerCommand: '__missing_picker__',
  })

  const picker = await call('POST', '/pick-folder', {})
  check('文件夹选择器失败时报 picker_failed', picker.status === 500 && picker.json.code === 'picker_failed', picker.raw.slice(0, 160))

  /* ------------------------------------------------------ 语音凭据（可选） */
  const credsBefore = await call('GET', '/credentials')
  check('凭据初始未配置', credsBefore.status === 200 && credsBefore.json.volcengine.apiKey === false && credsBefore.json.deepseek.apiKey === false)
  const credsPut = await call('PUT', '/credentials', {
    volcengine: { apiKey: 'volc-test-key', accessKey: 'AK123', secretKey: 'SK123' },
    deepseek: { apiKey: 'sk-test' },
  })
  check('凭据保存 200', credsPut.status === 200 && credsPut.json.volcengine.apiKey === true && credsPut.json.deepseek.apiKey === true)
  check('凭据响应不含明文', !credsPut.raw.includes('volc-test-key') && !credsPut.raw.includes('SK123'), credsPut.raw.slice(0, 200))
  check('凭据落到 asr.json', (await readFile(join(dataDir, 'asr.json'), 'utf8')).includes('volc-test-key'))
  const credsAfter = await call('GET', '/credentials')
  check('凭据状态可读', credsAfter.json.volcengine.accessKey === true && credsAfter.json.volcengine.resourceIdStreaming === '')
  const credsClear = await call('PUT', '/credentials', { clear: ['volcengine.apiKey'] })
  check('凭据可单独清除', credsClear.json.volcengine.apiKey === false && credsClear.json.volcengine.accessKey === true)
  check('清除后文件里也没有该字段', !(await readFile(join(dataDir, 'asr.json'), 'utf8')).includes('volc-test-key'))

  const current = await call('GET', '/sop?note=' + encodeURIComponent('00 资料库/甲.md'))
  check('临时 vault 读到正文', current.status === 200 && current.json.note.text.includes('原文'))

  const conflict = await call('PUT', '/sop/note', { path: '00 资料库/甲.md', text: 'x', expectedSha1: 'deadbeef' })
  check('指纹不符 409', conflict.status === 409 && conflict.json.code === 'conflict')

  const saved = await call('PUT', '/sop/note', {
    path: '00 资料库/甲.md',
    text: '# 甲\n改后\n',
    expectedSha1: current.json.note.sha1,
  })
  check('指纹正确写入', saved.status === 200, saved.raw.slice(0, 120))
  check('磁盘内容已变', (await readFile(join(vaultRoot, '00 资料库', '甲.md'), 'utf8')).includes('改后'))
  check('备份落到隐藏目录', (await readFile(join(vaultRoot, 'Workbench/.backups/00 资料库__甲.md.bak'), 'utf8')).includes('原文'))

  const created = await call('POST', '/sop/note', { path: '00 资料库/阶段一/乙.md', text: '# 乙\n' })
  check('新建笔记', created.status === 200 && created.json.note.path === '00 资料库/阶段一/乙.md')
  check('同名新建 409', (await call('POST', '/sop/note', { path: '00 资料库/阶段一/乙.md', text: 'x' })).status === 409)
  check('越界 400', (await call('PUT', '/sop/note', { path: '../x.md', text: 'x' })).status === 400)
  check('缺字段 400', (await call('PUT', '/sop/note', { path: '00 资料库/甲.md' })).status === 400)

  const added = await call('POST', '/glossary', { zh: '工程量清单', en: 'Bill of Quantities', field: '造价' })
  check('术语新增', added.status === 200 && added.json.total === 1, added.raw.slice(0, 120))
  check('术语重复 400', (await call('POST', '/glossary', { zh: '工程量清单', en: 'Bill of Quantities' })).status === 400)
  const updated = await call('PUT', '/glossary/' + added.json.entry.id, { zh: '工程量清单', en: 'Bill of Quantities (BOQ)' })
  check('术语修改', updated.status === 200)
  check('术语删除', (await call('DELETE', '/glossary/' + updated.json.entry.id)).status === 200)
  check('术语删不存在 404', (await call('DELETE', '/glossary/deadbeef0000')).status === 404)

  /* ------------------------------------------------ 造价三表（临时 vault） */
  const stdAdded = await call('POST', '/standards', { code: 'GB50500', name: '建设工程工程量清单计价规范', category: '计价规范', version: 'GB 50500-2013', date: '2013-07-01', note: '' })
  check('计价依据新增 200', stdAdded.status === 200 && stdAdded.json.total === 1, stdAdded.raw.slice(0, 160))
  check('计价依据重复 400', (await call('POST', '/standards', { code: 'GB50500', name: 'x' })).status === 400)
  const stdList = await call('GET', '/standards')
  check('计价依据列表命中落盘文件', stdList.json.entries.some((entry) => entry.code === 'GB50500'), stdList.raw.slice(0, 160))
  const stdUpdated = await call('PUT', '/standards/' + stdAdded.json.entry.id, { code: 'GB50500', name: '建设工程工程量清单计价规范', category: '计价规范', version: 'GB 50500-2013（含 2018 修订）', date: '2013-07-01', note: '' })
  check('计价依据修改 200', stdUpdated.status === 200)
  check('计价依据落盘可见', (await readFile(join(vaultRoot, 'Workbench', '计价依据.md'), 'utf8')).includes('2018 修订'))

  const priceAdded = await call('POST', '/prices', { name: '螺纹钢', spec: 'HRB400E φ20', unit: 't', price: '3950', region: '杭州', date: '2026-10-01', source: '信息价' })
  check('材料价格新增 200', priceAdded.status === 200)
  const priceDub = await call('POST', '/prices', { name: '螺纹钢', spec: 'HRB400E φ20', unit: 't', region: '杭州' })
  check('材料价格同主键 400', priceDub.status === 400)

  const changeAdded = await call('POST', '/changes', { code: 'BG-001', project: '示例项目', reason: '增加抗浮锚杆', amount: '120000', date: '2026-10-20', status: '待审批' })
  check('变更签证新增 200', changeAdded.status === 200)
  check('变更签证删除 200', (await call('DELETE', '/changes/' + changeAdded.json.entry.id)).status === 200)

  /* ---------------------------------------------- 会话工作区 = 项目根 */
  const projectDir = join(tmp.dir, '项目工作区')
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(tmp.dir, 'workspace-index.json'), JSON.stringify({
    tables: { workspaces: { w1: { path: projectDir, sessionIds: ['session-test-1'] } } },
  }), 'utf8')

  const ctxOn = await call('POST', '/context', { sessionId: 'session-test-1' })
  check('识别会话工作区为项目根', ctxOn.status === 200 && ctxOn.json.projectRoot === projectDir, ctxOn.raw.slice(0, 160))
  check('项目名取工作区文件夹名', ctxOn.json.project === '项目工作区')
  check('识别项目后自动初始化目录与空表', await readFile(join(projectDir, '造价工作台', '变更签证台账.md'), 'utf8').then((text) => text.includes('# 变更签证台账'), () => false))
  const projectStandards = await call('GET', '/standards')
  check('项目内读到空表', projectStandards.status === 200 && projectStandards.json.entries.length === 0)
  const projectAdd = await call('POST', '/standards', { code: 'W-001', name: '项目专用计价依据', category: '项目', version: 'v1', date: '', note: '' })
  check('项目内可新增', projectAdd.status === 200)
  check('项目数据落在会话工作区', await readFile(join(projectDir, '造价工作台', '计价依据.md'), 'utf8').then((text) => text.includes('W-001'), () => false))
  const projectSop = await call('GET', '/sop')
  check('资料库=项目根（含造价工作台目录）', projectSop.status === 200 && Array.isArray(projectSop.json.tree) && projectSop.json.tree.some((node) => node.type === 'dir' && node.name === '造价工作台'), projectSop.raw.slice(0, 160))
  const projectRecording = await call('GET', '/recordings')
  check('会议记录指向项目目录', projectRecording.status === 200 && projectRecording.json.dir === join(projectDir, '会议记录'), projectRecording.json.dir)

  const obsBefore = await call('GET', '/obsidian-status')
  check('项目文件夹未注册为 Obsidian 库', obsBefore.status === 200 && obsBefore.json.registered === false)
  await writeFile(join(tmp.dir, 'obsidian.json'), JSON.stringify({ vaults: { abc123: { path: projectDir } } }), 'utf8')
  const obsAfter = await call('GET', '/obsidian-status')
  check('注册后识别为 Obsidian 库', obsAfter.status === 200 && obsAfter.json.registered === true)

  /* ------------------------------------------------------ 图片附件 */
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  await writeFile(join(projectDir, '图.png'), png)
  await mkdir(join(projectDir, '附件'), { recursive: true })
  await writeFile(join(projectDir, '附件', '现场.png'), png)
  {
    const req = {
      method: 'GET',
      url: '/api/dsh-workbench/attachment?name=' + encodeURIComponent('图.png'),
      headers: { host: '127.0.0.1:58900' },
      socket: { remoteAddress: '127.0.0.1' },
      on() {},
      async *[Symbol.asyncIterator]() {},
    }
    let head = null
    let bytes = 0
    const res = {
      writeHead(status, headers) { head = { status, headers } },
      write(chunk) { bytes += chunk.length; return true },
      end() {},
      on() {},
      once() {},
      emit() {},
      removeListener() {},
    }
    await call.handler(req, res)
    await new Promise((resolve) => setTimeout(resolve, 120))
    check('图片附件按文件名找到', head !== null && head.status === 200 && String(head.headers['content-type']).startsWith('image/png'), JSON.stringify(head))
    check('图片附件有内容', bytes > 0, bytes)
  }
  {
    const req = {
      method: 'GET',
      url: '/api/dsh-workbench/attachment?path=' + encodeURIComponent('附件/现场.png'),
      headers: { host: '127.0.0.1:58900' },
      socket: { remoteAddress: '127.0.0.1' },
      on() {},
      async *[Symbol.asyncIterator]() {},
    }
    let head = null
    let bytes = 0
    const res = {
      writeHead(status, headers) { head = { status, headers } },
      write(chunk) { bytes += chunk.length; return true },
      end() {},
      on() {},
      once() {},
      emit() {},
      removeListener() {},
    }
    await call.handler(req, res)
    await new Promise((resolve) => setTimeout(resolve, 120))
    check('图片附件按相对路径找到', head !== null && head.status === 200 && bytes > 0, JSON.stringify(head))
  }
  check('附件越界被拒', (await call('GET', '/attachment?path=' + encodeURIComponent('../outside.png'))).status === 404)
  check('非图片附件被拒', (await call('GET', '/attachment?path=' + encodeURIComponent('造价工作台/计价依据.md'))).status === 404)

  const ctxOff = await call('POST', '/context', { sessionId: '' })
  check('清空会话后回退公共库', ctxOff.status === 200 && ctxOff.json.project === '')
  const publicStandards = await call('GET', '/standards')
  check('公共库数据未受影响', publicStandards.json.entries.some((entry) => entry.code === 'GB50500'))

  const stdSearch = await call('GET', '/search?q=' + encodeURIComponent('GB50500'))
  check('搜索命中计价依据', stdSearch.json.hits.some((hit) => hit.source === 'standards'), JSON.stringify(stdSearch.json.counts))
  const priceSearch = await call('GET', '/search?q=' + encodeURIComponent('螺纹钢'))
  check('搜索命中材料价格', priceSearch.json.hits.some((hit) => hit.source === 'prices'), JSON.stringify(priceSearch.json.counts))



  /* ------------------------------------------------------- 录音（临时 vault） */

  if (process.env.WB_TEST_NETWORK === '1') {
    const usage = await call('GET', '/usage')
    check('用量接口 200', usage.status === 200 && usage.json.ok === true, usage.raw.slice(0, 160))
    check('用量接口含 deepseek/volc', usage.json.deepseek !== undefined && usage.json.volc !== undefined)
  }

  const rec = await call('POST', '/recordings', { title: '单元测试' })
  check('新建录音 200', rec.status === 200 && typeof rec.json.id === 'string', rec.raw.slice(0, 120))
  const recId = rec.json.id
  const pcm = Buffer.alloc(6400)
  for (let index = 0; index < pcm.length; index += 2) pcm.writeInt16LE(Math.round(Math.sin(index / 20) * 12000), index)
  const chunk1 = await call('POST', '/recordings/' + encodeURIComponent(recId) + '/chunk', pcm)
  check('写入音频分片', chunk1.status === 200 && chunk1.json.bytes === 6400, chunk1.raw.slice(0, 120))
  const fin = await call('POST', '/recordings/' + encodeURIComponent(recId) + '/finalize', {})
  check('收尾修正时长', fin.status === 200 && fin.json.durationMs >= 190 && fin.json.durationMs <= 210, JSON.stringify(fin.json))

  const listed = await call('GET', '/recordings')
  check('录音出现在列表', listed.json.items.some((item) => item.id === recId), listed.json.items.length)
  const peaks = await call('GET', '/recordings/' + encodeURIComponent(recId) + '/peaks')
  check('波形峰值 160 段', Array.isArray(peaks.json.peaks) && peaks.json.peaks.length === 160)
  const put = await call('PUT', '/recordings/' + encodeURIComponent(recId) + '/transcript', { text: '# 转写\n- 测试\n' })
  check('写转写稿', put.status === 200)
  const got = await call('GET', '/recordings/' + encodeURIComponent(recId) + '/transcript')
  check('读回转写稿', got.json.exists === true && got.json.text.includes('测试'))
  {
    const escape = await call('GET', '/recordings/..%2F..%2Fetc/audio')
    check('录音 id 越界 400', escape.status === 400, escape.status + ' ' + escape.raw.slice(0, 120))
  }


  // Range：单独造一个能接流的 res
  {
    const req = {
      method: 'GET',
      url: '/api/dsh-workbench/recordings/' + encodeURIComponent(recId) + '/audio',
      headers: { host: '127.0.0.1:58900', range: 'bytes=44-143' },
      socket: { remoteAddress: '127.0.0.1' },
      on() {},
      async *[Symbol.asyncIterator]() {},
    }
    let head = null
    let received = 0
    const res = {
      writeHead(status, headers) { head = { status, headers } },
      write(chunk) { received += chunk.length; return true },
      end() {},
      on() {},
      once() {},
      emit() {},
      removeListener() {},
    }
    await call.handler(req, res)
    await new Promise((resolve) => setTimeout(resolve, 120))
    check('Range 返回 206', head !== null && head.status === 206, JSON.stringify(head))
    check('Range 头正确', head !== null && String(head.headers['content-range']).startsWith('bytes 44-143/'), JSON.stringify(head?.headers))
    check('Range 只传 100 字节', received === 100, received)
  }

  const savedAnn = await call('PUT', '/recordings/' + encodeURIComponent(recId) + '/annotations', {
    annotations: [{ id: 'a1', quote: '测试', note: '我的批注', color: 'yellow', time: 0, line: 0 }],
  })
  check('批注保存', savedAnn.status === 200 && savedAnn.json.annotations.length === 1, savedAnn.raw.slice(0, 120))
  const readAnn = await call('GET', '/recordings/' + encodeURIComponent(recId) + '/annotations')
  check('批注读回', readAnn.json.annotations[0]?.note === '我的批注')
  check('批注定位到行', readAnn.json.annotations[0]?.stale === false)
  check('转写稿追加批注附录', (await readFile(join(vaultRoot, '会议记录', recId, '转写.md'), 'utf8')).includes('## 批注'))

  const recSearch = await call('GET', '/search?q=' + encodeURIComponent('测试'))
  check('搜索命中录音转写', recSearch.json.hits.some((hit) => hit.source === 'recording'), JSON.stringify(recSearch.json.counts))
  const recHit = recSearch.json.hits.find((hit) => hit.source === 'recording')
  check('录音命中带日期', /^\d{4}-\d{2}-\d{2}$/.test(recHit?.date ?? ''), recHit?.date)
  const annSearch = await call('GET', '/search?q=' + encodeURIComponent('我的批注'))
  check('搜索命中录音批注', annSearch.json.hits.some((hit) => hit.source === 'recording'), JSON.stringify(annSearch.json.counts))

  const renamed = await call('POST', '/recordings/' + encodeURIComponent(recId) + '/rename', { title: '改过名' })
  check('改名 200', renamed.status === 200 && renamed.json.id !== recId, renamed.raw.slice(0, 120))
  check('改名保留日期前缀', /^\d{4}-\d{2}-\d{2} \d{4} 改过名$/.test(renamed.json.id), renamed.json.id)
  const finalId = renamed.json.id
  check('改名后旧目录不在列表', !(await call('GET', '/recordings')).json.items.some((item) => item.id === recId))

  const removed = await call('DELETE', '/recordings/' + encodeURIComponent(finalId))
  check('删除录音 200', removed.status === 200, removed.raw.slice(0, 120))
  const afterDelete = await call('GET', '/recordings')
  check('删除后不在列表', !afterDelete.json.items.some((item) => item.id === finalId))
  check('删除后可回收（.trash）', await readFile(join(vaultRoot, '会议记录', '.trash', finalId, 'audio.wav')).then(() => true, () => false))

  const open = await call('POST', '/open-obsidian', { path: '00 资料库/甲.md' })
  check('深链打开命令缺失时报 open_failed', open.status === 500 && open.json.code === 'open_failed', open.raw.slice(0, 160))
  check('深链越界 400', (await call('POST', '/open-obsidian', { path: '../../etc/passwd' })).status === 400)

} finally {
  await tmp.cleanup()
}

assert.ok(report())
