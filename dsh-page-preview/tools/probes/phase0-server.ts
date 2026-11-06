/**
 * Phase 0 受控响应层探针（方案 §6.8、§14）。不是产品静态适配器。
 * 只提供登记样本，使用临时端口和随机 nonce；不加载目标项目代码、不转发后端。
 * node dev/phase0-server.ts [port] [client-origin]
 */
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createResponseLayer } from '../../src/runner/response-layer/server.ts'
import type { BrowserReport } from '../../src/runner/response-layer/report-channel.ts'

const reports: BrowserReport[] = []
let crossOriginHits = 0
const layer = createResponseLayer({
  previewId: 'phase0-static', nonce: randomBytes(32).toString('hex'),
  allowedHosts: ['127.0.0.1', 'localhost'], csp: {},
  frameAncestors: [process.argv[3] ?? 'http://127.0.0.1:3080'],
  bootstrapScript: await readFile(new URL('../../src/browser/bootstrap.js', import.meta.url), 'utf8'),
  onReport(report) { if (reports.length < 500) reports.push(report) },
})
const files: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/second.html': ['second.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript'],
  '/worker.js': ['worker.js', 'application/javascript'],
  '/sw.js': ['sw.js', 'application/javascript'],
}
const server = createServer((req, res) => layer.middleware(req, res, (err) => {
  if (err) { res.writeHead(500); res.end('phase0 handler failed'); return }
  void serve().catch(() => { res.writeHead(500); res.end('phase0 fixture read failed') })
  async function serve() {
    const path = new URL(req.url ?? '/', 'http://preview.invalid').pathname
    if (path === '/phase0/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ reports, crossOriginHits }))
      return
    }
    if (path === '/phase0/cross-origin') { crossOriginHits++; res.end('cross-origin reached'); return }
    if (path === '/phase0/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: phase0\n\n'); return }
    const file = files[path]
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 'unmatched_request' }))
      return
    }
    const body = await readFile(new URL('../../tests/fixtures/static-multipage/' + file[0], import.meta.url), 'utf8')
    // Worker/SW 的响应也附带策略；单独验证，不能用文档 CSP 推断。
    res.writeHead(200, { ...layer.documentHeaders(), 'Content-Type': file[1] })
    res.end(file[1].startsWith('text/html') ? layer.transformDocument(body) : body)
  }
}))
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (req.url !== '/phase0/ws' || !key || req.headers.host !== `127.0.0.1:${(server.address() as AddressInfo).port}`) { socket.destroy(); return }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  socket.on('data', () => socket.end(Buffer.from([0x88, 0x00])))
  socket.on('error', () => socket.destroy())
})
server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => {
  console.log(JSON.stringify({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, pid: process.pid }))
})
process.once('SIGTERM', () => server.close(() => process.exit(0)))
process.once('SIGINT', () => server.close(() => process.exit(0)))
