/**
 * 自有服务的同源 Mock 中间件（方案 §7.2 默认实现选择、§7.3）。
 * - 业务请求：fixture 命中 → 返回；项目 handler 命中 → 交给 handler；都未命中 → 明确失败（unmatched_request），
 *   不静默返回空对象，也不转发真实后端
 * - 静态资源、模块、HMR 由构建器处理，不经过这里
 * - 哪些路径算“业务请求”由计划声明（例如 /api/**），不能用“放行所有同源请求”实现隔离
 */

import { remoteRequests } from '../shared/remote-requests.ts'
import { validateHeaderName, validateHeaderValue } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DiagnosticCode } from '../shared/errors.ts'
import type { Diagnostic } from '../shared/contracts.ts'
import type { HttpFixture, SseFixture } from '../shared/config/schema.ts'
import { applyEnvelope } from '../shared/envelope.ts'
import type { EnvelopeConfig } from '../shared/envelope.ts'
import type { Middleware } from '../runner/response-layer/server.ts'
import { OWNED_RESPONSE_HEADERS } from '../runner/response-layer/server.ts'
import type { ScenarioStore } from './store.ts'
import { matchFixture, matchHttpPath } from './http-matcher.ts'
import type { HttpRequestInfo } from './http-matcher.ts'
import type { HandlerResponse, ProjectHandler } from './handlers.ts'

export interface MockMiddlewareOptions {
  previewOrigin: string
  /** 业务请求路径模式（glob）。 */
  businessPaths: string[]
  store: ScenarioStore
  fixtures?: readonly HttpFixture[]
  /** R6-1：场景级响应包装；声明后在本函数物化 fixtures 时统一展开（文件头下方注释）。 */
  envelope?: EnvelopeConfig
  /** R5-1g：声明式 SSE 通道；GET 命中声明路径即供出事件流（先于 businessPaths 闸）。 */
  sse?: readonly SseFixture[]
  /** 只能由 Runner 传入已经批准并加载的 handler；此处不 import 项目模块。 */
  handlers?: readonly ProjectHandler[]
  /** Runner 提供应用范围内已校验的只读文件解析，不直接信任 bodyFile 路径。 */
  readBodyFile?: (file: string) => Promise<Uint8Array>
  maxBodyBytes?: number
  /**
   * method/url 为展示形（url = pathname 或 origin+pathname，不含 query）；
   * queryKeys 只带观察到的 query 键名（去重排序），供 Runner 汇总（R3-1）。
   */
  onUnmatched(request: { method: string; url: string; queryKeys?: string[] }): void
  onDiagnostic(diagnostic: Diagnostic): void
}

// R6-1：物化点选在本函数入口——所有调用方（worker 场景绑定、static runtime、preflight）
// 共用同一份展开规则，未命中路径行为不变（仍 unmatched_request）。
export function createMockMiddleware(options: MockMiddlewareOptions): Middleware {
  const origin = new URL(options.previewOrigin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== options.previewOrigin || origin.username || origin.password) throw new Error('Mock requires a canonical HTTP preview origin')
  const paths = options.businessPaths.map(businessPath)
  const fixtures = options.envelope === undefined
    ? options.fixtures ?? []
    : (options.fixtures ?? []).map(fixture => applyEnvelope(fixture, options.envelope!))
  const sseFixtures = options.sse ?? []
  for (const channel of sseFixtures) validateChannelPath(channel.path)
  const handlers = options.handlers ?? []
  const maxBytes = options.maxBodyBytes ?? 64 * 1024
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Mock body limit must be a positive integer')
  for (const fixture of fixtures) {
    matchHttpPath(fixture.path, '/') // 所有模式先校验，不等到碰巧命中该方法。
    validateResponse(fixture.response)
    if (fixture.response.bodyFile && !options.readBodyFile) throw new Error('Mock bodyFile requires a scoped Runner reader')
  }
  return (req, res, next) => {
    let url: URL
    try { url = new URL(req.url ?? '/', origin) } catch { next(new Error('Invalid Mock request URL')); return }
    // 经同源 remote 通道还原的跨源请求一律按业务请求处理（无论 businessPaths），fixture 按其 origin 匹配。
    const remote = remoteRequests.has(req) && url.origin !== origin.origin
    // R5-1g：声明的 SSE 通道自证准入（fixture 即声明），先于 businessPaths 闸；仍要求同源与 GET。
    const channel = !remote && req.method === 'GET' && url.origin === origin.origin
      ? sseFixtures.find(value => value.path === url.pathname) : undefined
    if (channel !== undefined) { serveSse(res, channel); return }
    if (!remote && !paths.some(matches => matches(url.pathname))) { next(); return }
    void handle(req, res, url).catch(next)
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase()
    // 不把 query/body/凭据写入诊断；跨源请求保留其 origin，便于 Agent 按 origin 补 fixture。
    // query 只上抛键名（R3-1 汇总用），值与请求体留在本进程内。
    const reported = url.origin === origin.origin ? url.pathname : url.origin + url.pathname
    const queryKeys = [...new Set(url.searchParams.keys())].sort()
    const unmatched = () => options.onUnmatched({ method, url: reported, ...(queryKeys.length ? { queryKeys } : {}) })
    const foreign = url.origin !== origin.origin && !remoteRequests.has(req)
    if (foreign || url.username || url.password) {
      unmatched(); replyError(res, 400, DiagnosticCode.unmatchedRequest); return
    }
    try { url.pathname.split('/').forEach(part => decodeURIComponent(part)) }
    catch { unmatched(); replyError(res, 400, DiagnosticCode.unmatchedRequest); return }
    const query: Record<string, string> = Object.fromEntries(url.searchParams)
    if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length > 1)) { unmatched(); replyError(res, 400, DiagnosticCode.unmatchedRequest); return }
    let body: unknown
    try { body = await requestBody(req, maxBytes) }
    catch (error) {
      if (!(error instanceof RequestBodyError)) throw error
      unmatched(); replyError(res, error.status, DiagnosticCode.unmatchedRequest); return
    }
    const request: HttpRequestInfo = { origin: url.origin, method, path: url.pathname, query, ...(body === undefined ? {} : { body }) }
    const match = matchFixture(request, fixtures, options.previewOrigin)
    if (match.kind === 'ambiguous') {
      options.onDiagnostic({ code: DiagnosticCode.configInvalid, phase: 'scenario', message: 'Several HTTP fixtures matched; no response or handler was selected' })
      replyError(res, 409, DiagnosticCode.configInvalid); return
    }
    if (match.kind === 'matched') {
      const response = match.fixture.response
      const bytes = response.bodyFile ? Buffer.from(await options.readBodyFile!(response.bodyFile)) : responseBytes(response.body)
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) options.onDiagnostic({ code: DiagnosticCode.unsupportedCapability, phase: 'scenario', message: 'This fixture returns a static response; it does not update the scenario store for later reads' })
      send(res, method, response, bytes, response.bodyFile ? 'application/octet-stream' : responseType(response.body))
      return
    }
    for (const handler of handlers) {
      const response = await handler(request, options.store)
      if (response !== undefined) { validateResponse(response); send(res, method, response, responseBytes(response.body), responseType(response.body)); return }
    }
    unmatched(); replyError(res, 404, DiagnosticCode.unmatchedRequest)
  }
}

type Response = HandlerResponse & { bodyFile?: string }
function validateResponse(response: Response): void {
  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) throw new Error('Mock responses require a final HTTP status from 200 through 599')
  if (response.body !== undefined && response.bodyFile !== undefined) throw new Error('Mock response body and bodyFile cannot both be configured')
  if ([204, 205, 304].includes(response.status) && (response.body !== undefined || response.bodyFile !== undefined)) throw new Error('This HTTP status does not carry a Mock response body')
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    validateHeaderName(name); validateHeaderValue(name, value)
    if (OWNED_RESPONSE_HEADERS.some(value => value === name.toLowerCase())) throw new Error('Owned preview response policy headers cannot be replaced by a Mock response')
    if (['content-length', 'transfer-encoding', 'connection', 'upgrade', 'trailer', 'keep-alive', 'proxy-connection'].includes(name.toLowerCase())) throw new Error('Mock transport headers are controlled by the HTTP server')
  }
}
function responseBytes(body: unknown): Buffer {
  if (body === undefined) return Buffer.alloc(0)
  return Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
}
function responseType(body: unknown): string { return typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8' }
function send(res: ServerResponse, method: string, response: HandlerResponse, bytes: Buffer, contentType: string): void {
  for (const [name, value] of Object.entries(response.headers ?? {})) res.setHeader(name, value)
  if (!res.hasHeader('Content-Type') && ![204, 205, 304].includes(response.status)) res.setHeader('Content-Type', contentType)
  res.statusCode = response.status
  res.end(method === 'HEAD' ? undefined : bytes)
}
function replyError(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ code }))
}
class RequestBodyError extends Error {
  readonly status: number
  constructor(status: number) { super('Mock request body cannot be parsed under the declared rules'); this.status = status }
}
async function requestBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    bytes += chunk.length
    if (bytes > maxBytes) throw new RequestBodyError(413)
    chunks.push(chunk)
  }
  if (!bytes) return undefined
  const text = Buffer.concat(chunks).toString('utf8')
  const type = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
  if (type === 'application/json' || type?.endsWith('+json')) {
    try { return JSON.parse(text) } catch { throw new RequestBodyError(400) }
  }
  if (!type || type === 'text/plain') return text
  throw new RequestBodyError(415)
}
/** R5-1g：SSE/WS 通道声明路径——同源 pathname，不含 query/hash 与通配符。 */
export function validateChannelPath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || /[?#*]/.test(path)) {
    throw new Error('Channel fixture path must be a literal same-origin pathname')
  }
  try { path.split('/').forEach(part => decodeURIComponent(part)) }
  catch { throw new Error('Channel fixture path has invalid encoding') }
}

/** R5-1g：写出固定事件流；CR/LF 拆成多行 data: 行，retry/id/event 按 SSE 语法逐行。 */
function serveSse(res: ServerResponse, channel: SseFixture): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  })
  const write = (event: SseFixture['events'][number]) => {
    const lines: string[] = []
    if (event.event !== undefined) lines.push('event: ' + event.event)
    if (event.id !== undefined) lines.push('id: ' + event.id)
    if (event.retry !== undefined) lines.push('retry: ' + event.retry)
    for (const line of event.data.split(/\r\n|\r|\n/)) lines.push('data: ' + line)
    res.write(lines.join('\n') + '\n\n')
  }
  let chain = Promise.resolve()
  for (const event of channel.events) {
    chain = chain.then(() => new Promise<void>(resolve => setTimeout(resolve, event.delay ?? 0)))
      .then(() => { if (!res.destroyed) write(event) })
  }
  void chain.then(() => { if (!channel.keepOpen) res.end() })
    .catch(() => { if (!res.destroyed) res.destroy() })
}

function businessPath(pattern: string): (pathname: string) => boolean {
  if (!pattern.startsWith('/') || pattern.startsWith('//') || /[?#]/.test(pattern)) throw new Error('Business path must be a local pathname glob')
  const parts = pattern.split('/').map((part, index, all) => {
    if (part === '**' && index === all.length - 1) return { wildcard: '**' }
    if (part === '*') return { wildcard: '*' }
    if (part.includes('*')) throw new Error('Business globs support only whole-segment * or final **')
    try { return { literal: decodeURIComponent(part) } } catch { throw new Error('Business glob has invalid encoding') }
  })
  return pathname => {
    const actual = pathname.split('/')
    for (const [index, part] of parts.entries()) {
      if (part.wildcard === '**') return true
      if (part.wildcard === '*') { if (!actual[index]) return false }
      else {
        try { if (part.literal !== decodeURIComponent(actual[index] ?? '')) return false }
        catch { return false }
      }
    }
    return actual.length === parts.length
  }
}
