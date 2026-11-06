/** 已有/托管服务的共同来源与导航规则（方案 §6.6、§8）；只解析数据，不发请求或推断来源。 */
import type { TargetSelector } from './contracts.ts'
import type { RouteContext } from './route.ts'
import { localRoute, loopbackUrl } from './route.ts'

export function serviceUrls(originValue: string, selector: TargetSelector, route?: RouteContext, probePath?: string): { origin: string, url: string, probe: string } {
  const origin = loopbackUrl(originValue)
  if (!origin || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('An explicit HTTP(S) loopback origin is required')
  let url: URL
  if (selector.kind === 'url') {
    const selected = loopbackUrl(selector.url)
    if (!selected || selected.origin !== origin.origin) throw new Error('Target URL must stay on the configured origin')
    url = selected
    if (route) {
      const navigation = localRoute(route)
      if (new URL(navigation.pathname + navigation.search + navigation.hash, origin).href !== url.href) throw new Error('URL target conflicts with its navigation context')
    }
  } else {
    const navigation = route ?? (selector.kind === 'route' ? selector : undefined)
    if (!navigation) throw new Error('A concrete route or explicitly mapped file route is required')
    const local = localRoute(navigation)
    if (selector.kind === 'route' && localRoute(selector).href !== local.href) throw new Error('Route context conflicts with the selected target')
    url = new URL(local.pathname + local.search + local.hash, origin)
  }
  if (probePath !== undefined && (!probePath.startsWith('/') || probePath.startsWith('//') || /[\\\0\r\n]/.test(probePath))) throw new Error('Probe requires an absolute local path')
  const probe = probePath === undefined ? new URL(url) : new URL(probePath, origin)
  if (probe.origin !== origin.origin) throw new Error('Service probe must stay on the configured origin')
  probe.hash = ''
  return { origin: origin.origin, url: url.href, probe: probe.href }
}
