/** Vue CLI 执行器入口（方案 §6.9、§9.2）：所有权/就绪编排共用 ../../worker-host.ts，本文件只保留 CLI 差异。 */
import { fileURLToPath } from 'node:url'
import { relative, sep } from 'node:path'
import { DiagnosticCode, RunnerSessionError } from '../../../shared/errors.ts'
import type { InputsChangedOutcome, RunningHandle, StartContext, UpdateOutcome } from '../../types.ts'
import { readVueBuildConfig } from '../readonly-config.ts'
import { planVue } from '../preflight.ts'
import { startWorkerHost } from '../../worker-host.ts'
import type { WorkerHostApi } from '../../worker-host.ts'
import { parseCliWorkerOutput, CLI_PAGE_PATH } from './protocol.ts'
import type { CliWorkerOutput } from './protocol.ts'
import { unverifiedCliFacts } from './profile.ts'

function problem(message: string) {
  return new RunnerSessionError({ code: DiagnosticCode.runtimeError, phase: 'start', message,
    hint: 'Verify the configured target/entry bindings and installed toolchain in package.json, then retry; ' +
      'no dependencies were installed or requirements relaxed',
  })
}

export function startVueCli(ctx: StartContext): Promise<RunningHandle> {
  let refreshWaiter: { resolve: (stale: boolean) => void; reject: (error: unknown) => void } | undefined
  return startWorkerHost<CliWorkerOutput>(ctx, {
    adapterId: 'vue-cli',
    framework: 'Vue',
    label: 'Vue CLI',
    workerScript: fileURLToPath(new URL(
      import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url)),
    tmpPrefix: 'dsh-preview-vue-cli-',
    pagePath: CLI_PAGE_PATH,
    compileLabel: 'Webpack',
    blockedBinding: 'the owned same-origin binding',
    unverifiedFacts: unverifiedCliFacts,
    verifyBindings: (c, plan) => planVue(c,
      { projectId: plan.projectId, targetId: plan.targetId, selector: plan.selector, scope: plan.scope },
      'vue-cli', plan.scenario, {
        requirements: plan.requirements,
        ...(plan.viewport ? { viewport: plan.viewport } : {}),
        ...(plan.route ? { route: plan.route } : {}),
      }).then(outcome => outcome.kind === 'plan' ? outcome.plan : undefined),
    parseOutput: parseCliWorkerOutput,
    classify: message => message.type === 'refresh-ack' || message.type === 'dev-server-diff'
      ? { kind: 'extra', message }
      : { kind: 'shared', message },
    onExtra(message, api) {
      if (message.type === 'refresh-ack') {
        const waiter = refreshWaiter
        if (!waiter) throw new Error('Unexpected Vue CLI refresh acknowledgement')
        refreshWaiter = undefined
        waiter.resolve(message.stale)
      } else if (message.type === 'dev-server-diff') ctx.emit({ type: 'diagnostic', diagnostic: {
        code: DiagnosticCode.devServerTakenOver, phase: 'start',
        message: 'Project devServer fields were taken over by the owned preview layer: ' +
          message.fields.map(field => field.key + ' (' + field.action + ')').join(', '),
        hint: 'Serve business data through declared scenario http/handlers fixtures; ' +
          'project devServer proxy and middleware hooks never execute',
      } })
    },
    extend(api: WorkerHostApi) {
      api.onFail(error => {
        const waiter = refreshWaiter
        refreshWaiter = undefined
        waiter?.reject(error)
      })
      // R2-P0-2：refresh 只递增 worker 的轮询 seq——浏览器经自有长轮询重载；编译失败态如实回 stale。
      const refresh = (): Promise<UpdateOutcome> => {
        if (!api.active()) return Promise.reject(problem('Vue CLI executor is not in a refreshable state'))
        if (refreshWaiter) return Promise.reject(problem('A Vue CLI refresh is already in flight'))
        const outcome = new Promise<boolean>((resolve, reject) => { refreshWaiter = { resolve, reject } })
        void api.send({ type: 'refresh' }).catch(error => {
          const waiter = refreshWaiter
          refreshWaiter = undefined
          waiter?.reject(error)
        })
        return outcome.then(stale => ({ kind: 'updated', freshness: stale ? 'stale' : 'unverified' }))
      }
      /**
       * R3-5：构建配置（vue.config.*）已随 devServer 接管绑定，无法就地生效 → restart-required；
       * 其余变化一律 refresh——webpack 重建链路覆盖被 watch 的文件，未被 watch 的文件（public/ 等）
       * 随文档重载重新读取；已覆盖文件的额外重载是幂等的。
       */
      const inputsChanged = async (paths: string[]): Promise<InputsChangedOutcome> => {
        const configFiles = await readVueBuildConfig(ctx.appRoot, 'vue-cli')
          .then(value => value.files, () => [] as string[])
        const hit = configFiles.map(file => relative(ctx.appRoot, file).split(sep).join('/'))
          .filter(file => paths.includes(file))
        if (hit.length) return { kind: 'restart-required',
          reason: 'Vue CLI build configuration changed (' + hit.join(', ') + ')' }
        return { kind: 'refresh' }
      }
      return { refresh, inputsChanged }
    },
  })
}
