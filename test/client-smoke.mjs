/**
 * 客户端模块冒烟：用最小 React / Slots / window 桩跑一遍 factory 与 apply，
 * 抓装配期异常（槽位注册、tab 类型注册、模块顶层语法/引用错误）。
 *
 * 注意：这只能证明"装配不炸 + 三个槽位都注册了"，
 * 证明不了渲染结果好不好看——那需要真浏览器。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { createReporter } from './helpers.mjs'

const { check, report } = createReporter('client-smoke')

const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

/** 最小 React 替身：够用来跑通 bundle 装配，不模拟真实渲染。 */
class StubComponent {
  constructor(props) {
    this.props = props ?? {}
    this.state = {}
  }

  setState(patch) {
    this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) }
  }
}

const React = {
  Component: StubComponent,
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

let loaded = null
const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => { loaded = definition } } },
  console,
  setTimeout,
  clearTimeout,
  fetch: () => Promise.reject(new Error('no network in smoke test')),
  navigator: { clipboard: { writeText: async () => {} } },
  document: {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({ style: {} }),
    body: { appendChild() {}, removeChild() {} },
    execCommand: () => true,
  },
  encodeURIComponent,
  decodeURIComponent,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

check('__ModuleLoader__.load 被调用', loaded !== null)
check('模块 id 正确', loaded.id === 'dsh-cost-workbench', loaded.id)

const plugin = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
check('factory 返回 apply', typeof plugin.apply === 'function')
check('inject 声明存在', Array.isArray(plugin.inject) && plugin.inject.includes('slots'))

/* 造价计算器：公式必须能被测试直接断言（WB_CALC 从 factory 暴露为 _calc）。 */
const calc = plugin._calc
check('WB_CALC 已暴露', calc !== undefined && typeof calc.rebarWeight === 'function')
if (calc !== undefined) {
  check('钢筋理论重量 d20 ≈ 2.468 kg/m', Math.abs(calc.rebarWeight(20) - 2.468) < 0.001, calc.rebarWeight(20))
  const unit = calc.unitPrice({ labor: 100, material: 200, machine: 50, overheadRate: 10, profitRate: 5, fee: 20, taxRate: 9 })
  check('综合单价组价 ≈ 462.43', Math.abs(unit - 462.4325) < 0.01, unit)
  const total = calc.totalCost({ direct: 1000, measures: 100, other: 50, fee: 30, taxRate: 9 })
  check('总造价 ≈ 1286.2', Math.abs(total - 1286.2) < 0.01, total)
  check('单位造价 = 1286.2 元/m²', Math.abs(calc.costPerArea(1286200, 1000) - 1286.2) < 0.01, calc.costPerArea(1286200, 1000))
  check('含钢量 = 10 kg/m²', Math.abs(calc.steelPerArea(10000, 1000) - 10) < 0.001, calc.steelPerArea(10000, 1000))
  check('1 m³ = 1000 L', Math.abs(calc.convert(1, 'm3', 'l') - 1000) < 1e-9, calc.convert(1, 'm3', 'l'))
  check('1 t = 1000 kg', Math.abs(calc.convert(1, 't', 'kg') - 1000) < 1e-9, calc.convert(1, 't', 'kg'))
  check('非法数字返回 NaN', Number.isNaN(calc.rebarWeight('abc')) && Number.isNaN(calc.unitPrice({ labor: 'x' })))
  check('跨维度换算返回 NaN', Number.isNaN(calc.convert(1, 'm3', 't')))
}

/* Markdown 渲染：marked 应覆盖表格/引用/任务列表/代码块/删除线，Obsidian 图片与双链仍然处理。 */
if (typeof plugin._md === 'function') {
  const md = [
    '| 编号 | 项目 | 金额 |',
    '| --- | --- | --- |',
    '| BG-001 | 增加锚杆 | 120000 |',
    '',
    '> 引用一段',
    '',
    '- [x] 已完成',
    '- [ ] 未完成',
    '',
    '```js',
    'const a = 1',
    '```',
    '',
    '~~删除线~~',
    '',
    '[[双链目标]]',
    '',
    '![[现场.png]]',
  ].join('\n')
  const html = plugin._md(md, '01 计价依据')
  check('表格渲染成 table', html.includes('<table>') && html.includes('<th>'), html.slice(0, 200))
  check('引用渲染成 blockquote', html.includes('<blockquote>'))
  check('任务列表渲染成 checkbox', html.includes('checkbox'))
  check('代码块渲染成 pre>code', html.includes('<pre>') && html.includes('<code'))
  check('删除线渲染成 del', html.includes('<del>'))
  check('双链渲染成 wikilink', html.includes('dsh-wb-wikilink'))
  check('Obsidian 图片转成附件 URL', html.includes('dsh-wb-md-img') && html.includes('/attachment?name='))
}

const registered = []
const ctx = {
  locale: {
    subscribe: () => () => {},
    getSnapshot: () => ({ locale: 'zh' }),
    getLocale: () => ({ locale: 'zh' }),
  },
  get: () => undefined,
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject: (name, callback) => {
      const dispose = callback()
      registered.push(name)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register: (options) => {
      registered.push(options.name + ':' + (options.id ?? options.key))
      return () => {}
    },
    spec: () => ({ kind: 'keyed' }),
  },
  sessions: { scope: () => undefined },
  inject: () => {},
}

plugin.apply(ctx)

check('注册了会话头部按钮', registered.includes('conversation.session.header.actions:dsh-workbench'))
check('注册了新会话入口', registered.includes('conversation.hero.options:dsh-workbench'))
// 侧栏回归：面板崩溃曾把整条右栏带走（根因是面板里误用了录音卡的 sessionRef，已修）。
// 现在侧栏与浮层并存：能放侧栏就放侧栏，放不进就浮层，且标签类型回调都带 try/catch。
check('注册了右侧栏正文位', registered.includes('sidebar.right.pane.tab:dsh-workbench.panel'))
// ⌥W 全屏工作台走官方 shell.overlay 槽位，不依赖侧栏
check('注册了全屏浮层槽位', registered.includes('shell.overlay:dsh-workbench-full'))

assert.ok(report())
