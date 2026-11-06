/**
 * Host、Runner、Client 共用的契约类型。
 * 对应方案 §4.2（工具契约）、§6.2（计划与能力）、§9.2（生命周期）、§9.3（采集记录）。
 *
 * 约束：只放类型与常量，不引入运行时依赖；任何字段语义变更必须同步修改方案文档。
 */

import type { FixtureDraft } from './fixture-draft.ts'
import type { UnmatchedSnapshot } from './unmatched.ts'

export type Strategy = 'static' | 'isolated' | 'project' | 'attach'
export type StrategyRequest = Strategy | 'auto'
export type Scope = 'page' | 'component' | 'shell'
export type Requirement = 'isolated-target' | 'mock-only'

/** 单次只接受一个选择器（§4.2）。路径基准：有 projectId 时相对应用根，否则相对工作区。 */
export type TargetSelector =
  | { kind: 'registered'; id: string }
  | { kind: 'file'; path: string; exportName?: string }
  | { kind: 'route'; path: string; params?: Record<string, string>; query?: Record<string, string>;
    /** true 时渲染该路由的完整父布局链（router-view 宿主），默认只渲染路由叶子组件（R5-4）。 */
    layout?: boolean }
  | { kind: 'story'; id: string }
  | { kind: 'url'; url: string }

export interface Viewport {
  width: number
  height: number
}

/** 工具调用结果（§4.2）；与会话生命周期 SessionState 分开。 */
export type ResultStatus =
  | 'ok'
  | 'needs_selection'
  | 'needs_configuration'
  | 'unsupported'
  | 'not_found'
  | 'busy'
  | 'error'

/** 预览会话生命周期（§9.2）。只有存在 previewId 时才有 state。 */
export type SessionState =
  | 'preparing'
  | 'starting'
  | 'reachable'
  | 'ready'
  | 'degraded'
  | 'updating'
  | 'failed'
  | 'stopping'
  | 'stopped'
  | 'cleanup_failed'

/** 源码/产物对应关系（§6.7），独立于生命周期。 */
export type Freshness = 'current' | 'stale' | 'unverified'

export type CapabilityStatus = 'supported' | 'conditional' | 'unsupported' | 'unknown'
/** 能力由谁提供（§6.8）。 */
export type CapabilitySource = 'response-layer' | 'carrier' | 'adapter' | 'project' | 'none'
export type RefreshMode = 'hmr' | 'reload' | 'rebuild' | 'manual'

/** 变更来源标签（§5.3）；不得声称可靠区分作者。 */
export type ChangeOrigin = 'agent-confirmed' | 'workspace-observed' | 'unknown'

export interface Capability {
  status: CapabilityStatus
  source: CapabilitySource
  /** supported 时列出覆盖范围。 */
  coverage?: string[]
  /** conditional 时列出需满足的条件。 */
  conditions?: string[]
  /** unsupported / unknown 时说明原因或待验证项。 */
  reason?: string
}

/** 网络覆盖按通道描述，不压缩成一个布尔值（§6.2、§7.3）。 */
export interface NetworkCoverage {
  channel:
    | 'browser-http'
    | 'browser-ws'
    | 'browser-sse'
    | 'service-worker'
    | 'dev-server-proxy'
    | 'build-process'
    | 'server-process'
  control: 'mock' | 'block' | 'observe' | 'none'
  location: CapabilitySource
  note?: string
}

export interface CapabilitySet {
  scopes: Partial<Record<Scope, Capability>>
  isolatedRender: Capability
  scenarioApply: Capability
  scenarioReset: Capability
  refresh: Capability & { mode?: RefreshMode }
  captureCurrentView: Capability
  runtimeErrors: Capability
  readinessAssertion: Capability
  network: NetworkCoverage[]
}

export type EvidenceStatus = 'proven' | 'failed' | 'unverified'

export interface Evidence {
  status: EvidenceStatus
  detail?: string
  /** ISO 8601 */
  at?: string
}

/** 就绪证据三层（§9.2）。 */
export interface ReadinessEvidence {
  serviceReachable: Evidence
  documentLoaded: Evidence
  targetMounted: Evidence
}

export const PAGE_TEXT_LIMIT = 2048

/** 最近一次受控目标文档的文本观察（§13 第 8 条脱敏后）；不等于当前画面或源码对应证明。 */
export interface PageTextObservation {
  text: string
  truncated: boolean
  url: string
  /** Runner 接收时间，ISO 8601。 */
  receivedAt: string
}

export type Phase =
  | 'resolve'
  | 'detect'
  | 'plan'
  | 'start'
  | 'ready'
  | 'update'
  | 'scenario'
  | 'capture'
  | 'stop'
  | 'config'
  | 'ledger'

export interface Diagnostic {
  code: string
  phase: Phase
  message: string
  hint?: string
  /** 所属预览；多预览平铺的列表里靠它区分归属，Host 在投影时按来源 preview 盖章。 */
  previewId?: string
  location?: { file?: string; line?: number; request?: string }
}

export interface Candidate {
  projectId: string
  selector: TargetSelector
  /** 例如 “样式 → 设置页面” 的关系链（§10）。 */
  relation: string[]
  evidence: 'strong' | 'medium' | 'weak'
  origin?: ChangeOrigin
  unresolved?: string[]
}

/** 进程或接入来源（§6.2、§8）。 */
export type ProcessSpec =
  | { kind: 'managed'; executable: string; args: string[]; cwd: string; env?: Record<string, string> }
  | { kind: 'in-runner' }
  | { kind: 'attach'; origin: string }

/** 启动前可检查的执行计划（§6.2）。 */
export interface PreviewPlan {
  projectId: string
  targetId: string
  selector: TargetSelector
  scope: Scope
  strategy: Strategy
  /** 导航上下文；文件/组件目标也可拥有路由，不把模块位置替换成 URL。 */
  route?: { path: string; params?: Record<string, string>; query?: Record<string, string> }
  /** 路由目标请求父布局时：挂载 router-view 宿主、导航到具体路由，渲染静态父链（R5-4）。 */
  layout?: boolean
  adapter: { id: string; version: string }
  toolchain: Record<string, string>
  requirements: Requirement[]
  scenario?: string
  viewport?: Viewport
  process: ProcessSpec
  readiness: {
    serviceDeadlineMs: number
    targetDeadlineMs: number
    /** 目标就绪断言（选择器/文本等），由 bootstrap 执行；没有时 targetMounted 只能 unverified。 */
    assertions?: TargetAssertion[]
  }
  capabilities: CapabilitySet
  /** 源文件、配置、场景指纹（§6.7）。 */
  fingerprints: { sources?: string; config: string; scenario?: string }
  /**
   * 项目未配置 runtime.setup 时插件从入口自动生成并使用的 setup（§0.3 第 10 条）。entry 相对应用根；
   * hash 是生成源码的摘要，计入执行指纹审批，worker 启动前重新生成并核对，入口改动后需重新批准。
   */
  generatedSetup?: { entry: string; hash: string }
  missing: Diagnostic[]
  knownDifferences: string[]
}

export type TargetAssertion =
  | { kind: 'selector-visible'; selector: string }
  | { kind: 'text-present'; text: string }
  | { kind: 'mount-signal' }

/** 默认输出摘要（§4.2 输出预算）。完整信息通过 detail 获取。 */
export interface PreviewSummary {
  previewId: string
  projectId: string
  targetId: string
  scope: Scope
  strategy: Strategy
  state: SessionState
  freshness: Freshness
  url?: string
  scenario?: string
  /** 只列 status 非 supported 的能力，减少上下文占用。 */
  capabilityGaps: Array<{ name: string; capability: Capability }>
  readiness: ReadinessEvidence
  /** 未命中业务请求的唯一条数（>0 才出现；detail=true 可取汇总与 fixture 草稿，§7.2、R3-1）。 */
  unmatchedCount?: number
  /** 超出汇总上限被丢弃的唯一条数（>0 才出现）。 */
  unmatchedDropped?: number
}

export interface ToolResultBase {
  status: ResultStatus
  diagnostics: Diagnostic[]
  /** 被截断的诊断条数。 */
  diagnosticsTruncated?: number
}

/** 面向模型的计划视图；不能当作可执行 PreviewPlan，参数/环境仅保留于 Host/Runner 和可信确认界面。 */
export type DisplayedPreviewPlan = Omit<PreviewPlan, 'process'> & {
  process: Exclude<ProcessSpec, { kind: 'managed' }> | {
    kind: 'managed'
    executable: string
    cwd: string
    executionDetailsOmitted: Array<'args' | 'env'>
  }
}

/** setup 草稿中的单项注册（§6.9 v1.4 补充条款）；只含分类与来源，不含原始表达式。 */
export interface SetupDraftItem {
  kind: string
  source: string
  reason?: string
}

/** needs_configuration 结果里的 setup 草稿摘要；草稿全文只写入插件数据目录/显式同意的项目路径，不进工具输出。 */
export interface SetupDraftSummary {
  /** 已写入的草稿文件绝对路径；数据目录不可用时缺失并由诊断说明。 */
  path?: string
  /** 用户在 open 中显式给出 writeSetupTo 后，草稿在项目内的相对路径；未写项目时缺失。 */
  installedTo?: string
  /** 可直接粘贴进项目 page-preview.config `runtime` 的字段片段（setup 指向 installedTo 或建议路径）。 */
  configSnippet?: string
  /** 已进入草稿的第三方注册、全局样式与根选项。 */
  thirdParty: SetupDraftItem[]
  /** 默认注释掉的业务模块及原因。 */
  business: SetupDraftItem[]
  /** 无法静态解析的注册项。 */
  unresolved: SetupDraftItem[]
}

/** busy 结果里的占用者摘要（方案 §4.2）：只含可安全跨 owner 展示的标识与状态，不含计划细节、URL 或命令。 */
export interface PreviewOccupant {
  previewId: string
  state: SessionState
  projectId: string
  targetId: string
  /** 占用者是否属于本次调用的同一 DSH 会话（例如自身 cleanup_failed 未恢复）。 */
  sameOwner: boolean
}

export interface OpenResult extends ToolResultBase {
  preview?: PreviewSummary
  candidates?: Candidate[]
  plan?: DisplayedPreviewPlan
  setupDraft?: SetupDraftSummary
  /** status=busy 时的占用者摘要。 */
  occupant?: PreviewOccupant
  /** DSH 侧边栏 Browser 自动加载并挂载后的可见文本（§4.2、§10）；与 status 同一观察源与脱敏。 */
  pageText?: PageTextObservation
}

export interface StatusResult extends ToolResultBase {
  preview?: PreviewSummary
  /** 省略 previewId 时返回调用者拥有的预览列表。 */
  previews?: PreviewSummary[]
  /** detail=true 时附带。 */
  plan?: DisplayedPreviewPlan
  /** 文本验证信号（§4.2）：可见文本或无障碍摘要，限长并经 §13 第 8 条脱敏。 */
  pageText?: PageTextObservation
  /** detail=true 且指定 previewId 时附带：未命中业务请求汇总（§7.2、R3-1）。 */
  unmatched?: UnmatchedSnapshot
  /** detail=true 且指定 previewId 且有未命中时附带：可直接粘贴的 fixtures 草稿（§7.2、R3-1）。 */
  fixtureDraft?: FixtureDraft
  /** 省略 previewId 时附带：本轮影响分析的页面候选（R3-4，最多 3 条；未完成分析时缺失）。 */
  suggestions?: Candidate[]
  /** 因代表页上限被省略的候选数（§5.2）。 */
  suggestionsOmitted?: number
}

export interface CaptureRecord {
  previewId: string
  context: 'current-view' | 'replayed'
  file: string
  targetId: string
  strategy: Strategy
  scenario?: string
  fingerprints: PreviewPlan['fingerprints']
  freshness: Freshness
  viewport?: Viewport
  capturedAt: string
  state: SessionState
  knownDifferences: string[]
}

export interface CaptureResult extends ToolResultBase {
  capture?: CaptureRecord
}

export interface RefreshResult extends ToolResultBase {
  preview?: PreviewSummary
}

/**
 * page_preview_write_scenario 的结果（R5-1a，§4.2、§7.2）：把 Agent 填好的场景定义写回
 * page-preview.config.json。只在用户经官方审批确认后写；已存在文件先备份，可回滚。
 */
export interface WriteScenarioResult extends ToolResultBase {
  /** 写入的工作区相对路径（固定 page-preview.config.json）。 */
  file?: string
  /** 已存在配置文件的备份绝对路径；新文件无备份。 */
  backup?: string
  projectId?: string
  scenario?: string
  /** created=新文件；merged=并入既有项目条目；appended=追加项目条目。 */
  mode?: 'created' | 'merged' | 'appended'
  /**
   * R6-3b：请求 `applyTo` 时经既有 refresh+scenario 路径就地切换的应用结果；
   * 写入照常返回 ok，应用失败如实记录在此与 diagnostics。
   */
  applied?: { previewId: string; status: ResultStatus }
}

export interface StopResult extends ToolResultBase {
  stopped: Array<{ previewId: string; state: SessionState; residual?: string[] }>
  /** recover=true 时的账本对账回收结果（§9.2 恢复入口）：已回收、无法核对已归档的记录。 */
  recovered?: { reclaimed: string[]; residual: string[]; archived: string[] }
}
