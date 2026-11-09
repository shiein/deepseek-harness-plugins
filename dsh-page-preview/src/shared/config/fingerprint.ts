/**
 * 执行项指纹（方案 §8、§13.1）。
 * command / env / setup / handlers（含文件内容哈希）变化时返回 config_changed_needs_approval，批准前不执行。
 * R2-1：一次性批准不落盘——用户批准后的指纹只存于 Host 内存，并随 start IPC 发给 Runner 核对。
 */

import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { resolveProjectPath } from './paths.ts'
import type { ProjectConfig } from './schema.ts'
import type { Strategy } from '../contracts.ts'
import { fingerprintJson } from '../fingerprint.ts'

/** 项目构建器会作为 Node 代码加载的配置文件名（应用根下）；adapters 的只读解析共用同一份清单。 */
export const VITE_CONFIG_NAMES = [
  'vite.config.ts', 'vite.config.js', 'vite.config.mts',
  'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs',
]
export const CLI_CONFIG_NAMES = ['vue.config.js', 'vue.config.cjs', 'vue.config.mjs', 'vue.config.ts']

export interface ExecutionItems {
  version: 2
  command?: ProjectConfig['runtime']['command']
  env?: Record<string, string>
  /** 规范文件路径 → 内容哈希；不包含文件原文。 */
  files: Record<string, string>
  /** 保留原始引用与实际位置，不能因文件集合相同而丢失 setup/场景的执行绑定。 */
  bindings: {
    appRoot: string
    cwd?: string
    setup?: { path: string; resolved: string }
    handlers: Record<string, { path: string; resolved: string }>
    /** 应用根下实际存在的构建配置文件名；无配置时省略，既有指纹不变。 */
    buildConfig?: string[]
  }
}

export function fingerprintExecutionItems(items: ExecutionItems): string {
  return fingerprintJson(items)
}

/** 只读取已核对范围的 setup/handlers 原始字节；不导入代码、不读取 .env、不生成批准。 */
export async function collectExecutionItems(appRoot: string, project: ProjectConfig): Promise<ExecutionItems> {
  const root = await realpath(appRoot)
  if (!(await stat(root)).isDirectory()) throw new Error('Execution application root must be a directory')
  const items: ExecutionItems = { version: 2, files: {}, bindings: { appRoot: root, handlers: {} } }
  if (project.runtime.command) {
    const command = project.runtime.command
    const cwd = await resolveProjectPath(appRoot, command.cwd, project.runtime.dependencyRoots)
    if (!(await stat(cwd)).isDirectory()) throw new Error('Execution working directory must be an existing directory')
    items.command = { executable: command.executable, args: [...command.args], cwd: command.cwd }
    items.bindings.cwd = cwd
  }
  if (project.runtime.env !== undefined) items.env = { ...project.runtime.env }
  const module = async (path: string) => {
    const resolved = await resolveProjectPath(appRoot, path, project.runtime.dependencyRoots)
    if (/^\.env(?:\.|$)/.test(basename(resolved))) throw new Error('Environment files cannot be execution modules')
    if (!Object.hasOwn(items.files, resolved)) items.files[resolved] = createHash('sha256').update(await readFile(resolved)).digest('hex')
    return { path, resolved }
  }
  if (project.runtime.setup !== undefined) items.bindings.setup = await module(project.runtime.setup)
  const handlers: Array<[string, { path: string; resolved: string }]> = []
  for (const [name, scenario] of Object.entries(project.scenarios ?? {})) {
    if (scenario.handlers !== undefined) handlers.push([name, await module(scenario.handlers)])
  }
  items.bindings.handlers = Object.fromEntries(handlers)
  // 构建配置在 Runner 中作为 Node 代码执行（方案 §13），改动后必须重新批准；只哈希字节，不加载。
  const buildConfig: string[] = []
  for (const name of [...VITE_CONFIG_NAMES, ...CLI_CONFIG_NAMES]) {
    const file = join(root, name)
    let bytes: Buffer
    try {
      bytes = await readFile(file)
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue
      throw error
    }
    items.files[file] = createHash('sha256').update(bytes).digest('hex')
    buildConfig.push(name)
  }
  if (buildConfig.length) items.bindings.buildConfig = buildConfig
  return items
}

/**
 * 本次执行的完整指纹：配置执行项 + 插件从入口自动生成的 setup（§0.3 第 10 条，计划 generatedSetup.hash）。
 * 无生成 setup 时与 fingerprintExecutionItems 相同，既有批准不受影响。
 */
export function executionFingerprint(items: ExecutionItems, generatedSetupHash?: string): string {
  const base = fingerprintExecutionItems(items)
  return generatedSetupHash === undefined ? base : fingerprintJson({ items: base, generatedSetup: generatedSetupHash })
}

/** 隔离路径由 Runner 启动项目构建器并加载其配置；static/attach 不加载，project 已由 command 触发批准。 */
export function runsProjectBuildConfig(strategy: Strategy, items: ExecutionItems): boolean {
  return strategy === 'isolated' && items.bindings.buildConfig !== undefined
}

/** 配置执行项、自动生成的 setup 或会被加载的构建配置存在时，运行前需要执行批准。 */
export function requiresExecutionApproval(
  project: ProjectConfig, generatedSetupHash?: string, buildConfigRuns = false,
): boolean {
  const runtime = project.runtime
  return Boolean(runtime.command || runtime.env !== undefined || runtime.setup || generatedSetupHash !== undefined
    || buildConfigRuns || Object.values(project.scenarios ?? {}).some(value => value.handlers))
}

/** 差异只包含组件标签和哈希，环境值、命令参数及模块原文不进入提示/日志。 */
export function executionComponentHashes(items: ExecutionItems, generatedSetupHash?: string): Record<string, string> {
  const hashes: Array<[string, string]> = [['application-root', fingerprintJson(items.bindings.appRoot)]]
  if (items.command) hashes.push(['command', fingerprintJson({ command: items.command, cwd: items.bindings.cwd })])
  for (const [name, value] of Object.entries(items.env ?? {}))
    hashes.push(['environment:' + name, fingerprintJson(value)])
  if (items.env !== undefined) hashes.push(['environment-binding', fingerprintJson(Object.keys(items.env).sort())])
  if (items.bindings.setup) hashes.push(['setup',
    fingerprintJson({ binding: items.bindings.setup, content: items.files[items.bindings.setup.resolved] })])
  for (const [name, binding] of Object.entries(items.bindings.handlers))
    hashes.push(['handler:' + name, fingerprintJson({ binding, content: items.files[binding.resolved] })])
  for (const name of items.bindings.buildConfig ?? []) {
    const content = items.files[join(items.bindings.appRoot, name)]
    hashes.push(['build-config:' + name, fingerprintJson({ name, content })])
  }
  if (generatedSetupHash !== undefined) hashes.push(['generated-setup', generatedSetupHash])
  return Object.fromEntries(hashes)
}
