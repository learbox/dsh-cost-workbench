/**
 * cards.json：工作台的唯一卡片清单。
 *
 * 纪律：
 *  · 文件不存在 → 用内置卡（不报错，卡片照常可用）；
 *  · 文件损坏 / 结构不对 → 内置卡 + warning（界面显示警告条，不静默回落）；
 *  · 单条坏卡片只丢这一条，其余照常渲染；
 *  · 未知 kind 不当错误，交给界面渲染「暂不支持」占位。
 */
import { readFile } from 'node:fs/promises'

/** 内置卡：文件缺失或损坏时的回退清单（与设计稿一致）。 */
export const BUILTIN_CARDS = [
  { id: 'sop', kind: 'sop', title: '资料库', order: 10 },
  { id: 'standards', kind: 'standards', title: '计价依据', order: 20 },
  { id: 'prices', kind: 'prices', title: '材料价格', order: 30 },
  { id: 'changes', kind: 'changes', title: '变更签证', order: 40 },
  { id: 'calc', kind: 'calc', title: '造价计算器', order: 50 },
  { id: 'glossary', kind: 'glossary', title: '术语表', order: 60 },
  { id: 'recorder', kind: 'recorder', title: '会议记录', order: 70 },
  { id: 'prompt', kind: 'prompt', title: '提示词模板', order: 80 },
]

const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** 单条卡片归一；返回 null 表示这条不能用（丢掉，不影响其余）。 */
function normalizeCard(raw, seen) {
  if (raw === null || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : ''
  if (id === '' || kind === '') return null
  if (!ID_PATTERN.test(id) || seen.has(id)) return null
  seen.add(id)
  const card = { id, kind }
  card.title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : id
  if (Number.isFinite(raw.order)) card.order = raw.order
  if (typeof raw.promptId === 'string' && raw.promptId.trim() !== '') card.promptId = raw.promptId.trim()
  if (typeof raw.note === 'string' && raw.note.trim() !== '') card.note = raw.note.trim()
  // placement: "strip" = 不占 tab，渲染成标题下方的状态条（未知值一律按 tab 处理）。
  if (raw.placement === 'strip' || raw.placement === 'tab') card.placement = raw.placement
  return card
}

/**
 * 读 cards.json。
 * @returns {{cards: object[], source: 'file'|'builtin', warning?: string}}
 */
export async function readCards(cardsFile) {
  let text
  try {
    text = await readFile(cardsFile, 'utf8')
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    if (code === 'ENOENT') {
      // 首次运行没有 cards.json 是正常状态，不弹警告
      return { cards: BUILTIN_CARDS, source: 'builtin' }
    }
    return { cards: BUILTIN_CARDS, source: 'builtin', warning: 'cards.json 读取失败，已用内置卡：' + describe(error) }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { cards: BUILTIN_CARDS, source: 'builtin', warning: 'cards.json 不是合法 JSON，已用内置卡；改好后刷新即可恢复' }
  }

  const list = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.cards) ? parsed.cards : null
  if (list === null) {
    return { cards: BUILTIN_CARDS, source: 'builtin', warning: 'cards.json 缺少 cards 数组，已用内置卡' }
  }

  const seen = new Set()
  const cards = []
  for (const item of list) {
    const card = normalizeCard(item, seen)
    if (card !== null) cards.push(card)
  }
  if (cards.length === 0) {
    return { cards: BUILTIN_CARDS, source: 'builtin', warning: 'cards.json 里没有一条可用卡片，已用内置卡' }
  }
  cards.sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
  const warning = cards.length < list.length ? `cards.json 有 ${list.length - cards.length} 条卡片不合法已跳过` : undefined
  return warning === undefined ? { cards, source: 'file' } : { cards, source: 'file', warning }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
