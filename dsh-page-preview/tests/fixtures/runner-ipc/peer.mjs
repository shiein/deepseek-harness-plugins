/** IPC 通信测试对端（方案 §6.5、§15.3）：仅发送合成消息，不执行项目代码、打开端口或访问外部服务。 */
const mode = process.argv[2]
const unverified = { status: 'unverified' }
const send = message => { if (process.connected) process.send(message) }
process.once('disconnect', () => process.exit(0))
setTimeout(() => process.exit(90), 5000)
process.on('message', message => {
  if (message.type === 'shutdown') { process.disconnect(); return }
  const { previewId, requestId } = message
  send({ type: 'diagnostic', previewId, diagnostic: { code: 'runtime_error', phase: 'stop', message: 'received:' + previewId } })
  if (previewId === 'never') return
  if (previewId === 'exit') { process.exit(17); return }
  if (previewId === 'bad-ack') { send({ type: 'ack', requestId, ok: 'yes', privateValue: 'synthetic-do-not-echo' }); return }
  if (previewId === 'negative') {
    send({ type: 'ack', requestId, ok: false, diagnostics: [{ code: 'cleanup_failed', phase: 'stop', message: 'synthetic residual', hint: 'retry' }] })
    return
  }
  const wait = previewId === 'slow' ? 80 : previewId === 'late' ? 100 : 0
  setTimeout(() => {
    send({ type: 'ack', requestId, ok: true })
    send({ type: 'state', previewId, state: 'reachable', freshness: 'unverified', readiness: { serviceReachable: { status: 'proven' }, documentLoaded: unverified, targetMounted: unverified }, url: 'http://127.0.0.1:12345' })
  }, wait)
})
if (mode === 'before-ready') send({ type: 'ack', requestId: 'early', ok: true })
else if (mode !== 'no-ready') setTimeout(() => {
  send({ type: 'ready-for-commands', pid: mode === 'wrong-pid' ? process.pid + 1 : process.pid })
  if (mode === 'duplicate-ready') send({ type: 'ready-for-commands', pid: process.pid })
}, mode === 'delayed-ready' ? 150 : 0)
