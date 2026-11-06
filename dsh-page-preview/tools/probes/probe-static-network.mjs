/** 产品 static.start 的真实浏览器边界探针（方案 §6.8、§7.3、§15.3）；自建回环接口、独立数据目录。 */
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RunnerClient } from '../../lib/host/runner-client.js'
import { fingerprintJson } from '../../lib/shared/fingerprint.js'
import { createFileLedger, readProcessStartTime } from '../../lib/shared/runner/ledger.js'

const output = fileURLToPath(new URL('../../output/', import.meta.url))
await mkdir(output, { recursive: true })
const dir = await realpath(await mkdtemp(join(output, 'network-browser-')))
const root = join(dir, 'workspace')
await cp(new URL('../../tests/fixtures/network-boundary/', import.meta.url), join(root, 'probe'), { recursive: true })
const ledger = createFileLedger(join(dir, 'probe-owner'))
const hostEntry = await ledger.record({ previewId: 'network-probe', ownerSessionId: 'probe', workspaceRoot: root, resource: { kind: 'process', pid: process.pid, startTime: await readProcessStartTime(process.pid), command: process.execPath } })
const counts = {}
const external = createServer((req, res) => {
  const path = new URL(req.url, 'http://probe.invalid').pathname
  if (path === '/stats') { res.end(JSON.stringify(counts)); return }
  counts[path] = (counts[path] ?? 0) + 1
  res.setHeader('Access-Control-Allow-Origin', '*')
  const documents = {
    '/jsonp': ['text/javascript', 'window.__networkProbeJsonp({synthetic:true})'],
    '/external-worker.js': ['text/javascript', 'self.postMessage({synthetic:true})'],
    '/pixel.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>'],
    '/style.css': ['text/css', 'body { --network-probe-external: 1 }'],
    '/frame.html': ['text/html', '<!doctype html><script>parent.postMessage({networkProbeFrame:true},"*")</script>'],
  }
  const [type, body] = documents[path] ?? ['application/json', JSON.stringify({ synthetic: true })]
  res.setHeader('Content-Type', type)
  res.end(body)
})
await new Promise(resolve => external.listen(0, '127.0.0.1', resolve))
const externalPort = external.address().port
const externalEntry = await ledger.record({ previewId: 'network-probe', ownerSessionId: 'probe', workspaceRoot: root, resource: { kind: 'port', port: externalPort, pid: process.pid } })
const origin = 'http://127.0.0.1:' + externalPort
const project = { id: 'network-probe', root: '.', runtime: { strategy: 'static', adapter: 'static', publicRoot: '.' }, targets: [{ id: 'index', selector: { kind: 'file', path: 'probe/index.html' } }] }
await writeFile(join(root, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1, projects: [project] }))
const unknown = { status: 'unknown', source: 'none', reason: 'This probe verifies rather than assumes network control' }
const plan = { projectId: project.id, targetId: 'index', selector: { kind: 'route', path: '/probe/index.html', query: { external: origin } }, scope: 'page', strategy: 'static', adapter: { id: 'static', version: '0.0.0' }, toolchain: {}, requirements: ['mock-only'], process: { kind: 'in-runner' }, readiness: { serviceDeadlineMs: 3000, targetDeadlineMs: 3000 }, capabilities: { scopes: {}, isolatedRender: unknown, scenarioApply: unknown, scenarioReset: unknown, refresh: unknown, captureCurrentView: unknown, runtimeErrors: unknown, readinessAssertion: unknown, network: [] }, fingerprints: { config: fingerprintJson(project) }, missing: [], knownDifferences: ['Network validation probe, not an accepted product plan'] }
const client = new RunnerClient({ dataDir: join(dir, 'plugin') })
let closing
function finish() {
  if (closing) return closing
  closing = (async () => {
    const result = await client.dispose()
    await new Promise((resolve, reject) => external.close(error => error ? reject(error) : resolve()))
    await ledger.release(externalEntry.id)
    await ledger.release(hostEntry.id)
    const residual = (await ledger.reconcile()).residual
    await writeFile(join(dir, 'result.json'), JSON.stringify({ counts, cleanup: result, residual: residual.length }, null, 2))
    console.log(JSON.stringify({ closed: true, counts, cleanup: result, residual: residual.length }))
    process.exit(result.residual.length || residual.length ? 1 : 0)
  })()
  return closing
}
process.on('SIGINT', () => { void finish() })
process.on('SIGTERM', () => { void finish() })
await client.start('network-first', plan, root, { ownerSessionId: 'probe' })
let shown = false
client.onMessage(message => {
  if (!shown && message.type === 'state' && message.state === 'reachable' && message.url) {
    shown = true
    const metadata = { pid: process.pid, startTime: hostEntry.resource.startTime, url: message.url, stats: origin + '/stats', output: dir }
    void writeFile(join(output, 'network-browser-current.json'), JSON.stringify(metadata, null, 2))
    console.log(JSON.stringify(metadata))
  }
})
