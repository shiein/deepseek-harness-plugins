/* Phase 0 的可丢弃 dev server；不模拟 Runner，Host 消失后仍监听，便于验证孤儿回收。 */
import { createServer } from 'node:net'
import { fork } from 'node:child_process'
import { once } from 'node:events'
const server = createServer()
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const child = fork('-e', ["const s=require('node:net').createServer(); s.listen(0,'127.0.0.1',()=>process.send({pid:process.pid,port:s.address().port}));"], {
  execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: {},
})
const [address] = await once(child, 'message')
process.send({ pid: process.pid, port: server.address().port, childPid: address.pid, childPort: address.port })
process.once('SIGTERM', () => server.close(() => process.exit(0)))
