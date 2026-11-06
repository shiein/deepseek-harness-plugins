/**
 * Phase 0 真实 Vite HMR 探针（方案 §6.5、§6.8、§14）。只在独立 Node 进程运行。
 * 显式使用已安装 Vite，不加载其所属项目的配置、环境文件或源码；仅修改临时 fixture 副本。
 * node dev/phase0-hmr.mjs <absolute-vite-package-directory> <absolute-output-directory>
 */
import { randomBytes } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFileLedger, readProcessStartTime } from '../../src/runner/ledger.ts'
import { createResponseLayer } from '../../src/runner/response-layer/server.ts'
import { createHmrBoundary } from './phase0-hmr-boundary.ts'

const [viteDirectory, output] = process.argv.slice(2)
if (!viteDirectory || !isAbsolute(viteDirectory) || !output || !isAbsolute(output)) throw new Error('Absolute Vite package and output directories are required')
const manifest = JSON.parse(await readFile(join(viteDirectory, 'package.json'), 'utf8'))
if (manifest.name !== 'vite' || manifest.version !== '5.2.12') throw new Error('This probe is pinned to installed Vite 5.2.12')
const bootstrapScript = await readFile(new URL('../../src/browser/bootstrap.js', import.meta.url), 'utf8')
await mkdir(output, { recursive: true })
const ledger = createFileLedger(output)
const root = await mkdtemp(join(tmpdir(), 'dsh-preview-hmr-'))
const owner = { previewId: 'phase0-vite-hmr', ownerSessionId: 'phase0-manual-probe', workspaceRoot: root }
const entries = []
let vite
const httpServer = createHttpServer()
let closing
const reports = []
const startedAt = new Date().toISOString()
const record = { startedAt, root, viteVersion: manifest.version, pid: process.pid, configFile: false, envFile: false, reports }
// 首次加载的 document-loaded/target-mounted 可同时到达，顺序写入以免截断同一证据文件。
let evidenceWrite = Promise.resolve()
function save() {
  evidenceWrite = evidenceWrite.then(() => writeFile(join(output, 'hmr-observations.json'), JSON.stringify(record, null, 2)))
  return evidenceWrite
}
async function close() {
  if (closing) return closing
  closing = (async () => {
    await vite?.close()
    if (httpServer.listening) await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()))
    await rm(root, { recursive: true })
    for (const entry of entries) await ledger.release(entry.id)
    record.cleaned = true
    await save()
  })()
  return closing
}
try {
  entries.push(await ledger.record({ ...owner, resource: { kind: 'path', path: root } }))
  const startTime = await readProcessStartTime(process.pid)
  if (!startTime) throw new Error('Probe process identity unavailable')
  entries.push(await ledger.record({ ...owner, resource: { kind: 'process', pid: process.pid, startTime, command: 'phase0-vite-hmr' } }))
  await cp(new URL('../../tests/fixtures/vite-hmr/', import.meta.url), root, { recursive: true })
  // 即使 Vite 的内部逻辑读取 cwd，也只看到可丢弃样本；显式配置关闭配置文件与 .env 加载。
  process.chdir(root)
  const layer = createResponseLayer({
    previewId: owner.previewId, nonce: randomBytes(32).toString('hex'), allowedHosts: ['127.0.0.1'],
    csp: {}, frameAncestors: ['http://127.0.0.1:3080'], bootstrapScript,
    onReport(report) { reports.push(report); void save().catch((error) => { console.error('Probe evidence write failed:', error.message); process.exitCode = 1 }) },
  })
  const { createServer } = await import(pathToFileURL(join(viteDirectory, 'dist/node/index.js')).href)
  // Vite 5 的客户端 import 使用真实包路径；只允许这个具体文件，不放行整个 /@fs/。
  const viteEnvironmentPath = '/@fs' + await realpath(join(viteDirectory, 'dist/client/env.mjs'))
  vite = await createServer({
    root, configFile: false, envFile: false, cacheDir: join(root, '.vite-cache'), clearScreen: false, logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: [] },
    // 非 middlewareMode 的 Vite 会自行在 SIGTERM 后 process.exit，抢先中断账本/临时目录清理。
    server: { middlewareMode: true, hmr: { server: httpServer, overlay: false } },
    plugins: [{
      name: 'page-preview-phase0-response-layer',
      configureServer(server) { server.middlewares.use(createHmrBoundary(layer, () => record, viteEnvironmentPath)) },
      transformIndexHtml: { order: 'post', handler: (html) => layer.transformDocument(html) },
    }],
  })
  httpServer.on('request', vite.middlewares)
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', resolve)
  })
  const address = httpServer.address()
  if (!address || typeof address === 'string') throw new Error('Vite did not bind a TCP port')
  record.origin = 'http://127.0.0.1:' + address.port
  record.startTime = startTime
  entries.push(await ledger.record({ ...owner, resource: { kind: 'port', port: address.port, pid: process.pid } }))
  await save()
  console.log(JSON.stringify({ origin: record.origin, root, pid: process.pid, startTime, viteVersion: manifest.version }))
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void close().catch((error) => { console.error('Probe cleanup failed:', error.message); process.exitCode = 1 }) })
} catch (error) {
  record.error = String(error)
  await close()
  throw error
}
