/** 已有服务的 Runner 接入（方案 §6.1、§9.2）；不登记/接管服务 PID/端口，不改写响应或浏览器状态。 */
import { DiagnosticCode } from '../../shared/errors.ts'
import { observeHttpService, probeHttpService } from '../../runner/http-observer.ts'
import type { RunningHandle, StartContext } from '../types.ts'
import { attachmentUrls, planExistingServer } from './preflight.ts'

export async function startExistingServer(ctx: StartContext): Promise<RunningHandle> {
  const plan = ctx.plan
  if (plan.strategy !== 'attach' || plan.process.kind !== 'attach') throw new Error('Existing service requires an attach plan')
  const target = { projectId: plan.projectId, targetId: plan.targetId, selector: plan.selector, scope: plan.scope, ...(plan.route ? { route: plan.route } : {}) }
  const checked = await planExistingServer(ctx, target, plan.scenario, { requirements: plan.requirements, ...(plan.route ? { route: plan.route } : {}), ...(plan.viewport ? { viewport: plan.viewport } : {}) })
  if (checked.kind !== 'plan') throw new Error('Existing service bindings are not executable')
  const urls = attachmentUrls(ctx, target, plan.route)
  if (plan.process.origin !== urls.origin) throw new Error('Configured origin changed before attach')
  ctx.signal.throwIfAborted()
  await probeHttpService(urls.probe, ctx.signal, Math.max(1, ctx.deadline - Date.now()))
  ctx.signal.throwIfAborted()
  ctx.emit({ type: 'evidence', layer: 'serviceReachable', evidence: { status: 'proven', at: new Date().toISOString(), detail: 'Configured local service probe returned a successful response without credentials or redirects; target rendering remains unverified' } })
  const monitoring = observeHttpService(urls.probe, ctx.signal, () => {
    ctx.emit({ type: 'diagnostic', diagnostic: { code: DiagnosticCode.runtimeError, phase: 'ready', message: 'Existing service is no longer reachable at its configured probe', hint: 'Check the configured service is still running and reachable at its probe path; the preview only detaches and does not stop it' } })
    ctx.emit({ type: 'evidence', layer: 'serviceReachable', evidence: { status: 'failed', at: new Date().toISOString(), detail: 'The configured probe failed; target readiness is not implied' } })
  })
  return { url: urls.url, async stop() { await monitoring.stop(); return { residual: [] } } }
}
