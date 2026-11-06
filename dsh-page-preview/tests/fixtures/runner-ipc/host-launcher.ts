/** 真正 Host SIGKILL 回归的隔离启动者（方案 §9.2）；只接受外层测试提供的合成计划。 */
import { RunnerClient } from '../../../src/host/runner-client.ts'
import { parseHostMessage } from '../../../src/shared/plan-schema.ts'
const client = new RunnerClient({ dataDir: process.argv[3]!, nodeExecutable: process.execPath })
process.on('message', raw => {
  const message = parseHostMessage(raw)
  if (message.type !== 'start') throw new Error('Expected a test start command')
  void (async () => {
    const reached = new Promise<string>(resolve => client.onMessage(event => { if (event.type === 'state' && event.state === 'reachable' && event.url) resolve(event.url) }))
    await client.start(message.previewId, message.plan, process.argv[2]!, { ownerSessionId: message.ownerSessionId })
    process.send?.({ url: await reached })
  })().catch(() => process.exit(1))
})
