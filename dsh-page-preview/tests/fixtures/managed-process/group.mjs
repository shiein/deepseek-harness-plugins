/** 托管进程测试（方案 §9.2）：真实父子服务；stubborn 忽略 TERM，escape 子进程另起进程组。 */
import { fork } from 'node:child_process'
import { once } from 'node:events'
const mode = process.argv[2]
const child = fork('-e', [
  "const server=require('node:net').createServer();" +
  (mode === 'stubborn' ? "process.on('SIGTERM',()=>{});" : '') +
  "server.listen(0,'127.0.0.1',()=>process.send({pid:process.pid,port:server.address().port}));",
], { execArgv: [], detached: mode === 'escape', env: {}, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
const [address] = await once(child, 'message')
if (mode === 'stubborn') process.on('SIGTERM', () => {})
console.log(JSON.stringify(address))
