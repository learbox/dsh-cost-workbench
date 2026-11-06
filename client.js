/**
 * dsh-cost-workbench · Client 半边（浏览器）
 *
 * 三件事：
 *  ① 会话头部加一个「造价工作台」图标按钮；
 *  ② 打开工作台：**只用浮层**，不注册右侧栏标签类型、不碰 layout 的右栏状态
 *     （曾尝试注册侧栏标签，一旦该类型在某个会话里出错，会把整条右栏连预览一起带走）；
 *  ③ 正文按 cards.json 渲染卡片：资料库 / 计价依据 / 材料价格 / 变更签证 / 造价计算器 /
 *     术语表 / 会议记录 / 提示词模板；每张卡自己取数、自己报错——一张坏掉不影响其它卡。
 *
 * 双模式：工具栏右侧「造价 / 普通」切换；普通模式卡片全部隐藏、只留搜索，
 * 状态存 localStorage（dsh-cost-workbench.mode），不写 vault、不写配置。
 *
 * 资料库卡的数据源是 Obsidian vault 里的 md 笔记本身：列表、读、改、新建都走同一个文件。
 * 拖宽、全屏、关闭由宿主右侧栏壳层提供。插入 prompt 只写输入框、不发送；输入框已有草稿
 * 时先弹确认条（追加 / 覆盖 / 取消），读不出草稿时也先确认，绝不盲写。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cost-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ADDRESS_PREFIX = 'dsh-resource://dsh-workbench/'
    const TAB_ID = 'dsh-workbench.panel'
    const TAB_KIND = 'dsh-workbench'
    const TAB_ADDRESS = ADDRESS_PREFIX + 'panel'
    const API = '/api/dsh-workbench'

/* ---------------------------------------------------------------- 一、三表 UI 元数据 */

/**
 * 三张表的前端元数据。
 *   api      路由基路径（拼在 API = '/api/dsh-workbench' 之后）
 *   titleKey 卡片标题的 i18n 键（cards.json 给了 title 时优先用 card.title）
 *   subKey   卡片说明的 i18n 键（渲染到 CardShell 的 note）
 *   emptyKey 空表提示的 i18n 键（三张表共用 table.empty）
 *   chipKey  行标题右侧显示成 dsh-wb-chip 的字段（可省略）
 *   idKeys   主键字段：新增/保存前做一次客户端校验，全空时提示 table.needKey
 *   fields   列顺序 = 表单顺序 = Markdown 行内插入顺序；key 与 Host 字段名一一对应
 *
 * 文案键全部沿用 client.js 现有字典（standards.field.* / table.* 等）；
 * WB_TABLES 的位置顺序就是界面里的列顺序，必须与 lib/tables.js 的 header / keys 对齐。
 */
const WB_TABLES = {
  standards: {
    api: '/standards',
    titleKey: 'standards.title',
    subKey: 'standards.sub',
    emptyKey: 'table.empty',
    chipKey: 'category',
    idKeys: ['code'],
    fields: [
      { key: 'code', labelKey: 'standards.field.code' },
      { key: 'name', labelKey: 'standards.field.name' },
      { key: 'category', labelKey: 'standards.field.category' },
      { key: 'version', labelKey: 'standards.field.version' },
      { key: 'date', labelKey: 'standards.field.date' },
      { key: 'note', labelKey: 'standards.field.note' },
    ],
  },
  prices: {
    api: '/prices',
    titleKey: 'prices.title',
    subKey: 'prices.sub',
    emptyKey: 'table.empty',
    chipKey: 'unit',
    idKeys: ['name', 'spec', 'unit', 'region'],
    fields: [
      { key: 'name', labelKey: 'prices.field.name' },
      { key: 'spec', labelKey: 'prices.field.spec' },
      { key: 'unit', labelKey: 'prices.field.unit' },
      { key: 'price', labelKey: 'prices.field.price' },
      { key: 'region', labelKey: 'prices.field.region' },
      { key: 'date', labelKey: 'prices.field.date' },
      { key: 'source', labelKey: 'prices.field.source' },
    ],
  },
  changes: {
    api: '/changes',
    titleKey: 'changes.title',
    subKey: 'changes.sub',
    emptyKey: 'table.empty',
    chipKey: 'status',
    idKeys: ['code'],
    fields: [
      { key: 'code', labelKey: 'changes.field.code' },
      { key: 'project', labelKey: 'changes.field.project' },
      { key: 'reason', labelKey: 'changes.field.reason' },
      { key: 'amount', labelKey: 'changes.field.amount' },
      { key: 'date', labelKey: 'changes.field.date' },
      { key: 'status', labelKey: 'changes.field.status' },
    ],
  },
}

/* ------------------------------------------------------------ 二、造价计算纯函数 */

/**
 * 严格的数字解析：空串、null、undefined、'abc'、'1,000' 都返回 NaN。
 * 纯函数内部统一用它，保证「非法输入绝不抛异常，只返回 NaN」。
 */
function wbNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  const text = String(value ?? '').trim()
  if (text === '') return NaN
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : NaN
}

/** 结果展示统一保留两位小数；NaN 返回空串（由调用方显示「请输入数字」）。 */
function wbFixed(value) {
  return Number.isFinite(value) ? value.toFixed(2) : ''
}

/**
 * 对本次新增的少数 i18n 键做中文兜底。
 * t() 缺键时会回退成键名本身（makeT 规则：EN → ZH → key），这里换成默认中文，
 * 这样即使 Lead 漏加 `table.saved` 这类键，界面也不会直接露出键名。
 */
function wbText(t, key, fallback) {
  const text = t(key)
  return text === key ? fallback : text
}

/** a / b；任一非法或 b 为 0 时返回 NaN。 */
function wbRatio(top, bottom) {
  const a = wbNumber(top)
  const b = wbNumber(bottom)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return NaN
  return a / b
}

/** 从一个对象里按候选键名取第一个非空值（给 totalCost 的别名兼容用）。 */
function wbPick(source, keys, fallback) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = source[key]
      if (value !== undefined && value !== null && String(value).trim() !== '') return value
    }
  }
  return fallback
}

/** 单位换算因子表：只有 dim 相同的单位之间才能换算。 */
const WB_UNIT_FACTORS = {
  m3: { dim: 'volume', factor: 1000 },
  l: { dim: 'volume', factor: 1 },
  t: { dim: 'mass', factor: 1000 },
  kg: { dim: 'mass', factor: 1 },
  mpa: { dim: 'stress', factor: 1 },
  'n/mm2': { dim: 'stress', factor: 1 },
  wanyuan: { dim: 'money', factor: 10000 },
  yuan: { dim: 'money', factor: 1 },
  m2: { dim: 'area', factor: 1 },
  mu: { dim: 'area', factor: 2000 / 3 },
}

/** 界面与测试里可能出现的各种单位写法 → 因子表的键。 */
const WB_UNIT_ALIASES = {
  m3: 'm3',
  'm³': 'm3',
  立方米: 'm3',
  l: 'l',
  L: 'l',
  升: 'l',
  t: 't',
  吨: 't',
  kg: 'kg',
  千克: 'kg',
  mpa: 'mpa',
  MPa: 'mpa',
  'n/mm2': 'n/mm2',
  'n/mm²': 'n/mm2',
  'N/mm2': 'n/mm2',
  'N/mm²': 'n/mm2',
  wanyuan: 'wanyuan',
  万元: 'wanyuan',
  yuan: 'yuan',
  元: 'yuan',
  m2: 'm2',
  'm²': 'm2',
  平方米: 'm2',
  mu: 'mu',
  亩: 'mu',
}

/** 单位名 → { dim, factor }；不认识返回 null。 */
function wbUnitOf(name) {
  const text = String(name ?? '').trim()
  if (text === '') return null
  const code = WB_UNIT_ALIASES[text] ?? WB_UNIT_ALIASES[text.toLowerCase()]
  if (code === undefined) return null
  const unit = WB_UNIT_FACTORS[code]
  return unit !== undefined ? { dim: unit.dim, factor: unit.factor } : null
}

/** 换算下拉框的选项。单位符号（m³/L/t/…）本身跨语言，直接写死，不占用 i18n 键。 */
const WB_CALC_UNITS = [
  { code: 'm3', label: 'm³' },
  { code: 'l', label: 'L' },
  { code: 't', label: 't' },
  { code: 'kg', label: 'kg' },
  { code: 'mpa', label: 'MPa' },
  { code: 'n/mm2', label: 'N/mm²' },
  { code: 'wanyuan', label: '万元' },
  { code: 'yuan', label: '元' },
  { code: 'm2', label: 'm²' },
  { code: 'mu', label: '亩' },
]

/**
 * 造价计算纯函数集合。UI 与测试共用同一批实现，CalcCard 只做取值与展示，禁止重复实现公式。
 *
 * 约定：
 *   - 入参可以是数字，也可以是数字字符串（来自 input 的原始值），内部用 wbNumber 严格解析；
 *   - 任何非法输入返回 NaN，**不抛异常**；
 *   - 返回未四舍五入的原始数值，展示层用 wbFixed(...) 保留两位小数，方便用户核对中间过程；
 *   - 费率类字段（overheadRate / profitRate / taxRate）都用百分数，例如 9 表示 9%。
 *
 * 字段名（与 README / Lead 的测试约定一致）：
 *   unitPrice({ labor, material, machine, overheadRate, profitRate, fee, taxRate })
 *   totalCost({ direct, measures, other, fee, taxRate })
 *     direct = 分部分项工程费，measures = 措施项目费，other = 其他项目费，fee = 规费
 *     兼容别名：direct ← part / works / 分部分项；measures ← measure / 措施项目 / 措施；
 *               other ← others / 其他项目 / 其他
 */
const WB_CALC = {
  /** 钢筋理论重量：w = d² × 0.00617（kg/m），d 为直径 mm。 */
  rebarWeight(diameter) {
    const d = wbNumber(diameter)
    if (!Number.isFinite(d) || d <= 0) return NaN
    return d * d * 0.00617
  },

  /** 综合单价 = (人工+材料+机械) × (1+管理费率/100) × (1+利润率/100) + 规费，再 × (1+税率/100)。 */
  unitPrice(input) {
    const source = input !== null && typeof input === 'object' ? input : {}
    const labor = wbNumber(source.labor)
    const material = wbNumber(source.material)
    const machine = wbNumber(source.machine)
    const overheadRate = wbNumber(source.overheadRate)
    const profitRate = wbNumber(source.profitRate)
    const fee = source.fee === undefined ? 0 : wbNumber(source.fee)
    const taxRate = source.taxRate === undefined ? 9 : wbNumber(source.taxRate)
    const values = [labor, material, machine, overheadRate, profitRate, fee, taxRate]
    if (!values.every((value) => Number.isFinite(value))) return NaN
    const base = labor + material + machine
    const withFee = base * (1 + overheadRate / 100) * (1 + profitRate / 100) + fee
    return withFee * (1 + taxRate / 100)
  },

  /** 总造价 = (分部分项+措施+其他+规费) × (1+税率/100)，税率默认 9。 */
  totalCost(input) {
    const source = input !== null && typeof input === 'object' ? input : {}
    const direct = wbNumber(wbPick(source, ['direct', 'part', 'works', '分部分项'], undefined))
    const measures = wbNumber(wbPick(source, ['measures', 'measure', '措施项目', '措施'], undefined))
    const other = wbNumber(wbPick(source, ['other', 'others', '其他项目', '其他'], undefined))
    const fee = source.fee === undefined ? 0 : wbNumber(source.fee)
    const taxRate = source.taxRate === undefined ? 9 : wbNumber(source.taxRate)
    const values = [direct, measures, other, fee, taxRate]
    if (!values.every((value) => Number.isFinite(value))) return NaN
    return (direct + measures + other + fee) * (1 + taxRate / 100)
  },

  /** 单位造价 = 总价 / 建筑面积（元/m²）。 */
  costPerArea(total, area) {
    return wbRatio(total, area)
  },

  /**
   * 含钢量 = 钢筋总量 / 建筑面积。
   * 入参单位由调用方决定：CalcCard 里钢筋总量填 kg、面积填 m²，得到 kg/m²。
   */
  steelPerArea(steel, area) {
    return wbRatio(steel, area)
  },

  /** 单位换算：m³↔L、t↔kg、MPa↔N/mm²、万元↔元、m²↔亩；跨维度返回 NaN。 */
  convert(value, from, to) {
    const amount = wbNumber(value)
    const source = wbUnitOf(from)
    const target = wbUnitOf(to)
    if (!Number.isFinite(amount) || source === null || target === null || source.dim !== target.dim) return NaN
    return (amount * source.factor) / target.factor
  },
}

    const ZH = {
      'tab.title': '造价工作台',
      'header.open': '造价工作台',
      'mode.cost': '造价',
      'mode.lite': '普通',
      'mode.hint': '普通模式：卡片全部隐藏，只保留搜索',
      'panel.refresh': '刷新',
      'panel.loading': '读取中…',
      'panel.retry': '重试',
      'panel.error': '读取失败',
      'panel.unsupported': '暂不支持这个卡片类型',
      'panel.search': '搜索资料 / 术语 / 清单 / 录音…',
      'panel.searchEmpty': '没有搜到',
      'panel.searchHit': '条命中',
      'panel.openNote': '去资料库',
      'panel.openCard': '去卡片',
      'panel.liteNotice': '当前是普通模式：卡片已隐藏，只保留搜索。点右上角「造价」回到造价模式。',
      'src.sop': '资料库',
      'src.standards': '计价依据',
      'src.prices': '材料价格',
      'src.changes': '变更签证',
      'src.glossary': '术语',
      'src.recording': '录音',
      'src.calc': '计算器',
      'insert.pending.title': '输入框已有草稿',
      'insert.append': '追加',
      'insert.overwrite': '覆盖',
      'insert.cancel': '取消',
      'insert.done': '已插入输入框，未发送',
      'insert.failed': '插入失败：没找到输入框通道',
      'copy.done': '已复制',
      'copy.failed': '复制失败',
      'sop.pages': '篇',
      'sop.chars': '字',
      'sop.updated': '最近改动',
      'sop.rebuild': '重新扫描',
      'sop.open': '打开',
      'sop.edit': '编辑',
      'sop.insert': '插入',
      'sop.copy': '复制',
      'sop.save': '保存',
      'sop.new': '新建',
      'sop.cancel': '取消',
      'sop.reload': '重新载入',
      'sop.saved': '已保存；Obsidian 会立即看到',
      'sop.created': '已新建笔记',
      'sop.conflict': '这篇在 Obsidian 里被改过了，已拒绝保存。点「重新载入」拿到最新内容再改。',
      'sop.conflictForce': '仍要覆盖',
      'sop.groupRoot': '（根目录）',
      'sop.noNotes': '这个目录下还没有 md 笔记',
      'sop.noMatch': '没有命中',
      'sop.source.spotlight': '列表走 Spotlight 兜底',
      'sop.folder': '目录',
      'sop.filename': '文件名',
      'sop.creating': '新建笔记',
      'sop.newTitle': '笔记名，如 招标流程',
      'sop.editing': '编辑笔记',
      'sop.body': '正文（Markdown）',
      'sop.pickNote': '从左边选一篇笔记',
      'sop.props': '笔记属性',
      'sop.nav': '目录',
      'sop.showNav': '显示目录',
      'sop.hideNav': '隐藏目录',
      'glossary.search': '搜索中文 / 英文 / 领域',
      'glossary.add': '新增',
      'glossary.edit': '编辑',
      'glossary.del': '删除',
      'glossary.save': '保存',
      'glossary.cancel': '取消',
      'glossary.copy': '复制',
      'glossary.insertAll': '整表插入',
      'glossary.empty': '还没有术语，点「新增」开始',
      'glossary.confirmDelete': '确定删除这条术语？',
      'glossary.zh': '中文',
      'glossary.en': '英文',
      'glossary.field': '领域',
      'glossary.tag': '标签',
      'glossary.tagHint': '多个标签用逗号分隔，如：清单, 待核',
      'glossary.note': '备注',
      'glossary.heading': '造价术语表',
      'table.search': '搜索…',
      'table.add': '新增',
      'table.edit': '编辑',
      'table.del': '删除',
      'table.save': '保存',
      'table.cancel': '取消',
      'table.copy': '复制',
      'table.insert': '插入',
      'table.empty': '还没有记录，点「新增」开始',
      'table.total': '条记录',
      'table.creating': '新增记录',
      'table.editing': '编辑记录',
      'table.confirmDelete': '确定删除这条记录？',
      'table.needKey': '请至少填写主键字段',
      'table.added': '已新增',
      'table.saved': '已保存',
      'table.deleted': '已删除',
      'table.failed': '操作失败：',
      'standards.title': '计价依据',
      'standards.sub': '清单规范、消耗量定额、面积规则、合同示范文本',
      'standards.field.code': '编号',
      'standards.field.name': '名称',
      'standards.field.category': '类别',
      'standards.field.version': '版本文号',
      'standards.field.date': '实施日期',
      'standards.field.note': '备注',
      'prices.title': '材料价格',
      'prices.sub': '询价与信息价，供组价与签证取证',
      'prices.field.name': '材料',
      'prices.field.spec': '规格',
      'prices.field.unit': '单位',
      'prices.field.price': '单价',
      'prices.field.region': '地区',
      'prices.field.date': '日期',
      'prices.field.source': '来源',
      'changes.title': '变更签证',
      'changes.sub': '变更、签证、索赔流水账',
      'changes.field.code': '编号',
      'changes.field.project': '项目',
      'changes.field.reason': '事由',
      'changes.field.amount': '金额',
      'changes.field.date': '日期',
      'changes.field.status': '状态',
      'calc.title': '造价计算器',
      'calc.sub': '综合单价、总造价、钢筋、单位指标、换算',
      'calc.unitPrice': '综合单价组价',
      'calc.totalCost': '总造价',
      'calc.rebar': '钢筋理论重量',
      'calc.indicators': '单位指标',
      'calc.convert': '单位换算',
      'calc.labor': '人工费',
      'calc.material': '材料费',
      'calc.machine': '机械费',
      'calc.overhead': '管理费率%',
      'calc.profit': '利润率%',
      'calc.fee': '规费',
      'calc.tax': '税率%',
      'calc.subtotal': '分部分项',
      'calc.measures': '措施费',
      'calc.others': '其他项目',
      'calc.area': '建筑面积',
      'calc.steel': '钢筋总量',
      'calc.costPerArea': '单位造价',
      'calc.steelPerArea': '含钢量',
      'calc.diameter': '直径(mm)',
      'calc.rebarHint': '多个直径用逗号分隔，如 16,20,25',
      'calc.value': '数值',
      'calc.from': '从',
      'calc.to': '到',
      'calc.result': '结果',
      'calc.calculate': '计算',
      'calc.invalid': '请输入数字',
      'state.ok': '存在',
      'state.missing': '缺失',
      'state.denied': '无权限',
      'state.unset': '未配置',
      'state.error': '异常',
      'state.ready': '就绪',
      'state.idle': '待读取',
      'state.stale': '缓存',
      'state.unsupported': '不支持',
    }
    const EN = {
      'tab.title': 'Cost Workbench',
      'header.open': 'Cost Workbench',
      'mode.cost': 'Cost',
      'mode.lite': 'Lite',
      'mode.hint': 'Lite mode: all cards hidden, search only',
      'panel.refresh': 'Refresh',
      'panel.loading': 'Loading…',
      'panel.retry': 'Retry',
      'panel.error': 'Could not load',
      'panel.unsupported': 'This card kind is not supported yet',
      'panel.search': 'Search library / terms / BOQ / recordings…',
      'panel.searchEmpty': 'No match',
      'panel.searchHit': 'hits',
      'panel.openNote': 'Open in library',
      'panel.openCard': 'Open card',
      'panel.liteNotice': 'Lite mode: cards are hidden and only search remains. Click "Cost" at the top right to switch back.',
      'src.sop': 'Library',
      'src.standards': 'Pricing basis',
      'src.prices': 'Material prices',
      'src.changes': 'Variations',
      'src.glossary': 'Terms',
      'src.recording': 'Recording',
      'src.calc': 'Calculator',
      'insert.pending.title': 'Composer already has a draft',
      'insert.append': 'Append',
      'insert.overwrite': 'Overwrite',
      'insert.cancel': 'Cancel',
      'insert.done': 'Inserted into the composer, not sent',
      'insert.failed': 'Insert failed: composer channel not found',
      'copy.done': 'Copied',
      'copy.failed': 'Copy failed',
      'sop.pages': 'notes',
      'sop.chars': 'chars',
      'sop.updated': 'last change',
      'sop.rebuild': 'Rescan',
      'sop.open': 'Open',
      'sop.edit': 'Edit',
      'sop.insert': 'Insert',
      'sop.copy': 'Copy',
      'sop.save': 'Save',
      'sop.new': 'New',
      'sop.cancel': 'Cancel',
      'sop.reload': 'Reload',
      'sop.saved': 'Saved; Obsidian sees it immediately',
      'sop.created': 'Note created',
      'sop.conflict': 'This note changed elsewhere (likely Obsidian). Save refused — reload first.',
      'sop.conflictForce': 'Overwrite anyway',
      'sop.groupRoot': '(root)',
      'sop.noNotes': 'No markdown notes here yet',
      'sop.noMatch': 'No match',
      'sop.source.spotlight': 'listing via Spotlight fallback',
      'sop.folder': 'Folder',
      'sop.filename': 'File name',
      'sop.creating': 'New note',
      'sop.newTitle': 'e.g. Tender workflow',
      'sop.editing': 'Edit note',
      'sop.body': 'Body (Markdown)',
      'sop.pickNote': 'Pick a note on the left',
      'sop.props': 'Properties',
      'sop.nav': 'Explorer',
      'sop.showNav': 'Show explorer',
      'sop.hideNav': 'Hide explorer',
      'glossary.search': 'Search Chinese / English / field',
      'glossary.add': 'Add',
      'glossary.edit': 'Edit',
      'glossary.del': 'Delete',
      'glossary.save': 'Save',
      'glossary.cancel': 'Cancel',
      'glossary.copy': 'Copy',
      'glossary.insertAll': 'Insert whole table',
      'glossary.empty': 'No terms yet — press Add',
      'glossary.confirmDelete': 'Delete this term?',
      'glossary.zh': 'Chinese',
      'glossary.en': 'English',
      'glossary.field': 'Field',
      'glossary.tag': 'Tag',
      'glossary.tagHint': 'Separate tags with commas, e.g. BOQ, to-check',
      'glossary.note': 'Note',
      'glossary.heading': 'Cost glossary',
      'table.search': 'Search…',
      'table.add': 'Add',
      'table.edit': 'Edit',
      'table.del': 'Delete',
      'table.save': 'Save',
      'table.cancel': 'Cancel',
      'table.copy': 'Copy',
      'table.insert': 'Insert',
      'table.empty': 'No records yet — press Add',
      'table.total': 'records',
      'table.creating': 'New record',
      'table.editing': 'Edit record',
      'table.confirmDelete': 'Delete this record?',
      'table.needKey': 'Fill in the key field first',
      'table.added': 'Added',
      'table.saved': 'Saved',
      'table.deleted': 'Deleted',
      'table.failed': 'Failed: ',
      'standards.title': 'Pricing basis',
      'standards.sub': 'BOQ codes, consumption quotas, area rules, contract templates',
      'standards.field.code': 'Code',
      'standards.field.name': 'Name',
      'standards.field.category': 'Category',
      'standards.field.version': 'Version',
      'standards.field.date': 'Effective date',
      'standards.field.note': 'Note',
      'prices.title': 'Material prices',
      'prices.sub': 'Quotes and published prices for pricing and claims',
      'prices.field.name': 'Material',
      'prices.field.spec': 'Spec',
      'prices.field.unit': 'Unit',
      'prices.field.price': 'Price',
      'prices.field.region': 'Region',
      'prices.field.date': 'Date',
      'prices.field.source': 'Source',
      'changes.title': 'Variations',
      'changes.sub': 'Variation, daywork and claim ledger',
      'changes.field.code': 'Code',
      'changes.field.project': 'Project',
      'changes.field.reason': 'Reason',
      'changes.field.amount': 'Amount',
      'changes.field.date': 'Date',
      'changes.field.status': 'Status',
      'calc.title': 'Cost calculator',
      'calc.sub': 'Unit price, total cost, rebar, indicators, conversion',
      'calc.unitPrice': 'Comprehensive unit price',
      'calc.totalCost': 'Total cost',
      'calc.rebar': 'Rebar theoretical weight',
      'calc.indicators': 'Unit indicators',
      'calc.convert': 'Unit conversion',
      'calc.labor': 'Labour',
      'calc.material': 'Material',
      'calc.machine': 'Machine',
      'calc.overhead': 'Overhead %',
      'calc.profit': 'Profit %',
      'calc.fee': 'Statutory fee',
      'calc.tax': 'Tax %',
      'calc.subtotal': 'Subtotal works',
      'calc.measures': 'Measures',
      'calc.others': 'Others',
      'calc.area': 'Floor area',
      'calc.steel': 'Total rebar',
      'calc.costPerArea': 'Cost per m²',
      'calc.steelPerArea': 'Steel per m²',
      'calc.diameter': 'Diameter (mm)',
      'calc.rebarHint': 'Comma-separated, e.g. 16,20,25',
      'calc.value': 'Value',
      'calc.from': 'From',
      'calc.to': 'To',
      'calc.result': 'Result',
      'calc.calculate': 'Calculate',
      'calc.invalid': 'Please enter a number',
      'state.ok': 'present',
      'state.missing': 'missing',
      'state.denied': 'denied',
      'state.unset': 'unset',
      'state.error': 'error',
      'state.ready': 'ready',
      'state.idle': 'idle',
      'state.stale': 'cached',
      'state.unsupported': 'unsupported',
    }

    const CSS = `
.dsh-wb-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;min-width:28px;padding:0 8px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:calc(var(--wb-fs) - 1px);line-height:1}
.dsh-wb-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-wb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-wb-btn[disabled]{opacity:.5;cursor:default}
.dsh-wb-btn[data-tone=primary]{background:var(--dsw-alias-brand-primary);color:#fff;border-color:transparent}
.dsh-wb-btn[data-tone=primary]:hover{filter:brightness(1.06);color:#fff}
.dsh-wb-btn[data-tone=quiet]{height:22px;padding:0 6px;font-size:calc(var(--wb-fs) - 2px)}
.dsh-wb-icon-btn{width:28px;padding:0}
.dsh-wb-overlay{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.28)}
.dsh-wb-overlay-panel{width:min(1100px,92vw);height:min(760px,86vh);display:flex;flex-direction:column;overflow:hidden;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);box-shadow:0 24px 64px rgba(0,0,0,.3)}
.dsh-wb-overlay-bar{flex:none;display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-wb-overlay-title{font-size:calc(var(--wb-fs) - 1px);font-weight:600}
.dsh-wb-overlay-body{flex:1;min-height:0;overflow:auto;display:block}
.dsh-wb-overlay-body > .dsh-wb-panel{height:auto;min-height:100%;overflow:visible}
.dsh-wb-panel{--wb-fs:13px;position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:var(--wb-fs)}
.dsh-wb-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:4px;padding:6px 14px 2px}
.dsh-wb-head{display:flex;align-items:flex-start;gap:8px;padding:12px 14px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-wb-head h2{margin:0;font-size:calc(var(--wb-fs) + 1px);font-weight:600}
.dsh-wb-sub{margin-top:3px;font-size:calc(var(--wb-fs) - 1px);color:var(--dsw-alias-label-secondary);line-height:1.45}
.dsh-wb-body{flex:1;min-height:0;overflow:auto;padding:12px 14px 18px;display:flex;flex-direction:column}
.dsh-wb-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 11px}
.dsh-wb-card+.dsh-wb-card{margin-top:10px}
.dsh-wb-card-fill{flex:0 0 auto;display:flex;flex-direction:column}
.dsh-wb-card-fill .dsh-wb-card-body{flex:0 0 auto;display:flex;flex-direction:column}
.dsh-wb-rule{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:7px 9px;margin-bottom:6px}
.dsh-wb-rule-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsh-wb-rule-id{font-size:calc(var(--wb-fs) - 2px);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsh-wb-rule-title{flex:1;min-width:0;font-weight:600;font-size:calc(var(--wb-fs) - 1px)}
.dsh-wb-rule-body{margin-top:4px;line-height:1.65;font-size:calc(var(--wb-fs) - 1px);white-space:pre-wrap}
.dsh-wb-rule-more{margin-top:4px}
.dsh-wb-rule-more summary{cursor:pointer;font-size:calc(var(--wb-fs) - 2px);color:var(--dsw-alias-label-secondary)}
.dsh-wb-rule-edit{padding:8px}
.dsh-wb-rule-field{width:100%;min-height:44px;padding:5px 6px;resize:vertical;font-family:inherit;line-height:1.5}
.dsh-wb-tip{position:absolute;top:calc(100% + 6px);right:0;z-index:80;display:none;white-space:nowrap;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;box-shadow:0 6px 18px rgba(0,0,0,.18);pointer-events:none}
.dsh-wb-badge-btn:hover .dsh-wb-tip{display:block}
.dsh-wb-badge-jump{margin-left:3px;opacity:.55;font-size:calc(var(--wb-fs) - 2px);cursor:pointer}
.dsh-wb-badge-jump:hover{opacity:1}
.dsh-wb-badge-btn{position:relative;display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:calc(var(--wb-fs) - 1px);cursor:pointer}
.dsh-wb-badge-btn b{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dsh-wb-badge-btn[data-state=peak]{background:rgba(255,149,0,.16);border-color:rgba(255,149,0,.55)}
.dsh-wb-badge-btn[data-state=peak] b{color:#c9740a}
.dsh-wb-badge-btn[data-state=valley]{background:rgba(52,199,89,.16);border-color:rgba(52,199,89,.5)}
.dsh-wb-badge-btn[data-state=valley] b{color:#2f9e4f}
.dsh-wb-badge-btn[data-state=warn]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dsh-wb-badge-btn[data-state=error]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsh-wb-badge-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-wb-popover{position:absolute;right:12px;top:36px;width:300px;max-width:calc(100% - 24px);z-index:60;padding:8px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 16px 40px rgba(0,0,0,.25)}
.dsh-wb-card-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsh-wb-card-head h3{margin:0;font-size:var(--wb-fs);font-weight:600}
.dsh-wb-card-actions{margin-left:auto;display:flex;gap:2px;align-items:center;flex-wrap:wrap}
.dsh-wb-card-body{margin-top:8px}
.dsh-wb-metrics{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:calc(var(--wb-fs) - 1px);color:var(--dsw-alias-label-secondary)}
.dsh-wb-metrics b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}
.dsh-wb-big{font-size:calc(var(--wb-fs) + 9px);font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1}
.dsh-wb-chip{flex:none;padding:0 7px;border-radius:999px;font-size:calc(var(--wb-fs) - 2px);line-height:18px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dsh-wb-chip[data-state=ok],.dsh-wb-chip[data-state=ready]{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
.dsh-wb-chip[data-state=missing]{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}
.dsh-wb-chip[data-state=denied],.dsh-wb-chip[data-state=error]{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.dsh-wb-chip[data-state=unset],.dsh-wb-chip[data-state=idle]{color:var(--dsw-alias-state-idle-primary);border-color:var(--dsw-alias-border-l2)}
.dsh-wb-input{width:100%;box-sizing:border-box;height:28px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:calc(var(--wb-fs) - 1px)}
.dsh-wb-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsh-wb-select{appearance:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding-right:20px}
.dsh-wb-textarea{width:100%;box-sizing:border-box;min-height:220px;padding:8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:calc(var(--wb-fs) - 1px);line-height:1.6;resize:vertical}
.dsh-wb-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsh-wb-field{display:flex;gap:6px;align-items:center;margin-bottom:6px}
.dsh-wb-field label{flex:none;width:48px;font-size:calc(var(--wb-fs) - 2px);color:var(--dsw-alias-label-secondary)}
.dsh-wb-row{position:relative;padding:9px 2px;border:none;border-bottom:1px solid var(--wb-line);border-radius:0;background:transparent;transition:background .12s}
.dsh-wb-row:last-child{border-bottom:none}
.dsh-wb-row:hover{background:var(--wb-surface)}
.dsh-wb-row:hover{border-color:var(--wb-line-strong)}
.dsh-wb-row-title{color:var(--wb-ink-2);font-weight:600;letter-spacing:.004em;font-size:calc(var(--wb-fs) + .5px)}
.dsh-wb-row-title > span:first-child{color:var(--wb-ink-2)}
.dsh-wb-row-meta{color:var(--wb-ink-3)}
.dsh-wb-row .dsh-wb-chip{color:var(--wb-ink-3);background:var(--wb-surface-2);border-color:var(--wb-line)}
/* 标签胶囊带一点主色，术语本身保持中性——橙色只出现在「你自己打的标记」上 */
.dsh-wb-row .dsh-wb-tag{color:var(--wb-accent-strong);background:var(--wb-accent-soft);border-color:#eccbbd;font-weight:600}
/* 悬停时左侧一道细主色，提示"这一行可操作" */
.dsh-wb-row::before{content:'';position:absolute;left:-6px;top:6px;bottom:6px;width:2px;border-radius:2px;
  background:var(--wb-accent);opacity:0;transition:opacity .12s}
.dsh-wb-row:hover::before{opacity:.85}
/* 悬停显现的动作组（只有术语表行用）：绝对定位到右上角，平时不可见 */
.dsh-wb-actions-hover{position:absolute;top:3px;right:3px;margin:0;display:flex;gap:1px;
  opacity:0;pointer-events:none;transition:opacity .12s;
  background:linear-gradient(90deg,rgba(255,255,255,0),var(--wb-surface) 24%);padding-left:14px;border-radius:8px}
.dsh-wb-row:hover .dsh-wb-actions-hover,.dsh-wb-row:focus-within .dsh-wb-actions-hover{opacity:.95;pointer-events:auto}
@media (hover:none){.dsh-wb-actions-hover{position:static;opacity:.55;background:none;padding:0;margin-top:5px}}
.dsh-wb-row+.dsh-wb-row{margin-top:0}
.dsh-wb-row-title{display:flex;align-items:center;gap:6px;font-weight:500;font-size:calc(var(--wb-fs) - 1px);min-width:0}
.dsh-wb-row-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-wb-row-meta{margin-top:2px;font-size:calc(var(--wb-fs) - 2px);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-wb-row-actions{margin-top:5px;display:flex;gap:2px;flex-wrap:wrap}
.dsh-wb-pre{margin:6px 0 0;max-height:240px;overflow:auto;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:calc(var(--wb-fs) - 2px);line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-wb-error{margin:0 0 8px;padding:7px 9px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:calc(var(--wb-fs) - 1px);line-height:1.5}
.dsh-wb-warn{margin:0 0 10px;padding:7px 9px;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);font-size:calc(var(--wb-fs) - 1px);line-height:1.5}
.dsh-wb-note{margin:4px 0 0;font-size:calc(var(--wb-fs) - 2px);color:var(--dsw-alias-label-secondary);line-height:1.5}
.dsh-wb-loading{padding:14px 2px;color:var(--dsw-alias-label-secondary);font-size:calc(var(--wb-fs) - 1px)}
.dsh-wb-bar{position:sticky;bottom:0;display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:10px -14px -18px;padding:9px 14px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);font-size:calc(var(--wb-fs) - 1px)}
.dsh-wb-bar .grow{flex:1;min-width:80px;color:var(--dsw-alias-label-secondary)}
.dsh-wb-toast{position:sticky;bottom:0;margin:10px -14px -18px;padding:7px 14px;font-size:calc(var(--wb-fs) - 1px);color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-overlay);border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-wb-strips{display:flex;flex-direction:column;gap:4px;padding:8px 14px 0}
.dsh-wb-strip{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:calc(var(--wb-fs) - 1px)}
.dsh-wb-strip[data-state=warn]{border-color:var(--dsw-alias-state-warn-primary)}
.dsh-wb-strip[data-state=error]{border-color:var(--dsw-alias-state-error-primary)}
.dsh-wb-strip-main{display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;flex-wrap:wrap}
.dsh-wb-strip-title{font-weight:600;flex:none}
.dsh-wb-strip-text{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-wb-strip-detail{flex-basis:100%;padding:6px 0 2px;border-top:1px dashed var(--dsw-alias-border-l1);margin-top:2px}
.dsh-wb-tabs{display:flex;gap:4px;align-items:center;padding:8px 14px 0;overflow-x:auto;flex:none}
.dsh-wb-tab{flex:none;height:26px;padding:0 10px;border-radius:8px 8px 0 0;border:1px solid var(--dsw-alias-border-l1);border-bottom-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:calc(var(--wb-fs) - 1px);cursor:pointer;white-space:nowrap}
.dsh-wb-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.dsh-wb-tab[data-active=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;border-color:var(--dsw-alias-border-l2)}
.dsh-wb-tab[data-error=true]{color:var(--dsw-alias-state-error-primary)}
.dsh-wb-searchrow{padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dsh-wb-tree{margin-top:8px}
.dsh-wb-tree-row{display:flex;align-items:center;gap:5px;width:100%;box-sizing:border-box;padding:3px 4px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:calc(var(--wb-fs) - 1px);text-align:left;cursor:pointer}
.dsh-wb-tree-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-wb-tree-row[data-empty=true]{color:var(--dsw-alias-label-secondary);opacity:.65}
.dsh-wb-tree-caret{flex:none;width:12px;color:var(--dsw-alias-label-secondary);font-size:10px}
.dsh-wb-tree-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-wb-tree-note{border-left:0;margin-left:0}
.dsh-wb-tree-count{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsh-wb-tree-dot{flex:none;width:8px;color:var(--dsw-alias-label-secondary);font-size:9px}
.dsh-wb-tree-row[data-active=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-wb-tree-row[data-active=true] .dsh-wb-tree-dot{color:var(--dsw-alias-brand-primary)}
.dsh-wb-wave-canvas{display:block;width:100%;height:88px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;touch-action:none}
.dsh-wb-transport{flex:none;display:flex;align-items:center;gap:10px;margin-top:6px;padding:8px 0 2px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-wb-transport-gap{flex:1}
.dsh-wb-transport-label{font-size:calc(var(--wb-fs) - 1px);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsh-wb-round{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;padding:0}
.dsh-wb-round:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-wb-round[data-primary=true]{width:48px;height:48px;border-color:transparent;background:var(--dsw-alias-brand-primary);color:#fff}
.dsh-wb-round[data-primary=true]:hover{filter:brightness(1.06)}
.dsh-wb-rate{padding:0 8px;height:26px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:calc(var(--wb-fs) - 1px);cursor:pointer;font-variant-numeric:tabular-nums}
.dsh-wb-round[disabled]{opacity:.4;cursor:default}
.dsh-wb-round[disabled]:hover{background:var(--dsw-alias-bg-layer-1)}
.dsh-wb-modal-backdrop{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.32)}
.dsh-wb-modal{width:300px;max-width:80vw;padding:16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 16px 48px rgba(0,0,0,.28)}
.dsh-wb-modal-title{font-size:calc(var(--wb-fs) + 1px);font-weight:600;margin-bottom:8px;color:var(--dsw-alias-label-primary)}
.dsh-wb-modal-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:14px}
.dsh-wb-time-static{cursor:default;opacity:.7}
.dsh-wb-live-tail{margin-top:6px;color:var(--dsw-alias-label-secondary);font-style:italic;line-height:1.7}
.dsh-wb-annot-split{display:flex;gap:8px;align-items:flex-start;margin-top:8px}
.dsh-wb-annot-main{flex:1;min-width:0}
.dsh-wb-annot-col{flex:0 0 200px;position:sticky;top:0;align-self:flex-start;max-height:100%;overflow:auto;padding-left:8px;border-left:1px solid var(--dsw-alias-border-l1)}
.dsh-wb-mark{padding:0 1px;border-radius:2px;background:rgba(255,214,10,.45);color:inherit;cursor:pointer}
.dsh-wb-mark[data-color=green]{background:rgba(52,199,89,.35)}
.dsh-wb-mark[data-color=blue]{background:rgba(0,122,255,.28)}
.dsh-wb-live-fold{margin-top:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dsh-wb-live-fold > summary{cursor:pointer;list-style:none;padding:6px 9px;font-size:calc(var(--wb-fs) - 2px);color:var(--dsw-alias-label-secondary);display:flex;align-items:baseline;gap:2px;overflow:hidden;white-space:nowrap}
.dsh-wb-live-fold > summary::-webkit-details-marker{display:none}
.dsh-wb-live-fold > summary::before{content:'▸ ';opacity:.6}
.dsh-wb-live-fold[open] > summary::before{content:'▾ '}
.dsh-wb-live-peek{opacity:.75;overflow:hidden;text-overflow:ellipsis}
.dsh-wb-live-fold > .dsh-wb-md{padding:0 9px 8px}
.dsh-wb-annot-fold{flex:0 0 auto}
.dsh-wb-annot-fold > summary{cursor:pointer;list-style:none;user-select:none}
.dsh-wb-annot-fold > summary::-webkit-details-marker{display:none}
.dsh-wb-annot-fold > summary::before{content:'▸ ';opacity:.6}
.dsh-wb-annot-fold[open] > summary::before{content:'▾ '}
.dsh-wb-annot-card{padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);margin-bottom:6px;border-left:3px solid #ffd60a}
.dsh-wb-annot-card[data-color=green]{border-left-color:#d97757}
.dsh-wb-annot-card[data-color=blue]{border-left-color:#007aff}
.dsh-wb-annot-quote{font-size:calc(var(--wb-fs) - 1px);line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dsh-wb-annot-note{margin-top:4px;font-size:calc(var(--wb-fs) - 1px);line-height:1.6;color:var(--dsw-alias-label-primary);white-space:pre-wrap}
.dsh-wb-annot-foot{display:flex;align-items:center;justify-content:space-between;margin-top:4px}
.dsh-wb-annot-draft{padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;margin-bottom:8px}
.dsh-wb-annot-input{height:64px;padding:6px;resize:vertical;font-family:inherit;line-height:1.5}
.dsh-wb-findbar{display:flex;align-items:center;gap:4px;margin-top:6px}
.dsh-wb-findbar .dsh-wb-input{flex:1;min-width:0;height:26px}
.dsh-wb-findcount{flex:none;min-width:44px;text-align:right;font-size:calc(var(--wb-fs) - 2px);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsh-wb-find{background:rgba(0,122,255,.28);color:inherit;border-radius:2px}
.dsh-wb-find-current{background:#ff9f0a;color:#1a1a1a}
.dsh-wb-sel-toolbar{position:fixed;transform:translateX(-50%);z-index:9998;display:flex;gap:2px;padding:3px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 24px rgba(0,0,0,.2)}
.dsh-wb-line{display:flex;gap:8px;align-items:baseline;margin:0 0 6px}
.dsh-wb-time{flex:none;padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:calc(var(--wb-fs) - 2px);cursor:pointer;font-variant-numeric:tabular-nums}
.dsh-wb-split{display:flex;gap:8px;margin-top:8px;align-items:flex-start}
.dsh-wb-nav{flex:0 0 200px;min-width:0;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1);padding-right:6px}
.dsh-wb-nav-title{flex:none;padding:2px 4px 6px;font-size:calc(var(--wb-fs) - 2px);color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-wb-treelist{flex:1;min-height:0;overflow:auto}
.dsh-wb-reading{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;padding:0 2px}
.dsh-wb-reading-body{padding-bottom:6px}
.dsh-wb-player{flex:none;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:4px}
.dsh-wb-player .dsh-wb-transport{border-top:0;padding-top:4px;margin-top:6px}
.dsh-wb-empty{display:flex;align-items:center;justify-content:center;height:100%}
.dsh-wb-doc-head{border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:6px;margin-bottom:8px}
.dsh-wb-doc-title{font-size:calc(var(--wb-fs) + 2px);font-weight:600;line-height:1.4;overflow-wrap:anywhere}
.dsh-wb-doc-meta{margin-top:2px;font-size:calc(var(--wb-fs) - 2px);color:var(--dsw-alias-label-secondary)}
.dsh-wb-md{font-size:var(--wb-fs);line-height:1.8;overflow-wrap:anywhere}
.dsh-wb-md-p{margin:0 0 8px}
.dsh-wb-md-h{margin:12px 0 6px;font-weight:600;line-height:1.5}
.dsh-wb-md-h1{font-size:calc(var(--wb-fs) + 4px)}
.dsh-wb-md-h2{font-size:calc(var(--wb-fs) + 2px)}
.dsh-wb-md-h3{font-size:var(--wb-fs);color:var(--dsw-alias-label-primary)}
.dsh-wb-md-h4{font-size:calc(var(--wb-fs) - 1px);color:var(--dsw-alias-label-secondary)}
.dsh-wb-md-ul{margin:0 0 8px;padding-left:18px}
.dsh-wb-md-ul li{margin:2px 0}
.dsh-wb-md-hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:10px 0}
.dsh-wb-code{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:calc(var(--wb-fs) - 2px)}
.dsh-wb-wikilink{color:var(--dsw-alias-brand-primary);border-bottom:1px dashed currentColor}
.dsh-wb-props{margin:0 0 10px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.dsh-wb-props-title{font-size:calc(var(--wb-fs) - 2px);color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.dsh-wb-prop{display:flex;gap:10px;font-size:calc(var(--wb-fs) - 2px);line-height:1.6}
.dsh-wb-prop-key{flex:0 0 84px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-wb-prop-value{flex:1;min-width:0;overflow-wrap:anywhere}
.dsh-wb-section-row+.dsh-wb-section-row{margin-top:4px;padding-top:4px;border-top:1px dashed var(--dsw-alias-border-l1)}
.dsh-wb-editor{margin-top:8px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}

/* ================= Claude 风格主题层 =================
   1) 在面板内重映射 DSH 的主题变量，宿主配色不再直接决定观感
   2) 字体：Anthropic 的 Styrene / Tiempos 为商用字体，不能随包分发；
      这里用最接近的开源替代（Inter / Source Serif / 系统宋体），观感对齐
   3) 绿色只保留语义位（成功状态），装饰性绿色一律去掉 */
.dsh-wb-panel,.dsh-wb-overlay-panel{
  --wb-bg:#faf9f5; --wb-surface:#ffffff; --wb-surface-2:#f2efe7; --wb-surface-3:#eae5d8;
  --wb-line:#e7e2d6; --wb-line-strong:#d9d3c4;
  --wb-ink:#141413; --wb-ink-2:#4a4842; --wb-ink-3:#8b887e;
  --wb-accent:#d97757; --wb-accent-strong:#c05f3c; --wb-accent-soft:#f7e9e3;
  --dsw-alias-bg-base:var(--wb-bg);
  --dsw-alias-bg-layer-1:var(--wb-surface);
  --dsw-alias-bg-layer-2:var(--wb-surface-2);
  --dsw-alias-border-l1:var(--wb-line);
  --dsw-alias-border-l2:var(--wb-line-strong);
  --dsw-alias-label-primary:var(--wb-ink);
  --dsw-alias-label-secondary:var(--wb-ink-2);
  --dsw-alias-brand-primary:var(--wb-accent);
  --dsw-alias-state-error-primary:#b4533b;
  --dsw-alias-state-warn-primary:#b98a3e;
  font-family:"Styrene B","Styrene A",ui-sans-serif,-apple-system,"SF Pro Text",Inter,"PingFang SC","Hiragino Sans GB",sans-serif;
  color:var(--wb-ink);
  letter-spacing:.006em;
}
.dsh-wb-panel{background:var(--wb-bg)}
/* 阅读区用衬线，接近 Tiempos 的编辑气质 */
.dsh-wb-md,.dsh-wb-reading-body,.dsh-wb-rule-body,.dsh-wb-annot-quote{
  font-family:"Tiempos Text","Source Serif 4","Source Serif Pro",Charter,Georgia,"Songti SC","STSong",serif;
  letter-spacing:.012em;
}
.dsh-wb-md{line-height:1.85;font-size:calc(var(--wb-fs) + .5px)}
.dsh-wb-head{border-bottom:1px solid var(--wb-line);padding:14px 16px 12px}
.dsh-wb-head h2{font-weight:600;letter-spacing:-.01em}
.dsh-wb-sub{color:var(--wb-ink-3)}
.dsh-wb-toolbar{padding:8px 16px 0}
.dsh-wb-tabs{gap:0;padding:10px 16px 0;border-bottom:1px solid var(--wb-line)}
.dsh-wb-tab{border:none;border-radius:8px 8px 0 0;padding:0 12px;color:var(--wb-ink-3);background:transparent}
.dsh-wb-tab:hover{background:var(--wb-surface-2);color:var(--wb-ink)}
.dsh-wb-tab[data-active=true]{background:var(--wb-surface);color:var(--wb-ink);font-weight:600;
  box-shadow:inset 0 2px 0 var(--wb-accent),0 -1px 0 var(--wb-line),1px 0 0 var(--wb-line),-1px 0 0 var(--wb-line)}
.dsh-wb-body{padding:14px 16px 22px;gap:2px}
.dsh-wb-btn{border-color:transparent;border-radius:9px;color:var(--wb-ink-2);background:transparent}
.dsh-wb-btn:hover{background:var(--wb-surface-2);color:var(--wb-ink)}
.dsh-wb-btn[data-tone=primary]{background:var(--wb-accent);color:#fff;border-color:transparent;box-shadow:0 1px 0 rgba(0,0,0,.04)}
.dsh-wb-btn[data-tone=primary]:hover{background:var(--wb-accent-strong);color:#fff;filter:none}
.dsh-wb-btn[data-tone=quiet]{background:var(--wb-surface);border-color:var(--wb-line-strong)}
.dsh-wb-btn[data-tone=quiet]:hover{background:var(--wb-surface-2)}
.dsh-wb-card{border:1px solid var(--wb-line);border-radius:12px;background:var(--wb-surface);padding:12px 13px}
.dsh-wb-card+.dsh-wb-card{margin-top:12px}
.dsh-wb-input,.dsh-wb-textarea,.dsh-wb-rule-field,.dsh-wb-annot-input{
  border:1px solid var(--wb-line-strong);border-radius:9px;background:var(--wb-surface);color:var(--wb-ink)}
.dsh-wb-input:focus,.dsh-wb-textarea:focus{outline:none;border-color:var(--wb-accent);box-shadow:0 0 0 3px var(--wb-accent-soft)}
.dsh-wb-nav-title{color:var(--wb-ink-3);border-bottom-color:var(--wb-line);letter-spacing:.04em}
.dsh-wb-metrics{color:var(--wb-ink-3)}
.dsh-wb-metrics b{color:var(--wb-ink)}
.dsh-wb-note{color:var(--wb-ink-3)}
.dsh-wb-chip{border-radius:999px;background:var(--wb-accent-soft);color:var(--wb-accent-strong)}
.dsh-wb-tree-row[data-active=true]{background:var(--wb-accent-soft);color:var(--wb-ink);font-weight:600}
.dsh-wb-tree-row[data-active=true] .dsh-wb-tree-dot{color:var(--wb-accent)}
.dsh-wb-rule{border:1px solid var(--wb-line);border-radius:10px;background:var(--wb-surface)}
.dsh-wb-rule-title{font-weight:600}
/* 用量角标：峰谷不再用红绿，改用暖色深浅区分 */
.dsh-wb-badge-btn{background:var(--wb-surface);border:1px solid var(--wb-line);border-radius:999px;color:var(--wb-ink-2)}
.dsh-wb-badge-btn:hover{background:var(--wb-surface-2)}
.dsh-wb-badge-btn[data-state=peak]{background:var(--wb-accent-soft);border-color:#e6b9a6}
.dsh-wb-badge-btn[data-state=peak] b{color:var(--wb-accent-strong)}
.dsh-wb-badge-btn[data-state=valley]{background:var(--wb-surface-2);border-color:var(--wb-line-strong)}
.dsh-wb-badge-btn[data-state=valley] b{color:var(--wb-ink-2)}
/* 高亮色：去掉绿色，改为暖色与中性色 */
.dsh-wb-mark[data-color=green]{background:rgba(217,119,87,.26)}
.dsh-wb-annot-card[data-color=green]{border-left-color:var(--wb-accent)}
.dsh-wb-mark[data-color=yellow]{background:rgba(214,168,74,.30)}
.dsh-wb-annot-card[data-color=yellow]{border-left-color:#d6a84a}
.dsh-wb-mark[data-color=blue]{background:rgba(120,134,160,.26)}
.dsh-wb-annot-card[data-color=blue]{border-left-color:#7886a0}
.dsh-wb-annot-card{border:1px solid var(--wb-line);border-left-width:3px;background:var(--wb-surface)}
.dsh-wb-annot-fold > summary{color:var(--wb-ink-3)}
.dsh-wb-live-fold{border:1px solid var(--wb-line);border-radius:10px;background:var(--wb-surface)}
.dsh-wb-live-fold > summary{color:var(--wb-ink-3)}
.dsh-wb-overlay{background:rgba(20,20,19,.34)}
.dsh-wb-overlay-panel{border:1px solid var(--wb-line-strong);border-radius:16px;box-shadow:0 28px 70px rgba(20,20,19,.28)}
.dsh-wb-overlay-bar{border-bottom:1px solid var(--wb-line);background:var(--wb-bg)}
/* 角标：默认中性，只有异常状态才带颜色 */
.dsh-wb-chip{background:var(--wb-surface-2);border:1px solid var(--wb-line);color:var(--wb-ink-3);
  font-variant-numeric:tabular-nums;padding:0 8px;line-height:17px}
.dsh-wb-chip[data-state=ok],.dsh-wb-chip[data-state=ready]{background:var(--wb-surface-2);border-color:var(--wb-line);color:var(--wb-ink-2)}
.dsh-wb-chip[data-state=missing],.dsh-wb-chip[data-state=warn]{background:#f7eddc;border-color:#e3cba6;color:#8a6630}
.dsh-wb-chip[data-state=denied],.dsh-wb-chip[data-state=error]{background:#f7e5df;border-color:#e0b6a6;color:#a24a30}
.dsh-wb-chip[data-state=unset],.dsh-wb-chip[data-state=idle]{background:transparent;border-color:var(--wb-line);color:var(--wb-ink-3)}
/* 按钮统一：不换行、同高、同圆角 */
.dsh-wb-btn{white-space:nowrap;height:28px;padding:0 10px;border-radius:9px}
.dsh-wb-btn[data-tone=quiet]{height:28px;padding:0 10px;font-size:calc(var(--wb-fs) - 1px)}
.dsh-wb-filters{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 4px}
.dsh-wb-filter{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;
  border:1px solid var(--wb-line);background:var(--wb-surface);color:var(--wb-ink-3);cursor:pointer;
  font:inherit;font-size:calc(var(--wb-fs) - 1px);white-space:nowrap;transition:background .12s,border-color .12s}
.dsh-wb-filter b{font-weight:600;color:var(--wb-ink-2);font-variant-numeric:tabular-nums}
.dsh-wb-filter:hover{background:var(--wb-surface-2)}
.dsh-wb-filter[data-active=true]{background:var(--wb-accent);border-color:var(--wb-accent);color:#fff}
.dsh-wb-filter[data-active=true] b{color:#fff}
.dsh-wb-empty-block{border:1px dashed var(--wb-line-strong);border-radius:10px;padding:12px;margin-top:8px;background:var(--wb-surface)}
.dsh-wb-draft{border:1px solid var(--wb-line);border-radius:10px;background:var(--wb-surface);margin-bottom:8px;overflow:hidden}
.dsh-wb-draft-head{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border:none;background:transparent;
  cursor:pointer;text-align:left;font:inherit}
.dsh-wb-draft-head:hover{background:var(--wb-surface-2)}
.dsh-wb-draft-title{flex:1;min-width:0;font-weight:600;font-size:calc(var(--wb-fs) - 1px)}
.dsh-wb-draft-meta{flex:none;color:var(--wb-ink-3);font-size:calc(var(--wb-fs) - 2px);font-variant-numeric:tabular-nums}
.dsh-wb-draft-body{border-top:1px solid var(--wb-line);padding:10px 12px;max-height:360px;overflow:auto;font-size:calc(var(--wb-fs) - .5px)}
.dsh-wb-section{margin:16px 0 4px}
.dsh-wb-section-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.dsh-wb-section-name{font-size:calc(var(--wb-fs) - 2px);letter-spacing:.1em;color:var(--wb-ink-3);text-transform:uppercase}
.dsh-wb-section-count{font-size:calc(var(--wb-fs) - 2px);color:var(--wb-ink-3);background:var(--wb-surface-2);
  border-radius:999px;padding:0 7px;line-height:17px;font-variant-numeric:tabular-nums}
.dsh-wb-section-head::after{content:'';flex:1;height:1px;background:var(--wb-line)}
.dsh-wb-strength{flex:none;font-size:calc(var(--wb-fs) - 2px);padding:1px 8px;border-radius:999px;
  border:1px solid transparent;font-variant-numeric:tabular-nums}
.dsh-wb-strength[data-tone=hard]{background:var(--wb-accent);color:#fff;border-color:var(--wb-accent)}
.dsh-wb-strength[data-tone=soft]{background:var(--wb-accent-soft);color:var(--wb-accent-strong);border-color:#eccbbd}
.dsh-wb-strength[data-tone=watch]{background:var(--wb-surface-2);color:var(--wb-ink-3);border-color:var(--wb-line)}
.dsh-wb-strength[data-tone=none]{background:transparent;color:var(--wb-ink-3);border-color:var(--wb-line)}
.dsh-wb-rule-actions{display:flex;gap:2px;flex:none;opacity:.55;transition:opacity .15s}
.dsh-wb-rule:hover .dsh-wb-rule-actions{opacity:1}
.dsh-wb-rule[data-strength=hard]{border-left:3px solid var(--wb-accent)}
.dsh-wb-rule[data-strength=soft]{border-left:3px solid #e6c0ae}
.dsh-wb-rule[data-strength=watch]{border-left:3px solid var(--wb-line-strong)}
.dsh-wb-rule-editlabel{font-size:calc(var(--wb-fs) - 2px);color:var(--wb-accent-strong)}
.dsh-wb-field-label{display:block;font-size:calc(var(--wb-fs) - 2px);color:var(--wb-ink-3);margin-bottom:3px;letter-spacing:.04em}
.dsh-wb-kv{display:grid;grid-template-columns:56px 1fr;gap:4px 10px;margin:8px 0 0}
.dsh-wb-kv dt{font-size:calc(var(--wb-fs) - 2px);color:var(--wb-ink-3)}
.dsh-wb-kv dd{margin:0;font-size:calc(var(--wb-fs) - 1px);color:var(--wb-ink-2);line-height:1.65}
.dsh-wb-btn[data-tone=outline]{height:28px;padding:0 12px;border-color:var(--wb-line-strong);background:var(--wb-surface);color:var(--wb-ink-2);font-size:calc(var(--wb-fs) - 1px)}
.dsh-wb-btn[data-tone=outline]:hover{background:var(--wb-surface-2);color:var(--wb-ink);border-color:var(--wb-line-strong)}
.dsh-wb-icon-btn{width:28px;padding:0}
`

    function StyleDefs() {
      return h('style', { 'data-dsh-workbench': 'style' }, CSS)
    }

    /**
     * 把样式装到 document.head 一次。
     * 早先只在面板里注入，导致「标题栏按钮」在面板没打开时完全没有样式（看着像灰色小点）。
     */
    let stylesInstalled = false
    function ensureStyles() {
      if (stylesInstalled) return
      if (typeof document === 'undefined' || document.head == null) return
      if (typeof document.getElementById !== 'function' || typeof document.createElement !== 'function') return
      if (document.getElementById('dsh-workbench-styles') !== null) {
        stylesInstalled = true
        return
      }
      const style = document.createElement('style')
      style.id = 'dsh-workbench-styles'
      // :root 给字号变量一个默认值：面板外（标题栏按钮）没有面板根节点可继承
      style.textContent = ':root{--wb-fs:13px}\n' + CSS
      document.head.appendChild(style)
      stylesInstalled = true
    }

    function pickLanguage(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return 'zh'
      const raw = snapshot.locale || snapshot.language || snapshot.id || snapshot.active || ''
      return typeof raw === 'string' ? raw.toLowerCase() : 'zh'
    }

    function Icon({ size = 16 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M2.5 6.2h11M3.8 6.2v6.1M12.2 6.2v6.1M2.5 12.3h11',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('rect', { x: 5.1, y: 3.1, width: 2.9, height: 2.2, rx: 0.6, stroke: 'currentColor', strokeWidth: 1.1 }),
        h('rect', { x: 8.9, y: 3.1, width: 2.2, height: 2.2, rx: 0.6, stroke: 'currentColor', strokeWidth: 1.1 }),
      )
    }

    /* ------------------------------------------------------------ 纯工具 */

    async function api(path, options) {
      const request = { credentials: 'same-origin', ...options }
      if (request.body !== undefined && typeof request.body !== 'string') {
        request.body = JSON.stringify(request.body)
        request.headers = { 'content-type': 'application/json', ...(options && options.headers) }
      }
      const response = await fetch(API + path, request)
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok || body === null || body.ok === false) {
        const message = body && body.message ? body.message : 'HTTP ' + response.status
        const code = body && body.code ? body.code : 'http_' + response.status
        const error = new Error(message)
        error.code = code
        throw error
      }
      return body
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          document.body.removeChild(area)
          return ok
        } catch {
          return false
        }
      }
    }

    function formatTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms === 0) return '—'
      const date = new Date(ms)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = (n) => String(n).padStart(2, '0')
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /** 草稿文本；读不出来时返回 undefined（调用方必须按"未知"处理，绝不当成空草稿覆盖掉）。 */
    function draftOf(state) {
      if (state === null || typeof state !== 'object') return undefined
      for (const key of ['draft', 'text', 'value']) {
        if (typeof state[key] === 'string') return state[key]
      }
      return undefined
    }

    /* ---------------------------------------------------- Markdown 渲染 */

    /** 拆 frontmatter（--- 包住的属性）与正文。 */
    function parseFrontmatter(text) {
      const src = String(text ?? '')
      if (!src.startsWith('---')) return { properties: [], body: src }
      const end = src.indexOf('\n---', 3)
      if (end < 0) return { properties: [], body: src }
      const properties = []
      for (const line of src.slice(3, end).split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z0-9_\u4e00-\u9fa5.-]+)\s*:\s*(.*)$/)
        if (match !== null) properties.push({ key: match[1], value: match[2].replace(/^["']|["']$/g, '') })
      }
      return { properties, body: src.slice(end + 4) }
    }

    /** 极简 Markdown 分块：标题 / 段落 / 列表 / 分隔线。够读这些 SOP 笔记，不引第三方库。 */
    function markdownBlocks(text) {
      const blocks = []
      let list = null
      let para = []
      const flushPara = () => {
        if (para.length > 0) {
          blocks.push({ type: 'p', text: para.join(' ') })
          para = []
        }
      }
      const flushList = () => {
        if (list !== null) {
          blocks.push(list)
          list = null
        }
      }
      for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '')
        if (line.trim() === '') { flushPara(); flushList(); continue }
        const hash = line.match(/^(#{1,6})\s+(.+)$/)
        if (hash !== null) { flushPara(); flushList(); blocks.push({ type: 'h', level: hash[1].length, text: hash[2] }); continue }
        const bold = line.match(/^\*\*(.+?)\*\*\s*$/)
        if (bold !== null) { flushPara(); flushList(); blocks.push({ type: 'h', level: 3, text: bold[1] }); continue }
        if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); flushList(); blocks.push({ type: 'hr' }); continue }
        if (/^\s*Image\s*$/i.test(line)) { flushPara(); flushList(); continue }
        const item = line.match(/^\s*(?:[-*·]|\d+[.)])\s+(.*)$/)
        if (item !== null) {
          flushPara()
          if (list === null) list = { type: 'list', items: [] }
          list.items.push(item[1])
          continue
        }
        flushList()
        para.push(line.trim())
      }
      flushPara()
      flushList()
      return blocks
    }

    /** 行内：**粗体** / `代码` / [[双链]] / ![[图片]]。 */
    function inlineNodes(text, keyPrefix) {
      const nodes = []
      const pattern = /(!?\[\[([^\]]+)\]\])|(\*\*([^*]+)\*\*)|(`([^`]+)`)/g
      let last = 0
      let index = 0
      let match
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index))
        if (match[1] !== undefined) {
          const isImage = match[1].charAt(0) === '!'
          nodes.push(h('span', { key: keyPrefix + '-' + (index++), className: 'dsh-wb-wikilink' }, (isImage ? '图片 ' : '') + match[2]))
        } else if (match[3] !== undefined) {
          nodes.push(h('strong', { key: keyPrefix + '-' + (index++) }, match[4]))
        } else {
          nodes.push(h('code', { key: keyPrefix + '-' + (index++), className: 'dsh-wb-code' }, match[6]))
        }
        last = pattern.lastIndex
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    function MarkdownBody({ text, t }) {
      const parsed = parseFrontmatter(text)
      const blocks = markdownBlocks(parsed.body)
      return h('div', { className: 'dsh-wb-md' },
        parsed.properties.length > 0
          ? h('div', { className: 'dsh-wb-props' },
              h('div', { className: 'dsh-wb-props-title' }, t('sop.props')),
              parsed.properties.map((property, index) => h('div', { key: index, className: 'dsh-wb-prop' },
                h('span', { className: 'dsh-wb-prop-key' }, property.key),
                h('span', { className: 'dsh-wb-prop-value' }, property.value),
              )),
            )
          : null,
        blocks.map((block, index) => {
          if (block.type === 'h') {
            return h('div', { key: index, className: 'dsh-wb-md-h dsh-wb-md-h' + Math.min(block.level, 4) }, inlineNodes(block.text, 'h' + index))
          }
          if (block.type === 'hr') return h('hr', { key: index, className: 'dsh-wb-md-hr' })
          if (block.type === 'list') {
            return h('ul', { key: index, className: 'dsh-wb-md-ul' },
              block.items.map((item, itemIndex) => h('li', { key: itemIndex }, inlineNodes(item, 'li' + index + '-' + itemIndex))),
            )
          }
          return h('p', { key: index, className: 'dsh-wb-md-p' }, inlineNodes(block.text, 'p' + index))
        }),
      )
    }

    return {
      inject: ['slots'],
      _calc: WB_CALC,
      apply(ctx) {
        const localeStore = {
          subscribe(listener) {
            try {
              const off = ctx.locale.subscribe(listener)
              return typeof off === 'function' ? off : () => {}
            } catch {
              return () => {}
            }
          },
          getSnapshot() {
            try {
              const snapshot = typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : ctx.locale.getLocale()
              return pickLanguage(snapshot)
            } catch {
              return 'zh'
            }
          },
        }

        function useLanguage() {
          return React.useSyncExternalStore(localeStore.subscribe, localeStore.getSnapshot, () => 'zh')
        }

        function makeT(language) {
          const dict = String(language || '').startsWith('en') ? EN : ZH
          return (key) => (dict[key] !== undefined ? dict[key] : ZH[key] !== undefined ? ZH[key] : key)
        }

        /* -------------------------------------------------------- 打开标签页 */

        /** 惰取一个客户端服务；没有就返回 undefined。 */
        function getService(key) {
          try {
            return typeof ctx.get === 'function' ? ctx.get(key) : undefined
          } catch {
            return undefined
          }
        }

        /**
         * 试着把工作台放进当前会话的右栏。
         * **绝不调用 layout.openRightbar** —— 强行展开会留下「显示着却没标签」的空壳，
         * 框架据此把自己的侧栏开关藏起来，用户看到的是整条右栏消失。
         */
        function placeInSidebar() {
          const sidebar = getService('sidebarRight')
          if (sidebar === null || typeof sidebar !== 'object' || typeof sidebar.openResource !== 'function') return false
          try {
            sidebar.openResource(TAB_ADDRESS, { kind: TAB_KIND })
            return true
          } catch (error) {
            console.warn('[dsh-workbench] 右栏放不进标签，改用浮层：', error instanceof Error ? error.message : String(error))
            return false
          }
        }

        /**
         * 全屏工作台：挂在 DSH 官方的 `shell.overlay` 槽位上（框架负责层级与生命周期），
         * 由 ⌥W 或侧栏放不进去时触发。比自建 document.body root 更稳。
         */
        const fullOverlay = { open: false, panelProps: {}, listeners: new Set() }
        function emitOverlay() {
          for (const listener of fullOverlay.listeners) {
            try {
              listener()
            } catch {
              // 单个订阅者出错不影响其它
            }
          }
        }
        function openFullWorkbench(panelProps) {
          fullOverlay.open = true
          fullOverlay.panelProps = panelProps ?? fullOverlay.panelProps ?? {}
          emitOverlay()
        }
        function closeFullWorkbench() {
          fullOverlay.open = false
          emitOverlay()
        }
        function toggleFullWorkbench() {
          if (fullOverlay.open) closeFullWorkbench()
          else openFullWorkbench(activeSession.panelProps)
        }

        /** 最近一次渲染的会话信息：快捷键呼出时用它拿到 sessionId 与输入框能力。 */
        const activeSession = { sessionId: null, panelProps: {} }

        /** shell.overlay 的宿主组件。 */
        function FullWorkbenchHost() {
          const [, force] = React.useState(0)
          React.useEffect(() => {
            const listener = () => force((value) => value + 1)
            fullOverlay.listeners.add(listener)
            return () => fullOverlay.listeners.delete(listener)
          }, [])
          return fullOverlay.open
            ? h(WorkbenchOverlay, { onClose: closeFullWorkbench, panelProps: fullOverlay.panelProps })
            : null
        }

        /** 兜底浮层：不依赖右栏，任意会话都能用。 */
        function WorkbenchOverlay({ onClose, panelProps }) {
          React.useEffect(() => {
            const onKey = (event) => {
              if (event.key === 'Escape') onClose()
            }
            window.addEventListener('keydown', onKey)
            return () => window.removeEventListener('keydown', onKey)
          }, [onClose])
          return h('div', { className: 'dsh-wb-overlay', onClick: onClose },
            h('div', { className: 'dsh-wb-overlay-panel', onClick: (event) => event.stopPropagation() },
              h('div', { className: 'dsh-wb-overlay-bar' },
                h('span', { className: 'dsh-wb-overlay-title' }, '工作台'),
                h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'quiet', onClick: onClose }, '关闭'),
              ),
              h('div', { className: 'dsh-wb-overlay-body' }, h(WorkbenchPanel, panelProps)),
            ),
          )
        }

        ensureStyles()

        let tabTypeRegistered = false
        function registerTabType() {
          if (tabTypeRegistered) return
          const tabs = getService('sidebarRightTabs')
          if (tabs === null || typeof tabs !== 'object' || typeof tabs.register !== 'function') return
          tabTypeRegistered = true
          try {
            ctx.effect(() => {
              const dispose = tabs.register.call(tabs, {
                id: TAB_ID,
                kind: TAB_KIND,
                patterns: [ADDRESS_PREFIX + '**'],
                title: () => {
                  try {
                    return makeT(localeStore.getSnapshot())('tab.title')
                  } catch {
                    return '工作台'
                  }
                },
                canOpen: (address) => {
                  try {
                    return typeof address === 'string' && address.startsWith(ADDRESS_PREFIX)
                  } catch {
                    return false
                  }
                },
              })
              return typeof dispose === 'function' ? dispose : () => {}
            }, 'dsh-workbench: tab type')
          } catch (error) {
            console.warn('[dsh-workbench] 标签类型注册失败：', error instanceof Error ? error.message : String(error))
          }
        }
        registerTabType()
        if (typeof ctx.inject === 'function') {
          try {
            ctx.inject(['sidebarRightTabs'], () => registerTabType())
          } catch {
            // 服务晚挂载的时序差异，忽略
          }
        }

        /** 把客户端异常写到 Host 的日志文件，便于事后定位（界面里看不到 console）。 */
        function reportError(where, error) {
          try {
            void fetch(API + '/client-log', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                where,
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? (error.stack ?? '') : '',
              }),
              keepalive: true,
            })
          } catch {
            // 上报失败不影响功能
          }
        }
        // React 的渲染异常不走 window.error，而是 console.error —— 这里劫持一份。
        try {
          const originalConsoleError = console.error.bind(console)
          console.error = (...args) => {
            try {
              const text = args
                .map((item) => (item instanceof Error ? (item.stack ?? item.message) : String(item)))
                .join(' ')
              if (text.includes('dsh-workbench') || text.includes('WorkbenchPanel') || text.includes('dsh-wb')) {
                reportError('console.error', text)
              }
            } catch {
              // 劫持自身不能出错
            }
            originalConsoleError(...args)
          }
        } catch {
          // 拿不到 console 就算了
        }

        try {
          window.addEventListener('error', (event) => {
            const message = String(event.message ?? '')
            if (message.includes('dsh-workbench') || event.error !== null) reportError('window.error', event.error ?? message)
          })
          window.addEventListener('unhandledrejection', (event) => {
            reportError('unhandledrejection', event.reason)
          })
        } catch {
          // 浏览器不支持就算了
        }

        /* --------------------------------------------------------- 头部按钮 */

        function HeaderButton(props) {
          const t = makeT(useLanguage())
          React.useEffect(() => {
            activeSession.sessionId = props?.sessionId ?? null
            activeSession.panelProps = props ?? {}
          })
          return h('button',
            {
              type: 'button',
              className: 'dsh-wb-btn dsh-wb-icon-btn',
              title: t('header.open'),
              'aria-label': t('header.open'),
              onClick: () => { if (!placeInSidebar()) openFullWorkbench(props) },
            },
            h(Icon, null),
          )
        }

        /** 新会话（还没有消息）时也会显示的紧凑入口：空会话没有会话头部，图标按钮在那儿看不到。 */
        function HeroWorkbenchButton(props) {
          const t = makeT(useLanguage())
          React.useEffect(() => {
            activeSession.sessionId = props?.sessionId ?? null
            activeSession.panelProps = props ?? {}
          })
          return h('button',
            {
              type: 'button',
              className: 'dsh-wb-btn',
              title: t('header.open'),
              onClick: () => { if (!placeInSidebar()) openFullWorkbench(props) },
            },
            h(Icon, { size: 14 }),
            h('span', { style: { marginLeft: '2px' } }, t('tab.title')),
          )
        }

        // 全屏工作台（shell.overlay）+ Alt+W 热键（macOS 上是 ⌥W）
        try {
          ctx.slots.inject('shell.overlay', () => {
            try {
              return ctx.slots.register({ name: 'shell.overlay', id: 'dsh-workbench-full' }, FullWorkbenchHost)
            } catch (error) {
              console.warn('[dsh-workbench] 全屏槽位注册失败：', error instanceof Error ? error.message : String(error))
              return () => {}
            }
          })
        } catch {
          // 某些版本没有 shell.overlay
        }

        try {
          const onKeyDown = (event) => {
            const isW = event.code === 'KeyW' || event.key === 'w' || event.key === 'W'
            if (event.altKey && !event.ctrlKey && !event.metaKey && isW) {
              event.preventDefault()
              toggleFullWorkbench()
              return
            }
            if (event.key === 'Escape' && fullOverlay.open) {
              event.preventDefault()
              closeFullWorkbench()
            }
          }
          window.addEventListener('keydown', onKeyDown, true)
        } catch {
          // 没有 window 就算了
        }

        ctx.slots.inject('conversation.session.header.actions', () => {
          try {
            return ctx.slots.register(
              { name: 'conversation.session.header.actions', id: 'dsh-workbench', order: 15 },
              HeaderButton,
            )
          } catch (error) {
            console.warn('[dsh-workbench] 会话头部按钮注册失败：', error instanceof Error ? error.message : String(error))
            return () => {}
          }
        })

        ctx.slots.inject('conversation.hero.options', () => {
          try {
            return ctx.slots.register({ name: 'conversation.hero.options', id: 'dsh-workbench', order: 12 }, HeroWorkbenchButton)
          } catch (error) {
            console.warn('[dsh-workbench] 新会话入口注册失败：', error instanceof Error ? error.message : String(error))
            return () => {}
          }
        })

        /* ------------------------------------------------------------- 壳 */

        function CardShell({ title, state, stateText, actions, children, note, t, fill = false }) {
          return h(
            'section',
            { className: fill ? 'dsh-wb-card dsh-wb-card-fill' : 'dsh-wb-card' },
            h(
              'header',
              { className: 'dsh-wb-card-head' },
              h('h3', null, title),
              stateText !== undefined ? h('span', { className: 'dsh-wb-chip', 'data-state': state ?? 'idle' }, stateText) : null,
              h('div', { className: 'dsh-wb-card-actions' }, actions),
            ),
            h('div', { className: 'dsh-wb-card-body' }, children),
            note !== undefined && note !== null ? h('p', { className: 'dsh-wb-note' }, note) : null,
          )
        }

        /** 读草稿：老版本没有 useInput、或 selector 形态不同，都只当"读不出来"。 */
        function readDraft(useInput) {
          if (typeof useInput !== 'function') return undefined
          try {
            const value = useInput(draftOf)
            return typeof value === 'string' ? value : undefined
          } catch {
            return undefined
          }
        }

        /* ------------------------------------------------------------ 正文 */

        function WorkbenchPanel(props) {
          props = props ?? {}
          ensureStyles()
          const language = useLanguage()
          const t = makeT(language)
          const [state, setState] = React.useState({ status: 'loading' })
          const [prompts, setPrompts] = React.useState({})
          const [pending, setPending] = React.useState(null)
          const [flash, setFlash] = React.useState(null)
          const [reloadKey, setReloadKey] = React.useState(0)
          const [activeId, setActiveId] = React.useState(null)
          const [query, setQuery] = React.useState('')
          const [search, setSearch] = React.useState({ status: 'idle' })
          const [focusNote, setFocusNote] = React.useState(null)
          const [focusRecording, setFocusRecording] = React.useState(null)
          const [focusMode, setFocusMode] = React.useState(false)
          /** 顶部刷新按钮的计数：卡片据此重新拉取自己的数据（SOP 不再自带刷新按钮）。 */
          const [refreshTick, setRefreshTick] = React.useState(0)
          const [fontSize, setFontSize] = React.useState(() => {
            try {
              const stored = Number(window.localStorage.getItem('dsh-workbench:fontSize'))
              return Number.isFinite(stored) && stored >= 11 && stored <= 18 ? stored : 13
            } catch {
              return 13
            }
          })
          const [usage, setUsage] = React.useState({ deepseek: null, volc: null })
          /** 双模式：cost = 造价模式（全部卡片）；lite = 普通模式（卡片全隐藏，只留搜索）。 */
          const [mode, setMode] = React.useState(() => {
            try {
              return window.localStorage.getItem('dsh-cost-workbench.mode') === 'lite' ? 'lite' : 'cost'
            } catch {
              return 'cost'
            }
          })
          React.useEffect(() => {
            try {
              window.localStorage.setItem('dsh-cost-workbench.mode', mode)
            } catch {
              // 隐私模式下写不了 localStorage 也不影响使用。
            }
          }, [mode])

          /** 消费之后强制取一次用量（平时不轮询）。 */
          const refreshUsage = React.useCallback(() => {
            api('/usage?refresh=1').then(
              (data) => setUsage({ deepseek: data.deepseek ?? null, volc: data.volc ?? null }),
              () => {},
            )
          }, [])
          /**
           * DeepSeek 错峰定价：北京时间 00:30–08:30 是谷价（V3 半价、R1 25%），其余为峰价。
           * 角标按「当前时段」变色，每分钟重算一次，跨过 00:30 / 08:30 时会自动翻转。
           */
          const [, setClockTick] = React.useState(0)
          const sessionId = props.sessionId

          const draftRaw = readDraft(props.useInput)
          const draft = typeof draftRaw === 'string' ? draftRaw : null

          React.useEffect(() => {
            const timer = setInterval(() => setClockTick((value) => value + 1), 60000)
            return () => clearInterval(timer)
          }, [])

          React.useEffect(() => {
            try {
              window.localStorage.setItem('dsh-workbench:fontSize', String(fontSize))
            } catch {
              // 隐私模式下写不了 localStorage 也不影响使用。
            }
          }, [fontSize])

          // 首次使用：还没有配置 Obsidian 库时，先显示引导，不去请求那些会返回 409 的接口
          const [setup, setSetup] = React.useState(null)
          const [setupDraft, setSetupDraft] = React.useState({ vaultRoot: '', sopDir: '00 资料库', recordingsDir: '会议记录', obsidianVaultName: '' })
          const [setupBusy, setSetupBusy] = React.useState(false)
          const [pickerBusy, setPickerBusy] = React.useState(false)
          React.useEffect(() => {
            let alive = true
            api('/config').then(
              (data) => {
                if (!alive) return
                setSetup(data)
                if (data.configured !== true) setSetupDraft({ vaultRoot: '', sopDir: data.sopDir ?? '00 资料库', recordingsDir: data.recordingsDir ?? '会议记录', obsidianVaultName: data.obsidianVaultName ?? '' })
              },
              () => { if (alive) setSetup({ configured: false, error: true }) },
            )
            return () => { alive = false }
          }, [])

          React.useEffect(() => {
            let alive = true
            if (setup === null || setup.configured !== true) return () => { alive = false }
            setState({ status: 'loading' })
            api('/overview').then(
              (data) => {
                if (!alive) return
                setState({ status: 'ready', data })
                setActiveId((current) => {
                  const inTabs = (Array.isArray(data.cards) ? data.cards : []).filter((card) => card.placement !== 'strip')
                  if (current !== null && inTabs.some((card) => card.id === current)) return current
                  const preferred = inTabs.find((card) => card.kind === 'sop')
                  return preferred !== undefined ? preferred.id : (inTabs[0] !== undefined ? inTabs[0].id : null)
                })
              },
              (error) => { if (alive) setState({ status: 'error', message: error.message }) },
            )
            api('/prompts').then(
              (data) => { if (alive) setPrompts(data.prompts ?? {}) },
              () => { if (alive) setPrompts({}) },
            )
            api('/usage').then(
              (data) => { if (alive) setUsage({ deepseek: data.deepseek ?? null, volc: data.volc ?? null }) },
              () => { if (alive) setUsage({ deepseek: null, volc: null }) },
            )
            return () => { alive = false }
          }, [reloadKey, setup === null ? 'pending' : (setup.configured === true ? 'ready' : 'unconfigured')])

          React.useEffect(() => {
            if (flash === null) return undefined
            const timer = setTimeout(() => setFlash(null), 2400)
            return () => clearTimeout(timer)
          }, [flash])

          // 全局搜索：笔记正文 + 术语 + 造价三表 + 录音，混排并标注来源。
          React.useEffect(() => {
            const text = query.trim()
            if (text === '') {
              setSearch({ status: 'idle' })
              return undefined
            }
            let alive = true
            setSearch((current) => ({ status: current.status === 'ready' ? 'ready' : 'loading', data: current.data }))
            const timer = setTimeout(() => {
              api('/search?q=' + encodeURIComponent(text)).then(
                (data) => { if (alive) setSearch({ status: 'ready', data }) },
                (error) => { if (alive) setSearch({ status: 'error', message: error.message }) },
              )
            }, 260)
            return () => { alive = false; clearTimeout(timer) }
          }, [query])

          function writeDraft(text) {
            try {
              const scope = typeof ctx.sessions?.scope === 'function' ? ctx.sessions.scope(sessionId) : undefined
              const conversation = scope !== undefined && typeof scope.get === 'function' ? scope.get('conversation') : undefined
              const input = conversation !== undefined && conversation.input !== undefined && typeof conversation.input.for === 'function'
                ? conversation.input.for(scope)
                : undefined
              if (input !== undefined && typeof input.setDraft === 'function') {
                input.setDraft(text)
                return true
              }
            } catch (error) {
              console.warn('[dsh-workbench] 写入草稿失败：', error instanceof Error ? error.message : String(error))
            }
            try {
              if (props.inputActions !== undefined && typeof props.inputActions.setDraft === 'function') {
                props.inputActions.setDraft(text)
                return true
              }
            } catch {
              // 两条通道都不通就如实报失败。
            }
            return false
          }

          function insertNow(text, mode) {
            const base = draft === null ? '' : draft
            const finalText = mode === 'append' && base.trim() !== '' ? base.replace(/\s+$/, '') + '\n\n' + text : text
            if (writeDraft(finalText)) setFlash(t('insert.done'))
            else setFlash(t('insert.failed'))
          }

          function requestInsert(text, label) {
            if (draft === null) {
              setPending({ text, label, length: null })
              return
            }
            if (draft.trim() === '') {
              insertNow(text, 'overwrite')
              return
            }
            setPending({ text, label, length: draft.length })
          }

          function insertPrompt(promptId) {
            const prompt = prompts[promptId]
            if (prompt === undefined) {
              setFlash('prompts.json 里没有 ' + promptId)
              return
            }
            requestInsert(prompt.text, prompt.title ?? promptId)
          }

          function insertNote(path) {
            api('/sop?note=' + encodeURIComponent(path)).then(
              (data) => requestInsert(data.note.text, data.note.title),
              (error) => setFlash('读取失败：' + error.message),
            )
          }

          const data = state.status === 'ready' ? state.data : null
          const allCards = data !== null && Array.isArray(data.cards) ? data.cards : []
          const cards = allCards.filter((card) => card.placement !== 'strip')
          const strips = allCards.filter((card) => card.placement === 'strip')
          const warnings = data !== null && Array.isArray(data.warnings) ? data.warnings : []
          const vault = data !== null && data.vault ? data.vault : { name: '', sopDir: '' }
          const activeCard = cards.find((card) => card.id === activeId) ?? null

          const pricing = deepseekPricingNow()

          const head = h('div', { className: 'dsh-wb-toolbar' },
            usage.deepseek !== null && usage.deepseek.configured === true
              ? h('button', {
                  type: 'button',
                  className: 'dsh-wb-badge-btn',
                  'data-state': usage.deepseek.error !== undefined ? 'error' : (pricing.peak ? 'peak' : 'valley'),
                },
                  h('span', null, 'DeepSeek'),
                  h('b', null, usage.deepseek.error !== undefined ? '—' : '¥' + Number(usage.deepseek.total).toFixed(2)),
                  usage.deepseek.error === undefined
                    ? h('span', { className: 'dsh-wb-tip' },
                        pricing.label + ' · 工作日 9–12 / 14–18 为峰价'
                        + (pricing.next === '' ? '' : ' · 下次切换 ' + pricing.next))
                    : null,
                )
              : null,
            usage.volc !== null && usage.volc.configured === true
              ? h('button', {
                  type: 'button',
                  className: 'dsh-wb-badge-btn',
                  'data-state': usage.volc.error !== undefined ? 'error' : 'ok',
                  title: usage.volc.error !== undefined
                    ? '火山语音剩余读取失败：' + usage.volc.error
                    : '火山流式语音识别：剩余 ' + (usage.volc.remainingLabel ?? '—')
                      + '（已用 ' + (usage.volc.used ?? 0) + ' / ' + (usage.volc.purchased ?? 0) + ' ' + (usage.volc.unit ?? '') + '）'
                      + (usage.volc.expires ? '，到期 ' + usage.volc.expires : ''),
                },
                  h('span', null, '语音'),
                  h('b', null, usage.volc.error !== undefined ? '—' : (usage.volc.remainingLabel ?? '—')),
                  h('span', {
                    className: 'dsh-wb-badge-jump',
                    title: '打开火山引擎控制台查看语音资源包',
                    onClick: (event) => {
                      event.stopPropagation()
                      api('/open-url', { method: 'POST', body: { url: 'https://console.volcengine.com/speech/new/experience/asr?projectName=default' } })
                        .catch((error) => setFlash('打开火山控制台失败：' + error.message))
                    },
                  }, '↗'),
                )
              : null,
            h('button', {
              type: 'button',
              className: 'dsh-wb-badge-btn',
              title: t('mode.hint'),
              onClick: () => setMode((value) => (value === 'cost' ? 'lite' : 'cost')),
            },
              h('span', null, mode === 'cost' ? t('mode.cost') : t('mode.lite')),
            ),
            h('button', {
              type: 'button',
              className: 'dsh-wb-btn dsh-wb-icon-btn',
              title: '字号调小',
              'aria-label': '字号调小',
              disabled: fontSize <= 11,
              onClick: () => setFontSize((value) => Math.max(11, value - 1)),
            }, 'A−'),
            h('button', {
              type: 'button',
              className: 'dsh-wb-btn dsh-wb-icon-btn',
              title: '字号调大',
              'aria-label': '字号调大',
              disabled: fontSize >= 18,
              onClick: () => setFontSize((value) => Math.min(18, value + 1)),
            }, 'A+'),
            focusMode
              ? h('button', { type: 'button', className: 'dsh-wb-btn', onClick: () => setFocusMode(false) }, '退出专注')
              : null,
            h('button', {
              type: 'button',
              className: 'dsh-wb-btn dsh-wb-icon-btn',
              onClick: () => setReloadKey((n) => n + 1),
              title: t('panel.refresh'),
              'aria-label': t('panel.refresh'),
            }, h(IconRefresh, null)),
          )

          const tabs = cards.length === 0 ? null : h('div', { className: 'dsh-wb-tabs', role: 'tablist' },
            cards.map((card) => h('button', {
              key: card.id,
              type: 'button',
              role: 'tab',
              className: 'dsh-wb-tab',
              'data-active': card.id === activeId,
              'data-error': card.status === 'error',
              onClick: () => { setActiveId(card.id) },
            }, card.title)),
          )

          // 状态条卡片：内置卡里没有 placement:"strip" 的卡，保留变量便于将来扩展。
          const stripRow = null

          const searchRow = h('div', { className: 'dsh-wb-searchrow' },
            h('input', {
              className: 'dsh-wb-input',
              value: query,
              placeholder: t('panel.search'),
              onChange: (event) => setQuery(event.target.value),
            }),
          )

          let body = null
          if (state.status === 'loading') {
            body = h('div', { className: 'dsh-wb-loading' }, t('panel.loading'))
          } else if (state.status === 'error') {
            body = h('div', null,
              h('div', { className: 'dsh-wb-error' }, t('panel.error') + '：' + state.message),
              h('button', { type: 'button', className: 'dsh-wb-btn', onClick: () => setReloadKey((n) => n + 1) }, t('panel.retry')),
            )
          } else if (query.trim() !== '') {
            const hits = search.status === 'ready' && Array.isArray(search.data.hits) ? search.data.hits : []
            body = h('div', null,
              search.status === 'loading' ? h('div', { className: 'dsh-wb-loading' }, t('panel.loading')) : null,
              search.status === 'error' ? h('div', { className: 'dsh-wb-error' }, search.message) : null,
              search.status === 'ready' && hits.length === 0 ? h('div', { className: 'dsh-wb-note' }, t('panel.searchEmpty')) : null,
              search.status === 'ready' && hits.length > 0
                ? h('div', { className: 'dsh-wb-note', style: { marginBottom: '6px' } }, hits.length + ' ' + t('panel.searchHit'))
                : null,
              hits.map((hit, index) => h('div', { className: 'dsh-wb-row', key: index },
                h('div', { className: 'dsh-wb-row-title' },
                  h('span', { className: 'dsh-wb-chip', 'data-state': 'unset' }, t('src.' + hit.source)),
                  hit.date !== undefined && hit.date !== null ? h('span', { className: 'dsh-wb-chip' }, hit.date) : null,
                  h('span', null, hit.title),
                  hit.time !== null && hit.time !== undefined
                    ? h('span', { className: 'dsh-wb-chip' }, formatClock(hit.time))
                    : hit.line !== undefined ? h('span', { className: 'dsh-wb-chip' }, 'L' + hit.line) : null,
                ),
                h('div', { className: 'dsh-wb-row-meta' }, hit.source === 'glossary' ? (hit.detail || '—') : hit.snippet),
                h('div', { className: 'dsh-wb-row-actions' },
                  hit.source === 'sop'
                    ? h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'quiet', onClick: () => {
                        if (mode === 'lite') setMode('cost')
                        const target = cards.find((candidate) => candidate.kind === 'sop')
                        setActiveId(target === undefined ? 'sop' : target.id)
                        setQuery('')
                        setFocusNote(hit.path)
                      } }, t('panel.openNote'))
                    : null,
                  hit.source === 'sop'
                    ? h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'quiet', onClick: () => insertNote(hit.path) }, t('sop.insert'))
                    : null,
                  hit.source === 'glossary'
                    ? h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'quiet', onClick: () => requestInsert(hit.title + (hit.detail ? ' — ' + hit.detail.split(' · ')[0] : ''), hit.title) }, t('sop.insert'))
                    : null,
                  hit.source === 'recording'
                    ? h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'quiet', onClick: () => {
                        if (mode === 'lite') setMode('cost')
                        const target = cards.find((candidate) => candidate.kind === 'recorder')
                        setActiveId(target === undefined ? 'recorder' : target.id)
                        setQuery('')
                        setFocusRecording(hit.path)
                      } }, '去会议记录')
                    : null,
                  ['standards', 'prices', 'changes'].includes(hit.source)
                    ? h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'quiet', onClick: () => {
                        if (mode === 'lite') setMode('cost')
                        const target = cards.find((candidate) => candidate.kind === hit.source)
                        setActiveId(target === undefined ? hit.source : target.id)
                        setQuery('')
                      } }, t('panel.openCard'))
                    : null,
                ),
              )),
            )
          } else if (activeCard !== null && mode === 'cost') {
            const shared = { key: activeCard.id, card: activeCard, t, requestInsert, insertPrompt, prompts, setFlash, vault, insertNote, focusMode, setFocusMode, onUsageChanged: refreshUsage, refreshTick, ...(activeCard.kind === 'recorder' ? { focusRecording, onRecordingHandled: () => setFocusRecording(null) } : {}) }
            if (activeCard.kind === 'sop') body = h(SopCard, { ...shared, focusNote, onFocusHandled: () => setFocusNote(null) })
            else if (activeCard.kind === 'standards' || activeCard.kind === 'prices' || activeCard.kind === 'changes') body = h(TableCard, shared)
            else if (activeCard.kind === 'calc') body = h(CalcCard, shared)
            else if (activeCard.kind === 'recorder') body = h(RecorderCard, shared)
            else if (activeCard.kind === 'glossary') body = h(EntryCard, shared)
            else if (activeCard.kind === 'prompt') body = h(PromptCard, shared)
            else body = h(CardShell, { t, title: activeCard.title, state: 'unsupported', stateText: t('state.unsupported') },
              h('p', { className: 'dsh-wb-note' }, t('panel.unsupported') + '：' + activeCard.kind))
          }

          const bar = pending !== null
            ? h('div', { className: 'dsh-wb-bar' },
                h('span', { className: 'grow' }, t('insert.pending.title') + (pending.length === null ? '' : '（' + pending.length + ' 字）')),
                h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'primary', onClick: () => { insertNow(pending.text, 'append'); setPending(null) } }, t('insert.append')),
                h('button', { type: 'button', className: 'dsh-wb-btn', onClick: () => { insertNow(pending.text, 'overwrite'); setPending(null) } }, t('insert.overwrite')),
                h('button', { type: 'button', className: 'dsh-wb-btn', onClick: () => setPending(null) }, t('insert.cancel')),
              )
            : flash !== null
              ? h('div', { className: 'dsh-wb-toast' }, flash)
              : null

          if (setup !== null && setup.configured !== true) {
            /** 弹系统文件夹选择框，选中后回填空格；目录不存在时 Host 会自动创建。 */
            const pickFolder = () => {
              setPickerBusy(true)
              setFlash(null)
              api('/pick-folder', { method: 'POST', body: {} })
                .then((data) => {
                  if (typeof data.path === 'string' && data.path !== '') {
                    setSetupDraft((current) => ({ ...current, vaultRoot: data.path }))
                    if (data.created === true) setFlash('已选择并创建目录：' + data.path)
                  } else if (data.cancelled === true) {
                    setFlash('已取消选择')
                  }
                }, (error) => setFlash('打开文件夹选择器失败：' + error.message))
                .finally(() => setPickerBusy(false))
            }
            const saveSetup = () => {
              const vaultRoot = String(setupDraft.vaultRoot ?? '').trim()
              if (vaultRoot === '') {
                setFlash('请先填写路径，或点「选择…」挑一个文件夹')
                return
              }
              setSetupBusy(true)
              setFlash(null)
              api('/config', { method: 'PUT', body: { ...setupDraft, vaultRoot } })
                .then((data) => {
                  if (data.configured === true) {
                    setSetup(data)
                    setFlash('已保存，正在加载…')
                  } else {
                    setFlash('保存后仍未生效，请检查路径后重试')
                  }
                }, (error) => setFlash('保存失败：' + error.message))
                .finally(() => setSetupBusy(false))
            }
            return h('div', { className: 'dsh-wb-panel', style: { '--wb-fs': fontSize + 'px' } },
              h('div', { className: 'dsh-wb-head' },
                h('div', null,
                  h('h2', null, '先配置一下'),
                  h('div', { className: 'dsh-wb-sub' }, '工作台读写一个文件夹里的 Markdown 笔记。选一次，以后不用再管。'),
                ),
              ),
              h('div', { className: 'dsh-wb-body' },
                flash !== null ? h('div', { className: 'dsh-wb-error' }, flash) : null,
                h('div', { className: 'dsh-wb-card' },
                  h('div', { className: 'dsh-wb-note' }, '笔记文件夹的完整路径（Obsidian 库，或任意文件夹都可以）'),
                  h('div', { style: { display: 'flex', gap: '6px', marginTop: '4px' } },
                    h('input', {
                      className: 'dsh-wb-input', style: { flex: '1 1 auto', minWidth: '0' },
                      placeholder: '点右边「选择…」，或直接粘贴，如 E:\\文档\\Obsidian\\造价工作台',
                      value: setupDraft.vaultRoot,
                      onChange: (event) => setSetupDraft({ ...setupDraft, vaultRoot: event.target.value }),
                    }),
                    h('button', {
                      type: 'button', className: 'dsh-wb-btn', 'data-tone': 'primary',
                      disabled: pickerBusy, style: { flex: 'none', height: '28px' },
                      onClick: pickFolder,
                    }, pickerBusy ? '选择中…' : '选择…'),
                  ),
                  h('div', { className: 'dsh-wb-note', style: { marginTop: '10px' } }, '资料库子目录（相对库根目录）'),
                  h('input', {
                    className: 'dsh-wb-input', style: { marginTop: '4px' },
                    value: setupDraft.sopDir,
                    onChange: (event) => setSetupDraft({ ...setupDraft, sopDir: event.target.value }),
                  }),
                  h('div', { className: 'dsh-wb-note', style: { marginTop: '10px' } }, '录音存放子目录'),
                  h('input', {
                    className: 'dsh-wb-input', style: { marginTop: '4px' },
                    value: setupDraft.recordingsDir,
                    onChange: (event) => setSetupDraft({ ...setupDraft, recordingsDir: event.target.value }),
                  }),
                  h('div', { className: 'dsh-wb-row-actions', style: { justifyContent: 'flex-end', marginTop: '12px' } },
                    h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'primary', disabled: setupBusy, onClick: saveSetup }, setupBusy ? '保存中…' : '保存并开始使用'),
                  ),
                ),
                h('p', { className: 'dsh-wb-note', style: { marginTop: '10px' } },
                  '没有 Obsidian 也能用：指向任意文件夹即可，插件只读写里面的 .md 文件，不会改动其它内容。'),
                h('p', { className: 'dsh-wb-note', style: { marginTop: '6px' } },
                  '路径填错也没关系，保存后如果读不到东西，回到这里改即可。所有数据只留在你自己的电脑上。'),
              ),
            )
          }

          try {
            const liteMode = mode === 'lite'
            return h('div', { className: 'dsh-wb-panel', style: { '--wb-fs': fontSize + 'px' } },
              h(StyleDefs, null),
              head,
              liteMode || focusMode ? null : stripRow,
              liteMode || focusMode ? null : tabs,
              searchRow,
              h('div', { className: 'dsh-wb-body' },
                warnings.map((warning, index) => h('div', { className: 'dsh-wb-warn', key: index }, warning)),
                liteMode && query.trim() === ''
                  ? h('div', { className: 'dsh-wb-note', style: { padding: '12px 0' } }, t('panel.liteNotice'))
                  : cards.length === 0 && state.status !== 'loading'
                    ? h('div', { className: 'dsh-wb-note', style: { padding: '12px 0' } },
                        '没有可显示的卡片：检查 ' + (state.cardsFile ?? 'cards.json') + ' 是否存在且格式正确。')
                    : body,
              ),
              bar,
            )
          } catch (error) {
            console.warn('[dsh-workbench] 面板渲染异常：', error)
            return h('div', { style: { padding: '14px', lineHeight: '1.7', fontSize: '13px' } },
              h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '工作台渲染出错'),
              h('div', { style: { opacity: 0.75, wordBreak: 'break-word' } }, error instanceof Error ? error.message : String(error)),
              h('div', { style: { opacity: 0.55, marginTop: '8px' } }, '这一块坏了不影响其它标签页；把上面这行发给我即可定位。'),
            )
          }

        }

        /* ------------------------------------------------------------- SOP */

/* ---------------------------------------------------------------- 三、通用表格卡 */

/**
 * 三张表共用的表格卡：读、客户端内搜索、增、改、删、行内插入、复制。
 * 接口形状与 EntryCard 保持一致：card 来自 cards.json（至少带 kind；title 可有可无）。
 */
function TableCard({ card, t, requestInsert, setFlash }) {
  const kind = card !== null && card !== undefined && typeof card.kind === 'string' ? card.kind : 'standards'
  const config = WB_TABLES[kind] ?? WB_TABLES.standards
  const [state, setState] = React.useState({ status: 'loading' })
  const [query, setQuery] = React.useState('')
  const [editing, setEditing] = React.useState(null)
  const [busy, setBusy] = React.useState(false)

  /** 拉全量；搜索在客户端过滤，表最多几百行，没必要再请求一次。 */
  const load = React.useCallback(() => {
    return api(config.api).then(
      (data) => setState({ status: 'ready', data }),
      (error) => setState({ status: 'error', message: error.message }),
    )
  }, [config.api])

  React.useEffect(() => { load() }, [load])

  const data = state.status === 'ready' ? state.data : null
  const entries = data !== null && Array.isArray(data.entries) ? data.entries : []
  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return entries
    return entries.filter((entry) => config.fields.some((field) => String(entry[field.key] ?? '').toLowerCase().includes(needle)))
  }, [entries, query, config.fields])

  /** 只提交这张表声明过的字段，避免把 id 之类的内部字段回传。 */
  function payloadOf(source) {
    const payload = {}
    for (const field of config.fields) payload[field.key] = source[field.key] ?? ''
    return payload
  }

  function blank() {
    const draft = {}
    for (const field of config.fields) draft[field.key] = ''
    return draft
  }

  /** 插入 / 复制时用来当标签的短名称：前两列非空值。 */
  function entryLabel(entry) {
    const parts = config.fields.slice(0, 2)
      .map((field) => String(entry[field.key] ?? '').trim())
      .filter((text) => text !== '')
    return parts.length > 0 ? parts.join(' / ') : String(entry.id ?? '')
  }

  function save() {
    if (editing === null || busy) return
    // 客户端先拦一次主键全空：省一趟请求，也避免把服务端的 400 当成网络错误。
    const idKeys = config.idKeys ?? []
    if (idKeys.length > 0 && idKeys.every((key) => String(editing[key] ?? '').trim() === '')) {
      setEditing((current) => (current === null ? null : { ...current, error: t('table.needKey') }))
      return
    }
    setBusy(true)
    const isNew = editing.id === undefined
    const request = isNew
      ? api(config.api, { method: 'POST', body: payloadOf(editing) })
      : api(config.api + '/' + encodeURIComponent(editing.id), { method: 'PUT', body: payloadOf(editing) })
    request.then(
      () => {
        setEditing(null)
        setFlash(wbText(t, isNew ? 'table.added' : 'table.saved', isNew ? '已新增' : '已保存'))
        load()
      },
      (error) => setEditing((current) => (current === null ? null : { ...current, error: error.message })),
    ).finally(() => setBusy(false))
  }

  function removeEntry(entry) {
    if (busy) return
    if (!window.confirm(t('table.confirmDelete') + '\n' + entryLabel(entry))) return
    setBusy(true)
    api(config.api + '/' + encodeURIComponent(entry.id), { method: 'DELETE' }).then(
      () => { setFlash(wbText(t, 'table.deleted', '已删除')); load() },
      (error) => setFlash(wbText(t, 'table.failed', '操作失败：') + error.message),
    ).finally(() => setBusy(false))
  }

  /** 行内插入：只输出一条 Markdown 数据行（表头交给调用方的上下文，避免重复表头）。 */
  function insertRow(entry) {
    const cells = config.fields.map((field) => String(entry[field.key] ?? '')
      .replace(/\r?\n/g, ' ')
      .replace(/\|/g, '｜'))
    requestInsert('| ' + cells.join(' | ') + ' |', entryLabel(entry) || t(config.titleKey))
  }

  /** 复制：按制表符分隔，粘进 Excel 直接是一行。写剪贴板失败时提示。 */
  function copyRow(entry) {
    const text = config.fields.map((field) => String(entry[field.key] ?? '')).join('\t')
    try {
      if (typeof navigator === 'undefined' || navigator.clipboard === undefined || typeof navigator.clipboard.writeText !== 'function') {
        setFlash(t('copy.failed'))
        return
      }
      navigator.clipboard.writeText(text).then(
        () => setFlash(t('copy.done')),
        () => setFlash(t('copy.failed')),
      )
    } catch {
      setFlash(t('copy.failed'))
    }
  }

  /** 编辑表单就地渲染在对应行下面（新增时渲染在搜索框下面）。 */
  function renderForm() {
    if (editing === null) return null
    return h('div', {
      style: {
        marginTop: '8px',
        padding: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
      },
    },
      h('div', { className: 'dsh-wb-row-title', style: { marginBottom: '6px' } },
        t(editing.id === undefined ? 'table.creating' : 'table.editing')),
      config.fields.map((field) => h('div', { className: 'dsh-wb-field', key: field.key },
        h('label', { style: { width: '76px' } }, t(field.labelKey)),
        h('input', {
          className: 'dsh-wb-input',
          value: editing[field.key] ?? '',
          maxLength: 200,
          onChange: (event) => {
            const next = event.target.value
            setEditing((current) => (current === null ? null : { ...current, [field.key]: next }))
          },
          onKeyDown: (event) => { if (event.key === 'Enter' && busy !== true) save() },
        }),
      )),
      editing.error !== undefined ? h('div', { className: 'dsh-wb-error' }, editing.error) : null,
      h('div', { className: 'dsh-wb-row-actions', style: { justifyContent: 'flex-end' } },
        h('button', { type: 'button', className: 'dsh-wb-btn', onClick: () => setEditing(null) }, t('table.cancel')),
        h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'primary', disabled: busy, onClick: save }, t('table.save')),
      ),
    )
  }

  function renderRow(entry) {
    const first = config.fields[0]
    const second = config.fields[1]
    const rest = config.fields.slice(2)
    const chip = config.chipKey !== undefined ? String(entry[config.chipKey] ?? '') : ''
    return h('div', { className: 'dsh-wb-row', key: entry.id },
      h('div', { className: 'dsh-wb-row-title' },
        h('span', null, String(entry[first.key] ?? '') !== '' ? entry[first.key] : '—'),
        second !== undefined && String(entry[second.key] ?? '') !== ''
          ? h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 400 } }, ' · ' + entry[second.key])
          : null,
        chip !== '' ? h('span', { className: 'dsh-wb-chip' }, chip) : null,
      ),
      rest.length > 0
        ? h('div', { className: 'dsh-wb-row-meta' },
            rest.map((field) => t(field.labelKey) + '：' + (String(entry[field.key] ?? '') !== '' ? entry[field.key] : '—')).join(' · '))
        : null,
      h('div', { className: 'dsh-wb-row-actions' },
        h('button', { type: 'button', className: 'dsh-wb-btn', onClick: () => insertRow(entry) }, t('table.insert')),
        h('button', { type: 'button', className: 'dsh-wb-btn', onClick: () => copyRow(entry) }, t('table.copy')),
        h('button', { type: 'button', className: 'dsh-wb-btn', onClick: () => setEditing({ ...payloadOf(entry), id: entry.id }) }, t('table.edit')),
        h('button', { type: 'button', className: 'dsh-wb-btn', disabled: busy, onClick: () => removeEntry(entry) }, t('table.del')),
      ),
      editing !== null && editing.id === entry.id ? renderForm() : null,
    )
  }

  const fallbackTitle = t(config.titleKey)
  const title = card !== null && card !== undefined && typeof card.title === 'string' && card.title !== ''
    ? card.title
    : fallbackTitle
  const stateName = state.status === 'error'
    ? 'error'
    : state.status === 'loading'
      ? 'idle'
      : data !== null && data.exists === false
        ? 'missing'
        : 'ok'
  const stateText = state.status === 'loading'
    ? t('panel.loading')
    : state.status === 'error'
      ? t('state.error')
      : data !== null && Number.isFinite(data.total)
        ? String(data.total) + ' ' + t('table.total')
        : undefined
  const actions = [
    h('button', {
      key: 'refresh', type: 'button', className: 'dsh-wb-btn', 'data-tone': 'quiet',
      onClick: () => load(),
    }, t('panel.refresh')),
    h('button', {
      key: 'add', type: 'button', className: 'dsh-wb-btn', 'data-tone': 'outline',
      onClick: () => setEditing(blank()),
    }, t('table.add')),
  ]

  return h(CardShell, { t, title, state: stateName, stateText, actions, note: t(config.subKey) },
    h('input', {
      className: 'dsh-wb-input',
      value: query,
      placeholder: t('table.search'),
      onChange: (event) => setQuery(event.target.value),
    }),
    editing !== null && editing.id === undefined ? renderForm() : null,
    data !== null && data.warning !== undefined ? h('div', { className: 'dsh-wb-error', style: { marginTop: '8px' } }, data.warning) : null,
    state.status === 'error' ? h('div', { className: 'dsh-wb-error', style: { marginTop: '8px' } }, state.message) : null,
    state.status === 'error'
      ? h('div', { className: 'dsh-wb-row-actions', style: { justifyContent: 'flex-end' } },
          h('button', { type: 'button', className: 'dsh-wb-btn', onClick: () => load() }, t('panel.retry')),
        )
      : null,
    state.status === 'loading' ? h('div', { className: 'dsh-wb-loading' }, t('panel.loading')) : null,
    state.status === 'ready' && visible.length === 0
      ? h('p', { className: 'dsh-wb-note' }, query.trim() === '' ? t(config.emptyKey) : t('panel.searchEmpty'))
      : null,
    state.status === 'ready' && visible.length > 0
      ? h('div', { style: { marginTop: '8px' } }, visible.map(renderRow))
      : null,
  )
}

/* ---------------------------------------------------------------- 四、造价计算器 */

/**
 * 造价计算器：纯前端、零请求。五个分区各自「填数 → 点计算 → 看结果」。
 * 所有公式都走 WB_CALC，本组件只负责取值、校验展示与排版。
 */
function CalcCard({ t }) {
  const [compositeDraft, setCompositeDraft] = React.useState({
    labor: '', material: '', machine: '', overheadRate: '10', profitRate: '5', fee: '0', taxRate: '9',
  })
  const [compositeResult, setCompositeResult] = React.useState({ status: 'idle' })
  const [totalDraft, setTotalDraft] = React.useState({ direct: '', measures: '', other: '', fee: '0', taxRate: '9' })
  const [totalResult, setTotalResult] = React.useState({ status: 'idle' })
  const [rebarDraft, setRebarDraft] = React.useState('12, 16, 20, 25')
  const [rebarResult, setRebarResult] = React.useState({ status: 'idle' })
  const [areaDraft, setAreaDraft] = React.useState({ total: '', area: '', steel: '' })
  const [areaResult, setAreaResult] = React.useState({ status: 'idle' })
  const [convertDraft, setConvertDraft] = React.useState({ value: '1', from: 'm3', to: 'l' })
  const [convertResult, setConvertResult] = React.useState({ status: 'idle' })

  /** 一个数字输入行：label + input。 */
  function numberField(key, labelKey, value, onChange) {
    return h('div', { className: 'dsh-wb-field', key },
      h('label', { style: { width: '76px' } }, t(labelKey)),
      h('input', {
        className: 'dsh-wb-input',
        value,
        inputMode: 'decimal',
        onChange: (event) => onChange(event.target.value),
      }),
    )
  }

  /** 一个分区外壳：标题 + 内容。 */
  function section(key, titleKey, children) {
    return h('div', { className: 'dsh-wb-card', key, style: { marginTop: '10px' } },
      h('div', { className: 'dsh-wb-row-title', style: { marginBottom: '6px' } }, t(titleKey)),
      children,
    )
  }

  /** 分区底部的「计算」按钮。 */
  function calculateButton(key, onClick) {
    return h('div', { className: 'dsh-wb-row-actions', key, style: { justifyContent: 'flex-end' } },
      h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'primary', onClick }, t('calc.calculate')),
    )
  }

  /** 单值结果的统一渲染：非法 →「请输入数字」，正常 → 两位小数 + 单位。 */
  function resultText(key, result, labelText, suffix) {
    if (result.status === 'invalid') {
      return h('div', { className: 'dsh-wb-error', key, style: { marginTop: '6px' } }, t('calc.invalid'))
    }
    if (result.status !== 'ok') return null
    return h('div', { className: 'dsh-wb-row-meta', key, style: { marginTop: '6px' } },
      labelText + '：' + wbFixed(result.value) + (suffix ?? ''))
  }

  function unitLabel(code) {
    const found = WB_CALC_UNITS.find((unit) => unit.code === code)
    return found !== undefined ? found.label : code
  }

  /* ---- ① 综合单价 —— 组价公式 */
  function calculateComposite() {
    const value = WB_CALC.unitPrice(compositeDraft)
    setCompositeResult(Number.isFinite(value) ? { status: 'ok', value } : { status: 'invalid' })
  }

  /* ---- ② 总造价 */
  function calculateTotal() {
    const value = WB_CALC.totalCost(totalDraft)
    setTotalResult(Number.isFinite(value) ? { status: 'ok', value } : { status: 'invalid' })
  }

  /* ---- ③ 钢筋理论重量（批量，逗号 / 空格 / 分号 / 换行分隔） */
  function calculateRebar() {
    const tokens = rebarDraft.split(/[,，;；\s]+/).map((token) => token.trim()).filter((token) => token !== '')
    if (tokens.length === 0) {
      setRebarResult({ status: 'invalid' })
      return
    }
    const rows = []
    for (const token of tokens) {
      const weight = WB_CALC.rebarWeight(token)
      if (!Number.isFinite(weight)) {
        setRebarResult({ status: 'invalid' })
        return
      }
      rows.push({ diameter: token, weight })
    }
    setRebarResult({ status: 'ok', rows })
  }

  function renderRebarResult() {
    if (rebarResult.status === 'invalid') {
      return h('div', { className: 'dsh-wb-error', key: 'rebar-error', style: { marginTop: '6px' } }, t('calc.invalid'))
    }
    if (rebarResult.status !== 'ok') return null
    return h('div', { key: 'rebar-out', style: { marginTop: '6px' } },
      rebarResult.rows.map((row, index) => h('div', { className: 'dsh-wb-row-meta', key: index },
        'Ø' + row.diameter + ' → ' + wbFixed(row.weight) + ' kg/m')),
    )
  }

  /* ---- ④ 单位造价与含钢量 */
  function calculateArea() {
    const cost = WB_CALC.costPerArea(areaDraft.total, areaDraft.area)
    const steel = WB_CALC.steelPerArea(areaDraft.steel, areaDraft.area)
    if (!Number.isFinite(cost) || !Number.isFinite(steel)) {
      setAreaResult({ status: 'invalid' })
      return
    }
    setAreaResult({ status: 'ok', cost, steel })
  }

  function renderAreaResult() {
    if (areaResult.status === 'invalid') {
      return h('div', { className: 'dsh-wb-error', key: 'area-error', style: { marginTop: '6px' } }, t('calc.invalid'))
    }
    if (areaResult.status !== 'ok') return null
    return h('div', { key: 'area-out', style: { marginTop: '6px' } },
      h('div', { className: 'dsh-wb-row-meta' }, wbText(t, 'calc.costPerArea', '单位造价') + '：' + wbFixed(areaResult.cost) + ' 元/m²'),
      h('div', { className: 'dsh-wb-row-meta' }, wbText(t, 'calc.steelPerArea', '含钢量') + '：' + wbFixed(areaResult.steel) + ' kg/m²'),
    )
  }

  /* ---- ⑤ 单位换算 */
  function calculateConvert() {
    const amount = wbNumber(convertDraft.value)
    if (!Number.isFinite(amount)) {
      setConvertResult({ status: 'invalid' })
      return
    }
    const value = WB_CALC.convert(amount, convertDraft.from, convertDraft.to)
    setConvertResult(Number.isFinite(value) ? { status: 'ok', value } : { status: 'mismatch' })
  }

  function renderConvertResult() {
    if (convertResult.status === 'invalid') {
      return h('div', { className: 'dsh-wb-error', key: 'convert-invalid', style: { marginTop: '6px' } }, t('calc.invalid'))
    }
    if (convertResult.status === 'mismatch') {
      return h('div', { className: 'dsh-wb-error', key: 'convert-mismatch', style: { marginTop: '6px' } },
        wbText(t, 'calc.unitMismatch', '单位类型不一致'))
    }
    if (convertResult.status !== 'ok') return null
    return h('div', { className: 'dsh-wb-row-meta', style: { marginTop: '6px' } },
      t('calc.result') + '：' + wbFixed(convertResult.value) + ' ' + unitLabel(convertDraft.to))
  }

  function updateConvert(patch) {
    setConvertDraft((current) => ({ ...current, ...patch }))
  }

  return h(CardShell, { t, title: t('calc.title'), note: t('calc.sub') },
    section('composite', 'calc.unitPrice', [
      numberField('labor', 'calc.labor', compositeDraft.labor, (value) => setCompositeDraft((current) => ({ ...current, labor: value }))),
      numberField('material', 'calc.material', compositeDraft.material, (value) => setCompositeDraft((current) => ({ ...current, material: value }))),
      numberField('machine', 'calc.machine', compositeDraft.machine, (value) => setCompositeDraft((current) => ({ ...current, machine: value }))),
      numberField('overheadRate', 'calc.overhead', compositeDraft.overheadRate, (value) => setCompositeDraft((current) => ({ ...current, overheadRate: value }))),
      numberField('profitRate', 'calc.profit', compositeDraft.profitRate, (value) => setCompositeDraft((current) => ({ ...current, profitRate: value }))),
      numberField('fee', 'calc.fee', compositeDraft.fee, (value) => setCompositeDraft((current) => ({ ...current, fee: value }))),
      numberField('taxRate', 'calc.tax', compositeDraft.taxRate, (value) => setCompositeDraft((current) => ({ ...current, taxRate: value }))),
      calculateButton('composite-actions', calculateComposite),
      resultText('composite-result', compositeResult, t('calc.unitPrice')),
    ]),
    section('total', 'calc.totalCost', [
      numberField('direct', 'calc.subtotal', totalDraft.direct, (value) => setTotalDraft((current) => ({ ...current, direct: value }))),
      numberField('measures', 'calc.measures', totalDraft.measures, (value) => setTotalDraft((current) => ({ ...current, measures: value }))),
      numberField('other', 'calc.others', totalDraft.other, (value) => setTotalDraft((current) => ({ ...current, other: value }))),
      numberField('fee', 'calc.fee', totalDraft.fee, (value) => setTotalDraft((current) => ({ ...current, fee: value }))),
      numberField('taxRate', 'calc.tax', totalDraft.taxRate, (value) => setTotalDraft((current) => ({ ...current, taxRate: value }))),
      calculateButton('total-actions', calculateTotal),
      resultText('total-result', totalResult, t('calc.totalCost')),
    ]),
    section('rebar', 'calc.rebar', [
      h('div', { className: 'dsh-wb-field', key: 'rebar' },
        h('label', { style: { width: '76px' } }, t('calc.diameter')),
        h('textarea', {
          className: 'dsh-wb-textarea',
          style: { minHeight: '52px', fontFamily: 'inherit' },
          value: rebarDraft,
          placeholder: t('calc.rebarHint'),
          onChange: (event) => setRebarDraft(event.target.value),
        }),
      ),
      calculateButton('rebar-actions', calculateRebar),
      renderRebarResult(),
    ]),
    section('area', 'calc.indicators', [
      numberField('total', 'calc.totalCost', areaDraft.total, (value) => setAreaDraft((current) => ({ ...current, total: value }))),
      numberField('area', 'calc.area', areaDraft.area, (value) => setAreaDraft((current) => ({ ...current, area: value }))),
      numberField('steel', 'calc.steel', areaDraft.steel, (value) => setAreaDraft((current) => ({ ...current, steel: value }))),
      calculateButton('area-actions', calculateArea),
      renderAreaResult(),
    ]),
    section('convert', 'calc.convert', [
      numberField('value', 'calc.value', convertDraft.value, (value) => updateConvert({ value })),
      h('div', { className: 'dsh-wb-field', key: 'from' },
        h('label', { style: { width: '76px' } }, t('calc.from')),
        h('select', {
          className: 'dsh-wb-input',
          value: convertDraft.from,
          onChange: (event) => updateConvert({ from: event.target.value }),
        }, WB_CALC_UNITS.map((unit) => h('option', { key: unit.code, value: unit.code }, unit.label))),
      ),
      h('div', { className: 'dsh-wb-field', key: 'to' },
        h('label', { style: { width: '76px' } }, t('calc.to')),
        h('select', {
          className: 'dsh-wb-input',
          value: convertDraft.to,
          onChange: (event) => updateConvert({ to: event.target.value }),
        }, WB_CALC_UNITS.map((unit) => h('option', { key: unit.code, value: unit.code }, unit.label))),
      ),
      calculateButton('convert-actions', calculateConvert),
      renderConvertResult(),
    ]),
  )
}

        function SopCard({ card, t, requestInsert, setFlash, vault, focusNote, onFocusHandled, focusMode, setFocusMode, refreshTick = 0 }) {
          const [state, setState] = React.useState({ status: 'loading' })
          const [doc, setDoc] = React.useState(null)
          const [editor, setEditor] = React.useState(null)
          const [engine, setEngine] = React.useState('volc')
          const [confirming, setConfirming] = React.useState(false)
          const [renaming, setRenaming] = React.useState(null)
          const [annotations, setAnnotations] = React.useState([])
          const [pending, setPending] = React.useState(null)
          const [draft, setDraft] = React.useState(null)
          const [showComments, setShowComments] = React.useState(true)
          const [findText, setFindText] = React.useState('')
          const [findPos, setFindPos] = React.useState(0)
          const [liveLines, setLiveLines] = React.useState([])
          const [expanded, setExpanded] = React.useState({})
          const [busy, setBusy] = React.useState(false)
          const lastLoaded = React.useRef(0)
          const currentPath = React.useRef(null)

          const selectPath = React.useCallback((path) => {
            currentPath.current = path
            return api('/sop?note=' + encodeURIComponent(path)).then(
              (data) => { setDoc(data.note) },
              (error) => { setFlash('读取正文失败：' + error.message) },
            )
          }, [setFlash])

          const load = React.useCallback((force) => {
            setBusy(true)
            lastLoaded.current = Date.now()
            const path = force === true ? '/sop/refresh' : '/sop'
            return api(path, force === true ? { method: 'POST' } : undefined).then(
              (data) => {
                setState({ status: 'ready', data })
                // 目录刷新后，把正在读的那篇也重读一次（Obsidian 里改完切回来就是新的）。
                if (currentPath.current !== null) {
                  api('/sop?note=' + encodeURIComponent(currentPath.current)).then(
                    (fresh) => setDoc((previous) => (previous !== null && previous.sha1 === fresh.note.sha1 ? previous : fresh.note)),
                    () => {},
                  )
                }
              },
              (error) => setState({ status: 'error', message: error.message }),
            ).finally(() => setBusy(false))
          }, [])

          React.useEffect(() => { load(false) }, [load])

          // 切回窗口时重读（1.5 秒内不重复）。
          React.useEffect(() => {
            function refresh() {
              if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
              if (Date.now() - lastLoaded.current < 1500) return
              load(true)
            }
            document.addEventListener('visibilitychange', refresh)
            window.addEventListener('focus', refresh)
            return () => {
              document.removeEventListener('visibilitychange', refresh)
              window.removeEventListener('focus', refresh)
            }
          }, [load])

          // 顶部搜索里点「去 SOP」→ 直接选中那篇。
          React.useEffect(() => {
            if (typeof focusNote !== 'string' || focusNote === '') return
            selectPath(focusNote)
            if (typeof onFocusHandled === 'function') onFocusHandled()
          }, [focusNote])

          // 第一次拿到目录树时默认展开：除 PDF 之外的所有文件夹（PDF 里没有笔记，展开只是噪音）。
          // 只做一次——你手动收起的文件夹不会被强制再展开。
          React.useEffect(() => {
            const tree = state.status === 'ready' && Array.isArray(state.data.tree) ? state.data.tree : []
            if (tree.length === 0) return
            setExpanded((previous) => {
              if (Object.keys(previous).length > 0) return previous
              const next = {}
              const walk = (nodes) => {
                for (const node of nodes) {
                  if (node.type !== 'dir') continue
                  const top = String(node.path).split('/')[0]
                  if (top.toLowerCase() !== 'pdf') next[node.path] = true
                  walk(node.children)
                }
              }
              walk(tree)
              return next
            })
          }, [state])

          // 顶部刷新按钮触发的强制重扫（首次挂载时 load(false) 已经跑过，这里跳过）
          const firstTick = React.useRef(true)
          React.useEffect(() => {
            if (firstTick.current) { firstTick.current = false; return }
            void load(true)
          }, [refreshTick, load])

          function toggleDir(path) {
            setExpanded((previous) => ({ ...previous, [path]: previous[path] !== true }))
          }

          function openEditor() {
            if (doc === null) return
            setEditor({ mode: 'edit', path: doc.path, title: doc.title, text: doc.text, sha1: doc.sha1, error: null })
          }

          /** 在 Obsidian 里打开这一篇（走 Host 的 /open-obsidian，避开 Web 壳丢弃自定义协议）。 */
          function openInObsidian(path) {
            api('/open-obsidian', { method: 'POST', body: { path } }).then(
              () => setFlash('已在 Obsidian 打开'),
              (error) => setFlash('打开失败：' + error.message),
            )
          }

          function newNote() {
            const currentFolder = doc === null ? '' : doc.path.split('/').slice(0, -1).join('/')
            const matched = folders.find((folder) => folder.value === currentFolder)
            const fallback = folders.length > 0 ? folders[0].value : String(vault.sopDir ?? '').replace(/\/+$/, '')
            setEditor({ mode: 'create', folder: matched !== undefined ? matched.value : fallback, name: '', text: '', error: null })
          }

          function saveEditor() {
            if (editor === null) return
            setBusy(true)
            const isCreate = editor.mode === 'create'
            const folder = String(editor.folder ?? '').trim() === '' ? String(vault.sopDir ?? '') : String(editor.folder)
            const path = isCreate
              ? folder.replace(/^\/+|\/+$/g, '') + '/' + String(editor.name ?? '').trim().replace(/\.md$/i, '').replace(/^\/+/, '') + '.md'
              : editor.path
            const request = isCreate
              ? api('/sop/note', { method: 'POST', body: { path, text: editor.text } })
              : api('/sop/note', { method: 'PUT', body: { path, text: editor.text, expectedSha1: editor.sha1 } })
            request.then(
              (data) => {
                const target = data.note.path
                setEditor(null)
                setFlash(isCreate ? t('sop.created') : t('sop.saved'))
                return load(true).then(() => selectPath(target))
              },
              (error) => {
                setEditor((current) => current === null ? null : { ...current, error: error.code === 'conflict' ? 'conflict' : error.message })
              },
            ).finally(() => setBusy(false))
          }

          function forceOverwrite() {
            if (editor === null) return
            setBusy(true)
            api('/sop/note', { method: 'PUT', body: { path: editor.path, text: editor.text } }).then(
              () => { setEditor(null); setFlash(t('sop.saved')); return load(true).then(() => selectPath(editor.path)) },
              (error) => setEditor((current) => current === null ? null : { ...current, error: error.message }),
            ).finally(() => setBusy(false))
          }

          const data = state.status === 'ready' ? state.data : null
          const stats = data !== null ? data.stats : null
          const tree = data !== null && Array.isArray(data.tree) ? data.tree : []

          // 新建笔记的目录：整棵目录树里所有含笔记的文件夹，按层级缩进（PDF 这类空目录不出现）。
          const sopBase = String(vault.sopDir ?? '').replace(/\/+$/, '')
          const folders = []
          const collectFolders = (nodes, depth) => {
            for (const node of nodes) {
              if (node.type !== 'dir') continue
              if (node.count > 0) {
                folders.push({
                  label: '\u3000'.repeat(depth) + node.name,
                  value: sopBase + '/' + node.path,
                  depth,
                })
              }
              collectFolders(node.children, depth + 1)
            }
          }
          collectFolders(tree, 0)

          function renderNodes(nodes, depth) {
            return nodes.map((node) => {
              if (node.type === 'dir') {
                const open = expanded[node.path] === true
                return h('div', { key: node.path },
                  h('button', {
                    type: 'button',
                    className: 'dsh-wb-tree-row',
                    'data-empty': node.count === 0,
                    style: { paddingLeft: (depth * 11 + 2) + 'px' },
                    onClick: () => toggleDir(node.path),
                    title: node.name,
                  },
                    h('span', { className: 'dsh-wb-tree-caret' }, open ? '▾' : '▸'),
                    h('span', { className: 'dsh-wb-tree-name' }, node.name),
                    h('span', { className: 'dsh-wb-tree-count' }, String(node.count)),
                  ),
                  open ? renderNodes(node.children, depth + 1) : null,
                )
              }
              const active = doc !== null && doc.path === node.path
              return h('button', {
                key: node.path,
                type: 'button',
                className: 'dsh-wb-tree-row dsh-wb-tree-note',
                'data-active': active,
                style: { paddingLeft: (depth * 11 + 15) + 'px' },
                onClick: () => selectPath(node.path),
                title: node.path,
              },
                h('span', { className: 'dsh-wb-tree-dot' }, active ? '●' : '·'),
                h('span', { className: 'dsh-wb-tree-name' }, node.name),
              )
            })
          }

          const actions = [
            h('button', { key: 'new', type: 'button', className: 'dsh-wb-btn', 'data-tone': 'primary', onClick: newNote }, t('sop.new')),
            focusMode ? null : h('button', {
              key: 'focus',
              type: 'button',
              className: 'dsh-wb-btn',
              'data-tone': 'quiet',
              title: '隐藏目录、卡片索引与搜索，整块留给阅读',
              onClick: () => setFocusMode(true),
            }, '专注模式'),
          ]

          const editorView = editor === null ? null : h('div', { className: 'dsh-wb-editor' },
            h('div', { className: 'dsh-wb-row-title', style: { marginBottom: '6px' } },
              h('span', null, editor.mode === 'create' ? t('sop.creating') : t('sop.editing') + ' · ' + editor.title),
            ),
            editor.mode === 'create'
              ? h('div', null,
                  h('div', { className: 'dsh-wb-field' },
                    h('label', null, t('sop.folder')),
                    h('select', {
                      className: 'dsh-wb-input dsh-wb-select',
                      value: editor.folder ?? '',
                      onChange: (e) => setEditor({ ...editor, folder: e.target.value }),
                    },
                      folders.map((folder) => h('option', { key: folder.value, value: folder.value }, folder.label)),
                      folders.length === 0 ? h('option', { value: String(vault.sopDir ?? '') }, String(vault.sopDir ?? '')) : null,
                    ),
                  ),
                  h('div', { className: 'dsh-wb-field' },
                    h('label', null, t('sop.filename')),
                    h('input', { className: 'dsh-wb-input', value: editor.name, placeholder: t('sop.newTitle'), onChange: (e) => setEditor({ ...editor, name: e.target.value }) }),
                  ),
                )
              : h('div', { className: 'dsh-wb-note' }, editor.path),
            h('textarea', {
              className: 'dsh-wb-textarea',
              value: editor.text,
              placeholder: t('sop.body'),
              onChange: (e) => setEditor({ ...editor, text: e.target.value }),
            }),
            editor.error === 'conflict'
              ? h('div', { className: 'dsh-wb-error' }, t('sop.conflict'))
              : editor.error !== null && editor.error !== undefined
                ? h('div', { className: 'dsh-wb-error' }, editor.error)
                : null,
            h('div', { style: { display: 'flex', gap: '4px', justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: '6px' } },
              editor.error === 'conflict'
                ? h('button', { type: 'button', className: 'dsh-wb-btn', onClick: () => selectPath(editor.path).then(() => openEditor()) }, t('sop.reload'))
                : null,
              editor.error === 'conflict'
                ? h('button', { type: 'button', className: 'dsh-wb-btn', disabled: busy, onClick: forceOverwrite }, t('sop.conflictForce'))
                : null,
              h('button', { type: 'button', className: 'dsh-wb-btn', onClick: () => setEditor(null) }, t('sop.cancel')),
              h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'primary', disabled: busy, onClick: saveEditor }, t('sop.save')),
            ),
          )

          const reader = editor !== null
            ? editorView
            : doc === null
              ? h('div', { className: 'dsh-wb-empty' }, h('div', { className: 'dsh-wb-note' }, t('sop.pickNote')))
              : h('div', null,
                  h('div', { className: 'dsh-wb-doc-head' },
                    h('div', { className: 'dsh-wb-doc-title' }, doc.title),
                    h('div', { className: 'dsh-wb-doc-meta' }, formatTime(doc.mtimeMs) + ' · ' + doc.chars + ' ' + t('sop.chars')),
                    h('div', { className: 'dsh-wb-row-actions' },
                      h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'quiet', onClick: openEditor }, t('sop.edit')),
                      h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'quiet', onClick: () => requestInsert(doc.text, doc.title) }, t('sop.insert')),
                      h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'quiet', onClick: () => {
                        copyText(doc.text).then((ok) => setFlash(ok ? t('copy.done') : t('copy.failed')))
                      } }, t('sop.copy')),
                      h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'quiet', onClick: () => openInObsidian(doc.path) }, t('sop.open')),
                    ),
                  ),
                  h(MarkdownBody, { text: doc.text, t }),
                )

          return h(CardShell, {
            t,
            fill: true,
            title: card.title,
            state: state.status === 'error' ? 'error' : 'ready',
            stateText: stats !== null
              ? stats.count + ' ' + t('sop.pages') + ' · ' + stats.chars + ' ' + t('sop.chars')
              : undefined,
            actions,
          },
            state.status === 'error' ? h('div', { className: 'dsh-wb-error' }, state.message) : null,
            state.status === 'loading' && stats === null ? h('div', { className: 'dsh-wb-loading' }, t('panel.loading')) : null,
            h('div', { className: 'dsh-wb-split' },
              focusMode ? null : h('div', { className: 'dsh-wb-nav' },
                h('div', { className: 'dsh-wb-nav-title' }, vault.sopDir ?? t('sop.nav')),
                h('div', { className: 'dsh-wb-treelist' },
                  tree.length === 0 && state.status === 'ready'
                    ? h('div', { className: 'dsh-wb-note' }, t('sop.noNotes'))
                    : renderNodes(tree, 0),
                ),
              ),
              h('div', { className: 'dsh-wb-reading' }, reader),
            ),
          )
        }

        /* ------------------------------------------------------------- 录音 */

        /** Float32(-1..1) → 16bit PCM。 */
        function toInt16(float32) {
          const out = new Int16Array(float32.length)
          for (let index = 0; index < float32.length; index += 1) {
            const sample = Math.max(-1, Math.min(1, float32[index]))
            out[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff)
          }
          return out
        }

        /** 把音频文件解码并重采样成 16k 单声道 PCM。 */
        async function decodeFileToPcm16(file) {
          const data = await file.arrayBuffer()
          const probe = new AudioContext()
          const decoded = await probe.decodeAudioData(data)
          await probe.close()
          const frames = Math.ceil(decoded.duration * 16000)
          const offline = new OfflineAudioContext(1, Math.max(1, frames), 16000)
          const source = offline.createBufferSource()
          source.buffer = decoded
          source.connect(offline.destination)
          source.start()
          const rendered = await offline.startRendering()
          return toInt16(rendered.getChannelData(0))
        }

        /** 从任意采样率降到 16k（简单分块平均，够用且不引依赖）。 */
        function downsampleTo16k(input, fromRate) {
          if (fromRate === 16000) return input
          const ratio = fromRate / 16000
          const out = new Float32Array(Math.floor(input.length / ratio))
          for (let index = 0; index < out.length; index += 1) {
            const start = Math.floor(index * ratio)
            const end = Math.min(input.length, Math.floor((index + 1) * ratio))
            let sum = 0
            for (let cursor = start; cursor < end; cursor += 1) sum += input[cursor]
            out[index] = end > start ? sum / (end - start) : 0
          }
          return out
        }

        function formatClock(seconds) {
          const value = Number(seconds)
          if (!Number.isFinite(value) || value <= 0) return '00:00'
          const total = Math.floor(value)
          const hours = Math.floor(total / 3600)
          const minutes = Math.floor((total % 3600) / 60)
          const rest = total % 60
          const mmss = String(minutes).padStart(2, '0') + ':' + String(rest).padStart(2, '0')
          return hours > 0 ? String(hours).padStart(2, '0') + ':' + mmss : mmss
        }

        function IconRewind15() {
          return h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'M12 5a7 7 0 1 1-6.6 4.7', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
            h('path', { d: 'M5 3.4v5h5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
            h('text', { x: 12.5, y: 15.5, textAnchor: 'middle', fontSize: '6.5', fill: 'currentColor' }, '15'),
          )
        }

        function IconForward15() {
          return h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'M12 5a7 7 0 1 0 6.6 4.7', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
            h('path', { d: 'M19 3.4v5h-5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
            h('text', { x: 11.5, y: 15.5, textAnchor: 'middle', fontSize: '6.5', fill: 'currentColor' }, '15'),
          )
        }

        /**
         * DeepSeek 峰谷定价（官方脚注）：北京时间周一至周五 9:00–12:00、14:00–18:00 为高峰，
         * 其余时段（含 12:00–14:00 午休、夜间、周末、法定节假日全天）为谷价，价格减半。
         * 节假日表按国务院 2026 年通知；2027 年安排通常 11 月才公布，届时补进 CN_HOLIDAY_RANGES。
         */
        const CN_HOLIDAY_RANGES = [
          ['2026-01-01', '2026-01-03'],
          ['2026-02-15', '2026-02-23'],
          ['2026-04-04', '2026-04-06'],
          ['2026-05-01', '2026-05-05'],
          ['2026-06-19', '2026-06-21'],
          ['2026-09-25', '2026-09-27'],
          ['2026-10-01', '2026-10-07'],
        ]

        const CN_HOLIDAYS = (() => {
          const set = new Set()
          for (const [from, to] of CN_HOLIDAY_RANGES) {
            const cursor = new Date(from + 'T00:00:00Z')
            const end = new Date(to + 'T00:00:00Z')
            while (cursor.getTime() <= end.getTime()) {
              set.add(cursor.toISOString().slice(0, 10))
              cursor.setUTCDate(cursor.getUTCDate() + 1)
            }
          }
          return set
        })()

        /** 把某个时刻换算成「北京时间的那一天/那一分钟」。中国无夏令时，直接加 8 小时即可。 */
        function beijingParts(ms) {
          const shifted = new Date(ms + 8 * 3600 * 1000)
          return {
            key: shifted.toISOString().slice(0, 10),
            weekday: shifted.getUTCDay(),
            minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
          }
        }

        function isPeakPricing(ms) {
          const parts = beijingParts(ms)
          if (parts.weekday === 0 || parts.weekday === 6) return false
          if (CN_HOLIDAYS.has(parts.key)) return false
          const morning = parts.minutes >= 9 * 60 && parts.minutes < 12 * 60
          const afternoon = parts.minutes >= 14 * 60 && parts.minutes < 18 * 60
          return morning || afternoon
        }

        /** 下一次峰谷切换的时刻说明，例如「明天 09:00」。 */
        function nextPricingSwitch(nowMs) {
          const current = isPeakPricing(nowMs)
          for (let step = 1; step <= 8 * 24 * 60; step += 1) {
            const at = nowMs + step * 60000
            if (isPeakPricing(at) === current) continue
            const parts = beijingParts(at)
            const clock = String(Math.floor(parts.minutes / 60)).padStart(2, '0') + ':' + String(parts.minutes % 60).padStart(2, '0')
            const startOfToday = beijingParts(nowMs).key
            const startOfThat = beijingParts(at).key
            const dayDiff = Math.round((Date.parse(startOfThat) - Date.parse(startOfToday)) / 86400000)
            const dayLabel = dayDiff === 0 ? '今天' : dayDiff === 1 ? '明天' : dayDiff === 2 ? '后天' : ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][parts.weekday]
            return dayLabel + ' ' + clock
          }
          return ''
        }

        function deepseekPricingNow() {
          const now = Date.now()
          const peak = isPeakPricing(now)
          const parts = beijingParts(now)
          const inLunch = parts.weekday >= 1 && parts.weekday <= 5 && !CN_HOLIDAYS.has(parts.key) && parts.minutes >= 12 * 60 && parts.minutes < 14 * 60
          return {
            peak,
            inLunch,
            next: nextPricingSwitch(now),
            label: peak ? '峰价' : (inLunch ? '谷价（午间）' : '谷价（半价）'),
          }
        }

        function IconMic({ size = 20 }) {
          return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
            h('rect', { x: 9, y: 3, width: 6, height: 11, rx: 3, fill: 'currentColor' }),
            h('path', { d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
          )
        }

        function IconStop({ size = 18 }) {
          return h('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true },
            h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2.5, fill: 'currentColor' }))
        }

        function IconRefresh({ size = 15 }) {
          return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'M13 8A5 5 0 1 1 11.5 4.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
            h('path', { d: 'M13 3.2v3.3H9.7', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
          )
        }

        function IconPencil({ size = 14 }) {
          return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'M10.8 2.9 13 5.1 5.6 12.5H3.4v-2.2z', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
          )
        }


        function IconCopy({ size = 14 }) {
          return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
            h('rect', { x: 5.2, y: 5.2, width: 8, height: 8, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.4 }),
            h('path', { d: 'M10.6 3.2H4.2a1.6 1.6 0 0 0-1.6 1.6v6.4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
          )
        }

        function IconTrash({ size = 15 }) {
          return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
          )
        }

        function IconPlay() {
          return h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', 'aria-hidden': true },
            h('path', { d: 'M8 5.5v13l11-6.5z', fill: 'currentColor' }))
        }

        function IconPause() {
          return h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', 'aria-hidden': true },
            h('rect', { x: 7, y: 5, width: 3.6, height: 14, rx: 1, fill: 'currentColor' }),
            h('rect', { x: 13.4, y: 5, width: 3.6, height: 14, rx: 1, fill: 'currentColor' }))
        }

        /** canvas 波形：按峰值归一化，已播放段用品牌色，其余用弱色。 */
        function Waveform({ peaks, progress, onSeek }) {
          const ref = React.useRef(null)
          const dragging = React.useRef(false)
          React.useEffect(() => {
            const canvas = ref.current
            if (canvas === null) return
            const ctx = canvas.getContext('2d')
            const width = canvas.width
            const height = canvas.height
            ctx.clearRect(0, 0, width, height)
            const list = Array.isArray(peaks) && peaks.length > 0 ? peaks : new Array(120).fill(0.25)
            const max = Math.max(0.05, ...list)
            const style = getComputedStyle(canvas)
            const brand = (style.getPropertyValue('--dsw-alias-brand-primary') || '#2f6fed').trim()
            const idle = (style.getPropertyValue('--dsw-alias-border-l2') || '#c9c9c9').trim()
            const played = Math.max(0, Math.min(1, progress || 0))
            const slot = width / list.length
            const barWidth = Math.max(1.5, slot * 0.55)
            list.forEach((peak, index) => {
              const ratio = Math.max(0.04, Math.min(1, peak / max))
              const barHeight = Math.max(3, ratio * (height - 6))
              ctx.fillStyle = (index + 0.5) / list.length <= played ? brand : idle
              ctx.fillRect(index * slot + (slot - barWidth) / 2, (height - barHeight) / 2, barWidth, barHeight)
            })
          }, [peaks, progress])
          const seekFrom = (event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
            if (typeof onSeek === 'function') onSeek(ratio)
          }
          return h('canvas', {
            ref,
            width: 960,
            height: 88,
            className: 'dsh-wb-wave-canvas',
            // 按下即可定位并开始拖动；pointer capture 保证拖出画布也继续跟随。
            onPointerDown: (event) => {
              dragging.current = true
              try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
              seekFrom(event)
            },
            onPointerMove: (event) => {
              if (!dragging.current) return
              seekFrom(event)
            },
            onPointerUp: (event) => {
              dragging.current = false
              try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
            },
            onClick: (event) => { seekFrom(event) },
            onPointerCancel: () => { dragging.current = false },
            onPointerLeave: (event) => {
              if (event.buttons === 0) dragging.current = false
            },
          })
        }

        /** 模块级：当前正在录的那条。面板重新挂载后组件 state 会丢，这个不会。 */
        let ACTIVE_RECORDING_ID = null

        /** 批注分两组显示：「仅高亮」与「有文字」——两者的用途不同，混在一起看不清。 */
        function annotationGroups(list, options = {}) {
          const items = list.slice().sort((left, right) => (left.line ?? 0) - (right.line ?? 0))
          const highlights = items.filter((item) => String(item.note ?? '').trim() === '')
          const notes = items.filter((item) => String(item.note ?? '').trim() !== '')
          const withJump = options.withJump === true
          const onRemove = options.onRemove
          const card = (item) => h('div', { key: item.id, className: 'dsh-wb-annot-card', 'data-color': item.color },
            h('div', {
              className: 'dsh-wb-annot-quote',
              title: withJump ? '跳到原文' : undefined,
              onClick: withJump
                ? () => {
                    const target = document.querySelector('[data-line="' + item.line + '"]')
                    if (target !== null) target.scrollIntoView({ block: 'center', behavior: 'smooth' })
                  }
                : undefined,
            }, '「' + item.quote + '」'),
            item.note === '' ? h('div', { className: 'dsh-wb-note' }, '仅高亮') : h('div', { className: 'dsh-wb-annot-note' }, item.note),
            h('div', { className: 'dsh-wb-annot-foot' },
              h('span', { className: 'dsh-wb-note' }, item.time === null || item.time === undefined ? '' : formatClock(item.time / 1000)),
              h('button', {
                type: 'button', className: 'dsh-wb-btn dsh-wb-icon-btn', title: '删除批注', 'aria-label': '删除批注',
                onClick: () => onRemove?.(item.id),
              }, h(IconTrash, { size: 15 })),
            ),
          )
          return [
            // 高亮默认折叠：数量先摆出来，点开才展开明细，避免淹没自己写过的批注
            highlights.length === 0 ? null : h('details', { key: 'h-group', className: 'dsh-wb-annot-fold' },
              h('summary', { className: 'dsh-wb-nav-title' }, '高亮（' + highlights.length + '）· 点开'),
              ...highlights.map(card),
            ),
            notes.length === 0 ? null : h('div', { key: 'n-title', className: 'dsh-wb-nav-title', style: { marginTop: '6px' } }, '批注（' + notes.length + '）'),
            ...notes.map(card),
          ]
        }

        function RecorderCard({ card, t, setFlash, focusMode, setFocusMode, focusRecording, onRecordingHandled, onUsageChanged }) {
          const [list, setList] = React.useState({ status: 'loading', items: [] })
          const [selected, setSelected] = React.useState(null)
          const [rec, setRec] = React.useState({ status: 'idle', recordedMs: 0 })
          const [partial, setPartial] = React.useState('')
          const [importing, setImporting] = React.useState(false)
          const [playing, setPlaying] = React.useState(false)
          const [rate, setRate] = React.useState(1)
          const [progress, setProgress] = React.useState({ time: 0, duration: 0 })
          const [engine, setEngine] = React.useState('volc')
          const [confirming, setConfirming] = React.useState(false)
          const [renaming, setRenaming] = React.useState(null)
          const [annotations, setAnnotations] = React.useState([])
          const [pending, setPending] = React.useState(null)
          const [draft, setDraft] = React.useState(null)
          const [showComments, setShowComments] = React.useState(true)
          const [findText, setFindText] = React.useState('')
          const [findPos, setFindPos] = React.useState(0)
          const [liveLines, setLiveLines] = React.useState([])
          const [silentFor, setSilentFor] = React.useState(0)
          const audioRef = React.useRef(null)
          const bufferRef = React.useRef(new Int16Array(0))
          const statusRef = React.useRef('idle')
          const sessionRef = React.useRef({
            recId: null, sid: null, sse: null, stream: null, ctx: null, node: null,
            asrActive: false, audioOffsetMs: 0, recordedMs: 0, silenceMs: 0, lastTextAt: 0, lastText: '', restarting: false,
          })

          /** 静音判定：低于这个 RMS 视为没人说话。 */
          const VOICE_RMS = 0.012
          /** 连续静音多久停掉转写（只停 API，录音继续）。 */
          const SILENCE_LIMIT_MS = 2 * 60 * 1000

          const refresh = React.useCallback(() => {
            return api('/recordings').then(
              (data) => setList({ status: 'ready', items: Array.isArray(data.items) ? data.items : [] }),
              (error) => setList({ status: 'error', items: [], message: error.message }),
            )
          }, [])

          React.useEffect(() => { refresh() }, [refresh])

          // 录音卡被关掉/重挂时不能把录音丢下不管：停止采集、结束会话、把文件收尾。
          React.useEffect(() => {
            return () => {
              const session = sessionRef.current
              if (session.recId === null) return
              statusRef.current = 'idle'
              try { session.node?.disconnect() } catch {}
              try { session.ctx?.close() } catch {}
              try { session.stream?.getTracks().forEach((track) => track.stop()) } catch {}
              try { session.sse?.close() } catch {}
              const id = session.recId
              const sid = session.sid
              ACTIVE_RECORDING_ID = null
              sessionRef.current = { recId: null, sid: null, sse: null, stream: null, ctx: null, node: null, asrActive: false, audioOffsetMs: 0, recordedMs: 0, silenceMs: 0, lastTextAt: 0, lastText: '', restarting: false }
              const send = (urlPath) => {
                try {
                  void fetch(API + urlPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', keepalive: true })
                } catch {
                  // 关闭途中发不出去就算了，页头可由服务端 list() 时修补。
                }
              }
              if (sid !== null) send('/recording/asr/' + encodeURIComponent(sid) + '/finish')
              if (id !== null) send('/recordings/' + encodeURIComponent(id) + '/finalize')
            }
          }, [])


          // 全局搜索里点「去录音」→ 打开那一条。
          React.useEffect(() => {
            if (typeof focusRecording !== 'string' || focusRecording === '') return
            openRecording({ id: focusRecording })
            if (typeof onRecordingHandled === 'function') onRecordingHandled()
          }, [focusRecording])

          React.useEffect(() => {
            if (rec.status !== 'recording' && rec.status !== 'paused') return undefined
            const timer = setInterval(() => setRec((current) => ({ ...current, recordedMs: sessionRef.current.recordedMs })), 500)
            return () => clearInterval(timer)
          }, [rec.status])

          const openRecording = React.useCallback((item) => {
            setFindText('')
            setFindPos(0)
            setSelected({ id: item.id, item, transcript: '', peaks: null, loading: true })
            api('/recordings/' + encodeURIComponent(item.id) + '/transcript').then(
              (data) => setSelected((current) => current === null || current.id !== item.id ? current : { ...current, transcript: data.text ?? '', loading: false }),
              () => setSelected((current) => current === null || current.id !== item.id ? current : { ...current, loading: false }),
            )
            api('/recordings/' + encodeURIComponent(item.id) + '/peaks').then(
              (data) => setSelected((current) => current === null || current.id !== item.id ? current : { ...current, peaks: data.peaks ?? null }),
              () => {},
            )
            api('/recordings/' + encodeURIComponent(item.id) + '/annotations').then(
              (data) => setAnnotations(Array.isArray(data.annotations) ? data.annotations : []),
              () => setAnnotations([]),
            )
          }, [])

          const pushChunk = React.useCallback(async (pcm) => {
            const session = sessionRef.current
            if (session.recId === null) return
            const query = session.asrActive && session.sid !== null ? '?asr=' + encodeURIComponent(session.sid) : ''
            try {
              await fetch(API + '/recordings/' + encodeURIComponent(session.recId) + '/chunk' + query, {
                method: 'POST',
                body: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
              })
            } catch {
              // 单片失败不打断录制。
            }
          }, [])

          const enqueue = React.useCallback((int16) => {
            const merged = new Int16Array(bufferRef.current.length + int16.length)
            merged.set(bufferRef.current, 0)
            merged.set(int16, bufferRef.current.length)
            let offset = 0
            while (merged.length - offset >= 3200) {
              void pushChunk(merged.subarray(offset, offset + 3200))
              offset += 3200
            }
            bufferRef.current = merged.subarray(offset)
          }, [pushChunk])

          function openSse(sid) {
            try {
              const source = new EventSource(API + '/recording/asr/' + encodeURIComponent(sid) + '/events')
              source.onmessage = (event) => {
                let payload = null
                try { payload = JSON.parse(event.data) } catch { return }
                if (payload.type === 'partial') {
                  setPartial(payload.text)
                  if (payload.text !== sessionRef.current.lastText) {
                    sessionRef.current.lastText = payload.text
                    sessionRef.current.lastTextAt = Date.now()
                  }
                  if (Array.isArray(payload.lines)) {
                    const offset = sessionRef.current.audioOffsetMs
                    setLiveLines(payload.lines.map((line) => ({ text: line.text, seconds: (offset + (Number(line.start) || 0)) / 1000 })))
                  }
                }
                if (payload.type === 'final') { setPartial(''); source.close(); if (sessionRef.current.sse === source) sessionRef.current.sse = null }
                if (payload.type === 'error') {
                  const text = String(payload.message ?? '')
                  // 「这一段没收到可识别的语音」是静音/切段时的正常回应，不该当成故障吓人；
                  // 只是把本段标记为已结束，录音继续，出声会自动新开一段。
                  const benign = text.includes('No audio was received') || text.includes('no audio')
                  if (sessionRef.current.sse === source) sessionRef.current.sse = null
                  source.close()
                  if (benign) {
                    sessionRef.current.asrActive = false
                    sessionRef.current.sid = null
                  } else {
                    setFlash('转写中断：' + text)
                  }
                }
              }
              source.onerror = () => { source.close(); if (sessionRef.current.sse === source) sessionRef.current.sse = null }
              sessionRef.current.sse = source
            } catch (error) {
              setFlash('转写通道打不开：' + error.message)
            }
          }

          /** 开一段转写：offsetMs 是这段音频在整条录音里的起点（静音切段后续写用）。 */
          async function startAsrSession(offsetMs) {
            const session = sessionRef.current
            if (session.recId === null || session.asrActive) return
            try {
              const started = await api('/recording/asr/start', { method: 'POST', body: { recordingId: session.recId, offsetMs: Math.max(0, Math.round(offsetMs)) } })
              session.sid = started.sessionId
              session.asrActive = true
              session.audioOffsetMs = offsetMs
              setPartial('')
              openSse(started.sessionId)
            } catch (error) {
              setFlash('转写启动失败：' + error.message)
            }
          }

          /** 停掉当前这段转写（录音继续，只是不再消耗 API）。 */
          async function stopAsrSession() {
            const session = sessionRef.current
            if (!session.asrActive) return
            const sid = session.sid
            session.asrActive = false
            session.sid = null
            if (sid !== null) {
              try { await api('/recording/asr/' + encodeURIComponent(sid) + '/finish', { method: 'POST' }) } catch {}
            }
            // 不立刻关 SSE：服务端要在收到定稿后才把这段文字写进转写稿，
            // 提前关会把最后一句丢掉。给它 6 秒，之后无论如何收掉。
            const sse = session.sse
            session.sse = null
            if (sse !== null) {
              setTimeout(() => {
                try { sse.close() } catch {}
              }, 6000)
            }
          }

          function rmsOf(int16) {
            let sum = 0
            for (let index = 0; index < int16.length; index += 1) {
              const sample = int16[index] / 32768
              sum += sample * sample
            }
            return Math.sqrt(sum / Math.max(1, int16.length))
          }

          /** 一块音频：写盘永远做；转写只在有人声时做，长时间静音就停掉。 */
          function onAudio(pcm) {
            const session = sessionRef.current
            // 看门狗：连接还在、但 90 秒没吐新字 → 认为这条流式会话已经废了，重开一条接上。
            // 只在「确实在说话（近 5 秒内有人声）却没出字」时才重连；单纯安静不算卡死。
            if (session.asrActive && !session.restarting && session.lastTextAt !== 0
              && session.silenceMs < 5000 && Date.now() - session.lastTextAt > 90000) {
              session.restarting = true
              const offset = session.recordedMs
              setFlash('转写通道卡住了，正在重连…')
              void stopAsrSession()
                .then(() => startAsrSession(offset))
                .catch(() => {})
                .finally(() => { session.restarting = false })
              return
            }
            const ms = (pcm.length / 16000) * 1000
            session.recordedMs += ms
            const rms = rmsOf(pcm)
            if (rms >= VOICE_RMS) {
              if (session.silenceMs > 0) setSilentFor(0)
              session.silenceMs = 0
              if (!session.asrActive) void startAsrSession(session.recordedMs - ms)
            } else {
              session.silenceMs += ms
              setSilentFor(session.silenceMs)
              if (session.asrActive && session.silenceMs >= SILENCE_LIMIT_MS) {
                void stopAsrSession().then(() => setFlash('已静音 2 分钟，转写暂停（录音继续，出声会自动续上）'))
              }
            }
            enqueue(pcm)
          }

          async function startRecording() {
            if (rec.status !== 'idle') return
            // 标记可能与真实状态不同步（例如上次异常退出）：只要当前是 idle，就以 idle 为准
            if (ACTIVE_RECORDING_ID !== null && statusRef.current !== 'idle') {
              setFlash('已经有一条在录（' + ACTIVE_RECORDING_ID + '），先停止它再开新的')
              return
            }
            ACTIVE_RECORDING_ID = null
            setRec({ status: 'starting', recordedMs: 0 })
            setPartial('')
            setLiveLines([])
            setAnnotations([])
            bufferRef.current = new Int16Array(0)
            setSilentFor(0)
            sessionRef.current = { recId: null, sid: null, sse: null, stream: null, ctx: null, node: null, asrActive: false, audioOffsetMs: 0, recordedMs: 0, silenceMs: 0, lastTextAt: 0, lastText: '', restarting: false }
            try {
              const created = await api('/recordings', { method: 'POST', body: { title: '' } })
              ACTIVE_RECORDING_ID = created.id
              sessionRef.current.recId = created.id
              const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
              const ctx = new AudioContext({ sampleRate: 16000 })
              const node = ctx.createScriptProcessor(4096, 1, 1)
              node.onaudioprocess = (event) => {
                if (statusRef.current !== 'recording') return
                const input = event.inputBuffer.getChannelData(0)
                onAudio(toInt16(downsampleTo16k(input, ctx.sampleRate)))
              }
              ctx.createMediaStreamSource(stream).connect(node)
              node.connect(ctx.destination)
              Object.assign(sessionRef.current, { stream, ctx, node })
              statusRef.current = 'recording'
              setRec({ status: 'recording', recordedMs: 0 })
              setSelected(null)
              await startAsrSession(0)
            } catch (error) {
              statusRef.current = 'idle'
              setRec({ status: 'idle', recordedMs: 0 })
              setFlash('录音启动失败：' + error.message)
            }
          }

          function pauseRecording() {
            if (statusRef.current !== 'recording') return
            const session = sessionRef.current
            statusRef.current = 'paused'
            setRec((current) => ({ ...current, status: 'paused', recordedMs: session.recordedMs }))
            // 先把缓冲里剩下的音频推完（写盘 + 转写都算这一段）
            if (bufferRef.current.length > 0) {
              void pushChunk(bufferRef.current)
              bufferRef.current = new Int16Array(0)
            }
            // 暂停就结束这段转写：火山那边约 10 秒收不到音频会自行掐断，
            // 与其留一条死连接，不如主动收尾；恢复时按已录时长新开一段续写。
            if (session.asrActive) void stopAsrSession()
          }

          function resumeRecording() {
            if (statusRef.current !== 'paused') return
            const session = sessionRef.current
            statusRef.current = 'recording'
            setRec((current) => ({ ...current, status: 'recording' }))
            // 新开一段：带 offset，服务端会把这段文字追加到已有转写稿后面，不覆盖
            if (!session.asrActive) void startAsrSession(session.recordedMs)
          }

          async function stopRecording() {
            const session = sessionRef.current
            if (session.recId === null) return
            statusRef.current = 'idle'
            setRec({ status: 'idle', recordedMs: session.recordedMs })
            try {
              if (bufferRef.current.length > 0) { await pushChunk(bufferRef.current); bufferRef.current = new Int16Array(0) }
              if (session.asrActive) {
                const sid = session.sid
                session.asrActive = false
                if (sid !== null) await api('/recording/asr/' + encodeURIComponent(sid) + '/finish', { method: 'POST' })
              }
              await api('/recordings/' + encodeURIComponent(session.recId) + '/finalize', { method: 'POST' })
            } catch (error) {
              setFlash('收尾失败：' + error.message)
            } finally {
              try { session.node?.disconnect() } catch {}
              try { session.ctx?.close() } catch {}
              try { session.stream?.getTracks().forEach((track) => track.stop()) } catch {}
              try { session.sse?.close() } catch {}
              const finishedId = session.recId
              ACTIVE_RECORDING_ID = null
              sessionRef.current = { recId: null, sid: null, sse: null, stream: null, ctx: null, node: null, asrActive: false, audioOffsetMs: 0, recordedMs: 0, silenceMs: 0, lastTextAt: 0, lastText: '', restarting: false }
              setPartial('')
              await refresh()
              openRecording({ id: finishedId })
              if (typeof onUsageChanged === 'function') onUsageChanged()
            }
          }

          async function importAudio(file) {
            if (file === undefined || importing) return
            setImporting(true)
            setFlash('正在解码并写入音频…')
            try {
              const pcm = await decodeFileToPcm16(file)
              const created = await api('/recordings', { method: 'POST', body: { title: file.name.replace(/\.[^.]+$/, '') } })
              sessionRef.current.recId = created.id
              for (let offset = 0; offset < pcm.length; offset += 3200) {
                await pushChunk(pcm.subarray(offset, offset + 3200))
              }
              await api('/recordings/' + encodeURIComponent(created.id) + '/finalize', { method: 'POST' })
              sessionRef.current.recId = null
              await refresh()
              openRecording({ id: created.id })
              setFlash('音频已保存，正在转写…')
              await api('/recordings/' + encodeURIComponent(created.id) + '/transcribe', { method: 'POST', body: { engine } })
              setFlash('转写完成')
              openRecording({ id: created.id })
              if (typeof onUsageChanged === 'function') onUsageChanged()
            } catch (error) {
              setFlash('导入或转写失败：' + error.message)
            } finally {
              setImporting(false)
            }
          }

          async function submitRename() {
            if (selected === null || renaming === null) return
            const title = String(renaming).trim()
            const target = selected
            setRenaming(null)
            try {
              const result = await api('/recordings/' + encodeURIComponent(target.id) + '/rename', { method: 'POST', body: { title } })
              await refresh()
              openRecording({ id: result.id, title: title === '' ? result.id : title, durationMs: target.item?.durationMs })
              setFlash('已改名')
            } catch (error) {
              setFlash('改名失败：' + error.message)
            }
          }

          async function retranscribe() {
            if (selected === null || importing) return
            setImporting(true)
            setFlash('正在重新转写…')
            try {
              await api('/recordings/' + encodeURIComponent(selected.id) + '/transcribe', { method: 'POST', body: { engine } })
              setFlash('转写完成')
              openRecording({ id: selected.id, title: selected.item?.title, durationMs: selected.item?.durationMs })
              if (typeof onUsageChanged === 'function') onUsageChanged()
            } catch (error) {
              setFlash('转写失败：' + error.message)
            } finally {
              setImporting(false)
            }
          }

          async function deleteRecording() {
            if (selected === null) return
            const target = selected
            setConfirming(false)
            try {
              await api('/recordings/' + encodeURIComponent(target.id), { method: 'DELETE' })
              setSelected(null)
              setFlash('已移到 03 录音/.trash/')
              refresh()
            } catch (error) {
              setFlash('删除失败：' + error.message)
            }
          }

          /** 批注写到哪条录音：录音中就是正在录的那条，否则是选中的那条。 */
          function activeRecordingId() {
            if (selected !== null) return selected.id
            return sessionRef.current.recId ?? null
          }

          async function persistAnnotations(next) {
            const targetId = activeRecordingId()
            if (targetId === null) return
            try {
              const result = await api('/recordings/' + encodeURIComponent(targetId) + '/annotations', {
                method: 'PUT',
                body: { annotations: next },
              })
              setAnnotations(Array.isArray(result.annotations) ? result.annotations : [])
            } catch (error) {
              setFlash('批注保存失败：' + error.message)
            }
          }

          function makeAnnotationId() {
            try {
              return crypto.randomUUID()
            } catch {
              return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
            }
          }

          function addAnnotation(quote, line, time, note, color) {
            const next = annotations.concat([{
              id: makeAnnotationId(),
              quote,
              note,
              color,
              createdAt: new Date().toISOString(),
              time,
              line,
            }])
            void persistAnnotations(next)
          }

          function removeAnnotation(id) {
            void persistAnnotations(annotations.filter((item) => item.id !== id))
          }

          /** 选中正文 → 记录选区（行号 + 引用 + 屏幕位置），供小工具条定位。 */
          function handleTranscriptMouseUp() {
            const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
            if (selection === null || selection.isCollapsed) {
              setPending(null)
              return
            }
            const quote = String(selection.toString() ?? '').trim()
            if (quote === '') {
              setPending(null)
              return
            }
            const range = selection.getRangeAt(0)
            const anchor = range.startContainer
            const element = anchor.nodeType === 3 ? anchor.parentElement : anchor
            const lineElement = element !== null && typeof element.closest === 'function' ? element.closest('[data-line]') : null
            if (lineElement === null) {
              setPending(null)
              return
            }
            const box = range.getBoundingClientRect()
            setPending({
              quote: quote.slice(0, 400),
              line: Number(lineElement.dataset.line ?? 0),
              time: Number(lineElement.dataset.time ?? '') || null,
              top: box.top,
              left: box.left + box.width / 2,
            })
          }

          /** 把一行切成若干段：批注高亮 + 当前录音内的搜索命中（重叠时搜索优先）。 */
          function segmentsOf(text, lineIndex, matches, currentPos) {
            const ranges = []
            for (const item of annotations) {
              if (item.line !== lineIndex || item.quote === '' || !text.includes(item.quote)) continue
              const start = text.indexOf(item.quote)
              ranges.push({ start, end: start + item.quote.length, kind: 'annot', item })
            }
            for (let index = 0; index < matches.length; index += 1) {
              const match = matches[index]
              if (match.line !== lineIndex) continue
              ranges.push({ start: match.start, end: match.end, kind: 'find', index, current: index === currentPos })
            }
            if (ranges.length === 0) return [{ text }]
            ranges.sort((left, right) => left.start - right.start || (left.kind === 'find' ? -1 : 1))
            const parts = []
            let cursor = 0
            for (const range of ranges) {
              if (range.start < cursor) continue
              if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start) })
              parts.push({ text: text.slice(range.start, range.end), range })
              cursor = range.end
            }
            if (cursor < text.length) parts.push({ text: text.slice(cursor) })
            return parts
          }

          function togglePlay() {
            const audio = audioRef.current
            if (audio === null) return
            if (audio.paused) { void audio.play(); setPlaying(true) }
            else { audio.pause(); setPlaying(false) }
          }

          function skip(seconds) {
            const audio = audioRef.current
            if (audio === null) return
            audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + seconds))
            setProgress({ time: audio.currentTime, duration: audio.duration || 0 })
          }

          function cycleRate() {
            const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1
            setRate(next)
            if (audioRef.current !== null) audioRef.current.playbackRate = next
          }

          /** 这段音频的真实总长：优先 audio 元数据，其次列表里的 durationMs。 */
          function totalDuration() {
            const audio = audioRef.current
            if (audio !== null && Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration
            const fallback = (selected?.item?.durationMs ?? 0) / 1000
            return Number.isFinite(fallback) && fallback > 0 ? fallback : 0
          }

          function seekTo(seconds) {
            const audio = audioRef.current
            const total = totalDuration()
            if (audio === null || total <= 0) return
            const target = Math.max(0, Math.min(total, Number(seconds) || 0))
            audio.currentTime = target
            setProgress({ time: target, duration: total })
          }

          /** 波形给的是 0–1 的比例，直接按比例定位，不依赖外部算好的秒数。 */
          function seekRatio(ratio) {
            seekTo(Math.max(0, Math.min(1, ratio)) * totalDuration())
          }

          const items = list.items
          const dur = progress.duration
          const peaks = selected?.peaks
          const recording = rec.status === 'recording' || rec.status === 'paused'
          const transcriptLines = (selected?.transcript ?? '').split('\n').map((line) => {
            const match = /^-\s+\*\*\[(\d{2}):(\d{2})\]\*\*\s+(.*)$/.exec(line.trim())
            return match === null ? { raw: line } : { seconds: Number(match[1]) * 60 + Number(match[2]), text: match[3] }
          })

          const findQuery = findText.trim().toLowerCase()
          const findMatches = []
          if (findQuery !== '' && selected !== null) {
            transcriptLines.forEach((line, index) => {
              if (line.text === undefined) return
              const hay = line.text.toLowerCase()
              let from = 0
              while (findMatches.length < 500) {
                const at = hay.indexOf(findQuery, from)
                if (at < 0) break
                findMatches.push({ line: index, start: at, end: at + findQuery.length })
                from = at + findQuery.length
              }
            })
          }
          const currentMatch = findMatches.length === 0 ? -1 : Math.min(Math.max(findPos, 0), findMatches.length - 1)

          function jumpToMatch(offset) {
            if (findMatches.length === 0) return
            const next = ((currentMatch + offset) % findMatches.length + findMatches.length) % findMatches.length
            setFindPos(next)
            const element = document.querySelector('[data-find-index="' + next + '"]')
            if (element !== null) element.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }

          /** 正在写的批注（录音中与回放时共用）。 */
          const draftCard = () => h('div', { className: 'dsh-wb-annot-draft' },
            h('div', { className: 'dsh-wb-annot-quote' }, '「' + draft.quote + '」'),
            h('textarea', {
              className: 'dsh-wb-input dsh-wb-annot-input',
              value: draft.note,
              autoFocus: true,
              placeholder: '写批注…',
              onChange: (event) => setDraft({ ...draft, note: event.target.value }),
            }),
            h('div', { className: 'dsh-wb-row-actions', style: { justifyContent: 'flex-end' } },
              h('button', { type: 'button', className: 'dsh-wb-btn', onClick: () => setDraft(null) }, '取消'),
              h('button', {
                type: 'button',
                className: 'dsh-wb-btn',
                'data-tone': 'primary',
                onClick: () => {
                  addAnnotation(draft.quote, draft.line, draft.time, draft.note, draft.color)
                  setDraft(null)
                },
              }, '保存'),
            ),
          )

          const player = selected === null || recording ? null : h('div', { className: 'dsh-wb-player' },
            h('div', { className: 'dsh-wb-doc-head' },
              renaming !== null
                ? h('div', { className: 'dsh-wb-doc-title', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                    h('input', {
                      className: 'dsh-wb-input',
                      value: renaming,
                      autoFocus: true,
                      placeholder: '录音名字',
                      onChange: (event) => setRenaming(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') { event.preventDefault(); void submitRename() }
                        if (event.key === 'Escape') { event.preventDefault(); setRenaming(null) }
                      },
                    }),
                    h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'primary', onClick: () => { void submitRename() } }, '保存'),
                    h('button', { type: 'button', className: 'dsh-wb-btn', onClick: () => setRenaming(null) }, '取消'),
                  )
                : h('div', { className: 'dsh-wb-doc-title', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                    h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, selected.item?.title ?? selected.id),
                    h('button', { type: 'button', className: 'dsh-wb-btn dsh-wb-icon-btn', title: '重命名', 'aria-label': '重命名', onClick: () => setRenaming(selected.item?.title ?? '') }, h(IconPencil, null)),
                  ),
              h('div', { className: 'dsh-wb-doc-meta' }, formatClock(dur > 0 ? dur : (selected.item?.durationMs ?? 0) / 1000)
                + ((selected.transcript ?? '').match(/转写引擎:\s*(.+)/)?.[1] ? ' · ' + (selected.transcript ?? '').match(/转写引擎:\s*(.+)/)[1].trim() : '')),
              h('div', { className: 'dsh-wb-row-actions' },
                h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': showComments ? 'primary' : 'quiet', onClick: () => setShowComments((value) => !value) }, '高亮 ' + annotations.filter((item) => String(item.note ?? '').trim() === '').length + ' · 批注 ' + annotations.filter((item) => String(item.note ?? '').trim() !== '').length),
                h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'quiet', disabled: importing, onClick: () => { void retranscribe() } }, importing ? '转写中…' : '重新转写'),
                h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'quiet', title: '删除这条录音', 'aria-label': '删除这条录音', onClick: () => setConfirming(true) }, h(IconTrash, { size: 15 })),
              ),
            ),
            h('audio', {
              ref: audioRef,
              src: API + '/recordings/' + encodeURIComponent(selected.id) + '/audio',
              preload: 'auto',
              onTimeUpdate: (event) => setProgress({ time: event.target.currentTime, duration: Number.isFinite(event.target.duration) ? event.target.duration : 0 }),
              onDurationChange: (event) => setProgress((current) => ({ ...current, duration: Number.isFinite(event.target.duration) ? event.target.duration : 0 })),
              onLoadedMetadata: (event) => setProgress({ time: 0, duration: event.target.duration || 0 }),
              onEnded: () => setPlaying(false),
              style: { display: 'none' },
            }),
            h(Waveform, { peaks, progress: dur > 0 ? progress.time / dur : 0, onSeek: seekRatio }),
            h('div', { className: 'dsh-wb-transport' },
              h('button', { type: 'button', className: 'dsh-wb-round', title: '后退 15 秒', onClick: () => skip(-15) }, h(IconRewind15, null)),
              h('button', { type: 'button', className: 'dsh-wb-round', 'data-primary': true, title: playing ? '暂停播放' : '播放', onClick: togglePlay }, playing ? h(IconPause, null) : h(IconPlay, null)),
              h('button', { type: 'button', className: 'dsh-wb-round', title: '前进 15 秒', onClick: () => skip(15) }, h(IconForward15, null)),
              h('span', { className: 'dsh-wb-transport-label' }, formatClock(progress.time) + ' / ' + formatClock(dur)),
              h('span', { className: 'dsh-wb-transport-gap' }),
              h('button', { type: 'button', className: 'dsh-wb-rate', title: '播放速度', onClick: cycleRate }, rate + '×'),
            ),
            h('div', { className: 'dsh-wb-findbar' },
              h('input', {
                className: 'dsh-wb-input',
                value: findText,
                placeholder: '在这条录音里搜索…',
                onChange: (event) => { setFindText(event.target.value); setFindPos(0) },
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  jumpToMatch(event.shiftKey ? -1 : 1)
                },
              }),
              h('span', { className: 'dsh-wb-findcount' },
                findQuery === '' ? '' : (findMatches.length === 0 ? '无命中' : (currentMatch + 1) + '/' + findMatches.length)),
              h('button', { type: 'button', className: 'dsh-wb-btn dsh-wb-icon-btn', title: '上一个', disabled: findMatches.length === 0, onClick: () => jumpToMatch(-1) }, '↑'),
              h('button', { type: 'button', className: 'dsh-wb-btn dsh-wb-icon-btn', title: '下一个', disabled: findMatches.length === 0, onClick: () => jumpToMatch(1) }, '↓'),
              h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'quiet', disabled: findQuery === '', onClick: () => setFindText('') }, '清空'),
            ),
          )

          const scrollBody = recording
            ? h('div', null,
                h('div', { className: 'dsh-wb-doc-meta' },
                  (rec.status === 'paused' ? '已暂停 · ' : '录制中 · ') + formatClock(rec.recordedMs / 1000)
                  + (sessionRef.current.asrActive ? '' : ' · 转写已暂停')
                  + (annotations.length > 0 ? ' · 批注 ' + annotations.length : '')),
                h('details', { className: 'dsh-wb-live-fold' },
                  h('summary', { className: 'dsh-wb-live-fold-bar' },
                    '实时转写（' + liveLines.length + ' 句）',
                    liveLines.length > 0
                      ? h('span', { className: 'dsh-wb-live-peek' }, ' · 最新：' + String(liveLines[liveLines.length - 1].text ?? '').slice(0, 40))
                      : h('span', { className: 'dsh-wb-live-peek' }, partial === '' ? ' · 正在听…' : ' · ' + partial.slice(0, 40)),
                  ),
                h('div', { className: 'dsh-wb-md', style: { marginTop: '8px' }, onMouseUp: handleTranscriptMouseUp },
                  liveLines.length === 0
                    ? h('div', { className: 'dsh-wb-note' }, partial === '' ? '（正在听…）' : partial)
                    : liveLines.map((line, index) => h('div', {
                        key: index,
                        className: 'dsh-wb-line',
                        'data-line': index,
                        'data-time': line.seconds * 1000,
                      },
                        h('span', { className: 'dsh-wb-time dsh-wb-time-static' }, '[' + formatClock(line.seconds) + ']'),
                        h('span', null, segmentsOf(line.text, index, [], -1).map((part, partIndex) => part.range === undefined
                          ? part.text
                          : h('mark', {
                              key: partIndex,
                              className: 'dsh-wb-mark',
                              'data-color': part.range.item.color,
                              title: part.range.item.note === '' ? '高亮' : part.range.item.note,
                            }, part.text))),
                      )),
                  partial !== '' && liveLines.length > 0 ? h('div', { className: 'dsh-wb-live-tail' }, partial) : null,
                ),
                ),
                draft === null ? null : draftCard(),
                annotations.length === 0 ? null : h('div', { style: { marginTop: '10px' } },
                  ...annotationGroups(annotations, { onRemove: removeAnnotation }),
                ),
                silentFor > 30000
                  ? h('div', { className: 'dsh-wb-note' }, '已静音 ' + Math.floor(silentFor / 1000) + ' 秒；连续 2 分钟没人声会自动停掉转写（录音不中断）')
                  : null,
              )
            : selected === null
              ? h('div', { className: 'dsh-wb-empty' }, h('div', { className: 'dsh-wb-note' }, '左边选一条录音，或点下方麦克风开始录制'))
              : selected.loading
                ? h('div', { className: 'dsh-wb-md' }, '读取转写稿…')
                : transcriptLines.filter((line) => line.raw !== '').length === 0
                  ? h('div', { className: 'dsh-wb-md' }, '这条还没有转写稿')
                  : h('div', { className: 'dsh-wb-annot-split' },
                      h('div', { className: 'dsh-wb-annot-main', onMouseUp: handleTranscriptMouseUp },
                        h('div', { className: 'dsh-wb-md' },
                          transcriptLines.map((line, index) => line.text === undefined
                            ? h('div', { key: index, className: 'dsh-wb-md-p', 'data-line': index }, line.raw)
                            : h('div', { key: index, className: 'dsh-wb-line', 'data-line': index, 'data-time': line.seconds * 1000 },
                                h('button', { type: 'button', className: 'dsh-wb-time', onClick: () => seekTo(line.seconds) }, '[' + formatClock(line.seconds) + ']'),
                                h('span', null, segmentsOf(line.text, index, findMatches, currentMatch).map((part, partIndex) => {
                                  if (part.range === undefined) return part.text
                                  if (part.range.kind === 'find') {
                                    return h('mark', {
                                      key: partIndex,
                                      className: part.range.current ? 'dsh-wb-find dsh-wb-find-current' : 'dsh-wb-find',
                                      'data-find-index': part.range.index,
                                    }, part.text)
                                  }
                                  return h('mark', {
                                    key: partIndex,
                                    className: 'dsh-wb-mark',
                                    'data-color': part.range.item.color,
                                    title: part.range.item.note === '' ? '高亮' : part.range.item.note,
                                  }, part.text)
                                })),
                              )),
                        ),
                      ),
                      showComments
                        ? h('div', { className: 'dsh-wb-annot-col' },
                            draft === null ? null : draftCard(),
                            annotations.length === 0 && draft === null
                              ? h('div', { className: 'dsh-wb-note' }, '选中正文里的文字，点「高亮」或「批注」')
                              : null,
                            ...annotationGroups(annotations, { withJump: true, onRemove: removeAnnotation }),
                          )
                        : null,
                    )

          return h(CardShell, {
            t,
            fill: true,
            title: card.title,
            state: recording ? 'ready' : 'idle',
            stateText: rec.status === 'recording' ? '录制中' : rec.status === 'paused' ? '已暂停' : undefined,
            actions: [
              h('label', { key: 'import', className: 'dsh-wb-btn', 'data-tone': 'quiet', style: { cursor: importing ? 'default' : 'pointer' } },
                importing ? '处理中…' : '导入音频',
                h('input', {
                  type: 'file', accept: 'audio/*', style: { display: 'none' }, disabled: importing,
                  onChange: (event) => { const file = event.target.files?.[0]; event.target.value = ''; void importAudio(file) },
                }),
              ),
              h('select', {
                key: 'engine', className: 'dsh-wb-input dsh-wb-select', style: { width: 'auto', height: '26px' },
                value: engine, title: '转写引擎', onChange: (event) => setEngine(event.target.value),
              },
                h('option', { value: 'volc' }, '火山（流式）'),
                h('option', { value: 'iflyrec' }, '听见（整段）'),
              ),
              h('button', { key: 'refresh', type: 'button', className: 'dsh-wb-btn dsh-wb-icon-btn', onClick: () => { refresh(); setRefreshTick((value) => value + 1) }, title: t('panel.refresh'), 'aria-label': t('panel.refresh') }, h(IconRefresh, null)),
              focusMode ? null : h('button', {
                key: 'nav',
                type: 'button',
                className: 'dsh-wb-btn',
                'data-tone': 'quiet',
                title: '隐藏目录、卡片索引与搜索，整块留给录音',
                onClick: () => setFocusMode(true),
              }, '专注模式'),
            ],
          },
            h('div', { className: 'dsh-wb-split' },
              focusMode ? null : h('div', { className: 'dsh-wb-nav' },
                h('div', { className: 'dsh-wb-nav-title' }, '录音（' + items.length + '）'),
                h('div', { className: 'dsh-wb-treelist' },
                  items.length === 0 && list.status === 'ready'
                    ? h('div', { className: 'dsh-wb-note' }, '还没有录音')
                    : items.map((item) => h('button', {
                        key: item.id, type: 'button', className: 'dsh-wb-tree-row dsh-wb-tree-note',
                        'data-active': selected?.id === item.id,
                        onClick: () => openRecording(item), title: item.id,
                      },
                        h('span', { className: 'dsh-wb-tree-name' }, item.title),
                        h('span', { className: 'dsh-wb-tree-count' }, formatClock(item.durationMs / 1000)),
                      )),
                ),
              ),
              h('div', { className: 'dsh-wb-reading' },
                player,
                h('div', { className: 'dsh-wb-reading-body' }, scrollBody),
                h('div', { className: 'dsh-wb-transport' },
                  rec.status === 'idle' || rec.status === 'starting'
                    ? h('button', { type: 'button', className: 'dsh-wb-round', 'data-primary': true, disabled: rec.status === 'starting' || importing, title: '开始录音', onClick: () => { void startRecording() } }, h(IconMic, null))
                    : h('button', { type: 'button', className: 'dsh-wb-round', 'data-primary': true, title: '停止录音', onClick: () => { void stopRecording() } }, h(IconStop, null)),
                  rec.status === 'recording'
                    ? h('button', { type: 'button', className: 'dsh-wb-round', title: '暂停录音', onClick: pauseRecording }, h(IconPause, null))
                    : null,
                  rec.status === 'paused'
                    ? h('button', { type: 'button', className: 'dsh-wb-round', title: '继续录音', onClick: resumeRecording }, h(IconPlay, null))
                    : null,
                  recording ? h('span', { className: 'dsh-wb-transport-label' }, formatClock(rec.recordedMs / 1000)) : null,
                  h('span', { className: 'dsh-wb-transport-gap' }),
                  recording ? null : h('span', { className: 'dsh-wb-note' }, selected === null ? '点麦克风开始；或从左边选一条已有录音' : '波形与播放控件已固定在上方'),
                ),
              ),
            ),
            pending === null ? null : h('div', {
              className: 'dsh-wb-sel-toolbar',
              style: { top: Math.max(8, pending.top - 44) + 'px', left: pending.left + 'px' },
            },
              h('button', {
                type: 'button', className: 'dsh-wb-btn', 'data-tone': 'primary',
                onClick: () => { addAnnotation(pending.quote, pending.line, pending.time, '', 'yellow'); setPending(null) },
              }, '高亮'),
              h('button', {
                type: 'button', className: 'dsh-wb-btn',
                onClick: () => { setDraft({ quote: pending.quote, line: pending.line, time: pending.time, note: '', color: 'yellow' }); setPending(null); setShowComments(true) },
              }, '批注'),
              h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'quiet', onClick: () => setPending(null) }, '×'),
            ),
            confirming
              ? h('div', { className: 'dsh-wb-modal-backdrop', onClick: () => setConfirming(false) },
                  h('div', { className: 'dsh-wb-modal', onClick: (event) => event.stopPropagation() },
                    h('div', { className: 'dsh-wb-modal-title' }, '删除这条录音？'),
                    h('div', { className: 'dsh-wb-note' }, selected?.item?.title ?? selected?.id ?? ''),
                    h('div', { className: 'dsh-wb-note' }, '音频与转写稿会一起移到 03 录音/.trash/，不会真删，随时可捞回。'),
                    h('div', { className: 'dsh-wb-modal-actions' },
                      h('button', { type: 'button', className: 'dsh-wb-btn', onClick: () => setConfirming(false) }, '取消'),
                      h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'primary', onClick: () => { void deleteRecording() } }, '删除'),
                    ),
                  ),
                )
              : null,
          )
        }

        /* ---------------------------------------------------------- 术语表 */

        /** 状态条：不占 tab 的卡片（cards.json 里 placement: "strip"），默认一行，点开看详情。 */
        const ENTRY_KINDS = {
          glossary: {
            api: '/glossary',
            titleKey: 'zh',
            subKey: 'en',
            chipKey: 'field',
            fields: [['zh', 'glossary.zh'], ['en', 'glossary.en'], ['field', 'glossary.field'], ['tag', 'glossary.tag'], ['note', 'glossary.note']],
            search: 'glossary.search',
            add: 'glossary.add',
            empty: 'glossary.empty',
            insertAll: 'glossary.insertAll',
            promptId: 'glossary-all',
          },
        }

        function EntryCard({ card, t, requestInsert, setFlash, prompts }) {
          const KIND = ENTRY_KINDS[card.kind] ?? ENTRY_KINDS.glossary
          const [state, setState] = React.useState({ status: 'loading' })
          const [query, setQuery] = React.useState('')
          const [editing, setEditing] = React.useState(null)
          const [busy, setBusy] = React.useState(false)

          const load = React.useCallback((q) => {
            return api(KIND.api + '?q=' + encodeURIComponent(q)).then(
              (data) => setState({ status: 'ready', data }),
              (error) => setState({ status: 'error', message: error.message }),
            )
          }, [KIND.api])

          React.useEffect(() => { load('') }, [load])
          React.useEffect(() => {
            const timer = setTimeout(() => { load(query) }, 240)
            return () => clearTimeout(timer)
          }, [query, load])

          /** 只提交这张表声明过的字段，避免把 id 之类的内部字段回传。 */
          function payloadOf(source) {
            const payload = {}
            for (const [key] of KIND.fields) payload[key] = source[key] ?? ''
            return payload
          }

          function blank() {
            const draft = {}
            for (const [key] of KIND.fields) draft[key] = ''
            return draft
          }

          function save() {
            if (editing === null) return
            setBusy(true)
            const request = editing.id === undefined
              ? api(KIND.api, { method: 'POST', body: payloadOf(editing) })
              : api(KIND.api + '/' + encodeURIComponent(editing.id), { method: 'PUT', body: payloadOf(editing) })
            request.then(
              () => { setEditing(null); setFlash('已保存'); load(query) },
              (error) => setEditing((current) => current === null ? null : { ...current, error: error.message }),
            ).finally(() => setBusy(false))
          }

          // 标签就地编辑：只 PUT 这一条，用返回值更新列表，滚动位置不动。
          function saveTags(entry, value) {
            const next = value.split(/[,，;；]/).map((part) => part.trim()).filter((part) => part !== '')
            const tag = Array.from(new Set(next)).join(', ')
            setBusy(true)
            api(KIND.api + '/' + encodeURIComponent(entry.id), { method: 'PUT', body: payloadOf({ ...entry, tag }) }).then(
              (result) => {
                setState((current) => current.status !== 'ready'
                  ? current
                  : {
                      status: 'ready',
                      data: {
                        ...current.data,
                        entries: current.data.entries.map((item) => item.id === entry.id
                          ? { ...item, tag, id: result !== null && result.entry !== undefined ? result.entry.id : item.id }
                          : item),
                      },
                    })
                setTagging(null)
                setFlash('已保存标签')
              },
              (error) => setFlash('保存标签失败：' + error.message),
            ).finally(() => setBusy(false))
          }

          function remove(entry) {
            const label = entry[KIND.titleKey] + ' / ' + entry[KIND.subKey]
            if (!window.confirm(t('glossary.confirmDelete') + '\n' + label)) return
            api(KIND.api + '/' + encodeURIComponent(entry.id), { method: 'DELETE' }).then(
              () => { setFlash('已删除'); load(query) },
              (error) => setFlash('删除失败：' + error.message),
            )
          }

          function insertAll() {
            api(KIND.api).then(
              (data) => {
                const entries = Array.isArray(data.entries) ? data.entries : []
                const header = KIND.fields.slice(0, 3).map(([, labelKey]) => t(labelKey))
                const rows = entries.map((entry) => '| ' + KIND.fields.slice(0, 3).map(([key]) => entry[key]).join(' | ') + ' |')
                const table = ['| ' + header.join(' | ') + ' |', '| ' + header.map(() => '---').join(' | ') + ' |', ...rows].join('\n')
                const prefix = prompts[KIND.promptId] !== undefined ? prompts[KIND.promptId].text : ''
                requestInsert(prefix + table, t(KIND.insertAll))
              },
              (error) => setFlash('读取失败：' + error.message),
            )
          }

          const data = state.status === 'ready' ? state.data : null
          const entries = data !== null && Array.isArray(data.entries) ? data.entries : []

          // 两个都是并列动作，视觉等级一致：描边同级，避免一实一空显得突兀
          const actions = [h('button', { key: 'add', type: 'button', className: 'dsh-wb-btn', 'data-tone': 'outline', onClick: () => setEditing(blank()) }, t(KIND.add))]
          if (KIND.insertAll !== undefined) {
            actions.push(h('button', { key: 'all', type: 'button', className: 'dsh-wb-btn', 'data-tone': 'outline', onClick: insertAll }, t(KIND.insertAll)))
          }

          // 编辑表单就地渲染：改哪一条就展开在哪一条下面，不用滚回卡片顶部。
          function renderForm() {
            if (editing === null) return null
            const field = (label, key, focus) => h('div', { className: 'dsh-wb-field' },
              h('label', null, label),
              h('input', {
                className: 'dsh-wb-input',
                value: editing[key] ?? '',
                autoFocus: focus === true,
                onChange: (e) => setEditing({ ...editing, [key]: e.target.value }),
                onKeyDown: (e) => { if (e.key === 'Enter' && busy !== true) save() },
              }),
            )
            return h('div', { style: { marginTop: '8px', padding: '8px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px' } },
              KIND.fields.map(([key, labelKey], index) => field(t(labelKey), key, index === 0)),
              editing.error !== undefined ? h('div', { className: 'dsh-wb-error' }, editing.error) : null,
              h('div', { style: { display: 'flex', gap: '4px', justifyContent: 'flex-end' } },
                h('button', { type: 'button', className: 'dsh-wb-btn', onClick: () => setEditing(null) }, t('glossary.cancel')),
                h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'primary', disabled: busy, onClick: save }, t('glossary.save')),
              ),
            )
          }

          return h(CardShell, {
            t,
            title: card.title,
            state: card.status,
            stateText: data !== null && Number.isFinite(data.total) ? String(data.total) : undefined,
            actions,
          },
            h('input', {
              className: 'dsh-wb-input',
              value: query,
              placeholder: t(KIND.search),
              onChange: (event) => setQuery(event.target.value),
            }),
            editing !== null && editing.id === undefined ? renderForm() : null,
            state.status === 'error' ? h('div', { className: 'dsh-wb-error' }, state.message) : null,
            entries.length === 0 && state.status === 'ready' ? h('p', { className: 'dsh-wb-note' }, t(KIND.empty)) : null,
            h('div', { style: { marginTop: '8px' } },
              entries.map((entry) => h('div', {
                className: 'dsh-wb-row',
                key: entry.id,
                style: editing !== null && editing.id === entry.id
                  ? { outline: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px' }
                  : undefined,
              },
                h('div', { className: 'dsh-wb-row-title' },
                  h('span', null, entry[KIND.titleKey] !== '' ? entry[KIND.titleKey] : '（空）'),
                  h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 400 } }, ' · ' + (entry[KIND.subKey] !== '' ? entry[KIND.subKey] : '（空）')),
                  entry[KIND.chipKey] !== '' ? h('span', { className: 'dsh-wb-chip' }, entry[KIND.chipKey]) : null,
                  ...String(entry.tag ?? '').split(/[,，]/).map((name) => name.trim()).filter((name) => name !== '').map((name, index) => h('span', {
                    className: 'dsh-wb-chip dsh-wb-tag',
                    key: 'tag-' + index,
                  }, '#' + name)),
                ),
                entry.note !== '' ? h('div', { className: 'dsh-wb-row-meta' }, entry.note) : null,
                h('div', { className: 'dsh-wb-row-actions dsh-wb-actions-hover' },
                  h('button', {
                    type: 'button', className: 'dsh-wb-btn dsh-wb-icon-btn', title: t('glossary.edit'), 'aria-label': t('glossary.edit'),
                    onClick: () => setEditing({ ...payloadOf(entry), id: entry.id }),
                  }, h(IconPencil, { size: 15 })),
                  h('button', {
                    type: 'button', className: 'dsh-wb-btn dsh-wb-icon-btn', title: t('glossary.copy'), 'aria-label': t('glossary.copy'),
                    onClick: () => { copyText(entry[KIND.titleKey] + '\t' + entry[KIND.subKey]).then((ok) => setFlash(ok ? t('copy.done') : t('copy.failed'))) },
                  }, h(IconCopy, { size: 15 })),
                  h('button', {
                    type: 'button', className: 'dsh-wb-btn dsh-wb-icon-btn', title: t('glossary.del'), 'aria-label': t('glossary.del'),
                    onClick: () => remove(entry),
                  }, h(IconTrash, { size: 15 })),
                ),
                editing !== null && editing.id === entry.id ? renderForm() : null,
              )),
            ),
          )
        }

        /* ---------------------------------------------------------- 提示词模板 */

        function PromptCard({ card, t, insertPrompt }) {
          const promptId = card.promptId ?? card.id
          return h(CardShell, {
            t,
            title: card.title,
            state: card.status,
            stateText: card.status === 'error' ? t('state.error') : undefined,
            actions: [
              h('button', { key: 'insert', type: 'button', className: 'dsh-wb-btn', 'data-tone': 'primary', onClick: () => insertPrompt(promptId) }, t('sop.insert')),
            ],
          },
            card.error !== undefined ? h('div', { className: 'dsh-wb-error' }, card.error.message) : null,
            h('p', { className: 'dsh-wb-note' }, '点「插入」把模板写进输入框，不会自动发送。'),
          )
        }

        /* -------------------------------------------------- 设置页（总设置） */

        /**
         * 设置 → 造价工作台。
         * 读写与工作台面板同一套接口（GET/PUT /config、POST /pick-folder），
         * 保存后 Host 原地重建，不需要重启；面板里的首次引导保留为兜底入口。
         */
        function CostSettingsSection({ close }) {
          ensureStyles()
          const t = makeT(useLanguage())
          const [status, setStatus] = React.useState({ state: 'loading' })
          const [draft, setDraft] = React.useState({ vaultRoot: '', sopDir: '00 资料库', recordingsDir: '会议记录', obsidianVaultName: '' })
          const [busy, setBusy] = React.useState(false)
          const [pickerBusy, setPickerBusy] = React.useState(false)
          const [flash, setFlash] = React.useState(null)

          React.useEffect(() => {
            let alive = true
            api('/config').then(
              (data) => {
                if (!alive) return
                setStatus({ state: 'ready' })
                setDraft({
                  vaultRoot: data.vaultRoot ?? '',
                  sopDir: data.sopDir ?? '00 资料库',
                  recordingsDir: data.recordingsDir ?? '会议记录',
                  obsidianVaultName: data.obsidianVaultName ?? '',
                })
              },
              (error) => { if (alive) setStatus({ state: 'error', message: error.message }) },
            )
            return () => { alive = false }
          }, [])

          React.useEffect(() => {
            if (flash === null) return undefined
            const timer = setTimeout(() => setFlash(null), 3200)
            return () => clearTimeout(timer)
          }, [flash])

          /* ------------------------------------------------ 语音凭据（可选） */
          const [creds, setCreds] = React.useState(null)
          const [credDraft, setCredDraft] = React.useState({ volcApiKey: '', volcAccessKey: '', volcSecretKey: '', deepseekKey: '' })
          const [credBusy, setCredBusy] = React.useState(false)
          const [credFlash, setCredFlash] = React.useState(null)

          React.useEffect(() => {
            let alive = true
            api('/credentials').then(
              (data) => { if (alive) setCreds(data) },
              () => { if (alive) setCreds(null) },
            )
            return () => { alive = false }
          }, [])

          React.useEffect(() => {
            if (credFlash === null) return undefined
            const timer = setTimeout(() => setCredFlash(null), 3200)
            return () => clearTimeout(timer)
          }, [credFlash])

          const saveCreds = () => {
            const body = { volcengine: {}, deepseek: {} }
            if (credDraft.volcApiKey.trim() !== '') body.volcengine.apiKey = credDraft.volcApiKey.trim()
            if (credDraft.volcAccessKey.trim() !== '') body.volcengine.accessKey = credDraft.volcAccessKey.trim()
            if (credDraft.volcSecretKey.trim() !== '') body.volcengine.secretKey = credDraft.volcSecretKey.trim()
            if (credDraft.deepseekKey.trim() !== '') body.deepseek.apiKey = credDraft.deepseekKey.trim()
            if (Object.keys(body.volcengine).length === 0 && Object.keys(body.deepseek).length === 0) {
              setCredFlash('没有新填写的内容；已配置的密钥不会回显，留空表示不修改')
              return
            }
            setCredBusy(true)
            setCredFlash(null)
            api('/credentials', { method: 'PUT', body }).then(
              (data) => {
                setCreds(data)
                setCredDraft({ volcApiKey: '', volcAccessKey: '', volcSecretKey: '', deepseekKey: '' })
                setCredFlash('凭据已保存；余额角标点刷新、录音转写下次开始即生效')
              },
              (error) => setCredFlash('保存失败：' + error.message),
            ).finally(() => setCredBusy(false))
          }

          const clearCred = (path) => {
            setCredBusy(true)
            setCredFlash(null)
            api('/credentials', { method: 'PUT', body: { clear: [path] } }).then(
              (data) => { setCreds(data); setCredFlash('已清除') },
              (error) => setCredFlash('清除失败：' + error.message),
            ).finally(() => setCredBusy(false))
          }

          const pick = () => {
            setPickerBusy(true)
            setFlash(null)
            api('/pick-folder', { method: 'POST', body: {} }).then(
              (data) => {
                if (typeof data.path === 'string' && data.path !== '') {
                  setDraft((current) => ({ ...current, vaultRoot: data.path }))
                  if (data.created === true) setFlash('已选择并创建目录：' + data.path)
                } else if (data.cancelled === true) {
                  setFlash('已取消选择')
                }
              },
              (error) => setFlash('打开文件夹选择器失败：' + error.message),
            ).finally(() => setPickerBusy(false))
          }

          const save = () => {
            const vaultRoot = String(draft.vaultRoot ?? '').trim()
            if (vaultRoot === '') {
              setFlash('请先填写路径，或点「选择…」挑一个文件夹')
              return
            }
            setBusy(true)
            setFlash(null)
            api('/config', { method: 'PUT', body: { ...draft, vaultRoot } }).then(
              (data) => {
                if (data.configured === true) {
                  setStatus({ state: 'ready' })
                  setFlash('已保存；工作台立即生效，不用重启')
                } else {
                  setFlash('保存后仍未生效，请检查路径后重试')
                }
              },
              (error) => setFlash('保存失败：' + error.message),
            ).finally(() => setBusy(false))
          }

          const field = (labelText, value, onChange, append) => h('div', { style: { marginTop: '12px' } },
            h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '5px' } }, labelText),
            h('div', { style: { display: 'flex', gap: '6px' } },
              h('input', {
                className: 'dsh-wb-input',
                style: { flex: '1 1 auto', minWidth: '0' },
                value,
                onChange: (event) => onChange(event.target.value),
              }),
              append ?? null,
            ),
          )

          const credField = (labelText, key, clearPath, configured) => h('div', { style: { marginTop: '10px' } },
            h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' } },
              h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
                labelText + '：' + (configured ? '已配置' : '未配置')),
              configured
                ? h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'quiet', onClick: () => clearCred(clearPath) }, '清除')
                : null,
            ),
            h('input', {
              className: 'dsh-wb-input',
              type: 'password',
              autoComplete: 'off',
              style: { width: '100%', marginTop: '4px', boxSizing: 'border-box' },
              value: credDraft[key],
              placeholder: configured ? '已配置（留空不修改）' : '未配置（可留空）',
              onChange: (event) => setCredDraft((current) => ({ ...current, [key]: event.target.value })),
            }),
          )
          const credFields = creds === null
            ? [h('p', { className: 'dsh-wb-note', style: { marginTop: '8px' } }, '正在读取凭据状态…')]
            : [
                credField('火山流式语音 API Key（会议记录转写）', 'volcApiKey', 'volcengine.apiKey', creds.volcengine?.apiKey === true),
                credField('火山 AccessKey（查语音资源包余额）', 'volcAccessKey', 'volcengine.accessKey', creds.volcengine?.accessKey === true),
                credField('火山 SecretKey', 'volcSecretKey', 'volcengine.secretKey', creds.volcengine?.secretKey === true),
                credField('DeepSeek API Key（顶部余额角标）', 'deepseekKey', 'deepseek.apiKey', creds.deepseek?.apiKey === true),
              ]

          if (status.state === 'loading') return h('div', { className: 'dsh-wb-loading' }, t('panel.loading'))
          if (status.state === 'error') {
            return h('div', { className: 'dsh-wb-error' }, t('panel.error') + '：' + status.message)
          }

          return h('div', { className: 'dsh-wb-panel', style: { '--wb-fs': '14px', padding: '2px 2px 18px' } },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px' } },
              h('h2', { style: { margin: 0, fontSize: '17px' } }, '造价工作台'),
              h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, '会话右侧栏的资料库与造价工具'),
            ),
            h('p', { className: 'dsh-wb-note', style: { marginTop: '6px' } },
              '这里配置工作台读写哪个 Obsidian 库。保存后立即生效，不需要重启；会话里首次打开工作台时也会先问一次。'),
            flash !== null ? h('div', { className: 'dsh-wb-error', style: { marginTop: '10px' } }, flash) : null,
            h('div', { className: 'dsh-wb-card', style: { marginTop: '12px', padding: '14px 16px' } },
              field(
                '笔记文件夹的完整路径（Obsidian 库，或任意文件夹）',
                draft.vaultRoot,
                (value) => setDraft((current) => ({ ...current, vaultRoot: value })),
                h('button', {
                  type: 'button', className: 'dsh-wb-btn', 'data-tone': 'primary',
                  disabled: pickerBusy, style: { flex: 'none' }, onClick: pick,
                }, pickerBusy ? '选择中…' : '选择…'),
              ),
              field('资料库子目录（相对库根目录）', draft.sopDir, (value) => setDraft((current) => ({ ...current, sopDir: value }))),
              field('Obsidian 库名（可选；默认用文件夹名）', draft.obsidianVaultName, (value) => setDraft((current) => ({ ...current, obsidianVaultName: value }))),
              field('录音存放子目录', draft.recordingsDir, (value) => setDraft((current) => ({ ...current, recordingsDir: value }))),
              h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' } },
                h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
                h('button', { type: 'button', className: 'dsh-wb-btn', onClick: () => { if (typeof close === 'function') close() } }, '关闭'),
              ),
            ),
            h('div', { className: 'dsh-wb-card', style: { marginTop: '14px', padding: '14px 16px' } },
              h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
                h('h3', { style: { margin: 0, fontSize: '14px' } }, '语音转写与余额（可选）'),
                h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
                  '不填完全不影响资料库、三张表、计算器等其它功能'),
              ),
              h('p', { className: 'dsh-wb-note', style: { marginTop: '6px' } },
                '填了才会出现顶部的 DeepSeek 余额 / 语音资源包角标，会议记录卡也才能实时转写。凭据只写在 ~/.dsh-workbench/asr.json，不会回显、不上传。'),
              ...credFields,
              credFlash !== null ? h('div', { className: 'dsh-wb-error', style: { marginTop: '10px' } }, credFlash) : null,
              h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '12px' } },
                h('button', { type: 'button', className: 'dsh-wb-btn', 'data-tone': 'primary', disabled: credBusy, onClick: saveCreds }, credBusy ? '保存中…' : '保存凭据'),
              ),
            ),
            h('p', { className: 'dsh-wb-note', style: { marginTop: '10px' } },
              '路径不存在时保存会自动创建目录。所有数据只留在你自己的电脑上。'),
          )
        }

        ctx.slots.inject('settings.section', () => {
          try {
            return ctx.slots.register({ name: 'settings.section', id: 'dsh-cost-workbench', order: 55, label: '造价工作台' }, CostSettingsSection)
          } catch (error) {
            console.warn('[dsh-workbench] 设置分区注册失败：', error instanceof Error ? error.message : String(error))
            return () => {}
          }
        })

        ctx.slots.inject('settings.section.icon', () => {
          try {
            return ctx.slots.register({ name: 'settings.section.icon', id: 'dsh-cost-workbench' }, ({ size }) => h(Icon, { size }))
          } catch (error) {
            console.warn('[dsh-workbench] 设置图标注册失败：', error instanceof Error ? error.message : String(error))
            return () => {}
          }
        })

        ctx.slots.inject('sidebar.right.pane.tab', () => {
          try {
            return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, WorkbenchPanel)
          } catch (error) {
            console.warn('[dsh-workbench] 正文位注册失败：', error instanceof Error ? error.message : String(error))
            return () => {}
          }
        })
      },
    }
  },
})
