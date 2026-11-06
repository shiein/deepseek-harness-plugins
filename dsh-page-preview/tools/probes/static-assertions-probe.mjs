/** 静态目标/子文档断言验收（方案 §6.8、§9.2、§15.3）；编译完整插件、自有临时页面，无模型/用户 profile。 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { apply } from '../../lib/host/plugin.js'
import { createFileLedger, readProcessStartTime } from '../../lib/runner/ledger.js'
import { runnerPaths } from '../../lib/shared/runner/paths.js'
import { findListeningPids } from '../../lib/runner/port-ownership.js'

const [output, ...flags] = process.argv.slice(2)
if (!output || !isAbsolute(output) || flags.some(flag => flag !== '--scene')) throw new Error('Explicit absolute output and optional --scene required')
const scene = flags.includes('--scene')
await mkdir(output, { recursive: true })
const workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-static-assert-')))
const app = join(workspace, 'app')
await mkdir(app)
await writeFile(join(app, 'index.html'), '<!doctype html><html><head><title>Static assertion fixture</title></head><body><h1>Parent preparing</h1><button id="show">Show parent target</button><div id="target"></div><iframe title="Other document" src="/child.html"></iframe><script>document.getElementById("show").addEventListener("click", function () { document.getElementById("target").innerHTML = "<h2>Static target loaded</h2>" })</script></body></html>')
await writeFile(join(app, 'child.html'), '<!doctype html><html><head><title>Other document</title></head><body><div id="target"><h2>Static target loaded</h2></div></body></html>')
if (scene) {
  await writeFile(join(workspace, 'reply.json'), '{"label":"Offline rows"}')
  await writeFile(join(app, 'index.html'), `<!doctype html><html><head><title>Static HTTP scenario</title></head><body><h1>Static HTTP scenario</h1><p id="value">Loading fixture</p><button id="reload">Reload fixture</button><button id="missing">Request missing fixture</button><button id="write">Write static fixture</button><p id="missing-result"></p><p id="write-result"></p><script>
  async function load() { var response = await fetch('/api/value'); if (!response.ok) throw new Error('Fixture failed'); document.getElementById('value').textContent = 'Static fixture: ' + (await response.json()).label }
  document.getElementById('reload').addEventListener('click', load)
  document.getElementById('missing').addEventListener('click', async function () { var response = await fetch('/api/missing?private=DO_NOT_REPORT_QUERY'); document.getElementById('missing-result').textContent = 'Missing fixture: ' + response.status })
  document.getElementById('write').addEventListener('click', async function () { var response = await fetch('/api/write', {method:'POST'}); document.getElementById('write-result').textContent = 'Static write response: ' + response.status; await load() })
  load()
  </script></body></html>`)
}
const hash = async () => Promise.all(['index.html', 'child.html', ...(scene ? ['../reply.json'] : [])].map(async name => createHash('sha256').update(await readFile(join(app, name))).digest('hex')))
const before = await hash()
const project = { id: 'static', root: '.', runtime: { adapter: 'static', strategy: 'static', publicRoot: 'app', readiness: { targetDeadlineMs: 60000 } }, targets: [{ id: 'parent', selector: { kind: 'file', path: 'app/index.html' }, assertions: [{ kind: 'selector-visible', selector: '#target h2' }, { kind: 'text-present', text: 'Static target loaded' }] }] }
if (scene) {
  project.runtime.readiness.targetDeadlineMs = 300000
  project.targets[0].assertions = [{kind:'text-present',text:'Static fixture: Offline rows'}]
  project.scenarios = { own: {businessPaths:['/api/**'],http:[
    {method:'GET',path:'/api/value',response:{status:200,bodyFile:'reply.json',headers:{'Content-Type':'application/json'}}},
    {method:'POST',path:'/api/write',response:{status:201,body:{accepted:true}}},
  ]} }
}
await writeFile(join(workspace, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1, projects: [project] }))
const dataDir = join(workspace, 'private')
const paths = runnerPaths(dataDir, workspace)
const ctx = new Context()
new SystemPrompt(ctx, {})
const tools = new ToolRuntime(ctx)
const sessions = new SessionStore(ctx)
const session = sessions.create(SessionId('static-assertions-own-test'), { meta: { cwd: workspace } })
const agent = { id: session.id, session, ctx, options: {} }
apply(ctx, { dataDir, nodeExecutable: process.execPath })
let calls = 0
async function invoke(name, args = {}) {
  const result = await tools.execute({ callId: ToolCallId('static-assertions-' + ++calls), name: 'page_preview_' + name, arguments: args, signal: AbortSignal.timeout(15000), agent })
  assert.equal(result.isError, false)
  return result.value
}
let record
let interval
let closing = false
const save = () => writeFile(join(output, 'observations.json'), JSON.stringify(record, null, 2))
try {
  const opened = await invoke('open', { projectId: 'static', target: { kind: 'registered', id: 'parent' }, ...(scene ? {scenario:'own'} : {}) })
  assert.equal(opened.status, 'ok')
  assert.equal(opened.preview.state, 'reachable')
  const root = (await createFileLedger(paths.control).listByPreview('__runner__'))[0].resource
  record = { hostPid: process.pid, hostStartTime: await readProcessStartTime(process.pid), root, workspace, port: Number(new URL(opened.preview.url).port), previewId: opened.preview.previewId, url: opened.preview.url, scene, initial: opened.preview }
  await save()
  console.log(JSON.stringify(record))
  let reading = false
  interval = setInterval(() => {
    if (reading || closing) return
    reading = true
    void invoke('status', { previewId: record.previewId, detail: true }).then(async value => { if (!closing) { record.current = value; await save() } }).catch(error => { console.error(error.message); process.exitCode = 1 }).finally(() => { reading = false })
  }, 250)
  await new Promise(resolve => { for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, resolve) })
} finally {
  closing = true
  if (interval) clearInterval(interval)
  if (record) {
    assert.equal((await invoke('stop', { previewId: record.previewId })).stopped[0].state, 'stopped')
    assert.deepEqual(await findListeningPids(record.port), [])
    assert.deepEqual(await createFileLedger(paths.services).listByPreview(record.previewId), [])
  }
  await ctx.fiber.dispose()
  if (record) assert.equal(await readProcessStartTime(record.root.pid), undefined)
  assert.deepEqual(await createFileLedger(paths.control).listByPreview('__runner__'), [])
  assert.deepEqual(await hash(), before)
  await rm(workspace, { recursive: true, force: true })
  if (record) { record.cleaned = true; await save() }
}
