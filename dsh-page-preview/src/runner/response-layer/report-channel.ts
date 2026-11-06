/**
 * bootstrap → Runner 的同源回传通道（方案 §6.8）。
 * 路径前缀与业务路由隔离；每个请求必须带会话 nonce；nonce 不对模型和日志明文暴露。
 */

import { remoteRequests } from '../../shared/remote-requests.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Middleware } from './server.ts'
import { createRedactor } from '../../shared/redact.ts'
import type { Redactor } from '../../shared/redact.ts'
import { PAGE_TEXT_LIMIT } from '../../shared/contracts.ts'

export const CHANNEL_PREFIX = '/__dsh_preview'
export const HEALTH_PATH = `${CHANNEL_PREFIX}/health`
export const REPORT_PATH = `${CHANNEL_PREFIX}/report`
export const CSP_REPORT_PATH = `${CHANNEL_PREFIX}/csp`
export const BUILD_PATH = `${CHANNEL_PREFIX}/build`
/**
 * 跨源业务请求的同源入口（§0.3 第 10 条）：bootstrap 把发往其他 origin 的 fetch/XHR 改写为
 * /__dsh_preview/remote/<encodeURIComponent(origin)>/<path>?<query>。这里还原成绝对形式的请求 URL
 * 交给后续自有管线（Mock 按 fixture origin 匹配，未命中如实 unmatched_request 并带原 origin），永不转发。
 */
export const REMOTE_PREFIX = `${CHANNEL_PREFIX}/remote/`
export { remoteRequests }

/** 与 src/browser/bootstrap.js 发送的消息保持一致。 */
export type BrowserReport =
  | { kind: 'document-loaded'; url: string; build?: string }
  | { kind: 'module-updated'; version: string }
  | { kind: 'target-mounted'; detail?: string }
  | { kind: 'assertion'; index: number; passed: boolean; detail?: string }
  | { kind: 'assertions'; url: string; results: boolean[] }
  | { kind: 'runtime-error'; message: string; stack?: string; source?: string }
  | { kind: 'unhandled-rejection'; message: string; stack?: string }
  | { kind: 'csp-violation'; blockedURI: string; directive: string }
  | { kind: 'page-text'; url: string; text: string; truncated: boolean }

const MAX_BODY_BYTES = 64 * 1024
const MAX_REPORTS_PER_SECOND = 100
/** 构建长轮询默认：无变化时最长挂起时长与状态检查间隔；仅 nonce 持有者可读。 */
const BUILD_HOLD_MS = 25000
const BUILD_POLL_MS = 250

export interface BuildStamp { build: string; seq: number }

export function createReportChannel(
  previewId: string,
  nonce: string,
  onReport: (report: BrowserReport) => void,
  secrets: readonly string[] = [],
  /** 提供时开放 GET /__dsh_preview/build 长轮询（R2-P0-2）：since/seq 变化立即返回，超时回当前值。 */
  buildState?: () => BuildStamp,
  /** 测试注入的挂起上限/检查间隔；未提供时用上面的默认值。 */
  buildHoldMs = BUILD_HOLD_MS,
  buildPollMs = BUILD_POLL_MS,
): Middleware {
  if (!previewId || !nonce) throw new Error('Report channel requires a preview id and nonce')
  const redactor = createRedactor({ secrets, channels: [nonce] })
  let windowStart = 0
  let count = 0
  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://preview.invalid')
    if (url.pathname !== CHANNEL_PREFIX && !url.pathname.startsWith(`${CHANNEL_PREFIX}/`)) return next()
    if (url.pathname.startsWith(REMOTE_PREFIX)) {
      const rest = url.pathname.slice(REMOTE_PREFIX.length)
      const slash = rest.indexOf('/')
      let remote: URL | undefined
      try { remote = new URL(decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash))) }
      catch { remote = undefined }
      const valid = remote && ['http:', 'https:'].includes(remote.protocol) && !remote.username && !remote.password
      if (!remote || !valid) return reply(res, 400)
      req.url = remote.origin + (slash === -1 ? '/' : rest.slice(slash)) + url.search
      remoteRequests.add(req)
      return next()
    }
    void handle(req, res, url).catch(next)
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    res.setHeader('Cache-Control', 'no-store')
    if (url.pathname === HEALTH_PATH) {
      if (req.method !== 'GET') return reply(res, 405)
      if (url.searchParams.get('nonce') !== nonce) return reply(res, 403)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ previewId }))
      return
    }
    if (url.pathname === BUILD_PATH) {
      if (!buildState) return reply(res, 404)
      if (req.method !== 'GET') return reply(res, 405)
      if (url.searchParams.get('nonce') !== nonce) return reply(res, 403)
      const send = () => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(buildState()))
      }
      const since = url.searchParams.get('since')
      const seq = url.searchParams.get('seq')
      const current = buildState()
      if (since === null || seq === null || since !== current.build || seq !== String(current.seq)) { send(); return }
      const deadline = Date.now() + buildHoldMs
      const timer = setInterval(() => {
        const now = buildState()
        if (now.build !== since || String(now.seq) !== seq || Date.now() >= deadline) {
          clearInterval(timer)
          send()
        }
      }, buildPollMs)
      res.on('close', () => clearInterval(timer))
      return
    }
    if (url.pathname !== REPORT_PATH && url.pathname !== CSP_REPORT_PATH) return reply(res, 404)
    if (req.method !== 'POST') return reply(res, 405)
    // Beacon/fetch 的同源上报可无 Origin；带 Origin 时必须与当前服务一致。
    if (req.headers.origin) {
      let origin: URL
      try { origin = new URL(req.headers.origin) } catch { return reply(res, 403) }
      if (origin.host !== req.headers.host) return reply(res, 403)
    }
    const now = Date.now()
    if (now - windowStart >= 1000) { windowStart = now; count = 0 }
    if (++count > MAX_REPORTS_PER_SECOND) return reply(res, 429)
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of req) {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > MAX_BODY_BYTES) return reply(res, 413)
      chunks.push(buffer)
    }
    let raw: unknown
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reply(res, 400) }
    if (!isRecord(raw)) return reply(res, 400)
    let report: BrowserReport
    if (url.pathname === CSP_REPORT_PATH) {
      if (url.searchParams.get('nonce') !== nonce) return reply(res, 403)
      const violation = raw['csp-report']
      if (!isRecord(violation) || typeof violation['blocked-uri'] !== 'string' ||
          typeof violation['effective-directive'] !== 'string') return reply(res, 400)
      report = { kind: 'csp-violation', blockedURI: violation['blocked-uri'], directive: violation['effective-directive'] }
    } else {
      if (raw.nonce !== nonce || raw.previewId !== previewId) return reply(res, 403)
      if (!isBrowserReport(raw.report)) return reply(res, 400)
      report = raw.report
    }
    // CSP 的 original-policy、堆栈或 URL 可能包含回传路径与项目值；回调边界统一脱敏。
    onReport(redactReport(report, redactor))
    reply(res, 204)
  }
}

function reply(res: ServerResponse, status: number): void {
  res.statusCode = status
  res.end()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isBrowserReport(value: unknown): value is BrowserReport {
  if (!isRecord(value)) return false
  const text = (key: string) => typeof value[key] === 'string' && value[key].length <= 16_384
  const optionalText = (key: string) => value[key] === undefined || text(key)
  switch (value.kind) {
    case 'document-loaded': return text('url') && optionalText('build')
    case 'module-updated': return text('version')
    case 'target-mounted': return optionalText('detail')
    case 'assertion': return Number.isSafeInteger(value.index) && Number(value.index) >= 0 && typeof value.passed === 'boolean' && optionalText('detail')
    case 'assertions': return text('url') && Array.isArray(value.results) && value.results.every(result => typeof result === 'boolean')
    case 'runtime-error': return text('message') && optionalText('stack') && optionalText('source')
    case 'unhandled-rejection': return text('message') && optionalText('stack')
    case 'csp-violation': return text('blockedURI') && text('directive')
    case 'page-text': return text('url') && typeof value.text === 'string' && value.text.length <= PAGE_TEXT_LIMIT && typeof value.truncated === 'boolean'
    default: return false
  }
}

function redactReport(report: BrowserReport, redactor: Redactor): BrowserReport {
  // 按已验证的 discriminated union 重建对象，不把未校验的 envelope/额外字段带给调用者；
  // URL 类字段去 userinfo/query，文本类字段做值替换与限长（§13 第 8 条）。
  const { text, url, address } = redactor
  switch (report.kind) {
    // 目标匹配用的 url 保留 query（address）；只有进入转发字段的 URL 才去 query（url）。
    case 'document-loaded': return { kind: report.kind, url: address(report.url), ...(report.build === undefined ? {} : { build: text(report.build) }) }
    // build/version 是 Runner 侧注入的构建印章，不是项目数据；限长透传即可。
    case 'module-updated': return { kind: report.kind, version: text(report.version) }
    case 'target-mounted': return { kind: report.kind, ...(report.detail === undefined ? {} : { detail: text(report.detail) }) }
    case 'assertion': return { kind: report.kind, index: report.index, passed: report.passed, ...(report.detail === undefined ? {} : { detail: text(report.detail) }) }
    case 'assertions': return { kind: report.kind, url: address(report.url), results: [...report.results] }
    case 'runtime-error': return { kind: report.kind, message: text(report.message), ...(report.stack === undefined ? {} : { stack: redactor.stack(report.stack) }), ...(report.source === undefined ? {} : { source: url(report.source) }) }
    case 'unhandled-rejection': return { kind: report.kind, message: text(report.message), ...(report.stack === undefined ? {} : { stack: redactor.stack(report.stack) }) }
    case 'csp-violation': return { kind: report.kind, blockedURI: url(report.blockedURI), directive: text(report.directive) }
    case 'page-text': return { kind: report.kind, url: address(report.url), text: text(report.text, PAGE_TEXT_LIMIT), truncated: report.truncated }
  }
}
