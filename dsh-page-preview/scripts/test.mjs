/**
 * 全量测试入口（R5-F2）。node --test 默认按核数并行执行测试文件；重量级文件各自再拉起
 * vite/vue-cli-service 编译链与无头 Chrome，9 路文件并发时 CPU 争用会让用例内的固定等待
 * 窗口超时、超时后又因子进程未退出而挂住整轮测试。这里把测试分两批：
 * 常规文件默认并发先跑（快速反馈），重量级文件以 --test-concurrency 2 单独压尾。
 * 两批都带 --test-timeout 300000：单个卡死的用例报失败而不是挂住整轮。
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const unitDir = fileURLToPath(new URL('../tests/unit/', import.meta.url))
const files = readdirSync(unitDir).filter(name => /\.test\.(ts|mjs)$/.test(name)).sort()

// 编译真实工具链或启动无头 Chrome 的测试文件；新增重量级文件须登记在这里。
const HEAVY = new Set([
  'open-pagetext-timing.test.mjs',
  'react-vite-runtime.test.ts',
  'real-traits.test.ts',
  'toolchain-scenario.test.mjs',
  'toolchain-scenario-cli.test.mjs',
  'vue-cli-public.test.mjs',
  'vue-cli-route.test.ts',
  'vue-cli-runtime.test.ts',
  'vue-route-viewport.test.ts',
  'vue-uikit-matrix.test.ts',
  'vue-uikit-tier2.test.ts',
  'vue-vite-public.test.mjs',
  'vue-vite-runtime.test.ts',
  'vue-vite-unverified.test.ts',
  'vue-vite-websocket.test.ts',
])

const heavy = files.filter(name => HEAVY.has(name))
const light = files.filter(name => !HEAVY.has(name))
const missing = [...HEAVY].filter(name => !files.includes(name))
if (missing.length > 0) {
  console.error('[test] heavyweight list is stale, missing files: ' + missing.join(', '))
  process.exitCode = 1
} else {
  const run = (list, extra) => new Promise(resolve => {
    const child = spawn(process.execPath,
      ['--test', '--test-timeout', '300000', ...extra, ...list.map(name => join(unitDir, name))],
      { stdio: 'inherit' })
    child.on('exit', code => resolve(code ?? 1))
  })
  const lightCode = await run(light, [])
  const heavyCode = heavy.length > 0 ? await run(heavy, ['--test-concurrency', '2']) : 0
  if (lightCode !== 0 || heavyCode !== 0) process.exitCode = lightCode !== 0 ? lightCode : heavyCode
}
