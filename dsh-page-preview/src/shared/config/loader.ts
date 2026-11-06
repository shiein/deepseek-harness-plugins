/**
 * 配置来源选择（方案 §8）。
 * 每个应用只选唯一来源：显式选中 > 工作区根 page-preview.config.json > 插件本地配置 > 自动检测。
 * 不深度合并同名项目配置；返回值必须携带生效来源，供诊断与 Client 展示。
 */

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { DiagnosticCode } from '../errors.ts'
import type { Diagnostic } from '../contracts.ts'
import { isWithinRoot, resolveProjectPath } from './paths.ts'
import { validateConfig } from './schema.ts'
import type { ConfigIssue, PreviewConfigFile, ProjectConfig } from './schema.ts'

export const REPO_CONFIG_FILE = 'page-preview.config.json'

export type ConfigSource =
  | { kind: 'explicit'; file: string }
  | { kind: 'repo'; file: string }
  | { kind: 'local'; file: string }
  | { kind: 'detected' }

export interface EffectiveProjectConfig {
  source: ConfigSource
  project: ProjectConfig
  diagnostics: Diagnostic[]
}

export class ConfigLoadError extends Error {
  readonly code = DiagnosticCode.configInvalid
  readonly file: string
  readonly issues: ConfigIssue[]

  constructor(file: string, issues: ConfigIssue[], cause?: unknown) {
    super('Invalid page preview configuration', { cause })
    this.name = 'ConfigLoadError'
    this.file = file
    this.issues = issues
  }
}

/** 调用者传入插件数据目录；不从 Host 环境猜测 profile，也不创建或写入配置。 */
export async function localConfigDirectory(dataDir: string, workspaceRoot: string): Promise<string> {
  if (!isAbsolute(dataDir) || !isAbsolute(workspaceRoot)) throw new Error('Configuration directories must be absolute')
  const workspace = await realpath(workspaceRoot)
  const key = createHash('sha256').update(workspace).digest('hex')
  return join(dataDir, 'config', key)
}

/** 显式选择一份完整来源；否则按项目 ID 选 repo > local，无配置时返回空列表供调用方检测。 */
export async function loadEffectiveConfigs(
  workspaceRoot: string,
  explicit?: string,
  options: { dataDir?: string } = {},
): Promise<EffectiveProjectConfig[]> {
  if (!isAbsolute(workspaceRoot)) throw new Error('Workspace root must be absolute')
  const workspace = await realpath(workspaceRoot)
  if (explicit !== undefined) {
    const file = resolve(workspace, explicit)
    return effective(await readConfig(file), { kind: 'explicit', file }, workspace)
  }
  const selected = new Map<string, EffectiveProjectConfig>()
  const file = join(workspace, REPO_CONFIG_FILE)
  const repo = await exists(file) ? await readConfig(file, workspace) : undefined
  if (repo) for (const config of await effective(repo, { kind: 'repo', file }, workspace)) selected.set(config.project.id, config)
  if (options.dataDir !== undefined) {
    const dir = await localConfigDirectory(options.dataDir, workspace)
    const names = await exists(dir) ? await readdir(dir) : []
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -5)
      const file = join(dir, name)
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new ConfigLoadError(file, [{ path: '/', message: 'Local config filename must be a project ID' }])
      const higher = selected.get(id)
      if (higher) {
        higher.diagnostics.push({ code: DiagnosticCode.configSourceIgnored, phase: 'config', message: 'Repository config takes precedence over local config for project ' + id, hint: 'The local config was not loaded or merged', location: { file } })
        continue
      }
      const local = await readConfig(file, await realpath(dir))
      if (local.projects.length !== 1 || local.projects[0]?.id !== id) throw new ConfigLoadError(file, [{ path: '/projects', message: 'Local config must contain exactly the filename project ID' }])
      const [config] = await effective(local, { kind: 'local', file }, workspace)
      if (config) selected.set(id, config)
    }
  }
  return [...selected.values()]
}

async function effective(config: PreviewConfigFile, source: Exclude<ConfigSource, { kind: 'detected' }>, workspace: string): Promise<EffectiveProjectConfig[]> {
  for (const [index, project] of config.projects.entries()) await checkPaths(project, index, workspace, source.file)
  return config.projects.map(project => ({ source, project, diagnostics: [] }))
}

async function readConfig(file: string, allowedRoot?: string): Promise<PreviewConfigFile> {
  const path = await realpath(file)
  if (allowedRoot && !isWithinRoot(allowedRoot, path)) throw new ConfigLoadError(file, [{ path: '/', message: 'Config source is outside its selected root' }])
  if (/^\.env(?:\.|$)/.test(basename(path))) throw new ConfigLoadError(file, [{ path: '/', message: 'Environment files are not preview config sources' }])
  const content = await readFile(path, 'utf8')
  let raw: unknown
  try { raw = JSON.parse(content) }
  catch { throw new ConfigLoadError(file, [{ path: '/', message: 'Invalid JSON' }]) }
  const result = validateConfig(raw)
  if (!result.config) throw new ConfigLoadError(file, result.issues)
  return result.config
}

async function checkPaths(project: ProjectConfig, index: number, workspace: string, file: string): Promise<void> {
  const base = '/projects/' + index
  let appRoot: string
  try {
    appRoot = await resolveProjectPath(workspace, project.root)
    if (!(await stat(appRoot)).isDirectory()) throw new Error('Application root is not a directory')
  } catch (error) { throw new ConfigLoadError(file, [{ path: base + '/root', message: 'Application root must be an existing directory within the workspace' }], error) }
  const runtime = project.runtime
  const paths: Array<{ field: string; path: string }> = []
  for (const field of ['setup', 'entry', 'publicRoot'] as const) if (runtime[field] !== undefined) paths.push({ field: '/runtime/' + field, path: runtime[field] })
  for (const [index, path] of (runtime.styles ?? []).entries()) paths.push({ field: '/runtime/styles/' + index, path })
  if (runtime.command) paths.push({ field: '/runtime/command/cwd', path: runtime.command.cwd })
  for (const [index, target] of (project.targets ?? []).entries()) if (target.selector.kind === 'file') paths.push({ field: '/targets/' + index + '/selector/path', path: target.selector.path })
  for (const [name, scenario] of Object.entries(project.scenarios ?? {})) {
    const field = '/scenarios/' + name.replaceAll('~', '~0').replaceAll('/', '~1')
    if (scenario.handlers !== undefined) paths.push({ field: field + '/handlers', path: scenario.handlers })
    for (const [index, fixture] of (scenario.http ?? []).entries()) if (fixture.response.bodyFile !== undefined) paths.push({ field: field + '/http/' + index + '/response/bodyFile', path: fixture.response.bodyFile })
  }
  const checked = await Promise.allSettled(paths.map(item => resolveProjectPath(appRoot, item.path, runtime.dependencyRoots)))
  const issues: ConfigIssue[] = []
  const causes: unknown[] = []
  for (const [index, result] of checked.entries()) if (result.status === 'rejected') {
    issues.push({ path: base + paths[index]!.field, message: 'Unable to resolve configured path within application/dependency roots' })
    causes.push(result.reason)
  }
  if (issues.length) throw new ConfigLoadError(file, issues, new AggregateError(causes, 'Configuration path checks failed'))
}

function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if (!missing(error)) throw error; return false }
}
