# pieces：造价三表 + 造价计算器（client.js 可插入片段）

本目录只有两个文件，都是**集成素材**，不是独立模块：

| 文件 | 内容 |
|---|---|
| `table-calc.js` | 730 行；四段：`WB_TABLES`（三表 UI 元数据）、`WB_CALC`（造价计算纯函数）、`TableCard`、`CalcCard` |
| `README.md` | 本文件：插入位置、闭包依赖、i18n 键清单、集成注意点、CSS 类 |

> 片段里没有 `import` / `export` / `require`，不要当模块加载。它假设外层 `client.js` 的 factory 作用域里已有
> `React`、`h`、`api`、`t`、`CardShell`，`apply(ctx)` 作用域里还有 `requestInsert`、`setFlash`。

**文案键已对齐 `client.js` 现有字典**（`standards.field.*`、`table.*`、`calc.*`），不是片段自拟的键名。
新增的 6 个键（`table.added/saved/deleted/failed`、`calc.costPerArea/steelPerArea`）Lead 已补进 ZH/EN；
唯一例外是 `calc.unitMismatch`，片段用 `wbText()` 做了中文兜底，加不加都能用。

---

## 一、插入位置（两段分开粘）

片段按「纯函数」与「UI」两段组织，**不要整段粘进 `apply(ctx)`**：`WB_CALC` 必须位于 factory 作用域，
否则无法挂到模块导出的 `_calc` 上供测试直接调用。

### 1. 纯函数区（`table-calc.js` 第 26–283 行）

粘到 `client.js` 的 factory 作用域，位置在 `async function api(...)` 之后、`return { inject, apply }` 之前
（当前 client.js 版本：`api` 在 744 行，`return` 在 913 行；Lead 还在改文件，行号以实际为准）。包含：

- `WB_TABLES`
- `wbNumber` / `wbFixed` / `wbText` / `wbRatio` / `wbPick`
- `WB_UNIT_FACTORS` / `WB_UNIT_ALIASES` / `wbUnitOf`
- `WB_CALC_UNITS` / `WB_CALC`

然后把模块返回值改成（只加 `_calc` 一个键）：

```js
return {
  inject: ['slots'],
  apply(ctx) { /* ... 原样 ... */ },
  _calc: WB_CALC,
}
```

这样 `test/unit.mjs` 里 import 宿主模块后可以直接调用 `_calc.rebarWeight(20)`、`_calc.convert(1, 'm³', 'L')` 等，
不需要浏览器环境。

### 2. UI 区（`table-calc.js` 第 285–730 行）

粘到 `client.js` 的 `apply(ctx)` 内、`function SopCard(...)` 之前（`CardShell` 定义之后即可，
当前 client.js 里 `CardShell` 在 1223 行、`SopCard` 在 1732 行）。包含 `TableCard`、`CalcCard`。
放在这个位置可以直接闭包拿到 `api`、`CardShell`、`h`、`React`，也与现有 `EntryCard` 的写法保持一致。

### 3. 卡片分派（`WorkbenchPanel` 的 render 分支）

`client.js` 里已经写好了这两行（当前 1630–1631 行），确认与片段同名即可：

```js
else if (activeCard.kind === 'standards' || activeCard.kind === 'prices' || activeCard.kind === 'changes') body = h(TableCard, shared)
else if (activeCard.kind === 'calc') body = h(CalcCard, shared)
```

`lib/cards.js` 也已注册四个 kind（`standards` / `prices` / `changes` / `calc`）。
`shared` 里已经带了 `t`、`requestInsert`、`setFlash`，`TableCard` 的签名正好吃这四个；`CalcCard` 只用 `t`。

---

## 二、依赖的闭包标识符

| 标识符 | 来源 | 用途 |
|---|---|---|
| `React` | factory 顶部 `require('react')` | 仅用 `useState` / `useEffect` / `useCallback` / `useMemo` |
| `h` | `React.createElement` | 全部渲染，无 JSX |
| `api(path, opts)` | `client.js` 纯工具 | 表格 CRUD；非 ok 时抛 `Error`（带 `message` / `code`） |
| `t(key)` | `apply` 内 `makeT(...)` 的产物 | 全部界面文案；缺键时按 `makeT` 规则回退 EN → ZH → 键名 |
| `CardShell` | `apply` 内组件 | 卡片外壳（标题 / 状态 chip / actions / note） |
| `requestInsert(text, label?)` | `WorkbenchPanel` 传入 | 行内插入：把 Markdown 行写进会话输入框（不发送） |
| `setFlash(text)` | `WorkbenchPanel` 传入 | 顶部 toast（复制失败、保存/删除结果） |

片段自身定义、无需外部提供的标识符：`WB_TABLES`、`WB_CALC`、`WB_CALC_UNITS`、`wbNumber`、`wbFixed`、
`wbText`、`wbRatio`、`wbPick`、`WB_UNIT_FACTORS`、`WB_UNIT_ALIASES`、`wbUnitOf`。
**粘贴纯函数区时整段带上**，不要只挑 `WB_CALC`，否则 `TableCard` / `CalcCard` 会缺工具函数。

另外刻意**没有**依赖现有 `copyText` / `IconPencil` / `IconCopy` / `IconTrash`：复制按任务要求直接用
`navigator.clipboard.writeText`（失败只提示，不静默降级），按钮用文字而不是图标。

---

## 三、接口契约（与 `index.js` 的 `handleEntryTable` 已核对）

三张表共用一套路由，`base` 分别为 `/standards`、`/prices`、`/changes`，都拼在 `API = '/api/dsh-workbench'` 之后：

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `<base>` | `{ ok:true, entries, total, exists, warning, file }`；`entries` 每条含 `id`（12 位 hex）与全部字段 |
| POST | `<base>` | `{ ok:true, entry, total }`；body 为字段对象 |
| PUT | `<base>/<id>` | `{ ok:true, entry, total }`；改主键等同「删旧加新」 |
| DELETE | `<base>/<id>` | `{ ok:true, total }` |
| 失败 | 任意 | `{ ok:false, code, message }`，`api()` 抛 `Error` |

字段名以 **`lib/tables.js` 为准**（standards 的「类别」是 `category`，不是 `kind`，避免与卡片 kind 混淆）：

| kind | 路由 | 字段（顺序即列顺序 / 表单顺序 / 插入顺序） | 主键字段 |
|---|---|---|---|
| `standards` | `/standards` | `code, name, category, version, date, note` | `code` |
| `prices` | `/prices` | `name, spec, unit, price, region, date, source` | `name + spec + unit + region` |
| `changes` | `/changes` | `code, project, reason, amount, date, status` | `code` |

`WB_TABLES` 的 `fields[].key` 必须与上表逐字一致；`fields[].labelKey` 是 `client.js` 里
`standards.field.* / prices.field.* / changes.field.*` 文案键，只负责显示名，不参与提交。
表格字段仍然受 `lib/table.js` 的约束：不能含 `|`、换行、制表符，单字段 ≤ 200 字（输入框已设 `maxLength: 200`；
行内插入时会把 `|` 替换成全角 `｜`、换行替换成空格，避免破坏 Markdown 表）。

---

## 四、`WB_CALC` 纯函数契约

`CalcCard` 的五个分区全部调用 `WB_CALC`，组件内**没有第二份公式**。

| 函数 | 公式 / 语义 | 示例 |
|---|---|---|
| `rebarWeight(d)` | `d² × 0.00617`（kg/m，d 为 mm） | `rebarWeight(20) ≈ 2.468` |
| `unitPrice({labor,material,machine,overheadRate,profitRate,fee,taxRate})` | `(人工+材料+机械) × (1+管理费率/100) × (1+利润率/100) + 规费`，再 `× (1+税率/100)`；费率按百分数（`9` = 9%）；`fee` 缺省 0、`taxRate` 缺省 9 | 100/200/50、10%、5%、规费 20、税率 9 → `462.4325` |
| `totalCost({direct,measures,other,fee,taxRate})` | `(分部分项+措施+其他+规费) × (1+税率/100)`，`taxRate` 缺省 9；兼容别名 `part/works/分部分项`、`measure/措施项目/措施`、`others/其他项目/其他` | 1000000/100000/50000/30000、税率 9 → `1286200` |
| `costPerArea(total, area)` | `总价 / 建筑面积`（元/m²） | `costPerArea(1000000, 1000) = 1000` |
| `steelPerArea(steel, area)` | `钢筋总量 / 建筑面积`；CalcCard 约定填 kg 与 m²，得到 kg/m² | `steelPerArea(50000, 1000) = 50` |
| `convert(value, from, to)` | `value × factor[from] / factor[to]`；支持 `m³↔L`（1 m³ = 1000 L）、`t↔kg`（1 t = 1000 kg）、`MPa↔N/mm²`（1:1）、`万元↔元`（1 万元 = 10000 元）、`m²↔亩`（1 亩 = 2000/3 m²）；跨维度或未知单位返回 `NaN` | `convert(1, '万元', '元') = 10000` |

统一约定：

- 入参可以是数字或数字字符串（来自 input 的原始值），内部用 `wbNumber` 严格解析；空串、`'abc'`、`null`、`undefined` 都是非法；
- **非法输入一律返回 `NaN`，不抛异常**；CalcCard 检测到 `NaN` 显示 `calc.invalid`（「请输入数字」）；
- 返回**未四舍五入**的原始数值，展示层统一 `wbFixed(...)` → `toFixed(2)`。写测试请用近似断言
  （例如 `Math.abs(actual - expected) < 1e-9`），不要要求 `462.43` 这种中间舍入值；
- 单位换算的单位名接受 `m3/m³/立方米`、`l/L/升`、`t/吨`、`kg/千克`、`mpa/MPa`、`n/mm2/N/mm²`、`wanyuan/万元`、
  `yuan/元`、`m2/m²/平方米`、`mu/亩`（大小写不敏感）。

---

## 五、所需 i18n 文案键清单

片段共用到 **80 个键**：73 个 `client.js` 原本就有，**6 个新增键 Lead 已补进 ZH/EN**，1 个 `calc.unitMismatch`
用 `wbText()` 中文兜底（可加可不加）。下表按用途分组，★ = 新增键，☆ = 可选键。

### 5.1 卡片标题与说明（6，原本已有）

| 键 | ZH | EN |
|---|---|---|
| `standards.title` | 计价依据 | Pricing Basis |
| `standards.sub` | 清单规范、消耗量定额、面积规则、合同示范文本 | BOQ codes, consumption quotas, area rules, contract templates |
| `prices.title` | 材料价格 | Material Prices |
| `prices.sub` | 询价与信息价，供组价与签证取证 | Quotes and published prices for pricing and claims |
| `changes.title` | 变更签证 | Variations |
| `changes.sub` | 变更、签证、索赔流水账 | Variation, daywork and claim ledger |

### 5.2 字段标签（19，原本已有，逐表一套）

| 键（standards） | ZH | 键（prices） | ZH | 键（changes） | ZH |
|---|---|---|---|---|---|
| `standards.field.code` | 编号 | `prices.field.name` | 材料 | `changes.field.code` | 编号 |
| `standards.field.name` | 名称 | `prices.field.spec` | 规格 | `changes.field.project` | 项目 |
| `standards.field.category` | 类别 | `prices.field.unit` | 单位 | `changes.field.reason` | 事由 |
| `standards.field.version` | 版本文号 | `prices.field.price` | 单价 | `changes.field.amount` | 金额 |
| `standards.field.date` | 实施日期 | `prices.field.region` | 地区 | `changes.field.date` | 日期 |
| `standards.field.note` | 备注 | `prices.field.date` | 日期 | `changes.field.status` | 状态 |
|  |  | `prices.field.source` | 来源 |  |  |

### 5.3 表格卡通用交互（18）

| 键 | ZH | EN | 说明 |
|---|---|---|---|
| `table.search` | 搜索… | Search… | 搜索框 placeholder |
| `table.add` | 新增 | Add | 顶部新增按钮 |
| `table.edit` | 编辑 | Edit | 行内编辑 |
| `table.del` | 删除 | Delete | 行内删除 |
| `table.save` | 保存 | Save | 表单保存 |
| `table.cancel` | 取消 | Cancel | 表单取消 |
| `table.insert` | 插入 | Insert | 行内插入 |
| `table.copy` | 复制 | Copy | 行内复制 |
| `table.empty` | 还没有记录，点「新增」开始 | No records yet — press Add | 三张表共用空态 |
| `table.total` | 条记录 | records | 状态 chip：`12 条记录` |
| `table.creating` | 新增记录 | New record | 新增表单标题 |
| `table.editing` | 编辑记录 | Edit record | 编辑表单标题 |
| `table.confirmDelete` | 确定删除这条记录？ | Delete this record? | 删除前 confirm |
| `table.needKey` | 请至少填写主键字段 | Fill in the key field first | 客户端主键校验 |
| ★ `table.added` | 已新增 | Added | 新增成功 toast |
| ★ `table.saved` | 已保存 | Saved | 保存成功 toast |
| ★ `table.deleted` | 已删除 | Deleted | 删除成功 toast |
| ★ `table.failed` | 操作失败： | Failed: | 删除失败 toast 前缀 |

### 5.4 造价计算器（29）

| 键 | ZH | EN |
|---|---|---|
| `calc.title` | 造价计算器 | Cost Calculator |
| `calc.sub` | 综合单价、总造价、钢筋、单位指标、换算 | Unit price, total cost, rebar, indicators, conversion |
| `calc.unitPrice` | 综合单价组价 | Comprehensive Unit Price |
| `calc.totalCost` | 总造价 | Total Cost |
| `calc.rebar` | 钢筋理论重量 | Rebar Theoretical Weight |
| `calc.indicators` | 单位指标 | Unit Indicators |
| `calc.convert` | 单位换算 | Unit Conversion |
| `calc.calculate` | 计算 | Calculate |
| `calc.invalid` | 请输入数字 | Please enter a number |
| `calc.labor` | 人工费 | Labour |
| `calc.material` | 材料费 | Material |
| `calc.machine` | 机械费 | Machine |
| `calc.overhead` | 管理费率% | Overhead % |
| `calc.profit` | 利润率% | Profit % |
| `calc.fee` | 规费 | Statutory Fee |
| `calc.tax` | 税率% | Tax % |
| `calc.subtotal` | 分部分项 | Subtotal Works |
| `calc.measures` | 措施费 | Measures |
| `calc.others` | 其他项目 | Others |
| `calc.area` | 建筑面积 | Floor Area |
| `calc.steel` | 钢筋总量 | Total Rebar |
| `calc.diameter` | 直径(mm) | Diameter (mm) |
| `calc.rebarHint` | 多个直径用逗号分隔，如 16,20,25 | Comma-separated, e.g. 16,20,25 |
| `calc.value` | 数值 | Value |
| `calc.from` | 从 | From |
| `calc.to` | 到 | To |
| `calc.result` | 结果 | Result |
| ★ `calc.costPerArea` | 单位造价 | Cost per m² |
| ★ `calc.steelPerArea` | 含钢量 | Steel per m² |

### 5.5 复用的现有键（7，原本已有，无需新增）

| 键 | 用途 |
|---|---|
| `copy.done` / `copy.failed` | 复制成功 / 失败 toast |
| `panel.loading` | 首次读取中 |
| `panel.refresh` | 卡片内刷新按钮 |
| `panel.retry` | 读取失败后的重试按钮 |
| `panel.searchEmpty` | 搜索无匹配（复用全局搜索的「没有搜到」） |
| `state.error` | 状态 chip 的「异常」 |

### 5.6 可选键（1）

| 键 | ZH | EN | 说明 |
|---|---|---|---|
| ☆ `calc.unitMismatch` | 单位类型不一致 | Units are not compatible | 跨维度换算时显示；未加键时 `wbText()` 自动用中文兜底 |

> 单位下拉的 10 个单位（m³ / L / t / kg / MPa / N/mm² / 万元 / 元 / m² / 亩）直接写符号，**不占 i18n 键**。
> `makeT` 的缺键回退是「EN → ZH → 键名本身」，所以漏加键不会崩，但界面会直接显示键名；新增键请按上表补齐。

---

## 六、用到的 CSS 类

全部是 `client.js` 现成 CSS（`CSS` 常量，约 239–334 行）里**已定义**的类，**不需要新增任何样式**：

| 类 | 用在哪 |
|---|---|
| `dsh-wb-card` | `CardShell` 外壳；`CalcCard` 五个分区各自套一层（CSS 已有 `.dsh-wb-card + .dsh-wb-card` 间距） |
| `dsh-wb-row` | 三张表的每一行 |
| `dsh-wb-row-title` | 行标题（第一列 + 第二列）；表单标题；`CalcCard` 分区标题 |
| `dsh-wb-row-meta` | 行内其余字段；计算结果行 |
| `dsh-wb-row-actions` | 行内按钮组；表单底部按钮；计算按钮右对齐 |
| `dsh-wb-btn` | 所有按钮；`data-tone` 用 `primary` / `outline` / `quiet`（均已定义） |
| `dsh-wb-input` | 搜索框、表单输入、计算器数字输入、单位下拉 `select` |
| `dsh-wb-error` | 读取/保存/删除错误、`warning`、非法数字提示、单位不一致提示、表单内错误 |
| `dsh-wb-note` | 空表提示、搜索无结果提示 |
| `dsh-wb-loading` | 首次读取中 |
| `dsh-wb-chip` | 行标题右侧的 `chipKey` 字段（standards 的类别 / prices 的单位 / changes 的状态） |
| `dsh-wb-field` | 编辑表单与计算器的「label + input」行 |
| `dsh-wb-textarea` | 钢筋批量直径输入框 |

额外的布局微调全部走内联 `style`，没有引入新类：

- `dsh-wb-field label` 现有 CSS 定宽 48px，放不下「管理费率%」等中文标签 → 内联覆盖为 `width: 76px`；
- 钢筋 `textarea` 内联 `minHeight: 52px` 并恢复正文字体（该类默认等宽字体、`min-height: 220px`）；
- 编辑表单容器用内联 `border` / `padding` / `borderRadius`，与 `EntryCard` 现有做法一致。

---

## 七、集成时的 3 个注意点

1. **作用域拆分 + `_calc` 导出。** `WB_CALC` 必须留在 factory 作用域（`return` 之前），模块返回值加
   `_calc: WB_CALC`；`TableCard` / `CalcCard` 放在 `apply(ctx)` 内。若把 730 行整段粘进 `apply`，
   `_calc` 拿不到对象，测试也就调不到纯函数。验收时确认 `test/unit.mjs` 能直接调
   `_calc.rebarWeight` / `unitPrice` / `totalCost` / `costPerArea` / `steelPerArea` / `convert` 六个函数。
2. **`category` 是契约，不要改回 `kind`。** `lib/tables.js`、`index.js` 的 `entryTables`、本片段的 `WB_TABLES`、
   `scripts/seed-vault.ps1` 四处必须一致（task-2 原始说明里的 `kind` 与现有 Host 代码冲突，已按 Lead 确认的
   `category` 实现）。以后若真要改列名，只需改 `WB_TABLES.standards.fields` 里那一个 `key` 以及
   `standards.field.category` 文案键，`TableCard` 本身是元数据驱动的；但 Host 表头/主键/种子脚本必须同时改。
3. **`refreshTick` 没接、行内插入只出一行。** `TableCard` 签名按 task-2 固定为
   `{ card, t, requestInsert, setFlash }`，没有接面板顶部的 `refreshTick`，卡片自带「刷新」按钮；
   若 Lead 希望顶部刷新联动，需把签名改成 `{ ..., refreshTick = 0 }` 并在 `useEffect` 依赖里加 `refreshTick`
   （由 Lead 决定，当前不要为此在片段里偷偷加参数）。行内「插入」按需求只输出**一条 Markdown 数据行**
   （`| 值 | 值 |`，不输出表头和 `---` 分隔行，避免粘进已有表格时重复表头）；需要「整表插入」时参考
   `EntryCard.insertAll` 的写法另做，不要改 `insertRow` 的语义。

---

## 八、已验证项

- `node --check`：片段包成 `(function(){ ... })()` 的临时文件检查通过（退出码 0），临时文件已删除；
- 纯函数 + 元数据冒烟（38 条断言）：公式数值、默认税率 9、非法输入返回 `NaN` 不抛异常、五个换算方向、
  字段顺序 / 主键 / labelKey 与 Lead 的 `client.js` schema 对齐，全部通过；
- 组件渲染冒烟（25 条断言，React 替身 + 假 `api`）：初始 loading、`standards.sub` note、ready 列表、
  字段标签、状态 chip、搜索框、行内插入文本与标签、复制失败提示、编辑表单、主键全空提示 `table.needKey`、
  错误态重试、空表提示、计算器五分区、`calc.invalid` 提示、五组计算结果，全部通过；
- 另单独校验 `CardShell` 的 `stateText`（`"7 table.total"`）/ `note`（`prices.sub`）/ `title`（`prices.title`）3 条，通过。

集成后请在 `client.js` 里跑 `node test/all.mjs`，并至少手动点一次：新增 → 编辑 → 插入 → 复制 → 删除，
以及计算器的「清空输入点计算」（应显示「请输入数字」而不是白屏或抛错）。
