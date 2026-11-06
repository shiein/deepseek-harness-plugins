/**
 * Host 头校验（方案 §6.8）：防 DNS rebinding 让外部网页读取预览服务与仓库资源。
 * 不依赖项目 dev server 是否已有同类校验。
 */

export const DEFAULT_ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '[::1]']

export function isAllowedHost(hostHeader: string | undefined, allowed: readonly string[] = DEFAULT_ALLOWED_HOSTS): boolean {
  if (!hostHeader) return false
  const host = stripPort(hostHeader.trim().toLowerCase())
  return allowed.includes(host)
}

function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end === -1 ? host : host.slice(0, end + 1)
  }
  const colon = host.lastIndexOf(':')
  return colon === -1 ? host : host.slice(0, colon)
}
