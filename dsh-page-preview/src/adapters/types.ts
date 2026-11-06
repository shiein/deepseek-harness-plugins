/**
 * 核心适配器契约（方案 §11）。
 * 接口中不得出现 configureVite、VNode、ReactNode、.vue/.tsx 等具体技术；这些留在具体适配器内部。
 *
 * - probe / discover / plan：只读文件与配置，不执行项目代码；需要执行才能确认的能力为 unknown
 * - start：接受取消信号与截止时间；失败或取消时回收已分配资源
 * - 运行句柄按能力提供 refresh / switchScenario / capture；缺失能力由核心统一报错
 * - attach 的 stop 语义是脱离
 */

import type {
  Candidate,
  CapabilitySet,
  Diagnostic,
  Evidence,
  Freshness,
  PageTextObservation,
  PreviewPlan,
  Requirement,
  SetupDraftSummary,
  Strategy,
  Viewport,
} from '../shared/contracts.ts'
import type { EffectiveProjectConfig } from '../shared/config/loader.ts'
import type { ScenarioUpdate } from '../shared/scenario-update.ts'
import type { AppProfile } from '../shared/profile.ts'
import type { FileChange } from '../core/change/baseline.ts'
import type { AdapterImpact } from '../core/impact/types.ts'
import type { ResolvedTarget } from '../core/target/resolve.ts'
import type { ResourceLedger } from '../runner/ledger.ts'
import type { ResponseLayer } from '../runner/response-layer/server.ts'

export interface AdapterContext {
  workspaceRoot: string
  /** 绝对路径。 */
  appRoot: string
  profile: AppProfile
  config: EffectiveProjectConfig
}

export interface ProbeResult {
  matched: boolean
  evidence: string[]
  /** 候选能力；最终能力由 plan 结合完整路径判定。 */
  capabilities: Partial<CapabilitySet>
  limits: string[]
}

export interface DiscoverResult {
  candidates: Candidate[]
  /** 不能构建依赖图时为 true，只支持手动目标。 */
  manualOnly: boolean
  unresolved: string[]
}

/** 适配器产出的待确认 setup 草稿（§6.9）；source 只用于写入插件数据目录，不随工具输出返回。 */
export interface SetupDraftPayload extends Omit<SetupDraftSummary, 'path'> {
  source: string
}

export type AdapterPlanOutcome =
  // diagnostics：随计划提交的非阻断信息性诊断（如 R3-3 检出的项目自有 Mock），不进入 plan.missing。
  | { kind: 'plan'; plan: PreviewPlan; diagnostics?: Diagnostic[] }
  | { kind: 'missing'; missing: Diagnostic[]; setupDraft?: SetupDraftPayload }
  // unsupported 是终态（§4.2）：适配路径未实现该能力；missing/setupDraft 继续并列展示，不被终态吞并。
  | { kind: 'unsupported'; reason: string; missing?: Diagnostic[]; setupDraft?: SetupDraftPayload }

export interface AdapterPlanOptions {
  requirements: readonly Requirement[]
  viewport?: Viewport
  route?: PreviewPlan['route']
}

export type RunEvent =
  | { type: 'page-text'; observation: PageTextObservation }
  | { type: 'evidence'; layer: 'serviceReachable' | 'documentLoaded' | 'targetMounted'; evidence: Evidence }
  | { type: 'diagnostic'; diagnostic: Diagnostic }
  | { type: 'freshness'; freshness: Freshness }
  | { type: 'exited'; code: number | null; signal: string | null }
  /**
   * 一次未命中的业务请求（R3-1）：只带 method/origin/path 与 query 键名，供 Runner 汇总；
   * 展示仍由 unmatched_request 诊断承担。query 值、请求体、headers 一律不出现。
   */
  | { type: 'unmatched'; request: { method: string; origin?: string; path: string; queryKeys?: string[] } }

export interface StartContext extends AdapterContext {
  previewId: string
  ownerSessionId: string
  plan: PreviewPlan
  signal: AbortSignal
  /** epoch ms */
  deadline: number
  ledger: ResourceLedger
  /** Runner 提供的执行前复核；运行项目命令/模块的适配器必须调用，不能由 Agent 填写。 */
  verifyExecution?(): Promise<void>
  /** 自有服务的受控响应层（static / isolated / 可选 project 代理）；attach 不使用。 */
  responseLayer?: ResponseLayer
  /**
   * 插件数据目录下按应用根划分的持久构建缓存根（Vite 依赖预构建）。跨预览复用以免每次冷启动重新预构建；
   * 不写入目标项目，不登记为单次预览资源（它是插件自有的长期缓存）。缺省时适配器退回每预览临时目录。
   */
  buildCacheRoot?: string
  emit(event: RunEvent): void
}

/** 更新必须对应实际目标或产物，不能只确认“请求已接收”。 */
export type UpdateOutcome =
  | { kind: 'updated'; freshness: Freshness }
  | { kind: 'compile-error'; diagnostics: Diagnostic[] }
  | { kind: 'restart-required'; reason: string }

/** inputs-changed 的适配器裁量（§9.1、R3-5）：ignored 如实声明变化已由本预览自身机制覆盖。 */
export type InputsChangedOutcome =
  | { kind: 'ignored'; reason: string }
  | { kind: 'refresh' }
  | { kind: 'restart-required'; reason: string }

export interface RunningHandle {
  url: string
  /** 预览自有通道值（回传 nonce 等）；只用于会话级诊断与调试日志脱敏，不返回给模型。 */
  channelSecrets?: readonly string[]
  refresh?(): Promise<UpdateOutcome>
  /**
   * 场景重新加载/切换（§7.4、R3-2）：重建本预览拥有的场景上下文（Mock/Store/入口数据）后整页重载。
   * 缺失表示该适配路径不支持就地场景更新，由核心统一报 unsupported_capability。
   */
  switchScenario?(update: ScenarioUpdate): Promise<UpdateOutcome>
  /**
   * R3-5：turn/end 后通知本预览应用内非执行输入已变化（应用根相对路径，POSIX 分隔）。
   * 适配器裁量：refresh（文档重载拾取）、ignored（本预览机制已覆盖，如 dev server watch/HMR）、
   * restart-required（构建配置等无法就地生效）。缺失表示该路径无裁量通道，会话层按"未覆盖"如实记 stale。
   * 执行项输入（setup/handlers、.env 系文件与配置文件）由会话层先判，不进入这里。
   */
  inputsChanged?(paths: string[]): Promise<InputsChangedOutcome>
  /** 返回本次停止后仍残留的资源描述；空数组表示全部回收。 */
  stop(): Promise<{ residual: string[] }>
}

/**
 * 适配器在 Runner 执行路径上接受的计划特性（R3-0，取代 runner/controller.ts 中按适配器 ID 写死的分支，
 * 即 review-2026-11-01 的 P2-3）。只是"本适配器实现了该机制"，不等于能力 supported。
 */
export interface AdapterFeatures {
  /** 接受 plan.scenario（初始场景应用）。 */
  scenarios: boolean
  /** 接受 plan.readiness.assertions（bootstrap 目标断言）。 */
  targetAssertions: boolean
  /** 接受 requirements 中的 isolated-target 以及 runtime.entry / runtime.styles。 */
  isolatedTarget: boolean
}

export interface Adapter {
  readonly id: string
  readonly version: string
  readonly strategies: readonly Strategy[]
  /**
   * 本适配器在 Runner 执行路径上接受的计划特性（R3-0，P2-3）；只是"实现了该机制"，
   * 不等于能力 supported。缺失声明视为全部 false。
   */
  readonly features: AdapterFeatures
  probe(ctx: AdapterContext, target?: ResolvedTarget): Promise<ProbeResult>
  discover(ctx: AdapterContext): Promise<DiscoverResult>
  plan(ctx: AdapterContext, target: ResolvedTarget, scenario?: string, options?: AdapterPlanOptions): Promise<AdapterPlanOutcome>
  start(ctx: StartContext): Promise<RunningHandle>
  /**
   * 只读影响分析（R3-4，方案 §5.2）：Host 在 probe/discover/plan 同级的只读阶段调用，不执行项目代码。
   * 未实现的适配器（existing-server、project-command）由 core 写入 gaps。
   */
  impact?(ctx: AdapterContext, changes: readonly FileChange[]): Promise<AdapterImpact>
}
