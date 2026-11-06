/** Vue Vite 执行器入口（方案 §6.5、§6.8、§9.2）：所有权/就绪编排共用 ../../worker-host.ts，本文件只保留 Vite 差异。 */
import { fileURLToPath } from 'node:url'
import { relative, sep } from 'node:path'
import type { InputsChangedOutcome, RunningHandle, StartContext } from '../../types.ts'
import { readVueBuildConfig } from '../readonly-config.ts'
import { planVue } from '../preflight.ts'
import { startWorkerHost } from '../../worker-host.ts'
import { parseViteWorkerOutput, VITE_PAGE_PATH } from './protocol.ts'
import type { ViteWorkerOutput } from './protocol.ts'
import { unverifiedViteFacts } from './profile.ts'

export function startVueVite(ctx: StartContext): Promise<RunningHandle> {
  return startWorkerHost<ViteWorkerOutput>(ctx, {
    adapterId: 'vue-vite',
    framework: 'Vue',
    label: 'Vite',
    workerScript: fileURLToPath(new URL(
      import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url)),
    tmpPrefix: 'dsh-preview-vue-',
    pagePath: VITE_PAGE_PATH,
    compileLabel: 'Vite',
    blockedBinding: 'the owned same-origin HMR binding',
    unverifiedFacts: unverifiedViteFacts,
    verifyBindings: (c, plan) => planVue(c,
      { projectId: plan.projectId, targetId: plan.targetId, selector: plan.selector, scope: plan.scope },
      'vite', plan.scenario, {
        requirements: plan.requirements,
        ...(plan.viewport ? { viewport: plan.viewport } : {}),
        ...(plan.route ? { route: plan.route } : {}),
      }).then(outcome => outcome.kind === 'plan' ? outcome.plan : undefined),
    parseOutput: parseViteWorkerOutput,
    classify: message => ({ kind: 'shared', message }),
    extend() {
      return {
        /**
         * R3-5：vite.config.* 变化无法就地生效（dev server 绑定与响应层是启动时建立的）
         * → restart-required；其余源文件/public 资产由 Vite watch 与 HMR 边界覆盖，如实 ignored。
         */
        async inputsChanged(paths: string[]): Promise<InputsChangedOutcome> {
          const configFiles = await readVueBuildConfig(ctx.appRoot, 'vite')
            .then(value => value.files, () => [] as string[])
          const hit = configFiles.map(file => relative(ctx.appRoot, file).split(sep).join('/'))
            .filter(file => paths.includes(file))
          if (hit.length) return { kind: 'restart-required',
            reason: 'Vite build configuration changed (' + hit.join(', ') + ')' }
          return { kind: 'ignored', reason: 'Vite watch and the owned HMR channel already apply module changes' }
        },
      }
    },
  })
}
