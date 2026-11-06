/** Vite 每预览执行器（方案 §6.3、§6.5、§6.8、§9.2）；机制在 adapters/vite/worker-core.ts，
 * 这里只提供 Vue 钩子：vue 工具链核对、@vitejs/plugin-vue 默认加载、虚拟模块只重锚 'vue'。 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveInstalledPackage } from '../../../shared/profile.ts'
import { readVueBuildConfig } from '../readonly-config.ts'
import { createViteSources } from './sources.ts'
import { VITE_VIRTUAL_PREFIX } from './protocol.ts'
import { runViteWorker as runCore, runIfMain } from '../../vite/worker-core.ts'
import type { ViteWorkerHooks } from '../../vite/worker-core.ts'

const hooks: ViteWorkerHooks = {
  adapterId: 'vue-vite',
  createSources: createViteSources,
  readBuildConfig: root => readVueBuildConfig(root, 'vite'),
  async verifyToolchain(input) {
    const vue = await resolveInstalledPackage(input.appRoot, input.workspaceRoot, 'vue')
    return vue?.version === input.plan.toolchain.vue
  },
  async loadDefaultPlugin(input, root) {
    const plugin = await resolveInstalledPackage(root, input.workspaceRoot, '@vitejs/plugin-vue')
    if (!plugin || plugin.version !== input.plan.toolchain.vuePluginVersion)
      throw new Error('Installed Vue compiler plugin differs from the approved plan')
    const module: unknown = await import(pathToFileURL(join(plugin.directory, 'dist/index.mjs')).href)
    if (!module || typeof module !== 'object' || !('default' in module)
      || typeof module.default !== 'function')
      throw new Error('Vue compiler plugin export is invalid')
    return (module.default as () => unknown)()
  },
  virtualBare: (id, importer) =>
    id === 'vue' && importer?.startsWith(VITE_VIRTUAL_PREFIX) ? 'vue' : undefined,
  optimizeInclude: ['vue'],
  ownPathnames: [],
}

export async function runViteWorker(): Promise<void> {
  await runCore(hooks)
}
runIfMain(import.meta.url, runViteWorker)
