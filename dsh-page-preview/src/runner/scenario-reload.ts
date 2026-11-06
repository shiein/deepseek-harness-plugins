/**
 * 场景重新加载与切换（方案 §7.4、§11；R3 计划 R3-2）。Runner 编排侧。
 *
 * 两个入口共用同一机制：
 *   - refresh 带 scenario：切换到另一个已配置场景
 *   - refresh 不带 scenario：重新读取当前场景的数据（fixture/businessPaths/props 等），
 *     使 Agent 按 R3-1 草稿编辑配置后无需重开预览
 *
 * 流程：
 *   1. 重新加载项目配置（与 start 同一来源规则），核对执行指纹与本预览批准的指纹一致：
 *      handlers/setup/command/env 任一变化 → config_changed_needs_approval，要求重新 open，不在此处批准
 *   2. 校验目标场景存在；其 handlers 绑定须与当前场景一致（worker 已按批准加载的模块不能换）
 *   3. 计算新 scenario 指纹（与计划阶段同一算法：scene + fixture 文件哈希）
 *   4. 交给 RunningHandle.switchScenario(update)；默认语义是"重建本预览拥有的上下文"：
 *      换 Mock 中间件与 ScenarioStore、重新生成预览入口中的场景数据、整页重载；不原地改 Store。
 *      worker 侧入口未能生效时（CLI 重写后编译失败/超时）不换绑、不回滚场景名，
 *      如实回报未应用（applied:false → compile-error outcome），旧场景 Mock/Store 一致服务（R5-0b）
 *   5. 调用方清空 UnmatchedRequestLog；freshness 回到 unverified，等浏览器证明新文档已应用
 *   6. 不清理用户的 Cookie/Storage（§7.4）
 *
 * 能力声明：scenarioReset 只能写 unknown（附原因），样本验证后（T 阶段）才可改为 supported。
 */

import type { PreviewPlan } from '../shared/contracts.ts'
import type { ScenarioConfig } from '../shared/config/schema.ts'
import type { ScenarioUpdate } from '../shared/scenario-update.ts'
import { DiagnosticCode, RunnerSessionError } from '../shared/errors.ts'
import { loadWorkspaceProjects } from '../shared/config/projects.ts'
import { resolveProjectPath } from '../shared/config/paths.ts'
import { collectExecutionItems, executionFingerprint, requiresExecutionApproval } from '../shared/config/fingerprint.ts'
import { fingerprintJson } from '../shared/fingerprint.ts'
import { inspectScenarioFixtures } from '../scenario/preflight.ts'

export interface ScenarioReloadInput {
  workspaceRoot: string
  dataDir: string
  configFile?: string
  plan: PreviewPlan
  /** 缺省表示重新加载当前场景；plan.scenario 必须已选。 */
  scenario?: string
  /** start 时用户批准过的执行指纹；执行项无批准要求时缺失。 */
  approval?: { fingerprint: string }
  /** 本预览启动时实际加载的项目 handler 声明路径；缺省表示启动时无 handler 绑定。 */
  initialHandlers?: string
}

/**
 * 只读复核 + 组装 ScenarioUpdate。不启动/执行任何项目代码；fixture 文件只读哈希。
 * 拒绝情形（都在动 worker 之前）：配置或执行项变化、目标场景缺失、handler 绑定变化。
 */
export async function prepareScenarioUpdate(input: ScenarioReloadInput): Promise<ScenarioUpdate> {
  const selected = (await loadWorkspaceProjects(input.workspaceRoot, input.configFile, { dataDir: input.dataDir }))
    .find(value => value.config.project.id === input.plan.projectId)
  if (!selected) throw problem(DiagnosticCode.configInvalid, 'Configured project disappeared before scenario update')
  const { config } = selected
  const appRoot = await resolveProjectPath(input.workspaceRoot, config.project.root)
  // 执行项不变：与 start 同一指纹算法；handlers/setup/command/env/generatedSetup 任一变化即拒绝。
  if (requiresExecutionApproval(config.project, input.plan.generatedSetup?.hash)) {
    const fingerprint = executionFingerprint(
      await collectExecutionItems(appRoot, config.project), input.plan.generatedSetup?.hash)
    if (input.approval?.fingerprint !== fingerprint) {
      throw problem(DiagnosticCode.configChangedNeedsApproval,
        'Execution items changed since approval; open a new preview and ask the user to approve again')
    }
  }
  const name = input.scenario ?? input.plan.scenario
  if (name === undefined) {
    throw problem(DiagnosticCode.configInvalid,
      'This preview has no scenario to reload; open with a scenario or pass one explicitly')
  }
  const scene = config.project.scenarios?.[name]
  if (!scene) {
    throw problem(DiagnosticCode.configInvalid,
      'Requested scenario is not configured; open a new preview with an existing scenario name')
  }
  // 已加载 handler 绑定不得换模块：以启动时实际加载的声明路径为不变量——
  // 目标场景的 handlers 必须与它一致（含"配置删掉了 handlers"这种指纹检查覆盖不到的情形）。
  if ((scene.handlers ?? undefined) !== input.initialHandlers) {
    throw problem(DiagnosticCode.configChangedNeedsApproval,
      'Scenario switch would change the loaded project handler module; open a new preview for this scenario')
  }
  // 与计划阶段同一预检：businessPaths/fixture 形状/bodyFile 绑定 + fixture 文件哈希。
  const files = await inspectScenarioFixtures(appRoot, scene, config.project.runtime.dependencyRoots)
  const scenario: ScenarioConfig = structuredClone(scene)
  return { name, scenario, fingerprint: fingerprintJson({ scene, files: Object.fromEntries(files) }) }
}

function problem(code: string, message: string): RunnerSessionError {
  return new RunnerSessionError({
    code, phase: 'scenario', message,
    hint: 'Edit the scenario configuration or reopen with page_preview_open; '
      + 'scenario updates never relax execution approval',
  })
}


