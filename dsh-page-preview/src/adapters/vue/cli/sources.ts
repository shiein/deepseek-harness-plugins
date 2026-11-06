/** Vue CLI 自有预览入口/包装配置生成（方案 §6.9）；全部产物写入插件临时目录，业务文件保持原路径/内容。 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { resolveProjectPath } from '../../../shared/config/paths.ts'
import { localRoute } from '../../../shared/route.ts'
import { jsonSource, renderEntryTemplate, scenarioEntryValues, vueRouteRootModule } from '../vite/sources.ts'
import { verifiedGeneratedSetup } from '../generated-setup.ts'
import { documentShell } from '../../../shared/html.ts'
import { readProjectText } from '../../../shared/profile.ts'
import { CLI_PAGE_NAME, CLI_PAGE_PATH } from './protocol.ts'
import type { CliWorkerInput } from './protocol.ts'
import type { ScenarioConfig } from '../../../shared/config/schema.ts'

export interface CliSources {
  entry: string
  template: string
  config: string
  bootstrap: string
  target: string
  setup?: string
  exposedFiles: string[]
  /** R3-2：用新场景数据重渲染入口内容；调用方负责写回 entry 文件并触发重编译。 */
  rerenderEntry(scene: ScenarioConfig | undefined): string
}

/** entry/template/config 落盘到 temporaryRoot；'vue' 等裸导入由 cli-service 的 resolve.modules(appRoot/node_modules) 解析。 */
export async function createCliSources(input: CliWorkerInput, originalConfig: string | undefined, hookModule: string): Promise<CliSources> {
  const project = input.project
  const root = input.temporaryRoot
  const scene = input.plan.scenario === undefined ? undefined : project.scenarios?.[input.plan.scenario]
  const requested = input.plan.selector
  const selector = requested.kind === 'registered' ? project.targets?.find(value => value.id === requested.id)?.selector : requested
  if (selector?.kind !== 'file') throw new Error('Vue CLI target must be a concrete module')
  const file = await resolveProjectPath(input.appRoot, selector.path, project.runtime.dependencyRoots)
  const setup = project.runtime.setup ? await resolveProjectPath(input.appRoot, project.runtime.setup, project.runtime.dependencyRoots) : undefined
  const version = input.plan.toolchain.vue
  const family = version?.startsWith('3.') ? '3' : version?.startsWith('2.6.') || version?.startsWith('2.7.') ? '2' : undefined
  if (!family) throw new Error('Vue runtime version is unresolved')
  const asset = (name: string) => new URL(import.meta.url.endsWith('.ts') ? '../../../browser/' + name : '../../../../browser/' + name, import.meta.url)
  const lifecycle = join(root, 'dsh-lifecycle.js')
  const runtime = join(root, 'dsh-runtime.js')
  await writeFile(lifecycle, await readFile(asset('vue/lifecycle.js'), 'utf8'), { mode: 0o600 })
  await writeFile(runtime, await readFile(asset(family === '3' ? 'vue/mount-vue3.js' : 'vue/mount-vue2.js'), 'utf8'), { mode: 0o600 })
  const styles = await Promise.all((project.runtime.styles ?? []).map(path => resolveProjectPath(input.appRoot, path, project.runtime.dependencyRoots)))
  const navigation = input.plan.route ? localRoute(input.plan.route) : undefined
  const specifier = (target: string) => jsonSource(target.replace(/\\/g, '/'))
  // 自动生成的 setup（§0.3 第 10 条）：重新生成并核对摘要后写入本预览临时目录（已登记账本），不写入项目。
  const generated = !setup && input.plan.generatedSetup
    ? await verifiedGeneratedSetup(input.appRoot, input.plan.generatedSetup, version) : undefined
  const generatedFile = generated === undefined ? undefined : join(root, 'dsh-generated-setup.js')
  if (generatedFile !== undefined) await writeFile(generatedFile, generated!, { mode: 0o600 })
  // R5-4：父布局渲染——挂载 router-view 宿主而非叶子组件；宿主模块写进临时目录（账本登记）。
  const routeRoot = input.plan.layout === true ? join(root, 'dsh-route-root.js') : undefined
  if (routeRoot !== undefined) await writeFile(routeRoot, vueRouteRootModule(family), { mode: 0o600 })
  const values: Record<string, string> = {
    __LIFECYCLE_MODULE__: './dsh-lifecycle.js', __VUE_MAJOR__: jsonSource(family), __MOUNT_ID__: jsonSource('__dsh_preview_root'),
    // webpack 无 import.meta.hot（webpack4 甚至无法解析 import.meta）；HMR 已关，Vite 专属钩子置空。
    __VITE_HOT_HOOK__: '',
    ...scenarioEntryValues(scene),
    __TARGET_JSON__: jsonSource({ projectId: input.plan.projectId, targetId: input.plan.targetId }),
    __NAVIGATION_JSON__: navigation ? jsonSource({ route: input.plan.route, href: navigation.pathname + navigation.search + navigation.hash }) : 'undefined',
    __EXPORT_NAME__: jsonSource(selector.exportName ?? 'default'), __REQUIRE_MOCK__: jsonSource(input.plan.requirements.includes('mock-only')),
    __RUNTIME_IMPORT__: 'import(' + jsonSource('./dsh-runtime.js') + ')',
    __SETUP_LOADER__: setup ? 'function () { return import(' + specifier(setup) + ') }'
      : generatedFile !== undefined ? 'function () { return import(' + specifier(generatedFile) + ') }' : 'null',
    __TARGET_IMPORT__: routeRoot === undefined ? 'import(' + specifier(file) + ')'
      : 'import(' + specifier(routeRoot) + ')',
    __STYLE_IMPORTS__: styles.map(path => 'await import(' + specifier(path) + ')').join('\n      '),
  }
  const template = await readFile(asset('vue/preview-entry.template.js'), 'utf8')
  const entry = join(root, 'dsh-entry.js')
  await writeFile(entry, renderEntryTemplate(template, values), { mode: 0o600 })
  const html = join(root, 'dsh-page.html')
  // 沿用项目 public/index.html 的 <html>/<body> 属性与内联经典脚本；含模板占位符的值不复制。
  const indexHtml = await readProjectText(join(input.appRoot, 'public', 'index.html'), input.appRoot)
  const shell = indexHtml === undefined ? undefined : documentShell(indexHtml)
  await writeFile(html, '<!doctype html><html' + (shell?.htmlAttributes ?? '') + '><head><meta charset="utf-8">'
    + (shell?.inlineScripts ?? []).map(code => '<script>' + code + '</script>').join('')
    + '</head><body' + (shell?.bodyAttributes ?? '') + '><div id="__dsh_preview_root"></div></body></html>\n',
  { mode: 0o600 })
  // is-file-esm 向上查找 package.json 判定模块类型；临时目录需自带一个，否则 readPkgUp 返回 undefined 直接抛错。
  await writeFile(join(root, 'package.json'), '{ "name": "dsh-page-preview-cli-tmp", "private": true }\n', { mode: 0o600 })
  // 包装配置 require 原配置与 hook；对象/函数/Promise 三种导出在 hook.resolveBase 中统一，异步导出显式拒绝。
  const config = join(root, 'vue.config.cjs')
  const lines = [
    'const hook = require(' + jsonSource(hookModule) + ')',
    originalConfig === undefined ? 'const original = undefined' : 'const original = require(' + jsonSource(originalConfig) + ')',
    'module.exports = function () {',
    '  const base = hook.resolveBase(original)',
    '  return hook.mergeConfig(base, ' + jsonSource({ entry, template: html, pageName: CLI_PAGE_NAME, pageFile: CLI_PAGE_PATH.slice(1) }) + ')',
    '}',
    '',
  ]
  await writeFile(config, lines.join('\n'), { mode: 0o600 })
  return {
    entry, template: html, config, bootstrap: await readFile(asset('bootstrap.js'), 'utf8'),
    target: relative(input.appRoot, file),
    exposedFiles: [file, ...(setup ? [setup] : []), ...styles], ...(setup ? { setup } : {}),
    // R3-2：场景更新只重算场景相关占位值，其余入口绑定（目标/setup/样式）不变。
    rerenderEntry: updated => renderEntryTemplate(template, { ...values, ...scenarioEntryValues(updated) }),
  }
}
