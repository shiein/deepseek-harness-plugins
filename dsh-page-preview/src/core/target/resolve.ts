/**
 * 目标选择器解析（方案 §4.2、§5.2）。
 * - registered / story ID 属于具体应用；无 projectId 且有同名候选 → 歧义，不取第一个
 * - file 路径：有 projectId 时相对应用根，否则相对工作区；不尝试多个基准后挑能存在的
 * - route 必须归属某应用；动态路由需具体参数
 * - url 仅限已配置的本地预览来源
 * - 文件无默认导出时不强行按默认组件加载
 */

import type { Candidate, Scope, TargetSelector } from '../../shared/contracts.ts'
import { stat, realpath } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import { targetSelectorSchema } from '../../shared/plan-schema.ts'
import { fingerprintJson } from '../../shared/fingerprint.ts'
import { canonicalPath, resolveProjectPath } from '../../shared/config/paths.ts'
import { localRoute, loopbackUrl, matchesRoute } from '../../shared/route.ts'
import type { EffectiveProjectConfig } from '../../shared/config/loader.ts'
import type { TargetConfig } from '../../shared/config/schema.ts'

export interface ResolvedTarget {
  projectId: string
  targetId: string
  selector: TargetSelector
  scope: Scope
  /** 绝对路径，按适配器实际情况提供。 */
  sourceFiles?: string[]
  route?: { path: string; params?: Record<string, string>; query?: Record<string, string> }
}

export type ResolveOutcome =
  | { kind: 'resolved'; target: ResolvedTarget }
  | { kind: 'ambiguous'; candidates: Candidate[] }
  | { kind: 'not-found'; reason: string }

/** 真实路径核对需要异步 IO；只读元数据，目标 ID 优先配置，否则由规范选择器稳定派生。 */
export async function resolveTarget(
  selector: TargetSelector,
  projects: EffectiveProjectConfig[],
  workspaceRoot: string,
  projectId?: string,
): Promise<ResolveOutcome> {
  const parsed = parseSelector(selector)
  if ('error' in parsed) return { kind: 'not-found', reason: parsed.error }
  selector = parsed
  const workspace = await realpath(workspaceRoot)
  const available = projectId === undefined ? projects : projects.filter(value => value.project.id === projectId)
  if (!available.length) return { kind: 'not-found', reason: 'No matching configured application' }
  const exact: ResolvedTarget[] = [], inferred: ResolvedTarget[] = []
  const declarations: Candidate[] = []
  const declare = (config: EffectiveProjectConfig, definition: TargetConfig) => declarations.push({ projectId: config.project.id, selector: { kind: 'registered', id: definition.id }, relation: ['Explicit target mapping'], evidence: 'strong' })
  const requestedFile = selector.kind === 'file' && projectId === undefined ? await canonicalPath(resolve(workspace, selector.path)) : undefined
  let requestedRoute: URL | undefined
  if (selector.kind === 'route') {
    try { requestedRoute = localRoute(selector) }
    catch { return { kind: 'not-found', reason: 'A concrete local route and all required parameters are needed' } }
  }
  for (const config of available) {
    const appRoot = await resolveProjectPath(workspace, config.project.root)
    const targets = config.project.targets ?? []
    const make = async (definition: TargetConfig): Promise<ResolvedTarget | undefined> => {
      const selected = definition.selector
      if ('error' in parseSelector(selected)) return undefined
      let file: string | undefined
      if (selected.kind === 'file') {
        file = await resolveProjectPath(appRoot, selected.path, config.project.runtime.dependencyRoots)
        if (!await sourceExists(file)) return undefined
      }
      if (selected.kind === 'url' && !sameConfiguredOrigin(selected.url, config)) return undefined
      return { projectId: config.project.id, targetId: definition.id, selector: structuredClone(selected), scope: definition.scope ?? 'page', ...(file ? { sourceFiles: [file] } : {}), ...(definition.route ? { route: structuredClone(definition.route) } : {}) }
    }
    if (selector.kind === 'registered') {
      const definition = targets.find(value => value.id === selector.id)
      if (definition) declare(config, definition)
      const selected = definition ? await make(definition) : undefined
      if (selected) exact.push(selected)
      continue
    }
    if (selector.kind === 'file') {
      let file: string
      if (requestedFile !== undefined) {
        // 先确定唯一工作区基准，再检查其是否属于该应用/声明依赖根；不按应用重试输入路径。
        try { file = await resolveProjectPath(appRoot, relative(appRoot, requestedFile) || '.', config.project.runtime.dependencyRoots) }
        catch (error) {
          if (error instanceof Error && error.message === 'Configured path is outside application and dependency roots') continue
          throw error
        }
      } else file = await resolveProjectPath(appRoot, selector.path, config.project.runtime.dependencyRoots)
      if (!await sourceExists(file)) continue
      const scoped: TargetSelector = { ...selector, path: relative(appRoot, file) }
      for (const definition of targets) if (definition.selector.kind === 'file' && definition.selector.exportName === selector.exportName) {
        const configured = await resolveProjectPath(appRoot, definition.selector.path, config.project.runtime.dependencyRoots)
        if (configured === file) {
          declare(config, definition)
          const selected = await make(definition)
          if (selected) exact.push(selected)
        }
      }
      inferred.push({ projectId: config.project.id, targetId: derivedId(scoped), selector: scoped, scope: 'page', sourceFiles: [file] })
      continue
    }
    if (selector.kind === 'url' && !sameConfiguredOrigin(selector.url, config)) continue
    for (const definition of targets) {
      const selected = definition.selector
      const route = selected.kind === 'route' ? selected : definition.route
      const matched = selector.kind === 'route' ? route && requestedRoute && matchesRoute(route.path, requestedRoute)
        : selector.kind === 'story' ? selected.kind === 'story' && selected.id === selector.id
        : selected.kind === 'url' && new URL(selected.url).href === new URL(selector.url).href
      if (matched) {
        declare(config, definition)
        const value = await make(definition)
        if (value) {
          if (selector.kind === 'route') {
            value.route = { path: selector.path, ...(selector.params ? { params: { ...selector.params } } : {}), ...(selector.query ? { query: { ...selector.query } } : {}) }
            if (value.selector.kind === 'route') value.selector = structuredClone(selector)
          }
          exact.push(value)
        }
      }
    }
    if (selector.kind !== 'story' || projectId !== undefined) inferred.push({ projectId: config.project.id, targetId: derivedId(selector), selector: structuredClone(selector), scope: 'page' })
  }
  // 绑定歧义独立于运行可行性；一个坏目标不能让另一个应用被静默选中。
  if (declarations.length > 1) return { kind: 'ambiguous', candidates: declarations }
  const matches = declarations.length ? exact : inferred
  if (matches.length === 1) return { kind: 'resolved', target: matches[0]! }
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches.map(value => ({ projectId: value.projectId, selector: exact.length ? { kind: 'registered', id: value.targetId } : structuredClone(value.selector), relation: [exact.length ? 'Explicit target mapping' : 'Application owns the requested selector'], evidence: exact.length ? 'strong' : 'medium' })) }
  return { kind: 'not-found', reason: declarations.length ? 'The configured target mapping could not be resolved' : 'No existing target in the selected application and allowed path/origin range' }
}

/** 工具边界复用 IPC 选择器结构，语义错误只给约束，不回显输入值。 */
export function parseSelector(raw: unknown): TargetSelector | { error: string } {
  const result = targetSelectorSchema.safeParse(raw)
  if (!result.success) return { error: 'Expected exactly one valid registered/file/route/story/url selector' }
  const selector = result.data
  if (selector.kind === 'file' && (/^[\\/]|^[A-Za-z]:|^[\w+.-]+:\/\//.test(selector.path) || !selector.path.trim())) return { error: 'File selector paths must be relative to their declared base' }
  if (selector.kind === 'route' && (!selector.path.startsWith('/') || selector.path.startsWith('//') || /[\\\0\r\n]/.test(selector.path))) return { error: 'Route selectors require a local absolute path' }
  if (selector.kind === 'url') {
    try { if (!loopbackUrl(selector.url)) return { error: 'URL selectors require an HTTP(S) loopback URL without credentials' } }
    catch { return { error: 'Invalid local URL selector' } }
  }
  return selector
}

function derivedId(selector: TargetSelector): string { return selector.kind + '-' + fingerprintJson(selector).slice(0, 24) }
async function sourceExists(file: string): Promise<boolean> {
  if (/^\.env(?:\.|$)/.test(basename(file))) return false
  try { return (await stat(file)).isFile() }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}
function sameConfiguredOrigin(value: string, config: EffectiveProjectConfig): boolean {
  const url = loopbackUrl(value)
  return Boolean(url && config.project.runtime.origin && url.origin === new URL(config.project.runtime.origin).origin)
}
