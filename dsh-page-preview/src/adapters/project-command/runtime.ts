/** 托管项目命令（方案 §6.5、§8、§9.2）；确认后显式启动，按实际进程树和端口归属接入，失败按账本回滚。 */
import { setTimeout as delay } from 'node:timers/promises'
import { DiagnosticCode, RunnerSessionError } from '../../shared/errors.ts'
import { fingerprintJson } from '../../shared/fingerprint.ts'
import { serviceUrls } from '../../shared/service-url.ts'
import { findListeningPids, findOwnedListeningPorts, isDescendantOf } from '../../runner/port-ownership.ts'
import { readProcessStartTime } from '../../runner/ledger.ts'
import { spawnManaged } from '../../runner/process-tree.ts'
import { UnsafeWindowsArgumentError } from '../../shared/runner/platform-env.ts'
import type { ManagedProcess } from '../../runner/process-tree.ts'
import { observeHttpService, probeHttpService } from '../../runner/http-observer.ts'
import type { RunningHandle, StartContext } from '../types.ts'
import { planProjectCommand } from './preflight.ts'

export async function startProjectCommand(ctx: StartContext): Promise<RunningHandle> {
  const plan = ctx.plan
  if (plan.strategy !== 'project' || plan.process.kind !== 'managed') throw problem(DiagnosticCode.configInvalid, 'Project command requires an owned managed plan')
  const target = { projectId: plan.projectId, targetId: plan.targetId, selector: plan.selector, scope: plan.scope, ...(plan.route ? { route: plan.route } : {}) }
  const checked = await planProjectCommand(ctx, target, plan.scenario, { requirements: plan.requirements, ...(plan.route ? { route: plan.route } : {}), ...(plan.viewport ? { viewport: plan.viewport } : {}) })
  if (checked.kind !== 'plan' || fingerprintJson(checked.plan.process) !== fingerprintJson(plan.process)) throw problem(DiagnosticCode.configInvalid, 'Command bindings changed or contradict the approved configuration')
  if (!ctx.verifyExecution) throw problem(DiagnosticCode.configChangedNeedsApproval, 'The Runner execution-approval verifier is not connected')
  await ctx.verifyExecution()
  ctx.signal.throwIfAborted()
  let process: ManagedProcess
  try { process = await spawnManaged({ executable: plan.process.executable, args: [...plan.process.args], cwd: plan.process.cwd, env: { ...plan.process.env } }, ctx.ledger, ctx, ctx.signal) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw problem(DiagnosticCode.dependencyMissing, 'Configured executable was not found in the explicit child environment; '
        + 'use an absolute path or an explicit PATH' + windowsCommandHint(), error)
    }
    if (error instanceof UnsafeWindowsArgumentError) throw problem(DiagnosticCode.configInvalid, error.message + '; remove %, " and line breaks from the command arguments', error)
    throw error
  }
  let exit: Awaited<typeof process.exited> | undefined
  let lifecycleFailed = false
  let started = false
  let stopping = false
  let stopped = false
  let stoppingTask: Promise<{ residual: string[] }> | undefined
  let port: number | undefined
  let portEntry: string | undefined
  let observer: ReturnType<typeof observeHttpService> | undefined
  void process.exited.then(value => {
    exit = value
    if (started && !stopping) ctx.emit({ type: 'exited', ...value })
  }, () => {
    lifecycleFailed = true
    if (started && !stopping) ctx.emit({ type: 'evidence', layer: 'serviceReachable', evidence: { status: 'failed', detail: 'Managed command lifecycle could not be observed' } })
  })
  // 必须持续排空管道，但原始输出可能含凭据，不能直接进入日志或模型诊断。
  const drains = [process.stdout, process.stderr].map(async output => {
    try { for await (const _chunk of output) { /* intentionally not persisted or forwarded */ } }
    catch {
      if (!stopping) ctx.emit({ type: 'diagnostic', diagnostic: { code: DiagnosticCode.runtimeError, phase: started ? 'ready' : 'start', message: 'Preview command output stream failed', hint: 'Run the configured command directly in the project to see its output; raw output is not forwarded' } })
    }
  })
  const stop = (): Promise<{ residual: string[] }> => {
    if (stopped) return Promise.resolve({ residual: [] })
    if (stoppingTask) return stoppingTask
    stopping = true
    stoppingTask = (async () => {
      const residual: string[] = []
      try { await observer?.stop() } catch { residual.push('HTTP observer cleanup failed') }
      try { residual.push(...(await process.stop()).map(pid => 'Managed process ' + pid)) }
      catch { residual.push('Managed process cleanup could not be confirmed') }
      if (!residual.length) await Promise.all(drains)
      if (port && portEntry) {
        try {
          if ((await findListeningPids(port)).length) residual.push('Managed listener ' + port)
          else { await ctx.ledger.release(portEntry); portEntry = undefined }
        } catch { residual.push('Managed listener ownership could not be checked') }
      }
      if (!residual.length) stopped = true
      return { residual }
    })().finally(() => { stoppingTask = undefined })
    return stoppingTask
  }
  try {
    const configured = ctx.config.project.runtime.origin
    const expectedPort = configured ? Number(new URL(configured).port || (new URL(configured).protocol === 'https:' ? 443 : 80)) : undefined
    let urls: ReturnType<typeof serviceUrls> | undefined
    while (!urls) {
      ctx.signal.throwIfAborted()
      if (exit) throw problem(DiagnosticCode.runtimeError, 'Preview command exited before service readiness (code=' + exit.code + ', signal=' + exit.signal + ')')
      if (lifecycleFailed || await readProcessStartTime(process.pid) !== process.startTime) throw problem(DiagnosticCode.ownershipUnverified, 'Preview command identity could not be confirmed before service readiness')
      if (Date.now() >= ctx.deadline) throw problem(DiagnosticCode.startTimeout, 'Preview command did not expose a verified service before its deadline')
      const ports = await findOwnedListeningPorts(process.pid)
      if (expectedPort !== undefined) {
        const listeners = await findListeningPids(expectedPort)
        for (const pid of listeners) if (!await isDescendantOf(pid, process.pid)) throw problem(DiagnosticCode.portConflict, 'Configured preview port belongs to another process')
        port = ports.includes(expectedPort) ? expectedPort : undefined
      } else {
        if (ports.length > 1) throw problem(DiagnosticCode.ambiguousTarget, 'Several owned loopback ports were found; configure one origin explicitly')
        port = ports[0]
      }
      if (port !== undefined) {
        const origin = configured ?? 'http://127.0.0.1:' + port
        const candidate = serviceUrls(origin, plan.selector, plan.route, ctx.config.project.runtime.readiness?.probePath)
        // 只在 PID/端口归属成立之后发 HTTP，不向端口上的其他用户服务试探。
        try {
          await probeHttpService(candidate.probe, ctx.signal, Math.min(1000, Math.max(1, ctx.deadline - Date.now())))
          urls = candidate
        } catch {
          ctx.signal.throwIfAborted()
          if (exit) throw problem(DiagnosticCode.runtimeError, 'Preview command exited during service readiness checks')
        }
      }
      if (!urls) await delay(50, undefined, { signal: ctx.signal })
    }
    if (port === undefined) throw problem(DiagnosticCode.ownershipUnverified, 'No owned service port was selected')
    // 端口扫描与探针之间存在 TOCTOU：服务可能在扫描后才绑定第二个监听端口。
    // 未显式配置 origin 时复核一次，绝不替用户在多个候选端口中做选择。
    if (expectedPort === undefined && (await findOwnedListeningPorts(process.pid)).length > 1) {
      throw problem(DiagnosticCode.ambiguousTarget, 'Several owned loopback ports were found; configure one origin explicitly')
    }
    const listeners = await findListeningPids(port)
    for (const pid of listeners) if (!await isDescendantOf(pid, process.pid)) throw problem(DiagnosticCode.ownershipUnverified, 'Preview listener ownership changed before registration')
    const listenerPid = listeners[0]
    if (listenerPid === undefined) throw problem(DiagnosticCode.ownershipUnverified, 'Preview listener disappeared before registration')
    portEntry = (await ctx.ledger.record({ previewId: ctx.previewId, ownerSessionId: ctx.ownerSessionId, workspaceRoot: ctx.workspaceRoot, resource: { kind: 'port', port, pid: listenerPid } })).id
    ctx.signal.throwIfAborted()
    if (exit) throw problem(DiagnosticCode.runtimeError, 'Preview command exited before readiness could be confirmed')
    observer = observeHttpService(urls.probe, ctx.signal, () => {
      ctx.emit({ type: 'evidence', layer: 'serviceReachable', evidence: { status: 'failed', at: new Date().toISOString(), detail: 'Owned project service health probe failed' } })
    })
    started = true
    ctx.emit({ type: 'evidence', layer: 'serviceReachable', evidence: { status: 'proven', at: new Date().toISOString(), detail: 'Loopback listener belongs to the managed command tree and its configured probe succeeded' } })
    return { url: urls.url, stop }
  } catch (error) {
    if ((await stop()).residual.length) throw problem(DiagnosticCode.cleanupFailed, 'Project command startup rollback is incomplete; inspect resource ownership records', error)
    throw error
  }
}

/** Windows 上不带扩展名的 npm/pnpm/yarn 找不到：它们是 .cmd 脚本，spawn 不按 PATHEXT 补全。 */
function windowsCommandHint(): string {
  return globalThis.process.platform === 'win32' ? ' (on Windows, name scripts with their extension, e.g. npm.cmd)' : ''
}

function problem(code: string, message: string, cause?: unknown): RunnerSessionError {
  return new RunnerSessionError({ code, phase: 'start', message, hint: 'Verify the configured command/probe and that the port is not held by another process; run the command directly to reproduce the failure' }, cause)
}
