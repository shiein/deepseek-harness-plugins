/** vue-cli 适配器自有样本（方案 §6.9、§15.3）；复用显式工具链依赖，所有源码/配置/环境均在可丢弃目录。 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectApp } from '../../src/shared/profile.ts'
import { vueCliAdapter } from '../../src/adapters/vue/cli/index.ts'
import type { AdapterContext, RunEvent, StartContext } from '../../src/adapters/types.ts'
import type { ResolvedTarget } from '../../src/core/target/resolve.ts'
import { createFileLedger } from '../../src/runner/ledger.ts'

export interface CliFixtureSpec {
  modules: string
  /** 声明并逐符号链接进 appRoot/node_modules 的包（含 scoped 名）。 */
  packages: string[]
  packageDeps: Record<string, string>
  files: Record<string, string>
  targetPath: string
  fixtureId: string
  /** 声明的 runtime.env 执行环境（进执行指纹与 worker env）。 */
  env?: Record<string, string>
  /** 已审阅的 runtime.setup 相对路径（由 files 写入）。 */
  setup?: string
}

export async function createCliAppRoot(spec: CliFixtureSpec) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-cli-adapter-')))
  try {
    const appRoot = join(root, 'app')
    const configMarker = join(root, 'config-evaluated')
    const put = async (path: string, source: string) => { const file = join(appRoot, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, source) }
    await put('package.json', JSON.stringify({ private: true, devDependencies: spec.packageDeps }))
    for (const name of spec.packages) { const dest = join(appRoot, 'node_modules', name); await mkdir(dirname(dest), { recursive: true }); await symlink(await realpath(join(spec.modules, name)), dest) }
    for (const [path, source] of Object.entries(spec.files)) await put(path, source.replace(/__CONFIG_MARKER__/g, configMarker))
    const context: AdapterContext = { workspaceRoot: root, appRoot, profile: await inspectApp(root, appRoot), config: { source: { kind: 'detected' }, diagnostics: [], project: { id: spec.fixtureId, root: 'app', runtime: { adapter: 'vue-cli', strategy: 'isolated', requirements: [], entry: 'src/main.js', ...(spec.env === undefined ? {} : { env: spec.env }), ...(spec.setup === undefined ? {} : { setup: spec.setup }) } } } }
    const target: ResolvedTarget = { projectId: spec.fixtureId, targetId: 'actual', scope: 'component', selector: { kind: 'file', path: spec.targetPath } }
    const cleanup = async () => { await rm(root, { recursive: true, force: true }) }
    return { root, appRoot, configMarker, context, target, put, cleanup }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}

export async function createVueCliFixture(spec: CliFixtureSpec) {
  const base = await createCliAppRoot(spec)
  const { root, context, target, put, cleanup } = base
  try {
    const outcome = await vueCliAdapter.plan(context, target)
    if (outcome.kind !== 'plan') throw new Error('Own Vue CLI fixture plan failed: ' + (outcome.kind === 'missing' ? outcome.missing.map(value => value.code + ' ' + value.message).join(' | ') : outcome.reason))
    const ledger = createFileLedger(join(root, 'control'))
    const events: RunEvent[] = []
    let verifications = 0
    const input: StartContext = { ...context, previewId: spec.fixtureId + '-owned', ownerSessionId: 'own-test', plan: outcome.plan, signal: new AbortController().signal, deadline: Date.now() + 120000, ledger,
      async verifyExecution() { verifications++ }, emit(event) { events.push(event) },
    }
    const guardedCleanup = async () => {
      if ((await ledger.listByPreview(input.previewId)).length) throw new Error('Own Vue CLI fixture still has resource records: ' + join(root, 'control'))
      await cleanup()
    }
    return { ...base, input, events, ledger, verifications: () => verifications, cleanup: guardedCleanup }
  } catch (error) { await cleanup(); throw error }
}
