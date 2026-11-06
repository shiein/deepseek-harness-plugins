// P1-3：把 tests/toolchains/<组合>/ 的私有清单按各自 lock 复现安装（--ignore-scripts），
// 不装进任何业务项目；lock 未变化时跳过，保证 npm test 幂等。缺失 lock 时用 npm install 生成，便于新增清单后提交。
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = new URL('../tests/toolchains/', import.meta.url)

const entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
let installed = 0
let skipped = 0
const failures = []
for (const name of entries) {
  const dir = new URL(name + '/', root)
  const manifest = await stat(new URL('package.json', dir)).catch(() => undefined)
  if (!manifest) continue
  const lock = await stat(new URL('package-lock.json', dir)).catch(() => undefined)
  // node_modules 存在且 lock 不早于清单：视为已按当前清单安装；否则必须重新安装，避免静默用过期依赖。
  const modules = await stat(new URL('node_modules/.package-lock.json', dir)).catch(() => undefined)
  if (lock && modules && modules.mtimeMs >= manifest.mtimeMs && modules.mtimeMs >= lock.mtimeMs) {
    skipped++
    continue
  }
  const args = lock
    ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error']
    : ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error']
  try {
    await execFileAsync('npm', args, { cwd: fileURLToPath(dir), env: { ...process.env } })
    installed++
    console.log('[toolchains] installed ' + name)
  } catch (error) {
    failures.push(name + ': ' + (error instanceof Error ? error.message : String(error)))
  }
}
for (const failure of failures) console.error('[toolchains] failed ' + failure)
console.log('[toolchains] ' + installed + ' installed, ' + skipped + ' up to date' + (failures.length ? ', ' + failures.length + ' failed' : ''))
if (failures.length) process.exit(1)
