/** Vite 自有预览入口（方案 §6.3、§6.5）；只生成加载真实目标的脚手架，业务文件保持原路径/内容。 */
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { documentShell } from '../../../shared/html.ts'
import { readProjectText } from '../../../shared/profile.ts'
import { readVueBuildConfig } from '../readonly-config.ts'
import { resolveProjectPath } from '../../../shared/config/paths.ts'
import { localRoute } from '../../../shared/route.ts'
import type { ViteWorkerInput } from './protocol.ts'
import type { ScenarioConfig } from '../../../shared/config/schema.ts'
import { VITE_VIRTUAL_PREFIX, viteVirtualUrl } from './protocol.ts'
import { verifiedGeneratedSetup } from '../generated-setup.ts'
import { entryModuleLang, viteResolvableImport } from '../../vite/paths.ts'

export const jsonSource = (value: unknown) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
// Vite import analysis consumes filesystem IDs, not pre-encoded request URLs.
export const viteFsImport = (file: string) => '/@fs/' + file.replace(/\\/g, '/').replace(/^\//, '')
/** R5-4：父布局渲染的宿主组件——挂载 router-view 由项目路由把整条静态父链渲染出来；
 * 叶子组件仍经 setup.navigate 推送到具体路由。CLI 侧把同一份源写进临时目录复用。 */
export const vueRouteRootModule = (family: '2' | '3') => family === '3'
  ? 'import { h, resolveComponent } from "vue"\n'
    + 'export default { name: "DshPreviewRouteRoot", render: function () {'
    + ' return h(resolveComponent("RouterView")) } }\n'
  : 'export default { name: "DshPreviewRouteRoot", render: function (h) { return h("router-view") } }\n'
/** 场景数据进入预览入口的两个占位键；CLI worker 共用（方案 §7.4、§6.9）。 */
export function scenarioEntryValues(scene: ScenarioConfig | undefined):
  Record<'__SCENARIO_JSON__' | '__PROPS_JSON__', string> {
  const data = scene === undefined ? undefined
    : Object.fromEntries((['identity', 'permissions', 'state', 'props', 'route', 'locale'] as const)
      .filter(key => scene[key] !== undefined).map(key => [key, scene[key]]))
  return { __SCENARIO_JSON__: data === undefined ? 'undefined' : jsonSource(data),
    __PROPS_JSON__: jsonSource(scene?.props ?? {}) }
}
/** 按占位键重渲染入口模板；值集合必须覆盖模板里全部占位键。 */
export const renderEntryTemplate = (template: string, values: Record<string, string>) =>
  template.replace(new RegExp(Object.keys(values).join('|'), 'g'), key => values[key]!)
export async function createViteSources(input: ViteWorkerInput): Promise<{
  modules: Map<string, string>
  bootstrap: string
  html: string
  target: string
  exposedFiles: string[]
  setup?: string
  rerenderEntry(scene: ScenarioConfig | undefined): string
  moduleLangs: Map<string, string>
}> {
  const project = input.project
  const scene = input.plan.scenario === undefined ? undefined : project.scenarios?.[input.plan.scenario]
  const requested = input.plan.selector
  const selector = requested.kind === 'registered' ? project.targets?.find(value => value.id === requested.id)?.selector : requested
  if (selector?.kind !== 'file') throw new Error('Vite target must be a concrete module')
  const file = await resolveProjectPath(input.appRoot, selector.path, project.runtime.dependencyRoots)
  const setup = project.runtime.setup ? await resolveProjectPath(input.appRoot, project.runtime.setup, project.runtime.dependencyRoots) : undefined
  const modules = new Map<string, string>()
  const asset = (file: string) => new URL(import.meta.url.endsWith('.ts') ? '../../../browser/' + file : '../../../../browser/' + file, import.meta.url)
  modules.set(VITE_VIRTUAL_PREFIX + 'lifecycle', await readFile(asset('vue/lifecycle.js'), 'utf8'))
  const version = input.plan.toolchain.vue
  const family = version?.startsWith('3.') ? '3' : version?.startsWith('2.6.') || version?.startsWith('2.7.') ? '2' : undefined
  if (!family) throw new Error('Vue runtime version is unresolved')
  modules.set(VITE_VIRTUAL_PREFIX + 'runtime', await readFile(asset(family === '3' ? 'vue/mount-vue3.js' : 'vue/mount-vue2.js'), 'utf8'))
  if (input.plan.layout === true) modules.set(VITE_VIRTUAL_PREFIX + 'route-root', vueRouteRootModule(family))
  // 自动生成的 setup（§0.3 第 10 条）：按计划入口重新生成并核对批准时的摘要，作为虚拟模块加载，不写入项目。
  const generated = !setup && input.plan.generatedSetup
    ? await verifiedGeneratedSetup(input.appRoot, input.plan.generatedSetup, version, viteResolvableImport) : undefined
  if (generated !== undefined) modules.set(VITE_VIRTUAL_PREFIX + 'setup', generated)
  // 生成的 setup 照搬入口导入（含 TS 入口里指向 .ts 的 `.js` 说明符），须按入口语言参与 Vite 解析。
  const moduleLangs = new Map<string, string>()
  const setupLang = generated !== undefined && input.plan.generatedSetup
    ? entryModuleLang(input.plan.generatedSetup.entry) : undefined
  if (setupLang !== undefined) moduleLangs.set(VITE_VIRTUAL_PREFIX + 'setup', setupLang)
  const styles = await Promise.all((project.runtime.styles ?? []).map(path => resolveProjectPath(input.appRoot, path, project.runtime.dependencyRoots)))
  const navigation = input.plan.route ? localRoute(input.plan.route) : undefined
  const values: Record<string, string> = {
    __LIFECYCLE_MODULE__: viteVirtualUrl('lifecycle'), __VUE_MAJOR__: jsonSource(family), __MOUNT_ID__: jsonSource('__dsh_preview_root'),
    ...scenarioEntryValues(scene),
    __TARGET_JSON__: jsonSource({ projectId: input.plan.projectId, targetId: input.plan.targetId }),
    __NAVIGATION_JSON__: navigation ? jsonSource({route: input.plan.route, href: navigation.pathname + navigation.search + navigation.hash}) : 'undefined',
    __EXPORT_NAME__: jsonSource(selector.exportName ?? 'default'), __REQUIRE_MOCK__: jsonSource(input.plan.requirements.includes('mock-only')),
    __RUNTIME_IMPORT__: 'import(' + jsonSource(viteVirtualUrl('runtime')) + ')',
    __SETUP_LOADER__: setup ? 'function () { return import(' + jsonSource(viteFsImport(setup)) + ') }'
      : generated !== undefined ? 'function () { return import(' + jsonSource(viteVirtualUrl('setup')) + ') }' : 'null',
    __TARGET_IMPORT__: input.plan.layout === true
      ? 'import(' + jsonSource(viteVirtualUrl('route-root')) + ')'
      : 'import(' + jsonSource(viteFsImport(file)) + ')',
    __STYLE_IMPORTS__: styles.map(path => 'await import(' + jsonSource(viteFsImport(path)) + ')').join('\n      '),
    // HMR 就地更新没有文档加载：bootstrap 上报 Vite 已应用的更新版本，Runner 据此把 freshness 推进到 current；
    // 与 __DSH_BUILD__ 文档印章互补：重载走 document-loaded，就地更新走 module-updated。仅 Vite 支持 import.meta。
    __VITE_HOT_HOOK__: `if (import.meta.hot) {
  import.meta.hot.on('vite:afterUpdate', function (payload) {
    var updates = payload && payload.updates ? payload.updates : []
    var latest = 0
    for (var index = 0; index < updates.length; index++) {
      var timestamp = updates[index] && updates[index].timestamp
      if (typeof timestamp === 'number' && timestamp > latest) latest = timestamp
    }
    var bridge = window.__DSH_PREVIEW__
    if (latest > 0 && bridge && bridge.report) bridge.report({ kind: 'module-updated', version: String(latest) })
  })
}`,
  }
  const template = await readFile(asset('vue/preview-entry.template.js'), 'utf8')
  modules.set(VITE_VIRTUAL_PREFIX + 'entry', renderEntryTemplate(template, values))
  // 沿用项目 index.html 的 <html>/<body> 属性与内联经典脚本（主题 class、语言、polyfill），不复制模块入口与外链。
  const config = await readVueBuildConfig(input.appRoot, 'vite')
  const indexHtml = await readProjectText(join(config.root ?? input.appRoot, 'index.html'), input.appRoot)
  const shell = indexHtml === undefined ? undefined : documentShell(indexHtml)
  const html = '<!doctype html><html' + (shell?.htmlAttributes ?? '') + '><head><meta charset="utf-8">'
    + (shell?.inlineScripts ?? []).map(code => '<script>' + code + '</script>').join('')
    + '</head><body' + (shell?.bodyAttributes ?? '') + '><div id="__dsh_preview_root"></div><script type="module" src="'
    + viteVirtualUrl('entry') + '"></script></body></html>'
  return {
    modules, moduleLangs, bootstrap: await readFile(asset('bootstrap.js'), 'utf8'), html,
    target: relative(input.appRoot, file),
    exposedFiles: [file, ...(setup ? [setup] : []), ...styles], ...(setup ? { setup } : {}),
    // R3-2：场景更新只重算场景相关占位值，其余入口绑定（目标/setup/样式）不变。
    rerenderEntry: updated => renderEntryTemplate(template, { ...values, ...scenarioEntryValues(updated) }),
  }
}
