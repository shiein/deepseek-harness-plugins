/**
 * Vue 应用的只读模块依赖图（方案 §5.2；R3-4）。机制在 adapters/shared/module-graph.ts，
 * 这里只提供 Vue 钩子：.vue 进脚本判定与解析候选、SFC 块经 shared/vue-sfc.ts 展开、
 * 构建别名经 readVueBuildConfig 读取。
 */
import { parseVueSfc } from '../../../shared/vue-sfc.ts'
import { readVueBuildConfig } from '../readonly-config.ts'
import { buildModuleGraph as buildSharedGraph, brokenImporters as sharedBrokenImporters,
  resolveModuleSpecifier as sharedResolve } from '../../shared/module-graph.ts'
import type { ModuleGraphHooks, ModuleGraphOptions, SpecifierResolution } from '../../shared/module-graph.ts'
import type { ReadonlyBuildConfig } from '../readonly-config.ts'

export type { ModuleGraph, ModuleGraphOptions, SpecifierResolution } from '../../shared/module-graph.ts'

const VUE_SCRIPT_EXT = /\.(?:vue|[cm]?[jt]sx?)$/i
const VUE_RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.vue', '.json',
  '.css', '.scss', '.sass', '.less', '.styl']
const STYLE_IMPORT = /@(?:import|use|forward)\s+['"]([^'"]+)['"]/g

const hooks: ModuleGraphHooks = {
  scriptExt: VUE_SCRIPT_EXT,
  resolveExts: VUE_RESOLVE_EXTS,
  scriptGap: 'script block',
  readConfig: appRoot => readVueBuildConfig(appRoot),
  expandFile(emit, rel, source) {
    if (!/\.vue$/i.test(rel)) return false
    const sfc = parseVueSfc(source)
    for (const issue of sfc.unresolved) emit.gap(rel + ': ' + issue)
    for (const block of sfc.scripts) {
      if (block.src) emit.relative(block.src)
      else emit.script(rel + '.script.' + (block.lang === 'ts' ? 'ts' : 'js'), block.source)
    }
    for (const block of sfc.styles) {
      if (block.src) emit.relative(block.src)
      else for (const match of block.source.matchAll(STYLE_IMPORT)) emit.relative(match[1]!)
    }
    return true
  },
}

export function buildModuleGraph(appRoot: string, options: ModuleGraphOptions = {}) {
  return buildSharedGraph(appRoot, hooks, options)
}

/** 供 route-map 等消费者复用的统一说明符解析（与 Vue 图同一扩展名候选）。 */
export function resolveModuleSpecifier(appRoot: string, fromRel: string, specifier: string,
  files: ReadonlySet<string>, config: Pick<ReadonlyBuildConfig, 'aliases' | 'opaqueAliases'>)
  : SpecifierResolution {
  return sharedResolve(appRoot, fromRel, specifier, files, config, VUE_RESOLVE_EXTS)
}

/** 断链说明符指向 deletedRel 的 importer 列表（与 Vue 图同一扩展名候选）。 */
export function brokenImporters(graph: import('../../shared/module-graph.ts').ModuleGraph,
  deletedRel: string): string[] {
  return sharedBrokenImporters(graph, deletedRel, VUE_RESOLVE_EXTS)
}

export { reachableImporters } from '../../shared/module-graph.ts'
