/** 自有 handler 加载/HTTP 样本执行器（方案 §7.2、§15.3）；只由测试显式启动，合成复核不写批准。 */
import { createServer } from 'node:http'
import { loadProjectHandlers } from '../../../src/scenario/handlers.ts'
import { createMockMiddleware } from '../../../src/scenario/mock-middleware.ts'
import { ScenarioStore } from '../../../src/scenario/store.ts'
import { DiagnosticCode, RunnerSessionError } from '../../../src/shared/errors.ts'

const [appRoot, file] = process.argv.slice(2)
if (!appRoot || !file || !process.send) throw new Error('Explicit own fixture and IPC are required')
setInterval(() => {}, 1000) // 保持执行器存活，直到测试按已登记身份停止。
let verifications = 0
try {
  const handlers = await loadProjectHandlers(appRoot, file, { async verifyExecution() { verifications++ } })
  let middleware: ReturnType<typeof createMockMiddleware>
  const server = createServer((req, res) => middleware(req, res, error => { res.writeHead(error ? 500 : 404); res.end(error ? 'Handler failed' : 'Not a business request') }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture listener missing')
  const origin = 'http://127.0.0.1:' + address.port
  middleware = createMockMiddleware({ previewOrigin: origin, businessPaths: ['/api/**'], store: new ScenarioStore('own-loaded-handler'), handlers, onUnmatched() {}, onDiagnostic() {} })
  process.send({ type: 'ready', pid: process.pid, origin, verifications })
} catch (error) {
  process.send({ type: 'failed', verifications, diagnostic: error instanceof RunnerSessionError ? error.diagnostic : { code: DiagnosticCode.runtimeError, message: 'Own handler fixture failed' } })
}
