/**
 * 纯逻辑单测：cards / prompts / glossary / 造价三表 / vault。
 * 全部用临时目录，不碰真实数据。
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readCards, BUILTIN_CARDS } from '../lib/cards.js'
import { readPrompts } from '../lib/prompts.js'
import * as G from '../lib/glossary.js'
import { createCostTables, entryMatches } from '../lib/tables.js'
import { createVaultStore, previewOf, sectionsOf } from '../lib/vault.js'
import { createReporter, tempDir } from './helpers.mjs'

const { check, report } = createReporter('unit')
const tmp = await tempDir()

try {
  /* ---------------------------------------------------------------- cards */
  await writeFile(join(tmp.dir, 'cards.json'), JSON.stringify({
    cards: [
      { id: 'a', kind: 'sop', title: 'A', order: 20 },
      { id: 'b', kind: 'prompt', title: 'B', order: 10, promptId: 'p1' },
      { id: 'c', kind: 'weird', title: 'C', order: 30, placement: 'strip' },
    ],
  }), 'utf8')
  const cards = await readCards(join(tmp.dir, 'cards.json'))
  check('cards 读文件并排序', cards.source === 'file' && cards.cards.map((c) => c.id).join(',') === 'b,a,c')
  check('cards 透出 placement', cards.cards.find((c) => c.id === 'c').placement === 'strip')

  await writeFile(join(tmp.dir, 'bad.json'), '{oops', 'utf8')
  const broken = await readCards(join(tmp.dir, 'bad.json'))
  check('cards 坏 JSON 回退内置', broken.source === 'builtin' && broken.cards.length === BUILTIN_CARDS.length && Boolean(broken.warning))

  await writeFile(join(tmp.dir, 'partial.json'), JSON.stringify({ cards: [{ id: 'a', kind: 'sop' }, { id: 'a', kind: 'x' }, {}] }), 'utf8')
  const partial = await readCards(join(tmp.dir, 'partial.json'))
  check('cards 单条坏只丢那一条', partial.cards.length === 1 && Boolean(partial.warning))

  /* -------------------------------------------------------------- prompts */
  await writeFile(join(tmp.dir, 'prompts.json'), JSON.stringify({ prompts: { p1: { title: 'T', text: 'hello' }, p2: { title: 'no text' } } }), 'utf8')
  const prompts = await readPrompts(join(tmp.dir, 'prompts.json'))
  check('prompts 丢掉没有正文的模板', prompts.source === 'file' && Object.keys(prompts.prompts).join(',') === 'p1')
  check('prompts 缺失回退内置', (await readPrompts(join(tmp.dir, 'nope.json'))).source === 'builtin')

  /* -------------------------------------------------------------- glossary */
  const glossaryFile = join(tmp.dir, '术语表.md')
  const added = await G.addGlossaryEntry(glossaryFile, { zh: '工程量清单', en: 'Bill of Quantities', field: '造价', note: '' })
  check('glossary 新增', added.ok === true && added.entry.id.length === 12)
  check('glossary 首次写入不产生 .bak', await readFile(glossaryFile + '.bak', 'utf8').then(() => false, () => true))

  const duplicated = await G.addGlossaryEntry(glossaryFile, { zh: '工程量清单', en: 'Bill of Quantities' })
  check('glossary 重复被拒', duplicated.ok === false && duplicated.code === 'duplicate')

  const before = await readFile(glossaryFile, 'utf8')
  const piped = await G.addGlossaryEntry(glossaryFile, { zh: 'a|b', en: 'x' })
  check('glossary 含竖线被拒且文件不变', piped.ok === false && (await readFile(glossaryFile, 'utf8')) === before)
  check('glossary 空条目被拒', (await G.addGlossaryEntry(glossaryFile, { zh: '', en: '' })).ok === false)
  check('glossary 超长被拒', (await G.addGlossaryEntry(glossaryFile, { zh: 'x'.repeat(201), en: '' })).ok === false)

  const second = await G.addGlossaryEntry(glossaryFile, { zh: '综合单价', en: 'Comprehensive Unit Price', field: '造价' })
  const updated = await G.updateGlossaryEntry(glossaryFile, added.entry.id, { zh: '工程量清单', en: 'Bill of Quantities (BOQ)', field: '造价', note: '改过' })
  check('glossary 改 key 生成新 id', updated.ok === true && updated.entry.id !== added.entry.id)
  check('glossary 改后 .bak 留住旧版', (await readFile(glossaryFile + '.bak', 'utf8')).includes('Bill of Quantities'))
  check('glossary 删除', (await G.deleteGlossaryEntry(glossaryFile, second.entry.id)).ok === true)
  check('glossary 解析回两条→一条', G.parseGlossary(await readFile(glossaryFile, 'utf8')).length === 1)
  const multi = await G.addGlossaryEntry(glossaryFile, { zh: '测试句式', en: 'test pattern', tag: '句式，待核，句式' })
  check('标签多值去重与规范化', multi.ok === true && multi.entry.tag === '句式, 待核', multi.entry?.tag)
  check('标签清空', (await G.updateGlossaryEntry(glossaryFile, multi.entry.id, { zh: '测试句式', en: 'test pattern', tag: '' })).entry.tag === '')


  /* ---------------------------------------------------------------- 三张表 */
  const workbenchDir = join(tmp.dir, 'Workbench')
  await mkdir(workbenchDir, { recursive: true })
  const tables = createCostTables({ workbenchDir })
  check('三张表路径落在 Workbench', tables.standards.file.endsWith(join('Workbench', '计价依据.md')), tables.standards.file)
  check('三张表列数一致', tables.standards.header.length === tables.standards.keys.length && tables.prices.header.length === 7 && tables.changes.header.length === 6)

  const std = await tables.standards.api.add(tables.standards.file, { code: 'GB50500', name: '建设工程工程量清单计价规范', category: '计价规范', version: 'GB 50500-2013', date: '2013-07-01', note: '' })
  check('计价依据新增', std.ok === true && std.entry.id.length === 12)
  const dupStd = await tables.standards.api.add(tables.standards.file, { code: 'GB50500', name: '另一个名字' })
  check('计价依据主键重复被拒', dupStd.ok === false && dupStd.code === 'duplicate')

  const price = await tables.prices.api.add(tables.prices.file, { name: '螺纹钢', spec: 'HRB400E φ20', unit: 't', price: '3950', region: '杭州', date: '2026-10-01', source: '信息价' })
  check('材料价格新增', price.ok === true)
  const price2 = await tables.prices.api.add(tables.prices.file, { name: '螺纹钢', spec: 'HRB400E φ20', unit: 't', region: '上海' })
  check('材料价格同规格不同地区可并存', price2.ok === true)
  const dupPrice = await tables.prices.api.add(tables.prices.file, { name: '螺纹钢', spec: 'HRB400E φ20', unit: 't', region: '杭州' })
  check('材料价格同主键被拒', dupPrice.ok === false && dupPrice.code === 'duplicate')

  const change = await tables.changes.api.add(tables.changes.file, { code: 'BG-001', project: '示例项目', reason: '增加抗浮锚杆', amount: '120000', date: '2026-10-20', status: '待审批' })
  check('变更签证新增', change.ok === true)
  const updatedChange = await tables.changes.api.update(tables.changes.file, change.entry.id, { code: 'BG-001', project: '示例项目', reason: '增加抗浮锚杆', amount: '135000', date: '2026-10-20', status: '已批准' })
  check('变更签证修改并落盘', updatedChange.ok === true && (await readFile(tables.changes.file, 'utf8')).includes('135000'))
  check('变更签证删除', (await tables.changes.api.remove(tables.changes.file, updatedChange.entry.id)).ok === true)

  check('搜索命中三表字段', entryMatches({ name: '螺纹钢', spec: 'HRB400E' }, tables.prices.keys, 'hrb400e'))
  check('搜索不误命中', !entryMatches({ name: '螺纹钢' }, tables.prices.keys, '混凝土'))

  /* ----------------------------------------------------------------- vault */
  const vaultRoot = join(tmp.dir, 'vault')
  await mkdir(join(vaultRoot, 'SOP', '子目录'), { recursive: true })
  await writeFile(join(vaultRoot, 'SOP', '甲.md'), '# 甲\n第一段\n\n**小节一**\n内容一\n', 'utf8')
  await writeFile(join(vaultRoot, 'SOP', '子目录', '乙.md'), '乙的正文\n', 'utf8')
  const store = createVaultStore({ vaultRoot, sopDir: 'SOP', backupDir: join(vaultRoot, 'backups') })

  const tree = await store.tree()
  check('vault 树含目录与笔记', tree.length === 2 && tree[0].type === 'dir' && tree[0].count === 1)
  const listed = await store.discover({ force: true })
  check('vault 发现两篇', listed.source === 'fs' && listed.notes.length === 2)

  const note = await store.readNote('SOP/甲.md')
  check('vault 小节切片', note.sections.length === 2 && note.sections[1].title === '小节一')
  check('vault 摘要去 markdown', previewOf(note.text).startsWith('甲 第一段') || previewOf(note.text).startsWith('第一段'), previewOf(note.text))

  const conflict = await store.writeNote('SOP/甲.md', 'x', { expectedSha1: 'deadbeef' }).then(() => 'WROTE', (error) => error.code)
  check('vault 指纹不符拒写', conflict === 'conflict')
  const saved = await store.writeNote('SOP/甲.md', '改后正文\n', { expectedSha1: note.sha1 })
  check('vault 正确指纹写入', saved.sha1.length === 40)
  check('vault 备份落在指定目录', (await readFile(join(vaultRoot, 'backups', 'SOP__甲.md.bak'), 'utf8')).includes('第一段'))
  check('vault 笔记旁没有 .bak', await readFile(join(vaultRoot, 'SOP', '甲.md.bak'), 'utf8').then(() => false, () => true))
  check('vault 同名新建被拒', await store.createNote('SOP/甲.md', 'x').then(() => 'CREATED', (error) => error.code) === 'exists')
  check('vault 越界被拒', await store.readNote('../../etc/passwd').then(() => 'READ', (error) => error.code) === 'bad_path')
  check('vault 深链不带 .md 且编码', store.uriFor('SOP/子目录/乙.md') === 'obsidian://open?vault=vault&file=SOP/%E5%AD%90%E7%9B%AE%E5%BD%95/%E4%B9%99', store.uriFor('SOP/子目录/乙.md'))

  /* ------------------------------------------------------------ 解析边界 */
  check('sectionsOf 忽略空白开头', sectionsOf('\n\n**一**\n正文\n').length === 1)
  check('sectionsOf 保留开头顶部正文', sectionsOf('前言\n\n**一**\n正文\n')[0].title === '（开头）')
} finally {
  await tmp.cleanup()
  await rm(tmp.dir, { recursive: true, force: true }).catch(() => {})
}

assert.ok(report())
