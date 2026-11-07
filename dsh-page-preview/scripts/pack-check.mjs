// R3-7：发布前的打包内容检查（方案 §14 Phase 4"验证打包、干净环境安装"）。只读，不发布、不上传。
//
// 检查项：
//   1. 构建产物齐备（lib/index.js、client bundle、wire 描述符、browser/）；缺失时先跑 `npm run build`
//   2. `npm pack --dry-run --json` 取得将打包的文件清单（dry-run 不在仓库内生成 tarball）
//   3. 必须包含 lib/、browser/、schema/、cordis.patch.yml 与 exports 引用的各入口；
//      不得包含 tests/、dev/、docs/、src/ 源码与任何 .env* 文件
//   4. package.json 的 dsh.bundle.patch / engines.dsh / peerDependencies 与锁定的 DSH 0.2.1-rc.5 一致
//   5. 输出文件数、总大小与上述检查结果；任一失败 exit 1
// 本脚本不把包装安装到任何 DSH profile（安装需 Aesc 单独授权，见 docs/dsh-e2e-acceptance.md）。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const LOCKED_DSH = '0.2.1-rc.5'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`[pack-check] ${ok ? 'ok' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

// 1. 构建产物
const built = ['lib/index.js', 'lib/client.js', 'lib/typert.host.js', 'lib/typert.remote-client.js', 'browser/bootstrap.js']
const missing = built.filter(file => !existsSync(join(root, file)))
check('build artifacts', missing.length === 0,
  missing.length === 0 ? 'lib/ + browser/ 齐备' : '缺 ' + missing.join(', ') + '（先跑 npm run build）')

// 2. 打包清单
let packed = []
try {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' })
  const parsed = JSON.parse(raw)
  packed = parsed[0]?.files ?? []
} catch (error) {
  check('npm pack --dry-run', false, String(error).split('\n')[0])
}
const paths = packed.map(file => file.path)
const totalSize = packed.reduce((sum, file) => sum + file.size, 0)

// 3a. 必须包含
const mustInclude = [
  'lib/index.js', 'lib/client.js', 'lib/typert.host.js', 'lib/typert.remote-client.js',
  'browser/bootstrap.js', 'cordis.patch.yml', 'package.json', 'README.md',
]
const absent = mustInclude.filter(file => !paths.includes(file))
check('required entries', absent.length === 0,
  absent.length === 0 ? mustInclude.length + ' 项均在清单中' : '缺 ' + absent.join(', '))
check('schema dir', paths.some(file => file.startsWith('schema/')),
  paths.filter(file => file.startsWith('schema/')).join(', ') || '无 schema/ 文件')

// 3a'. exports 中每个 types/default 目标都必须在包内（src/ 被排除，types 不能指向源码）
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const exportTargets = []
for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
  const conditions = typeof target === 'string' ? { default: target } : target
  for (const [condition, file] of Object.entries(conditions)) {
    exportTargets.push({ subpath, condition, file: String(file).replace(/^\.\//, '') })
  }
}
const danglingExports = exportTargets.filter(entry => !paths.includes(entry.file))
check('export targets packed', danglingExports.length === 0,
  danglingExports.length === 0
    ? exportTargets.length + ' 个 exports 目标均在清单中'
    : '不在包内：' + danglingExports.map(entry => `${entry.subpath} ${entry.condition} → ${entry.file}`).join(', '))

// 3b. 不得包含
const forbidden = [/^(tests|dev|docs)\//, /^src\//, /(^|\/)\.env/]
const leaked = paths.filter(file => forbidden.some(rule => rule.test(file)))
check('excluded paths', leaked.length === 0,
  leaked.length === 0 ? 'tests/dev/docs/src/.env* 均不在包内' : '泄漏 ' + leaked.join(', '))

// 4. 元数据与锁定版本
check('dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml',
  JSON.stringify(pkg.dsh?.bundle?.patch))
check('engines.dsh covers locked ' + LOCKED_DSH,
  semver.satisfies(LOCKED_DSH, pkg.engines?.dsh ?? '', { includePrerelease: true }),
  JSON.stringify(pkg.engines?.dsh))
const badPeers = Object.entries(pkg.peerDependencies ?? {})
  .filter(([name, range]) => name !== '@deepseek-ai/cordis' && range !== LOCKED_DSH)
check('peerDependencies pinned to ' + LOCKED_DSH, badPeers.length === 0,
  badPeers.length === 0 ? '全部 @deepseek-ai/* 锁定' : badPeers.map(([n, r]) => n + '@' + r).join(', '))
check('client bundle is plain JS', existsSync(join(root, 'lib/client.js'))
  && statSync(join(root, 'lib/client.js')).size > 0, 'lib/client.js')

console.log(`[pack-check] ${paths.length} files, ${(totalSize / 1024).toFixed(1)} KiB`)
const failed = results.filter(item => !item.ok)
if (packed.length === 0) console.log('[pack-check] FAIL no packed file list')
process.exit(failed.length === 0 && packed.length > 0 ? 0 : 1)
