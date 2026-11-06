/**
 * vue-vite / vue-cli 共用的影响分析（方案 §5.2；R3 计划 R3-4）。由 Host 在只读阶段调用，不执行项目代码。
 *
 * 流程：
 *   1. buildModuleGraph(appRoot)（全量、有界；向上追溯需要完整 importers 反向图）
 *   2. readRouteMap(appRoot, 入口, graph)；入口沿用 preflight 的推断（runtime.entry 优先）
 *   3. 对每个改动：reachableImporters → 命中路由组件 → page 级边（selector: file + 路由导航上下文）；
 *      改动本身是 .vue/.tsx 等模块且未到达任何路由 → component 级边（selector: file）
 *   4. 证据强度：改动即路由组件 = strong；经 import 链到达路由组件 = strong（链唯一）/ medium（共享，多页面）；
 *      非路由模块自身改动仍是可直接打开的 file 目标 = strong（component 级）
 *   5. 非前端文件（不在图中、扩展名不属于前端源/样式/资源）→ unrelated
 *
 * 注意：Candidate 的 file selector 必须能直接交给 page_preview_open（路径相对应用根，与 resolveTarget 规则一致）。
 * 已删除的文件不产生打开候选（selector 无法解析）；删除事实仍保留在 ImpactResult.changes 里供触发层使用。
 */

import type { AdapterContext } from '../../types.ts'
import type { FileChange } from '../../../core/change/baseline.ts'
import type { AdapterImpact, ImpactEdge } from '../../../core/impact/types.ts'
import { resolveProjectPath } from '../../../shared/config/paths.ts'
import { detectVueApp } from '../detect.ts'
import { buildModuleGraph, brokenImporters, reachableImporters } from './module-graph.ts'
import { readRouteMap } from './route-map.ts'

const MODULE_TARGET = /\.(?:vue|[cm]?[jt]sx?)$/i
const STYLE_TARGET = /\.(?:css|scss|sass|less|styl)$/i
const ASSET_TARGET = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|json|ya?ml|txt|wasm)$/i

export async function impactVue(ctx: AdapterContext, changes: readonly FileChange[]): Promise<AdapterImpact> {
  const edges: ImpactEdge[] = []
  const gaps: string[] = []
  const unrelated: string[] = []
  const graph = await buildModuleGraph(ctx.appRoot)
  gaps.push(...graph.gaps)
  // 入口：runtime.entry 优先（显式声明）；否则复用只读检测的推断（不执行构建配置）。
  let entry: string | undefined
  if (ctx.config.project.runtime.entry !== undefined) {
    try {
      entry = await resolveProjectPath(ctx.appRoot, ctx.config.project.runtime.entry,
        ctx.config.project.runtime.dependencyRoots)
    } catch { gaps.push('runtime.entry could not be resolved for impact analysis') }
  } else {
    try {
      entry = (await detectVueApp(ctx.appRoot, { workspaceRoot: ctx.workspaceRoot }))?.entry
    } catch { gaps.push('Vue app detection failed; the entry could not be inferred for impact analysis') }
  }
  const routeMap = await readRouteMap(ctx.appRoot, entry, graph)
  gaps.push(...routeMap.gaps)
  const pagePaths = new Map<string, string[]>() // 路由组件（应用根相对）→ 其路由 path 列表
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
    // 命中路由组件：rel 自身或可达 importer 是页面组件。
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
    if (pageHits.length) continue // 已产出页面边；同一改动不再重复产 component 边。
    if (change.kind === 'deleted') {
      // 已删除的文件不能作为打开目标，但引用它的 importer 还在（断链记在 graph.broken）：
      // 被删组件影响的页面/组件仍受影响——依赖事实静态确定，证据如实降为 medium。
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
    // 共享样式/资源未到达路由：把可达的组件模块作为候选（rank 做代表页截断）。
    const termini = [...reached.keys()]
      .filter(file => MODULE_TARGET.test(file) && file !== rel)
      .sort((a, b) => reached.get(a)!.length - reached.get(b)!.length || a.localeCompare(b))
    // 不产生任何边的改动与页面无关（如无引用的资源、构建产物）。
    if (!termini.length) { unrelated.push(rel); continue }
    for (const file of termini)
      edges.push({ changed: rel, selector: { kind: 'file', path: file },
        relation: reached.get(file)!, evidence: 'medium', scope: 'component' })
  }
  return { edges, gaps, unrelated, manualOnly: false }
}
