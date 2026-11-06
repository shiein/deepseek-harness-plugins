/**
 * 诊断错误码（方案 §4.2）。新增错误码时在此登记并补充说明，不在调用处临时拼字符串。
 */

import type { Diagnostic } from './contracts.ts'

/** 共享的可安全投影操作错误；适配器无需依赖 Runner 编排模块。 */
export class RunnerSessionError extends Error {
  readonly diagnostic: Diagnostic
  constructor(diagnostic: Diagnostic, cause?: unknown) {
    super(diagnostic.message, { cause })
    this.name = 'RunnerSessionError'
    this.diagnostic = diagnostic
  }
}

export const DiagnosticCode = {
  /** 当前路径不具备请求的能力（如截图）。 */
  unsupportedCapability: 'unsupported_capability',
  /** 计划无法满足 requirements，且不得隐式放宽。 */
  requirementUnsatisfied: 'requirement_unsatisfied',
  portConflict: 'port_conflict',
  /** 无法证明监听端口属于本次启动的进程树。 */
  ownershipUnverified: 'ownership_unverified',
  startTimeout: 'start_timeout',
  targetNotReady: 'target_not_ready',
  /** 可恢复：保持原状态，freshness=stale。 */
  compileError: 'compile_error',
  /** 本次手动 open 的计划变化，已清理并替换原有预览；不是原页面的 HMR。 */
  previewRestarted: 'preview_restarted',
  /** 工作区被另一会话或自身未完成清理的预览占用；结果附带占用者摘要。 */
  previewBusy: 'preview_busy',
  runtimeError: 'runtime_error',
  /** 业务请求未命中任何 fixture。 */
  unmatchedRequest: 'unmatched_request',
  /** 被受控响应层（CSP）阻断的请求。 */
  blockedRequest: 'blocked_request',
  cleanupFailed: 'cleanup_failed',
  configInvalid: 'config_invalid',
  /** 同一项目的低优先级配置被明确忽略，不合并。 */
  configSourceIgnored: 'config_source_ignored',
  /** 执行项指纹变化，需要重新批准（§8）。 */
  configChangedNeedsApproval: 'config_changed_needs_approval',
  ambiguousTarget: 'ambiguous_target',
  dependencyMissing: 'dependency_missing',
  toolchainMismatch: 'toolchain_mismatch',
  /** 执行的组合没有样本证据，照常执行但能力保持 unknown（§0.3 第 1 条）。 */
  unverifiedToolchain: 'unverified_toolchain',
  /** 项目 devServer 字段被自有响应层接管（剥离/覆盖），逐字段列明。 */
  devServerTakenOver: 'devserver_taken_over',
  /** 会话权限为完全访问（Full access / Auto 的 danger-full-access 沙箱）时执行项按用户的权限选择放行（§0.3 第 8 条）。 */
  approvedByPermission: 'approved_by_permission_preset',
  /** 新会话接管并清理了同工作区另一 DSH 会话的预览（2026-11-03 Aesc 决策）。 */
  previewTakenOver: 'preview_taken_over',
  /** 预览已在用户的 DSH 侧边栏 Browser 打开并加载（信息性，告诉 Agent 无需再等待/轮询/截图）。 */
  shownInSidebar: 'preview_shown_in_sidebar',
  /** 项目声明了自有 Mock 设施（依赖/文件/构建配置引用）；预览从不执行它们（信息性，R3-3）。 */
  projectMockDetected: 'project_mock_detected',
  /** 项目 vite-plugin-mock 已声明且选项可解析，但插件本体或 mock 目录无法加载；不阻断，请求如实未命中（R5-1e）。 */
  projectMockUnavailable: 'project_mock_unavailable',
  /** 已配置的 setup 可能漏掉入口声明的样式导入；非阻断、随计划提交（任务 C，2026-11-03）。 */
  setupMissingStyles: 'setup_missing_styles',
  /** 影响分析在预算/静态不可解处降级；候选只是部分结果（信息性，R3-4）。 */
  impactIncomplete: 'impact_incomplete',
  /** 调用点上下文收集失败或触顶；contexts 只是部分结果，草稿不阻断（信息性，R6-2）。 */
  contextIncomplete: 'context_incomplete',
  /** 变化了无法就地生效的输入（构建配置、声明的执行输入、配置或 .env*）；需停止后重新 open（R3-5）。 */
  previewNeedsRestart: 'preview_needs_restart',
  /** open 返回时尚无可证明为挂载后的页面文本；如实标注而非把首帧空文本当作页面文本（R5-0a，决策 P-A）。 */
  pageTextPending: 'page_text_pending',
  /** ws fixture 收到声明长度超 1 MiB 的客户端帧，按 RFC 6455 以 1009 关闭（F8）。 */
  protocolViolation: 'protocol_violation',
} as const

export type DiagnosticCode = (typeof DiagnosticCode)[keyof typeof DiagnosticCode]

/** 骨架占位。实现完成后删除对应调用；不得在生产路径上捕获并吞掉它。 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented: ${what}`)
    this.name = 'NotImplementedError'
  }
}

export function notImplemented(what: string): never {
  throw new NotImplementedError(what)
}
