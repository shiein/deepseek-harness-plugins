/** 原文件静态运行时（方案 §6.1、§6.6、§6.8）；只暴露 publicRoot 内的浏览器资源，不转发请求。 */
import { remoteRequests } from '../../shared/remote-requests.ts'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { localRoute } from '../../shared/route.ts'
import { readFile, stat } from 'node:fs/promises'
import { extname, relative, sep } from 'node:path'
import type { StartContext, RunningHandle } from '../types.ts'
import { isWithinRoot, resolveProjectPath } from '../../shared/config/paths.ts'
import { DiagnosticCode, RunnerSessionError } from '../../shared/errors.ts'
import { collectEnvPairs, createRedactor, envSecrets } from '../../shared/redact.ts'
import { fingerprintJson } from '../../shared/fingerprint.ts'
import { createResponseLayer } from '../../runner/response-layer/server.ts'
import type { Middleware } from '../../runner/response-layer/server.ts'
import { assertionEvidence, sameDocumentUrl } from '../../runner/response-layer/assertions.ts'
import { observePageText } from '../../runner/response-layer/page-text.ts'
import { findListeningPids } from '../../runner/port-ownership.ts'
import { readProcessStartTime } from '../../runner/ledger.ts'
import type { BrowserReport } from '../../runner/response-layer/report-channel.ts'
import { STATIC_CONTENT_TYPES, findStaticDocument, findStaticFile } from '../../shared/static-files.ts'
import { planStatic } from './preflight.ts'
import { createMockMiddleware } from '../../scenario/mock-middleware.ts'
import { ScenarioStore } from '../../scenario/store.ts'
import { readScenarioBodyFile } from '../../scenario/files.ts'

/** 场景仅处理同源 HTTP fixtures；不执行 Node 或浏览器初始化绑定。 */
export async function startStatic(ctx: StartContext): Promise<RunningHandle> {
  if (ctx.plan.strategy !== 'static' || ctx.plan.process.kind !== 'in-runner' || ctx.plan.scope === 'component') throw new Error('Static runtime requires a document plan in the Runner')
  const scene = ctx.plan.scenario === undefined ? undefined : ctx.config.project.scenarios?.[ctx.plan.scenario]
  if (ctx.plan.scenario !== undefined) {
    const checked = await planStatic(ctx, { projectId: ctx.plan.projectId, targetId: ctx.plan.targetId, selector: ctx.plan.selector, scope: ctx.plan.scope }, ctx.plan.scenario, { requirements: ctx.plan.requirements, ...(ctx.plan.route ? { route: ctx.plan.route } : {}), ...(ctx.plan.viewport ? { viewport: ctx.plan.viewport } : {}) })
    if (checked.kind !== 'plan') throw new RunnerSessionError(checked.kind === 'missing' ? checked.missing[0]! : { code: DiagnosticCode.unsupportedCapability, phase: 'scenario', message: checked.reason, hint: 'Remove the unsupported option and retry page_preview_open' })
    if (fingerprintJson(checked.plan.fingerprints) !== fingerprintJson(ctx.plan.fingerprints)) throw new RunnerSessionError({ code: DiagnosticCode.configInvalid, phase: 'scenario', message: 'Static scene/source bindings changed; create a fresh plan before starting' })
  }
  const runtime = ctx.config.project.runtime
  if (runtime.command || runtime.env !== undefined || runtime.setup || Object.values(ctx.config.project.scenarios ?? {}).some(value => value.handlers)) throw new Error('Static runtime cannot execute configured initialization')
  if (runtime.entry || runtime.styles?.length) throw new Error('Static entry replay and extra style bindings are not implemented')
  ctx.signal.throwIfAborted()
  await readProcessStartTime(process.pid) // 已验证平台的端口归属检查不可用时，在分配端口前失败。
  const root = await resolveProjectPath(ctx.appRoot, runtime.publicRoot ?? '.', runtime.dependencyRoots)
  if (!(await stat(root)).isDirectory()) throw new Error('Static publicRoot is not a directory')
  const selector = ctx.plan.selector
  const definition = ctx.config.project.targets?.find(target => target.id === ctx.plan.targetId)
  const selected = selector.kind === 'registered' ? ctx.config.project.targets?.find(target => target.id === selector.id)?.selector : selector
  let targetPath: string
  if (selected?.kind === 'file') {
    if (selected.exportName || definition?.route || ctx.plan.route) throw new Error('Static document export and route bindings are not implemented')
    const file = await resolveProjectPath(ctx.appRoot, selected.path, runtime.dependencyRoots)
    if (!isWithinRoot(root, file)) throw new Error('Static target is outside publicRoot')
    targetPath = '/' + relative(root, file).split(sep).map(encodeURIComponent).join('/')
  } else if (selected?.kind === 'route' && selected.path.startsWith('/') && !selected.path.startsWith('//')) {
    const target = localRoute(selected)
    if (ctx.plan.route && localRoute(ctx.plan.route).href !== target.href) throw new Error('Static route context conflicts with the selected target')
    targetPath = target.pathname + target.search + target.hash
  } else throw new Error('Static preview needs a file or concrete local route')
  const nonce = randomBytes(24).toString('hex')
  const bootstrapScript = await readFile(new URL(import.meta.url.endsWith('.ts') ? '../../browser/bootstrap.js' : '../../../browser/bootstrap.js', import.meta.url), 'utf8')
  const envValues = envSecrets(runtime.env, await collectEnvPairs(ctx.appRoot))
  const redactor = createRedactor({ secrets: envValues, channels: [nonce] })
  let origin = ''
  let port = 0
  let entryId: string | undefined
  let stopped = false
  let stopping: Promise<{ residual: string[] }> | undefined
  let mock: Middleware | undefined
  const layer = createResponseLayer({ previewId: ctx.previewId, nonce, allowedHosts: ['127.0.0.1', 'localhost'], csp: {}, frameAncestors: [], bootstrapScript, secrets: envValues, onReport,
    ...(ctx.plan.readiness.assertions?.length ? { assertions: ctx.plan.readiness.assertions, targetDeadlineMs: ctx.plan.readiness.targetDeadlineMs } : {}),
  })
  function onReport(report: BrowserReport): void {
    const expected = new URL(targetPath, origin).href
    const text = observePageText(report, expected)
    if (text) { ctx.emit({ type: 'page-text', observation: text }); return }
    const evidence = assertionEvidence(ctx.plan.readiness.assertions, report, expected)
    if (evidence) ctx.emit({ type: 'evidence', layer: 'targetMounted', evidence })
    else if (report.kind === 'document-loaded') {
      if (sameDocumentUrl(report.url, expected)) ctx.emit({ type: 'evidence', layer: 'documentLoaded', evidence: { status: 'proven', at: new Date().toISOString(), detail: 'Target document reported DOMContentLoaded' } })
    } else if (report.kind === 'runtime-error' || report.kind === 'unhandled-rejection') {
      // §13 第 8 条：转发脱敏后的 message 与前 N 帧堆栈，Agent 可据此定位并修复源码。
      ctx.emit({ type: 'diagnostic', diagnostic: { code: DiagnosticCode.runtimeError, phase: 'ready',
        message: 'Static preview reported a runtime error: ' + report.message + (report.stack ? '\n' + report.stack : ''),
        ...(report.kind === 'runtime-error' && report.source ? { location: { request: report.source } } : {}),
        hint: 'Fix the reported error in the target document source; forwarded message and stack frames are redacted project text' } })
    } else if (report.kind === 'csp-violation') {
      ctx.emit({ type: 'diagnostic', diagnostic: { code: DiagnosticCode.blockedRequest, phase: 'ready',
        message: 'Static preview resource/connection was blocked by its controlled response policy: ' + report.directive,
        location: { request: report.blockedURI },
        hint: 'Declare the required data source as a same-origin scenario fixture; blocked requests are never forwarded' } })
    }
  }
  async function documentPath(pathname: string, navigation: boolean): Promise<string | undefined> {
    return findStaticDocument(root, pathname, runtime.spaFallback === true, navigation)
  }
  const initial = await documentPath(new URL(targetPath, 'http://preview.invalid').pathname, true)
  if (!initial || !['.html', '.htm'].includes(extname(initial).toLowerCase())) throw new Error('Static target is not an existing HTML document')
  const server = createServer((req, res) => {
    const fail = (error?: unknown) => {
      if (error) ctx.emit({ type: 'diagnostic', diagnostic: { code: DiagnosticCode.runtimeError, phase: 'ready', message: 'Static response failed: ' + (error instanceof Error ? error.message : 'unknown error'), hint: 'Check the configured publicRoot contents and file permissions' } })
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
    layer.middleware(req, res, error => {
      if (error) { fail(error); return }
      void (async () => {
        const url = new URL(req.url ?? '/', origin)
        const unmatched = () => {
          const target = redactor.request(req.method, req.url ?? '/', origin)
          ctx.emit({ type: 'diagnostic', diagnostic: { code: DiagnosticCode.unmatchedRequest, phase: 'ready', message: 'No static resource matched the request',
            location: { request: [target.method, (target.origin ?? '') + target.path].filter(Boolean).join(' ') },
            hint: 'Declare an explicit fixture or supported preview binding; unmatched requests are never forwarded' } })
          res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: DiagnosticCode.unmatchedRequest }))
        }
        // 经 remote 通道还原的跨源业务请求：不读静态文件、不走 SPA 回退，只交给 Mock 或明确未命中。
        const read = ['GET', 'HEAD'].includes(req.method ?? '') && !remoteRequests.has(req)
        const serve = async (file: string) => {
          const type = STATIC_CONTENT_TYPES[extname(file).toLowerCase()]!
          const data = await readFile(file)
          res.writeHead(200, { ...layer.documentHeaders(), 'Content-Type': type })
          res.end(req.method === 'HEAD' ? undefined : type.startsWith('text/html') ? layer.transformDocument(data.toString('utf8')) : data)
        }
        const file = read ? await findStaticFile(root, url.pathname) : undefined
        if (file) { await serve(file); return }
        const fallback = async () => {
          const document = read ? await documentPath(url.pathname, Boolean(req.headers.accept?.includes('text/html'))) : undefined
          if (document) await serve(document); else unmatched()
        }
        for (const [key, value] of Object.entries(layer.documentHeaders())) res.setHeader(key, value)
        if (mock) mock(req, res, error => { if (error) fail(error); else void fallback().catch(fail) })
        else await fallback()
      })().catch(fail)
    })
  })
  const stop = () => {
    if (stopped) return Promise.resolve({ residual: [] })
    if (stopping) return stopping
    stopping = (async () => {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      if (port && (await findListeningPids(port)).length) return { residual: ['Static listener ' + port] }
      if (entryId) await ctx.ledger.release(entryId)
      stopped = true
      return { residual: [] }
    })().finally(() => { stopping = undefined })
    return stopping
  }
  try {
    ctx.signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Static listener address unavailable')
    port = address.port
    origin = 'http://127.0.0.1:' + port
    if (scene) mock = createMockMiddleware({ previewOrigin: origin, businessPaths: scene.businessPaths ?? [],
      fixtures: scene.http ?? [], ...(scene.envelope === undefined ? {} : { envelope: scene.envelope }),
      sse: scene.sse ?? [], store: new ScenarioStore(ctx.plan.scenario!),
      readBodyFile: file => readScenarioBodyFile(ctx.appRoot, file, runtime.dependencyRoots),
      onUnmatched: request => { const target = redactor.request(request.method, request.url, origin)
        // R3-1：除诊断外另发结构化事件，供 RunnerSession 的 UnmatchedRequestLog 汇总。
        ctx.emit({ type: 'unmatched', request: {
          method: target.method ?? 'UNKNOWN',
          // origin 只记跨源（remote 通道还原的真实目标）；同源未命中不带 origin，
          // 否则 UnmatchedForDraft 会把同源条目误归 crossOrigin（R3-1 语义修正）。
          ...(target.origin === undefined || target.origin === origin ? {} : { origin: target.origin }),
          path: target.path,
          ...(request.queryKeys === undefined ? {} : { queryKeys: request.queryKeys }),
        } })
        ctx.emit({ type: 'diagnostic', diagnostic: {
          code: DiagnosticCode.unmatchedRequest, phase: 'scenario',
          message: 'No static scenario HTTP fixture matched; no backend was contacted',
          location: { request: [target.method, (target.origin ?? '') + target.path].filter(Boolean).join(' ') },
        } }) },
      onDiagnostic: diagnostic => ctx.emit({ type: 'diagnostic', diagnostic }),
    })
    entryId = (await ctx.ledger.record({ previewId: ctx.previewId, ownerSessionId: ctx.ownerSessionId, workspaceRoot: ctx.workspaceRoot, resource: { kind: 'port', port, pid: process.pid } })).id
    ctx.signal.throwIfAborted()
    if (!(await findListeningPids(port)).includes(process.pid)) throw new Error('Static listener ownership could not be verified')
    const health = await fetch(origin + '/__dsh_preview/health?nonce=' + nonce, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, ctx.deadline - Date.now()))]) })
    if (!health.ok || (await health.json() as { previewId?: string }).previewId !== ctx.previewId) throw new Error('Static ownership probe failed')
    ctx.emit({ type: 'evidence', layer: 'serviceReachable', evidence: { status: 'proven', detail: 'Owned static listener and authenticated probe verified' } })
    return { url: new URL(targetPath, origin).href, channelSecrets: [nonce], stop }
  } catch (error) {
    const result = await stop()
    if (result.residual.length) throw new Error('Static startup cleanup failed', { cause: error })
    throw error
  }
}
