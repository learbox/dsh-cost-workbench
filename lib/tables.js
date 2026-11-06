/**
 * 造价三张表：计价依据 / 材料价格 / 变更签证。
 *
 * 存储完全复用 lib/table.js（解析、校验、备份、原子写），这里只声明列、
 * 主键和落盘文件名，让 Host 路由与界面共用同一份定义。
 *
 * 三张表都落在 vault 的 Workbench 目录下，Obsidian 里能直接打开、直接改。
 */
import { join } from 'node:path'

import { createTable } from './table.js'

/** 三张表的卡片 kind 与路由基路径（与 client.js 的 kind 一一对应）。 */
export const COST_TABLE_KINDS = ['standards', 'prices', 'changes']

/**
 * 建三张表。
 * @param {{workbenchDir: string}} options vault 下的工作台目录
 * @returns {Record<string, {file: string, keys: string[], header: string[], api: object}>}
 */
export function createCostTables({ workbenchDir }) {
  const standards = createTable({
    header: ['编号', '名称', '类别', '版本文号', '实施日期', '备注'],
    keys: ['code', 'name', 'category', 'version', 'date', 'note'],
    idKeys: ['code'],
    heading: '# 计价依据速查',
    intro: '由工作台维护：清单计价规范、消耗量定额、面积计算规则、合同示范文本等都可记在这里。也可以直接编辑本文件，保持下面表格的格式即可。',
  })

  const prices = createTable({
    header: ['材料', '规格', '单位', '单价', '地区', '日期', '来源'],
    keys: ['name', 'spec', 'unit', 'price', 'region', 'date', 'source'],
    idKeys: ['name', 'spec', 'unit', 'region'],
    heading: '# 材料价格库',
    intro: '记录询价与信息价，便于组价和变更签证取证。同一种材料在不同地区分开记；同一主键重复新增会被拒绝。',
  })

  const changes = createTable({
    header: ['编号', '项目', '事由', '金额', '日期', '状态'],
    keys: ['code', 'project', 'reason', 'amount', 'date', 'status'],
    idKeys: ['code'],
    heading: '# 变更签证台账',
    intro: '变更、签证、索赔的流水账。编号建议沿用项目内部编号（如 BG-001），状态可写「待审批 / 已批准 / 已结算 / 已驳回」。',
  })

  const wrap = (table, file) => ({
    file,
    keys: table.keys,
    header: table.header,
    api: {
      read: table.read,
      add: table.add,
      update: table.update,
      remove: table.remove,
      keys: table.keys,
    },
  })

  return {
    standards: wrap(standards, join(workbenchDir, '计价依据.md')),
    prices: wrap(prices, join(workbenchDir, '材料价格.md')),
    changes: wrap(changes, join(workbenchDir, '变更签证台账.md')),
  }
}

/**
 * 在一条表格记录里做全文匹配（大小写不敏感）。
 * @param {object} entry 表格条目
 * @param {string[]} keys 参与匹配的字段
 * @param {string} lower 已转小写的查询词
 */
export function entryMatches(entry, keys, lower) {
  return keys.some((key) => String(entry?.[key] ?? '').toLowerCase().includes(lower))
}
