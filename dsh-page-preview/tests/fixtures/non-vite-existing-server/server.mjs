/** 非 Vite 已有服务模拟样本（方案 §14、§15.1）：独立 HTTP 进程，无插件注入，无外部数据访问。 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const orders = [
  { id: 'DEMO-101', customer: '青禾工作室', item: '办公空间方案', amount: 12800, status: '待处理', date: '2026-10-31' },
  { id: 'DEMO-102', customer: '山海设计', item: '展厅视觉更新', amount: 8600, status: '进行中', date: '2026-10-30' },
  { id: 'DEMO-103', customer: '白露书店', item: '阅读区改造', amount: 24500, status: '已完成', date: '2026-10-29' },
]
const assets = new Map([
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
])

export async function startDemo(port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid loopback port')
  const startedAt = new Date().toISOString()
  let documentRequests = 0
  let apiRequests = 0
  const server = createServer((req, res) => {
    void respond().catch((error) => {
      console.error('Demo request failed:', error.message)
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 'sample_request_failed' }))
    })
    async function respond() {
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) {
        res.writeHead(403); res.end(); return
      }
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      const path = new URL(req.url, 'http://sample.invalid').pathname
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET' }); res.end(); return
      }
      if (path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sample: 'non-vite-orders', pid: process.pid, startedAt, documentRequests, apiRequests }))
      } else if (path === '/api/orders') {
        apiRequests++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ orders }))
      } else if (path === '/orders/' || /^\/orders\/DEMO-10[1-3]$/.test(path)) {
        const html = await readFile(new URL('./index.html', import.meta.url))
        documentRequests++
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html)
      } else if (path === '/') {
        res.writeHead(302, { Location: '/orders/' }); res.end()
      } else if (assets.has(path)) {
        const [file, type] = assets.get(path)
        const body = await readFile(new URL(file, import.meta.url))
        res.writeHead(200, { 'Content-Type': type }); res.end(body)
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 'unmatched_request' }))
      }
    }
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', accept)
  })
  return { server, origin: 'http://127.0.0.1:' + server.address().port }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, origin } = await startDemo(Number(process.argv[2] || 0))
  console.log(JSON.stringify({ origin, pid: process.pid }))
  const stop = () => server.close((error) => {
    if (error) { console.error(error.message); process.exitCode = 1 }
  })
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
