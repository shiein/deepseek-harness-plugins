/**
 * react-vite 的影响分析（方案 §5.2；R5-7）。由 Host 在只读阶段调用，不执行项目代码。
 * 流程与 Vue 版一致：buildModuleGraph → readRouteMap → reachableImporters 与路由/登记目标求交；
 * 模块扩展名域为 .js/.jsx/.ts/.tsx（无 .vue）。
 */
import type { AdapterContext } from '../../types.ts'
import type { FileChange } from '../../../core/change/baseline.ts'
import type { AdapterImpact, ImpactEdge } from '../../../core/impact/types.ts'
import { resolveProjectPath } from '../../../shared/config/paths.ts'
import { detectReactApp } from '../detect.ts'
import { buildModuleGraph, brokenImporters, reachableImporters } from './module-graph.ts'
import { readRouteMap } from './route-map.ts'

const MODULE_TARGET = /\.[cm]?[jt]sx?$/i
const STYLE_TARGET = /\.(?:css|scss|sass|less|styl)$/i
const ASSET_TARGET = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|json|ya?ml|txt|wasm)$/i

export async function impactReact(ctx: AdapterContext, changes: readonly FileChange[]): Promise<AdapterImpact> {
  const edges: ImpactEdge[] = []
  const gaps: string[] = []
  const unrelated: string[] = []
  const graph = await buildModuleGraph(ctx.appRoot)
  gaps.push(...graph.gaps)
  let entry: string | undefined
  if (ctx.config.project.runtime.entry !== undefined) {
    try {
      entry = await resolveProjectPath(ctx.appRoot, ctx.config.project.runtime.entry,
        ctx.config.project.runtime.dependencyRoots)
    } catch { gaps.push('runtime.entry could not be resolved for impact analysis') }
  } else {
    try {
      entry = (await detectReactApp(ctx.appRoot, { workspaceRoot: ctx.workspaceRoot }))?.entry
    } catch { gaps.push('React app detection failed; the entry could not be inferred for impact analysis') }
  }
  const routeMap = await readRouteMap(ctx.appRoot, entry, graph)
  gaps.push(...routeMap.gaps)
  const pagePaths = new Map<string, string[]>()
  for (const route of routeMap.routes) {
    const list = pagePaths.get(route.component) ?? []
    list.push(route.path)
    pagePaths.set(route.component, list)
  }
  for (const list of pagePaths.values()) list.sort()

  for (const change of changes) {
    const rel = change.path
    const inGraph = graph.files.has(rel)
    const frontendLike = MODULE_TARGET.test(rel) || STYLE_TARGET.test(rel) || ASSET_TARGET.test(rel)
    if (!inGraph && !frontendLike) { unrelated.push(rel); continue }
    const reached = reachableImporters(graph, rel)
    const pageHits = [...reached.keys()].filter(file => pagePaths.has(file))
      .sort((a, b) => reached.get(a)!.length - reached.get(b)!.length || a.localeCompare(b))
    const evidence = (hit: string): ImpactEdge['evidence'] =>
      hit === rel || pageHits.length === 1 ? 'strong' : 'medium'
    for (const hit of pageHits) {
      const chain = reached.get(hit)!
      const relation = [...chain, ...pagePaths.get(hit)!.map(path => 'route ' + path)]
      edges.push({ changed: rel, selector: { kind: 'file', path: hit }, relation,
        evidence: evidence(hit), scope: 'page' })
    }
    if (pageHits.length) continue
    if (change.kind === 'deleted') {
      let produced = false
      for (const importer of brokenImporters(graph, rel)) {
        const up = reachableImporters(graph, importer)
        const hits = [...up.keys()].filter(file => pagePaths.has(file))
          .sort((a, b) => up.get(a)!.length - up.get(b)!.length || a.localeCompare(b))
        if (!hits.length && MODULE_TARGET.test(importer)) {
          edges.push({ changed: rel, selector: { kind: 'file', path: importer },
            relation: [rel, importer], evidence: 'medium', scope: 'component' })
          produced = true
          continue
        }
        for (const hit of hits)
          edges.push({ changed: rel, selector: { kind: 'file', path: hit },
            relation: [rel, ...up.get(hit)!, ...pagePaths.get(hit)!.map(path => 'route ' + path)],
            evidence: 'medium', scope: 'page' })
        produced = produced || hits.length > 0
      }
      if (!produced) unrelated.push(rel)
      continue
    }
    if (MODULE_TARGET.test(rel)) {
      edges.push({ changed: rel, selector: { kind: 'file', path: rel },
        relation: [rel], evidence: 'strong', scope: 'component' })
      continue
    }
    const termini = [...reached.keys()]
      .filter(file => MODULE_TARGET.test(file) && file !== rel)
      .sort((a, b) => reached.get(a)!.length - reached.get(b)!.length || a.localeCompare(b))
    if (!termini.length) { unrelated.push(rel); continue }
    for (const file of termini)
      edges.push({ changed: rel, selector: { kind: 'file', path: file },
        relation: reached.get(file)!, evidence: 'medium', scope: 'component' })
  }
  return { edges, gaps, unrelated, manualOnly: false }
}
