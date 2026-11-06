/**
 * 声明式 WebSocket fixture 服务（R5-1g，方案 §7.2/§7.3）。
 * 最小 RFC 6455 服务端：只处理文本/关闭/ping 帧；声明路径的 Upgrade 才准入，
 * 连接后按固定序列发送、按精确匹配应答，播完可按配置关闭。
 * 未声明路径不进入此模块（由调用方 destroy + blocked_request 诊断）。
 * F8：超过 1 MiB 的客户端帧按 RFC 6455 以 1009（message too big）关闭并经
 * onTooLargeFrame 上报诊断——此前 decodeFrame 返回空载荷帧被静默当作正常帧吞掉。
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { WsFixture } from '../../shared/config/schema.ts'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 声明路径集合中的准入判断：GET + websocket Upgrade + pathname 精确命中。 */
export function wsFixtureFor(fixtures: readonly WsFixture[], request: IncomingMessage): WsFixture | undefined {
  if (request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket') return undefined
  let pathname: string
  try { pathname = new URL(request.url ?? '/', 'http://preview.invalid').pathname } catch { return undefined }
  return fixtures.find(fixture => fixture.path === pathname)
}

/**
 * 在已准入的 socket 上完成握手并播放 fixture 序列。socket 由调用方拥有；
 * 播放结束或配置 close 后关闭连接；任何协议错误如实断开，不重试。
 */
export function serveWsFixture(fixture: WsFixture, request: IncomingMessage, socket: Socket,
  onTooLargeFrame?: () => void): void {
  const key = request.headers['sec-websocket-key']
  const version = request.headers['sec-websocket-version']
  if (typeof key !== 'string' || version !== '13') { socket.destroy(); return }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
    + 'Connection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  const sendText = (data: string) => {
    if (!socket.destroyed) socket.write(encodeFrame(0x1, Buffer.from(data, 'utf8')))
  }
  const sendClose = (code?: number, reason?: string) => {
    if (socket.destroyed) return
    const reasonBytes = Buffer.from(reason ?? '', 'utf8')
    const payload = code === undefined ? reasonBytes
      : Buffer.concat([Buffer.from([code >> 8 & 0xff, code & 0xff]), reasonBytes])
    socket.write(encodeFrame(0x8, payload))
    socket.end()
  }
  // 固定序列按声明延迟播放；socket 已毁则停止。
  let chain = Promise.resolve()
  for (const item of fixture.send ?? []) {
    chain = chain.then(() => new Promise<void>(resolve => setTimeout(resolve, item.delay ?? 0)))
      .then(() => { if (!socket.destroyed) sendText(item.data) })
  }
  void chain.then(() => { if (fixture.close) sendClose(fixture.close.code, fixture.close.reason) })
    .catch(() => { if (!socket.destroyed) socket.destroy() })
  // 客户端帧解码：masked text/close/ping（pong 应答）；其他 opcode 或不带掩码如实断开。
  const replies = fixture.replies ?? []
  let pending = Buffer.alloc(0)
  let fragments: Buffer[] | undefined
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk])
    for (;;) {
      const frame = decodeFrame(pending)
      if (frame === undefined) return
      pending = pending.subarray(frame.consumed)
      if (!frame.masked) { socket.destroy(); return }
      // F8：声明长度超 1 MiB 的帧不再是"空载荷正常帧"——按 RFC 6455 1009 关闭并上报。
      if (frame.tooLarge) { sendClose(1009, 'message too big'); onTooLargeFrame?.(); return }
      if (frame.opcode === 0x8) { sendClose(); return }
      if (frame.opcode === 0x9) { if (!socket.destroyed) socket.write(encodeFrame(0xA, frame.payload)); continue }
      if (frame.opcode === 0x0 && fragments !== undefined) {
        fragments.push(frame.payload)
        if (frame.fin) {
          const text = Buffer.concat(fragments).toString('utf8')
          fragments = undefined
          for (const reply of replies) if (reply.match === text) sendText(reply.data)
        }
        continue
      }
      if (frame.opcode !== 0x1 && frame.opcode !== 0x2) { sendClose(1003, 'unsupported opcode'); return }
      const payload = frame.fin ? frame.payload.toString('utf8') : undefined
      if (!frame.fin) { fragments = [frame.payload]; continue }
      for (const reply of replies) if (reply.match === payload) sendText(reply.data)
    }
  })
  socket.on('error', () => { /* socket 级错误如实结束连接；无上报语义 */ })
}

interface DecodedFrame { fin: boolean; opcode: number; masked: boolean; payload: Buffer
  consumed: number; tooLarge?: boolean }
/** 解析一条完整帧；不完整返回 undefined。声明长度超 1 MiB 时返回 tooLarge 由调用方按 1009 关闭。 */
function decodeFrame(buffer: Buffer): DecodedFrame | undefined {
  if (buffer.length < 2) return undefined
  const fin = (buffer[0]! & 0x80) !== 0
  const opcode = buffer[0]! & 0x0f
  const masked = (buffer[1]! & 0x80) !== 0
  let length = buffer[1]! & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return undefined
    length = buffer.readUInt16BE(2); offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return undefined
    const big = buffer.readBigUInt64BE(2)
    if (big > BigInt(1024 * 1024))
      return { fin, opcode, masked, payload: Buffer.alloc(0), consumed: buffer.length, tooLarge: true }
    length = Number(big); offset = 10
  }
  const maskOffset = offset
  if (masked) offset += 4
  if (buffer.length < offset + length) return undefined
  let payload = buffer.subarray(offset, offset + length)
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4)
    payload = Buffer.from(payload)
    for (let index = 0; index < payload.length; index++) payload[index] = payload[index]! ^ mask[index % 4]!
  }
  return { fin, opcode, masked, payload, consumed: offset + length }
}

/** 服务端→客户端帧：不掩码（RFC 6455 要求）。 */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const header: number[] = [0x80 | opcode]
  if (payload.length < 126) header.push(payload.length)
  else if (payload.length < 65536) { header.push(126, payload.length >> 8 & 0xff, payload.length & 0xff) }
  else {
    header.push(127)
    const big = BigInt(payload.length)
    for (let shift = 56; shift >= 0; shift -= 8) header.push(Number(big >> BigInt(shift) & BigInt(0xff)))
  }
  return Buffer.concat([Buffer.from(header), payload])
}
