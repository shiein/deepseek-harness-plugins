/**
 * 变更 → 受影响预览目标（方案 §5.2、§5.3；R3 计划 R3-4）。
 * 发现顺序：显式配置 → 已有预览入口 → 已验证路由/构建入口 → 适配器依赖关系 → 目录命名启发式 → Agent 建议。
 * 触发取决于是否有受影响目标，不取决于后缀；无页面关系的后端/SQL/文档变更不自动打开。
 * 共享样式/布局/资源改动默认推荐 1～3 个代表页面（rank.ts）。
 *
 * 只读：不执行项目代码；适配器边由 Host 注入的 AdapterImpactFn 提供（core 不 import adapters/registry）。
 */

import { isAbsolute, join, relative, sep } from 'node:path'
import type { Candidate, ChangeOrigin } from '../../shared/contracts.ts'
import type { EffectiveProjectConfig } from '../../shared/config/loader.ts'
import { fingerprintJson } from '../../shared/fingerprint.ts'
import { isWithinRoot } from '../../shared/config/paths.ts'
import type { FileChange } from '../change/baseline.ts'
import { rankCandidates } from './rank.ts'
import type { AdapterImpactFn, ImpactEdge, ImpactProject, ImpactResult } from './types.ts'

export type { ImpactResult } from './types.ts'

export interface AnalyzeImpactInput {
  /** 工作区根（绝对路径）；FileChange.path 相对它解析。 */
  workspaceRoot: string
  changes: readonly FileChange[]
  /** 已识别的应用（含 adapterId 与绝对 appRoot）；改动按 appRoot 归属，最长前缀优先，不跨应用猜测。 */
  projects: readonly ImpactProject[]
  /** 项目配置，用于第一优先级"显式登记目标"匹配（targets[].selector.kind === 'file'）。 */
  configs: ReadonlyMap<string, EffectiveProjectConfig>
  adapterImpact: AdapterImpactFn
  /** 代表页上限，默认 3（§5.2）。 */
  maxCandidates?: number
  /** 基线降级、预算耗尽等说明；原样进入结果。 */
  degraded?: string[]
}

const EVIDENCE_RANK: Record<Candidate['evidence'], number> = { strong: 0, medium: 1, weak: 2 }
const stronger = (a: ImpactEdge, b: ImpactEdge) =>
  (EVIDENCE_RANK[a.evidence] - EVIDENCE_RANK[b.evidence]) || (a.relation.length - b.relation.length)
const toAppRelative = (appRoot: string, absolute: string) => relative(appRoot, absolute).split(sep).join('/')
const toAbsolute = (root: string, rel: string) => join(root, rel.split('/').join(sep))

export async function analyzeImpact(input: AnalyzeImpactInput): Promise<ImpactResult> {
  const unrelated: string[] = []
  const gaps: string[] = []
  const edges: Array<{ projectId: string, edge: ImpactEdge }> = []
  const origins = new Map<string, ChangeOrigin>()
  // 改动按 appRoot 归属（最长前缀优先）；不归属任何应用的进 unrelated。同一文件可能被多个
  // 应用/适配器对认领（配置应用根重叠时），每个归属各自分析。
  const perProject = new Map<ImpactProject, FileChange[]>()
  for (const change of input.changes) {
    const absolute = join(input.workspaceRoot, change.path.split('/').join(sep))
    const owners = input.projects
      .filter(project => isWithinRoot(project.appRoot, absolute))
      .sort((a, b) => b.appRoot.length - a.appRoot.length)
    const owner = owners[0]
    if (!owner) { unrelated.push(change.path); continue }
    const appChange: FileChange = { ...change, path: toAppRelative(owner.appRoot, absolute) }
    // 同一 appRoot 的多个适配器对各自收到同一份改动；登记目标命中在下方按 projectId 去重。
    for (const project of owners.filter(value => value.appRoot === owner.appRoot)) {
      origins.set(project.projectId + '\x00' + appChange.path, change.origin)
      const list = perProject.get(project) ?? []
      list.push(appChange)
      perProject.set(project, list)
    }
  }
  const registeredHitPaths = new Map<string, Set<string>>()
  const registeredDone = new Set<string>()
  for (const [project, changes] of perProject) {
    // 显式登记目标直接命中 → strong，不经适配器；同一 projectId 只匹配一次。
    const config = input.configs.get(project.projectId)
    const registered = new Map((config?.project.targets ?? [])
      .filter(target => target.selector.kind === 'file')
      .map(target => [(target.selector as { kind: 'file'; path: string }).path, target]))
    for (const change of changes) {
      const target = registeredDone.has(project.projectId) ? undefined : registered.get(change.path)
      if (!target) continue
      const hits = registeredHitPaths.get(project.projectId) ?? new Set<string>()
      hits.add(change.path)
      registeredHitPaths.set(project.projectId, hits)
      edges.push({
        projectId: project.projectId,
        edge: {
          changed: change.path, selector: { kind: 'registered', id: target.id },
          relation: [change.path, 'registered target ' + target.id], evidence: 'strong',
          scope: target.scope === 'component' ? 'component' : 'page',
        },
      })
    }
    registeredDone.add(project.projectId)
    const impact = await input.adapterImpact(project, changes)
    for (const edge of impact.edges) edges.push({ projectId: project.projectId, edge })
    gaps.push(...impact.gaps.map(gap => project.adapterId + ': ' + gap))
    if (impact.manualOnly) gaps.push(project.adapterId + ' returned manual-only impact analysis')
    for (const path of impact.unrelated) {
      const workspaceRel = relative(input.workspaceRoot, toAbsolute(project.appRoot, path))
      unrelated.push(isAbsolute(workspaceRel) || workspaceRel.startsWith('..')
        ? project.projectId + ':' + path : workspaceRel.split(sep).join('/'))
    }
  }
  // 合并去重：同一 projectId+selector 保留最强证据与最短关系链；登记目标直接命中时丢弃同文件的 file 边。
  const merged = new Map<string, { projectId: string, edge: ImpactEdge }>()
  for (const { projectId, edge } of edges) {
    if (edge.selector.kind === 'file' && registeredHitPaths.get(projectId)?.has(edge.selector.path)) continue
    const key = projectId + '\x00' + fingerprintJson(edge.selector)
    const existing = merged.get(key)
    if (!existing || stronger(edge, existing.edge) < 0) merged.set(key, { projectId, edge })
  }
  const candidates: Candidate[] = [...merged.values()].map(({ projectId, edge }) => ({
    projectId, selector: edge.selector, relation: edge.relation, evidence: edge.evidence,
    origin: origins.get(projectId + '\x00' + edge.changed) ?? 'unknown',
  }))
  const ranked = rankCandidates(candidates, input.maxCandidates ?? 3)
  // apps 按 projectId 去重为工作区相对根（'' 即工作区根本身是应用根）；Host 用它判定受影响预览。
  const apps = new Map<string, string>()
  for (const project of input.projects) {
    if (apps.has(project.projectId)) continue
    apps.set(project.projectId, toAppRelative(input.workspaceRoot, project.appRoot))
  }
  return {
    candidates: ranked.candidates, omitted: ranked.omitted, gaps, unrelated: [...new Set(unrelated)].sort(),
    changes: input.changes.map(change => ({ path: change.path, kind: change.kind, origin: change.origin })),
    apps: [...apps].map(([projectId, root]) => ({ projectId, root })),
    degraded: [...(input.degraded ?? [])],
  }
}
