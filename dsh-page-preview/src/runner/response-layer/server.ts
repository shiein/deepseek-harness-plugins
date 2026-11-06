/**
 * 受控响应层（方案 §6.8）：插件拥有页面 HTTP 响应时，在这里建立与展示载体无关的能力。
 * 用于 static、isolated（作为 dev server 中间件）以及可选的 project 前置代理；attach 不使用。
 *
 * 组成：Host 头校验 → 回传通道（/__dsh_preview/*）→ 业务 Mock 中间件 → 文档响应改写（CSP + bootstrap + 帧限制）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildCsp, buildFrameAncestors } from './csp.ts'
import type { CspOptions } from './csp.ts'
import { isAllowedHost } from './host-check.ts'
import { injectBootstrap } from './inject.ts'
import { createReportChannel } from './report-channel.ts'
import type { BrowserReport } from './report-channel.ts'
import type { TargetAssertion } from '../../shared/contracts.ts'
import { PAGE_TEXT_LIMIT } from '../../shared/contracts.ts'

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void

/** 这些响应策略由自有服务维护，项目构建器/fixture 不能覆盖。 */
export const OWNED_RESPONSE_HEADERS = ['content-security-policy', 'content-security-policy-report-only', 'cache-control', 'x-frame-options', 'x-content-type-options', 'access-control-allow-origin'] as const

export function withOwnedResponseHeaders(project: Record<string, unknown>, owned: Record<string, string>): Record<string, unknown> {
  return { ...Object.fromEntries(Object.entries(project).filter(([name]) => !OWNED_RESPONSE_HEADERS.some(value => value === name.toLowerCase()))), ...owned }
}

export interface ResponseLayerOptions {
  previewId: string
  /** 回传通道与归属探针使用的会话 nonce；不得写入日志或返回给模型。 */
  nonce: string
  allowedHosts: string[]
  csp: CspOptions
  /** 允许 DSH Client 嵌入的来源（Phase 0 确认 Client origin 后填写）。 */
  frameAncestors: string[]
  /** bootstrap 脚本内容（src/browser/bootstrap.js 构建产物）。 */
  bootstrapScript: string
  /** 提供时按每次文档响应注入 self.__DSH_BUILD__ 构建印章；bootstrap 在 document-loaded 中回传，供 freshness 版本核对（P1-6）。 */
  buildVersion?: () => string
  /** 提供时开放同源构建长轮询 /__dsh_preview/build（R2-P0-2）；bootstrap 用它在编译成功后自动重载文档。 */
  buildState?: () => { build: string; seq: number }
  /** 仅验证计划声明的断言；期限与 Runner 的目标就绪期限一致。 */
  assertions?: TargetAssertion[]
  targetDeadlineMs?: number
  /** 回传内容的额外脱敏值（runtime.env 值与项目 env 文件值，§13 第 8 条）。 */
  secrets?: readonly string[]
  /** R5-1e：检出项目 MSW 时传 'allow'，bootstrap 放行 Service Worker 注册；默认屏蔽 API。 */
  serviceWorker?: 'allow'
  /** R5-4：提供时开放 GET /__dsh_preview/frame——插件自有外层页面，固定尺寸 iframe 内嵌预览文档。 */
  frame?: { pagePath: string; width: number; height: number }
  onReport(report: BrowserReport): void
}

/** 外层框架页只做尺寸容器：iframe 边界使外层样式/脚本不进入内层预览文档（R5-4）。 */
function framePage(frame: { pagePath: string; width: number; height: number }): string {
  const src = frame.pagePath.replace(/["&<>]/g, ch => '&#' + ch.charCodeAt(0) + ';')
  return '<!doctype html><html><head><meta charset="utf-8"><title>dsh preview ' + frame.width + 'x'
    + frame.height + '</title><style>html,body{margin:0;min-height:100%;background:#444;'
    + 'display:flex;align-items:flex-start;justify-content:center;padding:24px}'
    + 'iframe{border:0;display:block;background:#fff;flex:none}</style></head><body>'
    + '<iframe src="' + src + '" width="' + frame.width + '" height="' + frame.height
    + '" data-dsh-preview-frame=""></iframe></body></html>\n'
}

export interface ResponseLayer {
  /** 作为 connect/express 风格中间件挂到 Vite / webpack-dev-server / 自有静态服务前面。 */
  middleware: Middleware
  /** 改写文档响应：注入 bootstrap、附加 CSP、按 frameAncestors 处理帧限制头。 */
  transformDocument(html: string): string
  documentHeaders(): Record<string, string>
}

/** 自有服务使用这些响应头；项目代理还须显式移除上游 X-Frame-Options。 */
export function createResponseLayer(options: ResponseLayerOptions): ResponseLayer {
  const channel = createReportChannel(options.previewId, options.nonce, options.onReport,
    options.secrets ?? [], options.buildState)
  const marker = '/*__DSH_PREVIEW_CONFIG__*/ null'
  if (!options.bootstrapScript.includes(marker)) throw new Error('Bootstrap config marker is missing')
  if (options.assertions?.length && (!Number.isSafeInteger(options.targetDeadlineMs) || options.targetDeadlineMs! < 1 || options.targetDeadlineMs! > 2147483647)) throw new Error('Target assertions require a bounded deadline')
  const script = options.bootstrapScript.replace(marker, () => JSON.stringify({
    previewId: options.previewId,
    nonce: options.nonce,
    pageTextLimit: PAGE_TEXT_LIMIT,
    ...(options.serviceWorker === 'allow' ? { serviceWorker: true } : {}),
    ...(options.assertions?.length ? { assertions: options.assertions, targetDeadlineMs: options.targetDeadlineMs } : {}),
  }))
  const policy = `${buildCsp(options.csp)}; ${buildFrameAncestors(options.frameAncestors)}`
  const layer: ResponseLayer = {
    middleware(req, res, next) {
      if (!isAllowedHost(req.headers.host, options.allowedHosts)) {
        res.statusCode = 403
        res.end()
        return
      }
      if (options.frame !== undefined && req.method === 'GET'
        && new URL(req.url ?? '/', 'http://preview.invalid').pathname === '/__dsh_preview/frame') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...layer.documentHeaders() })
        res.end(framePage(options.frame))
        return
      }
      channel(req, res, next)
    },
    // __DSH_BUILD_POLL__ 只在提供构建长轮询（CLI 整页重载路径）时注入；Vite 走 HMR，不轮询不存在的端点。
    transformDocument: (html) => injectBootstrap(html, (options.buildVersion === undefined ? ''
      : 'window.__DSH_BUILD__=' + JSON.stringify(options.buildVersion()) + ';')
      + (options.buildState === undefined ? '' : 'window.__DSH_BUILD_POLL__=true;') + script),
    documentHeaders: () => ({
      'Content-Security-Policy': policy,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }),
  }
  return layer
}
