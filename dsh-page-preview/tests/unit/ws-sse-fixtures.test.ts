/**
 * R5-1g 声明式 WS/SSE 通道（方案 §7.2、§7.3、§15.3）。
 * 真实本地 HTTP 服务 + Node 全局 WebSocket 客户端；断言固定序列、应答、关闭与未声明阻断。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { createMockMiddleware } from '../../src/scenario/mock-middleware.ts'
import { serveWsFixture, wsFixtureFor } from '../../src/runner/response-layer/ws-fixture.ts'
import { ScenarioStore } from '../../src/scenario/store.ts'
import type { SseFixture, WsFixture } from '../../src/shared/config/schema.ts'
import { scenarioConfigSchema } from '../../src/shared/config/schema.ts'

const sseFixtures: SseFixture[] = [{
  path: '/api/stream',
  events: [
    { data: 'first', event: 'tick', id: '1' },
    { data: 'multi\nline', delay: 5 },
    { data: 'last', retry: 3000 },
  ],
}]

test('a declared SSE path streams the fixed event sequence; other paths still fall through', async t => {
  const unmatched: unknown[] = []
  let middleware!: ReturnType<typeof createMockMiddleware>
  const http = createServer((req, res) => middleware(req, res, () => { res.writeHead(418); res.end('downstream') }))
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())))
  const address = http.address()
  const origin = 'http://127.0.0.1:' + (typeof address === 'object' && address ? address.port : 0)
  middleware = createMockMiddleware({
    previewOrigin: origin, businessPaths: [], store: new ScenarioStore('sse'),
    sse: sseFixtures, onUnmatched: value => unmatched.push(value), onDiagnostic() {},
  })
  const response = await fetch(origin + '/api/stream', { signal: AbortSignal.timeout(3000) })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  const text = await response.text()
  const [tick, multi, last] = text.split('\n\n').filter(Boolean)
  assert.deepEqual(tick?.split('\n'), ['event: tick', 'id: 1', 'data: first'])
  assert.deepEqual(multi?.split('\n'), ['data: multi', 'data: line'])
  assert.deepEqual(last?.split('\n'), ['retry: 3000', 'data: last'])
  // 未声明路径不进 SSE 分支（此处下游 418 证明落到调用方），也不计入未命中。
  assert.equal((await fetch(origin + '/api/other', { signal: AbortSignal.timeout(3000) })).status, 418)
  assert.equal(unmatched.length, 0)
})

test('SSE fixtures reject invalid channel paths at middleware construction', () => {
  const base = { previewOrigin: 'http://127.0.0.1:1', businessPaths: [],
    store: new ScenarioStore('x'), onUnmatched() {}, onDiagnostic() {} }
  for (const path of ['/api/*', 'api/x', '//x', '/api/x?y=1', '/api/x#f', '/api/%zz']) {
    assert.throws(() => createMockMiddleware({ ...base, sse: [{ path, events: [{ data: 'x' }] }] }),
      /Channel fixture path/)
  }
})

/** 真实 HTTP server：upgrade 交给 wsFixtureFor/serveWsFixture，未声明路径销毁。 */
async function wsServer(t: { after(callback: () => Promise<void>): void }, fixtures: WsFixture[],
  onTooLargeFrame?: () => void) {
  const destroyed: string[] = []
  const http = createServer()
  http.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    const fixture = wsFixtureFor(fixtures, req)
    if (fixture) { serveWsFixture(fixture, req, socket, onTooLargeFrame); return }
    destroyed.push(req.url ?? '')
    socket.destroy()
  })
  http.on('request', (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(404); res.end() })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())))
  const address = http.address()
  const url = 'ws://127.0.0.1:' + (typeof address === 'object' && address ? address.port : 0)
  return { url, destroyed }
}

test('a declared ws fixture plays its sequence, answers a match and closes as configured', async t => {
  const f = await wsServer(t, [{
    path: '/api/push',
    send: [{ data: 'hello' }, { data: 'world', delay: 10 }],
    replies: [{ match: 'ping', data: 'pong' }],
    close: { code: 1000, reason: 'done' },
  }])
  const received: string[] = []
  const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const ws = new WebSocket(f.url + '/api/push')
    // close 在 send 播完即触发；应答要在打开时发，验证 replies 与固定序列可交叠。
    ws.onopen = () => ws.send('ping')
    ws.onmessage = event => received.push(String(event.data))
    ws.onclose = event => resolve({ code: event.code, reason: event.reason })
    ws.onerror = () => reject(new Error('WebSocket failed'))
    setTimeout(() => reject(new Error('WS sequence timed out')), 5000)
  })
  // replies 是即时应答，可能与带延迟的序列交叠：只断言集合与数量，不假定交错顺序。
  assert.equal(received.length, 3)
  assert.deepEqual([...received].sort(), ['hello', 'pong', 'world'])
  assert.deepEqual(closed, { code: 1000, reason: 'done' })
})

// F8：>1 MiB 客户端帧不再被静默吞掉——RFC 6455 1009 关闭并经 onTooLargeFrame 上报一次。
// undici 的 WebSocket 客户端拒绝发送超大帧，改走裸 TCP：声明 >1 MiB 的 127 长度掩码帧
// 头部到达即触发服务端关闭（无需真发载荷），断言返回的 close 帧码与上报次数。
test('a client frame over 1 MiB closes with RFC 6455 1009 and reports once (F8)', async t => {
  let reported = 0
  const f = await wsServer(t, [{ path: '/api/push', replies: [{ match: 'ping', data: 'pong' }] }],
    () => { reported += 1 })
  const port = Number(f.url.split(':').pop())
  const socket = connect(port, '127.0.0.1')
  t.after(() => socket.destroy())
  const chunks: Buffer[] = []
  const closed = new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no close frame within 5s')), 5000)
    let handshakeDone = false
    socket.on('data', chunk => {
      chunks.push(chunk)
      const all = Buffer.concat(chunks)
      if (!handshakeDone) {
        const end = all.indexOf('\r\n\r\n')
        if (end < 0) return
        assert.ok(all.subarray(0, end).toString('utf8').includes(' 101 '), 'fixture handshake must be 101')
        handshakeDone = true
        chunks.length = 0
        chunks.push(all.subarray(end + 4))
        // 0x81=FIN+text，0xff=masked+127 长度；声明 1 MiB+1，掩码 4 字节。
        const header = Buffer.alloc(14)
        header[0] = 0x81
        header[1] = 0xff
        header.writeBigUInt64BE(BigInt(1024 * 1024 + 1), 2)
        socket.write(header)
        return
      }
      const frame = Buffer.concat(chunks)
      if (frame.length >= 2 && (frame[0]! & 0x0f) === 0x8 && frame.length >= 2 + (frame[1]! & 0x7f)) {
        clearTimeout(timer)
        resolve(frame)
      }
    })
    socket.on('error', reject)
  })
  socket.write('GET /api/push HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n'
    + 'Connection: Upgrade\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n'
    + 'Sec-WebSocket-Version: 13\r\n\r\n')
  const frame = await closed
  assert.equal((frame[2]! << 8) | frame[3]!, 1009, 'oversized frames must close with RFC 6455 1009')
  assert.equal(reported, 1, 'the oversized frame must be reported exactly once')
  // 正常大小帧的连接照旧应答（同一 fixture、同一监听未受影响的旁证）。
  const reply = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(f.url + '/api/push')
    ws.onopen = () => ws.send('ping')
    ws.onmessage = event => { ws.close(); resolve(String(event.data)) }
    ws.onerror = () => reject(new Error('second WebSocket failed'))
    setTimeout(() => reject(new Error('normal-sized frame timed out')), 5000)
  })
  assert.equal(reply, 'pong')
})

test('an undeclared ws path is destroyed before any handshake', async t => {
  const f = await wsServer(t, [{ path: '/api/push', send: [{ data: 'x' }] }])
  const outcome = await new Promise<string>(resolve => {
    const ws = new WebSocket(f.url + '/api/other')
    ws.onopen = () => resolve('opened')
    ws.onclose = () => resolve('closed')
    ws.onerror = () => resolve('error')
    setTimeout(() => resolve('timeout'), 4000)
  })
  assert.notEqual(outcome, 'opened')
  assert.deepEqual(f.destroyed, ['/api/other'])
})

test('scenario schema accepts ws/sse channels and rejects malformed ones', () => {
  const ok = scenarioConfigSchema.safeParse({
    ws: [{ path: '/api/push', send: [{ data: 'x', delay: 50 }], replies: [{ match: 'a', data: 'b' }],
      close: { code: 1001 } }],
    sse: [{ path: '/api/stream', events: [{ data: 'y', event: 'e', retry: 500 }], keepOpen: true }],
  })
  assert.equal(ok.success, true)
  for (const bad of [
    { ws: [{ path: '/api/x?y=1', send: [] }] },
    { ws: [{ path: '/api/x', send: [{ data: 'x', delay: -1 }] }] },
    { ws: [{ path: 'api/x', send: [] }] },
    { sse: [{ path: '/api/x', events: [] }] },
    { sse: [{ path: '/api/x', events: [{ data: 'x', delay: 99999 }] }] },
    { ws: [{ path: '/api/x', close: { code: 700 } }] },
  ]) {
    assert.equal(scenarioConfigSchema.safeParse(bad).success, false, JSON.stringify(bad))
  }
})
