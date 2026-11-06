/**
 * 术语表：中文｜英文｜领域｜标签｜备注。
 *
 * 存储与写盘由 lib/table.js 统一实现，这里只声明这张表的列与文案。
 * 四列老文件（无标签列）照读，第四列当备注、标签留空，写回时自动补成五列。
 */
import { createTable, TableValidationError } from './table.js'

const table = createTable({
  header: ['中文', '英文', '领域', '标签', '备注'],
  keys: ['zh', 'en', 'field', 'tag', 'note'],
  idKeys: ['zh', 'en'],
  legacy: { index: 3 },
  heading: '# 造价中英术语表',
  intro: '由工作台维护。清单、定额、合同、招投标里的中英对照都记在这里；新增、修改、删除都在工作台里做，落盘即生效，也可以直接编辑本文件，保持下面这张表即可。',
})

/** 标签存成 "句式, 待核" 这种形状：半角逗号分隔、去空白、去重、保序。 */
export function tidyTags(value) {
  return String(value ?? '')
    .split(/[,，;；]/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .filter((part, index, all) => all.indexOf(part) === index)
    .join(', ')
}

/** 只规范化标签，其余字段原样交给通用表。 */
function withTidyTags(input) {
  if (input === null || typeof input !== 'object') return input
  return { ...input, tag: tidyTags(input.tag) }
}

export { TableValidationError as GlossaryValidationError }

export const parseGlossary = (text) => table.parse(text)
export const serializeGlossary = (entries) => table.serialize(entries)
export const glossaryId = (zh, en) => table.idOf({ zh, en })
export const normalizeEntry = (input, options) => table.normalize(withTidyTags(input), options)
export const readGlossary = (file) => table.read(file)
export const addGlossaryEntry = (file, input) => table.add(file, withTidyTags(input))
export const updateGlossaryEntry = (file, id, input) => table.update(file, id, withTidyTags(input))
export const deleteGlossaryEntry = (file, id) => table.remove(file, id)

/** 整表文本（用于「整表插入」）。 */
export function glossaryTableText(entries) {
  const width = (text) => [...String(text ?? '')].reduce((n, char) => n + (char.charCodeAt(0) > 255 ? 2 : 1), 0)
  const columns = [entries.map((e) => e.zh), entries.map((e) => e.en), entries.map((e) => e.field)]
  const widths = columns.map((cells) => Math.max(4, ...cells.map(width)))
  const pad = (text, size) => String(text ?? '') + ' '.repeat(Math.max(0, size - width(text)))
  const lines = [pad('中文', widths[0]) + '  ' + pad('英文', widths[1]) + '  ' + pad('领域', widths[2])]
  for (const entry of entries) {
    lines.push(pad(entry.zh, widths[0]) + '  ' + pad(entry.en, widths[1]) + '  ' + pad(entry.field, widths[2]))
  }
  return lines.join('\n')
}
