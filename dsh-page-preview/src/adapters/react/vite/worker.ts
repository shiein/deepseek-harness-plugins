/** React Vite 每预览执行器（方案 §6.3、§6.5、§6.8、§9.2；R5-7）；机制在
 * adapters/vite/worker-core.ts，这里只提供 React 钩子：react/react-dom 工具链核对、
 * plugin-react[-swc] 默认加载、虚拟模块全部裸说明符重锚、/@react-refresh 准入。 */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolveInstalledPackage } from '../../../shared/profile.ts'
import { readReactBuildConfig } from '../readonly-config.ts'
import { createViteSources } from './sources.ts'
import { VITE_VIRTUAL_PREFIX } from './protocol.ts'
import { runViteWorker as runCore, runIfMain } from '../../vite/worker-core.ts'
import type { ViteWorkerHooks } from '../../vite/worker-core.ts'

const hooks: ViteWorkerHooks = {
  adapterId: 'react-vite',
  createSources: createViteSources,
  readBuildConfig: readReactBuildConfig,
  async verifyToolchain(input) {
    const react = await resolveInstalledPackage(input.appRoot, input.workspaceRoot, 'react')
    const reactDom = await resolveInstalledPackage(input.appRoot, input.workspaceRoot, 'react-dom')
    return react?.version === input.plan.toolchain.react && reactDom !== undefined
      && (input.plan.toolchain.reactDom === undefined
        || reactDom.version === input.plan.toolchain.reactDom)
  },
  async loadDefaultPlugin(input, root) {
    const pluginName = input.plan.toolchain.reactPlugin
    if (pluginName !== '@vitejs/plugin-react' && pluginName !== '@vitejs/plugin-react-swc')
      throw new Error('React compiler plugin is unresolved')
    const plugin = await resolveInstalledPackage(root, input.workspaceRoot, pluginName)
    if (!plugin || plugin.version !== input.plan.toolchain.reactPluginVersion)
      throw new Error('Installed React compiler plugin differs from the approved plan')
    // 插件的 ESM 入口从其 exports/module 声明取，不猜文件名。
    const manifestText = await readFile(join(plugin.directory, 'package.json'), 'utf8')
    const manifest = JSON.parse(manifestText) as {
      exports?: Record<string, unknown>, module?: string, main?: string
    }
    const exported = manifest.exports?.['.']
    const esm = typeof exported === 'object' && exported !== null && 'import' in exported
      && typeof exported.import === 'string' ? exported.import
      : typeof manifest.module === 'string' ? manifest.module : undefined
    if (esm === undefined) throw new Error('React compiler plugin has no ESM entry')
    const module: unknown = await import(pathToFileURL(join(plugin.directory, esm)).href)
    const valid = (value: unknown): value is { default: () => unknown } =>
      value !== null && typeof value === 'object' && 'default' in value
      && typeof (value as { default?: unknown }).default === 'function'
    if (!valid(module)) throw new Error('React compiler plugin export is invalid')
    return module.default()
  },
  // 虚拟模块（setup/entry）没有文件系统位置：其裸说明符统一锚到应用根解析，
  // 保证 react/react-dom/react-router-dom 与 Provider 第三方包都命中项目自己的安装。
  virtualBare: (id, importer) => {
    const bare = !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0')
    return importer?.startsWith(VITE_VIRTUAL_PREFIX) && bare ? id : undefined
  },
  optimizeInclude: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  ownPathnames: ['/@react-refresh'],
}

export async function runViteWorker(): Promise<void> {
  await runCore(hooks)
}
runIfMain(import.meta.url, runViteWorker)
