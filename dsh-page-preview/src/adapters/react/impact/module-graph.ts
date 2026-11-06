/**
 * React 应用的只读模块依赖图（方案 §5.2；R5-7）。机制在 adapters/shared/module-graph.ts，
 * 这里只提供 React 钩子：JS/TS/JSX/TSX 脚本判定与解析候选、构建别名经 readReactBuildConfig
 * 读取；无 .vue SFC 分支。
 */
import { readReactBuildConfig } from '../readonly-config.ts'
import { buildModuleGraph as buildSharedGraph, brokenImporters as sharedBrokenImporters,
  resolveModuleSpecifier as sharedResolve } from '../../shared/module-graph.ts'
import type { ModuleGraphHooks, ModuleGraphOptions, SpecifierResolution } from '../../shared/module-graph.ts'
import type { ReadonlyBuildConfig } from '../readonly-config.ts'

export type { ModuleGraph, ModuleGraphOptions, SpecifierResolution } from '../../shared/module-graph.ts'

const REACT_SCRIPT_EXT = /\.[cm]?[jt]sx?$/i
const REACT_RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json',
  '.css', '.scss', '.sass', '.less', '.styl']

const hooks: ModuleGraphHooks = {
  scriptExt: REACT_SCRIPT_EXT,
  resolveExts: REACT_RESOLVE_EXTS,
  scriptGap: 'script',
  readConfig: appRoot => readReactBuildConfig(appRoot),
}

export function buildModuleGraph(appRoot: string, options: ModuleGraphOptions = {}) {
  return buildSharedGraph(appRoot, hooks, options)
}

/** 供 route-map 等消费者复用的统一说明符解析（与 React 图同一扩展名候选）。 */
export function resolveModuleSpecifier(appRoot: string, fromRel: string, specifier: string,
  files: ReadonlySet<string>, config: Pick<ReadonlyBuildConfig, 'aliases' | 'opaqueAliases'>)
  : SpecifierResolution {
  return sharedResolve(appRoot, fromRel, specifier, files, config, REACT_RESOLVE_EXTS)
}

/** 断链说明符指向 deletedRel 的 importer 列表（与 React 图同一扩展名候选）。 */
export function brokenImporters(graph: import('../../shared/module-graph.ts').ModuleGraph,
  deletedRel: string): string[] {
  return sharedBrokenImporters(graph, deletedRel, REACT_RESOLVE_EXTS)
}

export { reachableImporters } from '../../shared/module-graph.ts'
