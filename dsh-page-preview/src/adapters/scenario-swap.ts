/**
 * 自有 worker 内的场景替换（方案 §7.4；R3 计划 R3-2）。Vue/React 各宿主 worker 共用，避免多份实现。
 *
 * 用法：worker 启动时 createSwappableScenario(...) 持有可替换引用；请求管线固定调用
 * swappable.middleware(req, res, next)，内部转给当前 Mock 中间件（无当前场景时直接 next）。
 * replace(name, scenario)：用新 ScenarioConfig 构建新中间件 + 新 ScenarioStore，原子替换引用；
 * 旧 store 丢弃——不原地改 Store，不清理用户的 Cookie/Storage（§7.4）。
 *
 * 执行项边界：handlers 模块与 store 的 handler 绑定在执行批准时固定；replace 不重新加载项目模块，
 * 只换 fixture/businessPaths/store 数据面。handlers 变化由 Runner prepareScenarioUpdate 的
 * 执行指纹核对拒绝，此处再按 handlers 引用恒等断言一次（防御，不是替代审批）。
 *
 * 组件中立：不出现任何 UI 组件库分支（AGENTS.md §5 第 8 条）。
 */

import type { ScenarioConfig, WsFixture } from '../shared/config/schema.ts'
import type { Diagnostic } from '../shared/contracts.ts'
import type { Middleware } from '../runner/response-layer/server.ts'
import { createMockMiddleware } from '../scenario/mock-middleware.ts'
import { ScenarioStore } from '../scenario/store.ts'
import { readScenarioBodyFile } from '../scenario/files.ts'
import type { ProjectHandler } from '../scenario/handlers.ts'

export interface SwappableScenarioOptions {
  previewOrigin: string
  appRoot: string
  dependencyRoots?: readonly string[]
  /** 已在执行复核后由 Runner 加载的项目 handler；replace 中不重新加载。 */
  handlers: readonly ProjectHandler[]
  onUnmatched(request: { method: string; url: string; queryKeys?: string[] }): void
  onDiagnostic(diagnostic: Diagnostic): void
  /** 初始场景；缺省时 middleware 一律放行（业务请求落到调用方的未命中分支）。 */
  initial?: { name: string; scenario: ScenarioConfig }
}

export interface SwappableScenario {
  /** 当前场景名；无当前场景时缺失。 */
  readonly current: string | undefined
  /** 固定引用的中间件入口；内部转发到当前 Mock。 */
  readonly middleware: Middleware
  /** R5-1g：当前场景声明的 WS 通道；Upgrade 准入用它判断，替换场景即换表。 */
  readonly wsFixtures: () => readonly WsFixture[]
  /** 替换 Mock 中间件与场景存储；返回后新请求不再命中旧 fixture。 */
  replace(name: string, scenario: ScenarioConfig): void
}

export function createSwappableScenario(options: SwappableScenarioOptions): SwappableScenario {
  let current: string | undefined
  let mock: Middleware | undefined
  let ws: readonly WsFixture[] = []
  // 已加载 handler 模块的绑定路径；替换只允许同一绑定（不同绑定意味着要执行另一个项目模块）。
  const handlersPath = options.initial?.scenario.handlers
  const build = (name: string, scenario: ScenarioConfig) => createMockMiddleware({
    previewOrigin: options.previewOrigin,
    businessPaths: scenario.businessPaths ?? [],
    fixtures: scenario.http ?? [],
    ...(scenario.envelope === undefined ? {} : { envelope: scenario.envelope }),
    sse: scenario.sse ?? [],
    handlers: options.handlers,
    store: new ScenarioStore(name),
    readBodyFile: file => readScenarioBodyFile(options.appRoot, file, options.dependencyRoots),
    onUnmatched: options.onUnmatched,
    onDiagnostic: options.onDiagnostic,
  })
  if (options.initial) {
    mock = build(options.initial.name, options.initial.scenario)
    ws = options.initial.scenario.ws ?? []
    current = options.initial.name
  }
  return {
    get current() { return current },
    get wsFixtures() { return () => ws },
    middleware(req, res, next) {
      // 无当前场景时交给调用方的未命中分支，与启动时未创建 Mock 的原行为一致。
      if (mock === undefined) { next(); return }
      mock(req, res, next)
    },
    replace(name, scenario) {
      if (scenario.handlers !== handlersPath) {
        throw new Error('Scenario switch would change the loaded project handler module')
      }
      const next = build(name, scenario)
      // 先构建成功再换引用：新场景无效时旧 Mock 仍在服务，不半切。
      mock = next
      ws = scenario.ws ?? []
      current = name
    },
  }
}
