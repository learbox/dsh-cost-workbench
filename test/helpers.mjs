/**
 * 测试公用件：假 webServer（捕获 prefix handler）+ 临时目录。
 *
 * 这些测试直接 import 插件的 index.js，不经过 DSH 运行时；
 * 所以既能跑在开发机上，也能在没有 App 的终端里跑。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 真实 vault（只读测试用）；不存在时调用方应跳过相关断言。 */
// 真实 vault 只在本地联调时用：设置 WORKBENCH_REAL_VAULT 环境变量，默认不启用
export const REAL_VAULT = process.env.WORKBENCH_REAL_VAULT ?? ''
export const REAL_SOP = '00 资料库'

/**
 * 挂载一个插件实例，返回能直接打路由的函数。
 * call.handler 也暴露出来，供需要自定义 res（流式、Range）的用例使用。
 * @param {object} config 传给 apply 的 config（缺省走插件内置默认值）
 */
export function mount(config = {}) {
  let handler = null
  const ctx = {
    webServer: {
      register(route) {
        assert.equal(route.kind, 'prefix')
        assert.equal(route.path, '/api/dsh-workbench')
        handler = route.handler
        return () => {}
      },
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { info() {}, warn() {} },
  }

  return import('../index.js').then((module) => {
    module.apply(ctx, config)
    assert.ok(handler !== null, 'webServer.register 没有被调用')

    const call = async function call(method, path, body) {
      const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))]
      const req = {
        method,
        url: '/api/dsh-workbench' + path,
        headers: { host: '127.0.0.1:58900' },
        socket: { remoteAddress: '127.0.0.1' },
        on() {},
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
        },
      }
      let status = 0
      let payload = ''
      await handler(req, {
        writeHead(code) { status = code },
        write() { return true },
        end(data) { if (data !== undefined) payload = String(data) },
        on() {},
      })
      let json = null
      try {
        json = JSON.parse(payload)
      } catch {
        json = null
      }
      return { status, json, raw: payload }
    }

    call.handler = handler
    return call
  })
}

/** 建一个临时目录，返回 { dir, cleanup }。 */
export async function tempDir(prefix = 'dsh-workbench-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** 简易断言计数器：每个测试文件末尾调用 report()。 */
export function createReporter(name) {
  const results = []
  return {
    check(label, condition, detail) {
      results.push([label, Boolean(condition)])
      if (!condition) console.error('  ✗ ' + label + (detail === undefined ? '' : '  → ' + String(detail).slice(0, 200)))
      else console.log('  ✓ ' + label)
    },
    report() {
      const failed = results.filter(([, ok]) => !ok)
      console.log(`\n${name}: ${results.length - failed.length}/${results.length} 通过`)
      if (failed.length > 0) {
        console.error('失败项：' + failed.map(([label]) => label).join('、'))
        process.exitCode = 1
      }
      return failed.length === 0
    },
  }
}
