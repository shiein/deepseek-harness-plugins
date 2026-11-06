/** Phase 0 Vite 请求边界（方案 §6.8、§14）：只允许登记的样本资源与 Vite 客户端，不放行未知业务请求。 */
import type { Middleware, ResponseLayer } from '../../src/runner/response-layer/server.ts'

const resources = new Set(['/', '/index.html', '/@vite/client', '/@vite/env', '/main.js', '/target.js', '/style.css'])

export function createHmrBoundary(layer: ResponseLayer, status: () => unknown, viteEnvironmentPath?: string): Middleware {
  const allowed = new Set([...resources, ...(viteEnvironmentPath ? [viteEnvironmentPath] : [])])
  return (req, res, next) => layer.middleware(req, res, (error) => {
    if (error) return next(error)
    const path = new URL(req.url ?? '/', 'http://preview.invalid').pathname
    for (const [key, value] of Object.entries(layer.documentHeaders())) res.setHeader(key, value)
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }); res.end(); return
    }
    if (path === '/phase0/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(status()))
    } else if (allowed.has(path)) next()
    else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 'unmatched_request' }))
    }
  })
}
