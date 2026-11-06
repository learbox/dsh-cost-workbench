/* ===========================================================================
 * 造价工作台 · 可粘贴进 client.js 的片段（不是模块：没有 import / export / require）
 *
 * 插入位置（细节见同目录 README.md）：
 *   ① 纯函数区（WB_TABLES / wbNumber / WB_CALC / WB_CALC_UNITS）→ factory 作用域，
 *      放在 `async function api(...)` 之后、`return { inject, apply }` 之前。
 *      这样 `return { inject, apply, _calc: WB_CALC }` 才能把计算器暴露给测试。
 *   ② UI 区（TableCard / CalcCard）→ `apply(ctx)` 内、`function SopCard` 之前
 *      （也就是 CardShell 定义之后，能直接闭包拿到 api / CardShell）。
 *
 * 依赖的闭包标识符：React、h、api、t、CardShell、requestInsert、setFlash。
 * 只用 React.useState / useEffect / useCallback / useMemo 与 h，不引入任何新依赖。
 *
 * 数据契约（与 index.js 的 handleEntryTable 一致）：
 *   GET    <base>         → { ok:true, entries, total, exists, warning, file }
 *   POST   <base>         → { ok:true, entry, total }
 *   PUT    <base>/<id>    → { ok:true, entry, total }
 *   DELETE <base>/<id>    → { ok:true, total }
 *   失败一律 { ok:false, code, message }，api() 在非 ok 时抛 Error（带 message / code）。
 *
 * 三张表的 Host 字段名以 lib/tables.js 为准（standards 的「类别」是 category，不是 kind，
 * 避免与卡片的 kind 混淆）。改列名等于改数据格式，必须四处同步：
 * lib/tables.js → index.js 的 entryTables → 本片段 → scripts/seed-vault.ps1。
 * =========================================================================== */

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
