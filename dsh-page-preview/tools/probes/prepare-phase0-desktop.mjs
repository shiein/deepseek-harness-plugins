/** Phase 0 桌面本地探针包（方案 §4.1、§14）；只生成可丢弃包，不修改或安装用户 profile。 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join } from 'node:path'

const origin = process.argv[2]
if (!origin) throw new Error('Usage: node scripts/prepare-phase0-desktop.mjs <loopback-origin> <absolute-output-directory>')
const url = new URL(origin)
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== origin) throw new Error('Probe requires an exact loopback HTTP origin')
const output = process.argv[3]
if (!output || !isAbsolute(output)) throw new Error('Probe output directory must be absolute')
const root = fileURLToPath(new URL('../..', import.meta.url))
// 新快照使用独立模块路径，避免覆盖运行中的包或复用上一轮的模块缓存。
const destination = join(root, 'output/phase0/desktop-package-' + Date.now())
const source = join(root, 'dev/bridge')
const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
manifest.dsh.bundle = { patch: './cordis.patch.yml' }
await mkdir(destination, { recursive: true })
await cp(join(source, 'lib'), join(destination, 'lib'), { recursive: true })
for (const file of ['host.mts', 'client.mts', 'protocol.ts']) await cp(join(source, file), join(destination, file))
await writeFile(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
// JSON 字符串是 YAML 合法标量；路径和 URL 均保持字面值，不解释为代码。
await writeFile(join(destination, 'cordis.patch.yml'), `- id: ui-sidebar-browser
  disabled: false
- insert:
    - id: page-preview-phase0-carrier
      name: dsh-page-preview-phase0-bridge
      config:
        origin: ${JSON.stringify(origin)}
        output: ${JSON.stringify(output)}
`)
console.log('Local-only Phase 0 package prepared: ' + destination)
console.log('Install through Desktop plugin manager; only the fixed probe session receives commands. Remove it after verification.')
