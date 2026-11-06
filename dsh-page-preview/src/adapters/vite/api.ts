/** 已安装 Vite 执行边界的最小类型（方案 §6.5）；版本范围由 profile/兼容矩阵维护，这里只核对必需的 API 形状，不引入插件自带 Vite。 */
import type { Middleware } from '../../runner/response-layer/server.ts'
export interface ViteServer {
  middlewares: Middleware
  config: { root: string; publicDir: string | false; server: { hmr: unknown } }
  moduleGraph: {
    urlToModuleMap: { get(url: string): object | undefined }
    fileToModulesMap: { get(file: string): ReadonlySet<object> | undefined }
    getModuleById(id: string): { file: string | null } | undefined
    /** Vite 5.1+；场景更新后强制重转换虚拟入口。缺失时 worker 如实回绝更新。 */
    invalidateAll?(): void
  }
  transformIndexHtml(url: string, html: string): Promise<string>
  close(): Promise<void>
}
export interface ViteApi {
  version: string
  loadConfigFromFile(environment: Record<string, unknown>, file: string, root: string, level: string): Promise<{ config: Record<string, unknown>; dependencies: string[] } | null>
  createServer(config: Record<string, unknown>): Promise<ViteServer>
}
export interface VitePlugin {
  name: string
  enforce?: 'pre' | 'post'
  resolveId?(this: { resolve(id: string, importer: string, options: { skipSelf: boolean }): Promise<{ id: string } | null> }, id: string, importer?: string): string | null | Promise<{ id: string } | null>
  load?(id: string): string | { code: string, meta: Record<string, unknown> } | null
  config?(config: Record<string, unknown>): void
  configResolved?(config: { cacheDir: string; envDir: string | false; server: { proxy?: Record<string, unknown>; cors?: boolean | Record<string, unknown>; headers?: Record<string, unknown> } }): void
  /** Vite 把同一 timestamp 传给插件钩子与客户端 update 载荷；module-updated 报告按它核对版本（P1-6）。 */
  handleHotUpdate?(context: { timestamp: number }): void
}
export function viteApi(value: unknown): ViteApi {
  if (!value || typeof value !== 'object' || !('version' in value) || typeof value.version !== 'string' || !('createServer' in value) || typeof value.createServer !== 'function' || !('loadConfigFromFile' in value) || typeof value.loadConfigFromFile !== 'function') throw new Error('Installed Vite module lacks the required API shape')
  // 版本差异由 unverified_toolchain 诊断表达；这里只核对必需导出存在，返回形状按 Vite 公开类型定义。
  return value as ViteApi
}
export function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid project configuration section')
  return value as Record<string, unknown>
}
