/** 具体本地路由（方案 §4.2、§6.6）；只转换数据，不导航、不访问网络，不猜测缺失动态参数。 */
export interface RouteContext {
  path: string
  params?: Record<string, string>
  query?: Record<string, string>
}

/** 预览来源只接受无凭据的 HTTP(S) loopback；配置来源与具体导航共用。 */
export function loopbackUrl(value: string): URL | undefined {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password ? url : undefined
}

export function localRoute(route: RouteContext): URL {
  if (!route.path.startsWith('/') || route.path.startsWith('//') || /[\\\0\r\n]/.test(route.path)) throw new Error('Expected a local route path')
  const path = route.path.replace(/(^|\/):([\w-]+)/g, (_match, slash: string, name: string) => {
    const value = route.params?.[name]
    if (!value || value === '.' || value === '..') throw new Error('Route parameters must be concrete')
    return slash + encodeURIComponent(value)
  })
  const url = new URL(path, 'http://preview.invalid')
  decodeURIComponent(url.pathname) // 畸形转义不是有效目标；不尝试另一种解释。
  if (url.origin !== 'http://preview.invalid' || /(^|\/)[:*]|\[[^\]]+\]/.test(url.pathname)) throw new Error('Route parameters must be concrete')
  for (const [key, value] of Object.entries(route.query ?? {})) url.searchParams.set(key, value)
  return url
}

/** 仅匹配声明的固定段和 :name 段，不模拟框架路由优先级、可选参数或自定义正则。 */
export function matchesRoute(template: string, concrete: URL): boolean {
  if (!template.startsWith('/') || template.startsWith('//') || /[\\\0\r\n]/.test(template)) return false
  const route = new URL(template, 'http://preview.invalid')
  const segments = (pattern: string, value: string) => {
    const expected = pattern.split('/'), actual = value.split('/')
    return expected.length === actual.length && expected.every((part, index) => /^:[\w-]+$/.test(part) ? Boolean(actual[index]) : decodeURIComponent(part) === decodeURIComponent(actual[index]!))
  }
  return segments(route.pathname, concrete.pathname) && (!route.hash || segments(route.hash, concrete.hash))
}
