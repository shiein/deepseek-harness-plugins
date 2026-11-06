/**
 * 执行项指纹（方案 §8、§13.1）。
 * command / env / setup / handlers（含文件内容哈希）变化时返回 config_changed_needs_approval，批准前不执行。
 * R2-1：一次性批准不落盘——用户批准后的指纹只存于 Host 内存，并随 start IPC 发给 Runner 核对。
 */

import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { resolveProjectPath } from './paths.ts'
import type { ProjectConfig } from './schema.ts'
import { fingerprintJson } from '../fingerprint.ts'

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

/** 配置执行项或自动生成的 setup 存在时，运行前需要执行批准。 */
export function requiresExecutionApproval(project: ProjectConfig, generatedSetupHash?: string): boolean {
  const runtime = project.runtime
  return Boolean(runtime.command || runtime.env !== undefined || runtime.setup || generatedSetupHash !== undefined
    || Object.values(project.scenarios ?? {}).some(value => value.handlers))
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
  if (generatedSetupHash !== undefined) hashes.push(['generated-setup', generatedSetupHash])
  return Object.fromEntries(hashes)
}
