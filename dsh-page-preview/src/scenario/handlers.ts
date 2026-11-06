/**
 * 项目 handler 模块契约（方案 §7.2 写交互）。
 * handler 由项目提供（ScenarioConfig.handlers，相对应用根），在 Runner 侧（Node）执行。
 * 执行项目代码需遵守 §13.1 授权与 §8 执行项指纹。
 */

import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DiagnosticCode, RunnerSessionError } from '../shared/errors.ts'
import { resolveProjectPath } from '../shared/config/paths.ts'
import type { HttpRequestInfo } from './http-matcher.ts'
import type { ScenarioStore } from './store.ts'

export interface HandlerResponse {
  status: number
  headers?: Record<string, string>
  body?: unknown
}

/** handler 返回 undefined 表示未处理，继续按未命中处理。 */
export type ProjectHandler = (request: HttpRequestInfo, store: ScenarioStore) => Promise<HandlerResponse | undefined> | HandlerResponse | undefined

export interface HandlerLoadOptions {
  dependencyRoots?: readonly string[]
  /** Runner 的当前执行项复核，不接受 Agent 的 approved 字段或生成批准记录。 */
  verifyExecution(): Promise<void>
  signal?: AbortSignal
}

/** Host/Runner 共用的只读文件边界，不导入项目模块。 */
export async function resolveHandlerModule(appRoot: string, file: string, dependencyRoots?: readonly string[]): Promise<string> {
  try {
    const resolved = await resolveProjectPath(appRoot, file, dependencyRoots)
    if (/^\.env(?:\.|$)/.test(basename(resolved)) || !['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'].includes(extname(resolved).toLowerCase()) || !(await stat(resolved)).isFile()) throw new Error('Invalid handler module source')
    return resolved
  } catch (error) { throw problem(DiagnosticCode.configInvalid, 'Handler module must be an existing Node JS/TS file within the declared application/dependency roots', error) }
}

/** 仅在每预览执行器调用；固定 default handler 数组，原位置解析依赖，缓存生命周期属于执行器。 */
export async function loadProjectHandlers(appRoot: string, file: string, options?: HandlerLoadOptions): Promise<ProjectHandler[]> {
  if (!options || typeof options.verifyExecution !== 'function') throw problem(DiagnosticCode.configChangedNeedsApproval, 'Project handlers require the Runner execution verifier')
  options.signal?.throwIfAborted()
  const resolved = await resolveHandlerModule(appRoot, file, options.dependencyRoots)
  try { await options.verifyExecution() }
  catch (error) {
    if (error instanceof RunnerSessionError) throw error
    throw problem(DiagnosticCode.configChangedNeedsApproval, 'Current handler execution fingerprint was not approved; no module was imported', error)
  }
  options.signal?.throwIfAborted()
  let module: unknown
  try { module = await import(pathToFileURL(resolved).href) }
  catch (error) { throw problem(DiagnosticCode.runtimeError, 'Project handler module could not be evaluated; raw project errors are excluded from diagnostics', error) }
  options.signal?.throwIfAborted()
  if (!module || typeof module !== 'object' || !('default' in module) || !Array.isArray(module.default)) throw problem(DiagnosticCode.configInvalid, 'Handler module must default-export an array of handler functions; no alternative export was selected')
  const handlers: unknown[] = [...module.default]
  if (!handlers.every(value => typeof value === 'function')) throw problem(DiagnosticCode.configInvalid, 'Every default-exported handler entry must be a function')
  // Node 只能校验函数导出，参数契约由项目遵守；响应在 Mock 中间件消费时继续校验。
  return handlers as ProjectHandler[]
}

function problem(code: string, message: string, cause?: unknown): RunnerSessionError { return new RunnerSessionError({ code, phase: 'scenario', message, hint: 'Use a reviewed default-export handler array, then retry page_preview_open and ask the user to approve the execution fingerprint' }, cause) }
