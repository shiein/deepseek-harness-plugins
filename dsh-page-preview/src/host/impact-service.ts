/**
 * Host 侧影响分析服务（方案 §5.2、§5.3、§9.1；R3 计划 R3-4）。
 *
 * 职责：
 *   - 每个 DSH 会话一份轮次状态：turn/start 时的 Baseline、本轮 agent-confirmed 路径、最近一次 ImpactResult
 *   - analyzeNow(sessionId)：在轮次进行中按需分析（Agent 写完文件后、未指定 target 调用 open 时用），
 *     与 turn/end 的分析走同一路径，结果缓存到下一次 turn/start
 *   - 组装 ImpactProject（loadWorkspaceProjects + adapters/registry 的 adapter.impact），注入 core/impact/analyzer
 *
 * 边界：
 *   - 只读：只调用适配器的 impact（与 probe/discover/plan 同级），绝不调用 start（AGENTS.md §6.3）
 *   - 工作区归属以 session.header.cwd 为准（与现有工具一致），不随有效 cd 漂移
 *   - 重放事件（会话恢复时）不重建基线或触发分析：锁定版本类型定义写明"seed events never publish
 *     on session/event"，即 ctx.on('session/event') 收到的都是 live 追加；重放历史天然不可达此路径
 *   - 内存态，不落盘；Host 重启后第一轮没有基线时如实返回 degraded，不用 mtime 猜本轮改动
 */

import { relative, sep } from 'node:path'
import type { Adapter, AdapterContext } from '../adapters/types.ts'
import { adapters } from '../adapters/registry.ts'
import { analyzeImpact } from '../core/impact/analyzer.ts'
import type { AdapterImpact, ImpactProject, ImpactResult } from '../core/impact/types.ts'
import { createBaseline, diffBaseline } from '../core/change/baseline.ts'
import type { Baseline, FileChange } from '../core/change/baseline.ts'
import { canonicalPath, isWithinRoot, resolveProjectPath } from '../shared/config/paths.ts'
import { loadWorkspaceProjects } from '../shared/config/projects.ts'
import type { WorkspaceProject } from '../shared/config/projects.ts'
import type { EffectiveProjectConfig } from '../shared/config/loader.ts'

export interface TurnImpactState {
  workspaceRoot: string
  /** 基线建立时间（epoch ms）；无基线时缺失。 */
  baselineAt?: number
  agentConfirmed: Set<string>
  last?: ImpactResult
}

interface Prepared {
  baseline?: Baseline
  projects: WorkspaceProject[]
  /** 全部配置应用的工作区相对根（含无 impact 能力的适配器项目；R3-5 预览通知判定用）。 */
  apps: Map<string, string>
  degraded: string[]
}

interface PreparedTurn {
  workspaceRoot: string
  /** 基线与项目画像的建立中 promise；analyzeNow 先等它再 diff。 */
  prepared: Promise<Prepared>
  agentConfirmed: Set<string>
  last?: ImpactResult
}

export interface ImpactServiceOptions {
  dataDir?: string
  /** 代表页上限（§5.2 默认 3）。 */
  maxCandidates?: number
}

const MANUAL_ONLY: AdapterImpact = { edges: [], gaps: [], unrelated: [], manualOnly: true }

export class ImpactService {
  private readonly states = new Map<string, PreparedTurn>()
  private readonly options: ImpactServiceOptions

  constructor(options: ImpactServiceOptions = {}) {
    this.options = options
  }

  /** turn/start：建立基线、清空 agent-confirmed 与上次结果。失败只记入本轮 degraded，不抛给事件分发。 */
  async beginTurn(sessionId: string, workspaceRoot: string): Promise<void> {
    const turn: PreparedTurn = {
      workspaceRoot,
      prepared: this.prepare(workspaceRoot),
      agentConfirmed: new Set(),
    }
    this.states.set(sessionId, turn)
    // 提前结算（prepare 内部不抛，这里只等待就绪），避免 analyzeNow 时才暴露失败。
    await turn.prepared
  }

  /** tools/result：记录 agent-confirmed 路径（core/change/agent-writes.ts 已过滤为工作区内绝对路径）。 */
  recordAgentWrites(sessionId: string, paths: readonly string[]): void {
    const state = this.states.get(sessionId)
    if (!state) return
    for (const path of paths) state.agentConfirmed.add(path)
  }

  /** 按需分析当前轮次；没有基线/状态或分析失败时如实返回 degraded 结果，不抛错。 */
  async analyzeNow(sessionId: string): Promise<ImpactResult> {
    const empty = (degraded: string[], apps: Map<string, string> = new Map()): ImpactResult =>
      ({ candidates: [], omitted: 0, gaps: [], unrelated: [], changes: [], degraded,
        apps: [...apps].map(([projectId, root]) => ({ projectId, root })) })
    const state = this.states.get(sessionId)
    if (!state) return empty(['No turn baseline is available for this session; ' +
      'impact analysis starts at the next turn boundary'])
    const { baseline, projects, apps, degraded } = await state.prepared
    if (!baseline) return empty(degraded, apps)
    let diff: { changes: FileChange[], degraded: string[] }
    try { diff = await diffBaseline(baseline, state.agentConfirmed) }
    catch (error) {
      return empty([...degraded, 'Workspace diff failed: '
        + (error instanceof Error ? error.message : String(error))], apps)
    }
    const items = await this.impactProjects(state.workspaceRoot, projects, degraded)
    const result = await analyzeImpact({
      workspaceRoot: state.workspaceRoot,
      changes: diff.changes,
      projects: items.map(item => item.project),
      configs: new Map(items.map(item => [item.project.projectId, item.config])),
      adapterImpact: (project, changes) => this.adapterImpact(items, project, changes),
      maxCandidates: this.options.maxCandidates ?? 3,
      degraded: [...degraded, ...diff.degraded],
    })
    // analyzer 只覆盖 impact 能力对；结果换回全部配置应用的根（R3-5 通知判定）。
    const merged = { ...result, apps: [...apps].map(([projectId, root]) => ({ projectId, root })) }
    state.last = merged
    return merged
  }

  /** 最近一次结果（status/面板读取用），不触发新分析。 */
  latest(sessionId: string): ImpactResult | undefined {
    return this.states.get(sessionId)?.last
  }

  /** 本轮归属的工作区根（R3-5：onTurnAnalyzed 需要它对 RunnerClient 寻址）。 */
  workspaceOf(sessionId: string): string | undefined {
    return this.states.get(sessionId)?.workspaceRoot
  }

  /** 会话结束/插件卸载时释放（session/disposed）。 */
  forget(sessionId: string): void {
    this.states.delete(sessionId)
  }

  /** 基线 + 项目画像；所有失败都降级为 degraded 文本而不是拒绝分析。 */
  private async prepare(workspaceRoot: string): Promise<Prepared> {
    const degraded: string[] = []
    let root: string
    try { root = await canonicalPath(workspaceRoot) }
    catch (error) {
      return { projects: [], apps: new Map(), degraded: ['Workspace root could not be canonicalized: '
        + (error instanceof Error ? error.message : String(error))] }
    }
    let projects: WorkspaceProject[] = []
    try {
      projects = await loadWorkspaceProjects(root, undefined,
        this.options.dataDir === undefined ? {} : { dataDir: this.options.dataDir })
    } catch (error) {
      degraded.push('Workspace project loading failed (' + (error instanceof Error ? error.name : String(error))
        + '); configured targets and adapters were not applied')
    }
    // 显式声明必须纳入的文件/目录：publicRoot（覆盖默认忽略）与登记目标/入口/setup/styles（预哈希）。
    const forceInclude: string[] = []
    const hashPaths: string[] = []
    const workspaceRel = (absolute: string) =>
      isWithinRoot(root, absolute) ? absolute.slice(root.length + 1).split(sep).join('/') : undefined
    const apps = new Map<string, string>()
    for (const { config } of projects) {
      const appRoot = await resolveProjectPath(root, config.project.root).catch(() => undefined)
      if (appRoot === undefined) continue
      // 应用根在工作区之外时改动不可能归属它（changes 全是工作区相对路径），不纳入通知判定。
      if (isWithinRoot(root, appRoot) && !apps.has(config.project.id))
        apps.set(config.project.id, relative(root, appRoot).split(sep).join('/'))
      const resolve = async (path: string) =>
        await resolveProjectPath(appRoot, path, config.project.runtime.dependencyRoots)
          .then(workspaceRel, () => undefined)
      if (config.project.runtime.publicRoot !== undefined) {
        const included = await resolve(config.project.runtime.publicRoot)
        if (included !== undefined) forceInclude.push(included)
      }
      for (const target of config.project.targets ?? [])
        if (target.selector.kind === 'file') {
          const path = await resolve(target.selector.path)
          if (path !== undefined) hashPaths.push(path)
        }
      for (const path of [config.project.runtime.entry, config.project.runtime.setup,
        ...(config.project.runtime.styles ?? [])]) {
        const resolved = path === undefined ? undefined : await resolve(path)
        if (resolved !== undefined) hashPaths.push(resolved)
      }
    }
    let baseline: Baseline | undefined
    try {
      baseline = await createBaseline(root, { forceInclude, hashPaths })
      if (baseline.degraded) degraded.push(baseline.degraded)
      degraded.push(...baseline.ignoreNotes
        .map(note => 'Unsupported .gitignore rule at ' + note + ' was not applied'))
    } catch (error) {
      degraded.push('Baseline creation failed: ' + (error instanceof Error ? error.message : String(error)))
    }
    return { ...(baseline === undefined ? {} : { baseline }), projects, apps, degraded }
  }

  /** 按 projectId 组装适配器对；未声明适配器的项目经 probe 过滤（与 discover 同规则）。 */
  private async impactProjects(workspaceRoot: string, projects: WorkspaceProject[], degraded: string[]) {
    const items: Array<{
      project: ImpactProject, config: EffectiveProjectConfig, ctx: AdapterContext, adapter: Adapter
    }> = []
    for (const { config, profile } of projects) {
      const appRoot = await resolveProjectPath(workspaceRoot, config.project.root).catch(() => undefined)
      if (appRoot === undefined) continue
      const ctx: AdapterContext = { workspaceRoot, appRoot, profile, config }
      const requested = config.project.runtime.adapter
      let added = 0
      for (const adapter of adapters) {
        if (!adapter.impact) continue
        if (requested !== undefined && adapter.id !== requested) continue
        if (requested === undefined) {
          // probe 失败视为不匹配而不是阻断分析。
          const matched = await adapter.probe(ctx).then(value => value.matched, () => false)
          if (!matched) continue
        }
        items.push({ project: { projectId: config.project.id, adapterId: adapter.id, appRoot }, config, ctx, adapter })
        added += 1
      }
      if (requested !== undefined && !added)
        degraded.push('Configured adapter ' + JSON.stringify(requested)
          + ' has no read-only impact analysis; its changes stay manual')
    }
    return items
  }

  private adapterImpact(
    items: Array<{ project: ImpactProject, ctx: AdapterContext, adapter: Adapter }>,
    project: ImpactProject, changes: readonly FileChange[],
  ): Promise<AdapterImpact> {
    const item = items.find(value => value.project === project)
    if (!item?.adapter.impact) return Promise.resolve(MANUAL_ONLY)
    return item.adapter.impact(item.ctx, changes).catch(error => ({
      edges: [], unrelated: [], manualOnly: true,
      gaps: [project.adapterId + ' impact analysis failed: '
        + (error instanceof Error ? error.message : String(error))],
    }))
  }
}
