/**
 * 受控响应层 CSP（方案 §6.8、§7.3）。
 * connect-src 约束浏览器文档发起的 fetch/XHR/WebSocket/EventSource/beacon；form-action 约束表单提交。
 * default-src/script-src 同时阻止 JSONP、资源和子文档数据旁路；保留原页内联/动态编译和本地/blob 资源。
 * 不约束服务端进程。页面自身的 meta CSP 会叠加（只会更严格）。
 *
 * Phase 0 已实测：原生 DSH 0.2.1-rc.5 + Chrome 152 + Vite 5.2.12 的同源 HMR 可在 'self' 下更新与失败恢复。
 * 产品 static.start + IAB Chrome 156 已验证 Worker/SW、JSONP/外部资源阻断与本地兼容，见 docs/network-boundary.md。
 * TODO(phase0): 新策略下原生载体/其他内核的 HMR 边界。Worker/Service Worker 数据边界在
 * 已验证组合（headless Chrome + 响应层）已由字面 URL Worker/SharedWorker/SW 受控响应与
 * 未启用 MSW 时 SW 注册屏蔽两项实测覆盖（tests/unit/vue-vite-runtime.test.ts）；
 * 原生 DSH 载体与其他内核仍待 phase0 实测，不外推。
 */

export interface CspOptions {
  /** 计划允许的额外连接来源（如显式声明的 HMR 端口），默认只有 'self'。 */
  connectSources?: string[]
  /** 违规上报路径（回传通道）；省略则只依赖 bootstrap 监听 securitypolicyviolation。 */
  reportPath?: string
}

export function buildCsp(options: CspOptions = {}): string {
  const connect = ["'self'", ...(options.connectSources ?? [])]
  const directives = [
    "default-src 'self'", `connect-src ${connect.join(' ')}`, "form-action 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'", "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:", "frame-src 'self'", "img-src 'self' data: blob:",
    "font-src 'self' data: blob:", "media-src 'self' data: blob:",
  ]
  if (options.reportPath) directives.push(`report-uri ${options.reportPath}`)
  return directives.join('; ')
}

/**
 * 帧限制头：只对自有服务放宽。frame-ancestors 优先于 X-Frame-Options；
 * 返回 CSP 片段，调用方负责移除上游的 X-Frame-Options。
 */
export function buildFrameAncestors(ancestors: string[]): string {
  return `frame-ancestors ${["'self'", ...ancestors].join(' ')}`
}
