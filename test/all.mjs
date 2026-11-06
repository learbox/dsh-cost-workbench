/**
 * 一键回归：依次跑三个测试文件，任何一个失败即整体失败。
 *
 * 用法：
 *   node test/all.mjs                  # 离线（不联网）
 *   WB_TEST_NETWORK=1 node test/all.mjs
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const files = ['unit.mjs', 'routes.mjs', 'client-smoke.mjs']

function run(file) {
  const path = fileURLToPath(new URL('./' + file, import.meta.url))
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path], { stdio: 'inherit' })
    child.on('close', (code) => resolve(code === 0))
  })
}

const started = Date.now()
const results = []
for (const file of files) {
  console.log('\n──────── ' + file + ' ────────')
  results.push([file, await run(file)])
}

const failed = results.filter(([, ok]) => !ok)
console.log('\n════════ 汇总 ════════')
for (const [file, ok] of results) console.log((ok ? '✓ ' : '✗ ') + file)
console.log(`${results.length - failed.length}/${results.length} 个套件通过，用时 ${Math.round((Date.now() - started) / 1000)}s`)

if (failed.length > 0) {
  console.error('整体失败：' + failed.map(([file]) => file).join('、'))
  process.exit(1)
}
