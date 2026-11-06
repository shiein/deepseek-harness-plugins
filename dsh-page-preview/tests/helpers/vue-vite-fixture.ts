/** Vite 适配器自有样本（方案 §6.5、§15.3）；复用显式现有依赖，所有源码/配置/环境/缓存均在可丢弃目录。 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile, readdir, lstat, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { inspectApp } from '../../src/shared/profile.ts'
import { vueViteAdapter } from '../../src/adapters/vue/vite/index.ts'
import type { AdapterContext, RunEvent, StartContext } from '../../src/adapters/types.ts'
import type { ResolvedTarget } from '../../src/core/target/resolve.ts'
import { createFileLedger } from '../../src/runner/ledger.ts'

export async function createVueViteFixture(modules: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-vite-adapter-')))
  try {
    const appRoot = join(root, 'app')
    const configMarker = join(root, 'config-evaluated')
    const put = async (path: string, source: string) => { const file = join(appRoot, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, source) }
    await put('package.json', JSON.stringify({ private: true, type: 'module', dependencies: { vue: '3.4.27', vite: '5.2.12', '@vitejs/plugin-vue': '5.1.4' } }))
    for (const name of ['vue', 'vite', '@vitejs/plugin-vue']) { await mkdir(dirname(join(appRoot, 'node_modules', name)), { recursive: true }); await symlink(await realpath(join(modules, name)), join(appRoot, 'node_modules', name)) }
    await put('index.html', '<div id="app"></div><script type="module" src="/src/main.js"></script>')
    await put('src/main.js', `import {createApp} from 'vue'; import App from './Target.vue'; createApp(App).mount('#app')`)
    await put('src/value.ts', `export const label: string = 'Real adapter target'`)
    await put('.env', 'VITE_DSH_FIXTURE_PRIVATE=THIS_VALUE_MUST_NOT_BE_EXPOSED\n')
    await put('vite.config.mjs', `import vue from ${JSON.stringify(pathToFileURL(join(await realpath(join(modules, '@vitejs/plugin-vue')), 'dist/index.mjs')).href)}
  import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
  export default {
 plugins: [(function () { writeFileSync(${JSON.stringify(configMarker)}, String(process.pid), { mode: 0o600 }); console.log('DO_NOT_EXPOSE_FIXTURE_OUTPUT'); return vue() })()],
   resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
   define: { __FIXTURE_CONFIG_DIR__: JSON.stringify(fileURLToPath(new URL('.', import.meta.url))) },
  }`)
    await put('src/Target.vue', `<script setup lang="ts">
  import { ref } from 'vue'
  import { label } from '@/value.ts'
  if (import.meta.env.VITE_DSH_FIXTURE_PRIVATE !== undefined) throw new Error('Unexpected automatic environment loading')
  if (__FIXTURE_CONFIG_DIR__ !== ${JSON.stringify(appRoot + '/')}) throw new Error('Original config URL semantics changed')
  const count = ref(0)
  const browser = navigator.userAgent
  </script>
  <template><article><h1>{{ label }}</h1><p>adapter-revision-1</p><button @click="count++">Adapter counter: {{ count }}</button><small>{{ browser }}</small></article></template>
  <style scoped>article { border-left: 4px solid #246; padding: 12px }</style>`)
    const context: AdapterContext = { workspaceRoot: root, appRoot, profile: await inspectApp(root, appRoot), config: { source: { kind: 'detected' }, diagnostics: [], project: { id: 'vue-app', root: 'app', runtime: { adapter: 'vue-vite', strategy: 'isolated', requirements: [], entry: 'src/main.js' } } } }
    const target: ResolvedTarget = { projectId: 'vue-app', targetId: 'actual', scope: 'component', selector: { kind: 'file', path: 'src/Target.vue' } }
    const outcome = await vueViteAdapter.plan(context, target)
    if (outcome.kind !== 'plan') throw new Error('Own Vue fixture plan failed: ' + (outcome.kind === 'missing' ? outcome.missing.map(value => value.code).join(',') : outcome.reason))
    const ledger = createFileLedger(join(root, 'control'))
    const events: RunEvent[] = []
    let verifications = 0
    const input: StartContext = { ...context, previewId: 'vue-vite-owned-fixture', ownerSessionId: 'own-test', plan: outcome.plan, signal: new AbortController().signal, deadline: Date.now() + 15000, ledger,
      async verifyExecution() { verifications++ }, emit(event) { events.push(event) },
    }
    const cleanup = async () => {
      if ((await ledger.listByPreview(input.previewId)).length) throw new Error('Own Vue fixture still has resource records: ' + join(root, 'control'))
      await rm(root, { recursive: true, force: true })
    }
    return { root, appRoot, configMarker, input, events, ledger, put, verifications: () => verifications, cleanup }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}

/** 对实际源文件作前后比较；跳过显式借用的依赖目录，不读取其内容。 */
export async function fixtureFiles(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const name of await readdir(root)) {
    if (name === 'node_modules') continue
    const file = join(root, name)
    if ((await lstat(file)).isDirectory()) for (const [child, hash] of Object.entries(await fixtureFiles(file))) result[name + '/' + child] = hash
    else result[name] = createHash('sha256').update(await readFile(file)).digest('hex')
  }
  return result
}
