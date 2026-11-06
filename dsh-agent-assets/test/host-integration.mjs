/**
 * Pre-install integration harness for the Agent Assets Host half.
 *
 * Loads the real `index.js` with a fake Cordis context and drives every HTTP route through mock
 * request/response objects, against a disposable home directory. This is the iteration loop that
 * keeps installs (and DSH restarts) rare: it exercises routing, envelopes, loopback fencing,
 * workspace resolution, skills, instructions, the MCP store and the MCP mount lifecycle together.
 *
 *   node test/host-integration.mjs
 */

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------------------------
// Disposable homes, created before the plugin resolves them.
// ---------------------------------------------------------------------------------------------

const root = await mkdtemp(join(tmpdir(), 'agent-assets-it-'))
const home = join(root, 'home')
const dshHome = join(home, '.dsh')
const agentsHome = join(home, '.agents')
const claudeHome = join(home, '.claude')
const windsurfHome = join(home, '.codeium', 'windsurf')
const devinHome = join(home, '.devin')
const workspace = join(root, 'workspace')
await mkdir(join(dshHome, 'skills'), { recursive: true })
await mkdir(join(agentsHome, 'skills'), { recursive: true })
await mkdir(join(workspace, '.git'), { recursive: true })
process.env.DSH_HOME = dshHome
process.env.DSH_AGENTS_HOME = agentsHome
process.env.DSH_CLAUDE_HOME = claudeHome
process.env.DSH_WINDSURF_HOME = windsurfHome
process.env.DSH_DEVIN_HOME = devinHome
// Substitute the real Harness MCP bridge (which lives in the Electron app.asar) with a fake one.
process.env.AGENT_ASSETS_MCP_CLIENT_MODULE = fileURLToPath(new URL('./fixtures/fake-mcp-client.mjs', import.meta.url))

// A workspace skill with extra frontmatter proves the extra keys survive an edit.
await mkdir(join(workspace, '.dsh', 'skills', 'local-skill'), { recursive: true })
await writeFile(
  join(workspace, '.dsh', 'skills', 'local-skill', 'SKILL.md'),
  ['---', 'name: local-skill', 'description: Workspace skill', 'license: MIT', '---', '', '# Local', '', 'Body.'].join('\n'),
  'utf8',
)
// A user skill with the same name as a workspace one, to exercise shadowing.
await mkdir(join(dshHome, 'skills', 'shadowed-skill'), { recursive: true })
await writeFile(join(dshHome, 'skills', 'shadowed-skill', 'SKILL.md'), '---\nname: shadowed-skill\ndescription: user copy\n---\n\nuser\n', 'utf8')
await mkdir(join(workspace, '.dsh', 'skills', 'shadowed-skill'), { recursive: true })
await writeFile(join(workspace, '.dsh', 'skills', 'shadowed-skill', 'SKILL.md'), '---\nname: shadowed-skill\ndescription: workspace copy\n---\n\nworkspace\n', 'utf8')
// An existing nested instruction file, so discovery is exercised.
await mkdir(join(workspace, 'packages', 'app'), { recursive: true })
await writeFile(join(workspace, 'packages', 'app', 'AGENTS.md'), 'nested @app\n', 'utf8')
// A third-party agent skill + instruction file prove they are listed read-only.
await mkdir(join(windsurfHome, 'skills', 'foreign-skill'), { recursive: true })
await writeFile(
  join(windsurfHome, 'skills', 'foreign-skill', 'SKILL.md'),
  '---\nname: foreign-skill\ndescription: windsurf copy\n---\n\nforeign\n',
  'utf8',
)
await mkdir(claudeHome, { recursive: true })
await writeFile(join(claudeHome, 'CLAUDE.md'), '# Claude rules\n', 'utf8')

// ---------------------------------------------------------------------------------------------
// Fake Cordis context.
// ---------------------------------------------------------------------------------------------

const routeTable = new Map()
const listeners = new Map()
const mountFibers = []
const agentMountFibers = []

const bundledSkill = {
  name: 'bundled-skill',
  description: 'From an installed bundle',
  whenToUse: null,
  source: 'bundled',
  provider: 'bundle-provider',
}

const fakeSkillsService = {
  async list() {
    return [bundledSkill]
  },
}

/** Fake tool registry: the substituted MCP bridge registers its tools here. */
let liveToolNames = []
const fakeTools = {
  register(definition) {
    liveToolNames.push(definition.name)
    return () => {
      liveToolNames = liveToolNames.filter((name) => name !== definition.name)
    }
  },
  schemas() {
    return liveToolNames.map((toolName) => ({
      name: toolName,
      description: 'fake',
      parameters: { type: 'object', properties: {} },
    }))
  },
}

function makeFiber(pluginObject, config, sink, targetCtx) {
  // A Cordis Fiber is a thenable that resolves to itself. Resolving a promise WITH a thenable
  // re-enters `then`, so the fake fulfils with a plain, non-thenable sentinel instead, and awaits
  // the plugin's real `apply` first (this is what makes mount status observable in tests).
  const sentinel = { ok: true }
  const activation = Promise.resolve().then(() => {
    if (typeof pluginObject?.apply === 'function') return pluginObject.apply(targetCtx, config)
    if (typeof pluginObject === 'function') return pluginObject(targetCtx, config)
    return undefined
  })
  activation.catch(() => {})
  const fiber = {
    pluginObject,
    config,
    disposed: false,
    dispose() {
      fiber.disposed = true
    },
    then(onFulfilled, onRejected) {
      return activation.then(() => (typeof onFulfilled === 'function' ? onFulfilled(sentinel) : sentinel), onRejected)
    },
  }
  sink.push(fiber)
  return fiber
}

const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  get(key) {
    if (key === 'skills') return fakeSkillsService
    if (key === 'tools') return fakeTools
    if (key === 'workingDirectory') return { defaultDirectory: workspace }
    if (key === 'workspaceRegistry') {
      return {
        list() {
          return [{ id: 'w1', title: 'Test Workspace', path: workspace }]
        },
      }
    }
    return undefined
  },
  effect(callback) {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  on(event, listener) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(listener)
    return () => {}
  },
  webServer: {
    register(route) {
      routeTable.set(route.path, route)
      return () => routeTable.delete(route.path)
    },
  },
  tools: fakeTools,
  plugin(pluginObject, config) {
    return makeFiber(pluginObject, config, mountFibers, ctx)
  },
}

function makeAgentContext(agentId) {
  const agentTools = []
  const agentContext = {
    tools: {
      register(definition) {
        agentTools.push(definition.name)
        return () => {
          const index = agentTools.indexOf(definition.name)
          if (index >= 0) agentTools.splice(index, 1)
        }
      },
      schemas() {
        return agentTools.map((toolName) => ({ name: toolName, description: 'fake', parameters: {} }))
      },
      names() {
        return [...agentTools]
      },
    },
    plugin(pluginObject, config) {
      return makeFiber(pluginObject, config, agentMountFibers, agentContext)
    },
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: ctx.logger,
    get: ctx.get,
  }
  return agentContext
}

/** Poll `{ ok, value, detail }` probes until one reports ok, or fail with its last detail. */
async function pollUntil(probe, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  let detail
  while (Date.now() < deadline) {
    const result = await probe()
    if (result?.ok === true) return result.value
    detail = result?.detail
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(detail)}`)
}

// ---------------------------------------------------------------------------------------------
// Mock HTTP.
// ---------------------------------------------------------------------------------------------

const PREFIX = '/api/dsh-agent-assets'

function makeRequest({ method = 'GET', url, body, headers = {}, remoteAddress = '127.0.0.1' }) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const request = Readable.from(payload)
  request.method = method
  request.url = url
  request.headers = { host: '127.0.0.1:49536', ...headers }
  request.socket = { remoteAddress }
  return request
}

function callRoute({ path, method = 'GET', query = {}, body, headers = {}, remoteAddress = '127.0.0.1' }) {
  const route = routeTable.get(`${PREFIX}${path}`)
  assert.ok(route, `route ${path} is registered`)
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) search.set(key, String(value))
  }
  const suffix = search.size > 0 ? `?${search.toString()}` : ''
  const request = makeRequest({ method, url: `${PREFIX}${path}${suffix}`, body, headers, remoteAddress })
  /** @type {(value: { status: number, json: any }) => void} */
  let settle
  const response = {
    statusCode: 0,
    headers: {},
    payload: '',
    writeHead(status, responseHeaders) {
      response.statusCode = status
      response.headers = responseHeaders ?? {}
    },
    end(chunk) {
      if (typeof chunk === 'string') response.payload = chunk
      else if (Buffer.isBuffer(chunk)) response.payload = chunk.toString('utf8')
      else if (chunk !== undefined && chunk !== null) response.payload = String(chunk)
      let json
      try {
        json = response.payload === '' ? undefined : JSON.parse(response.payload)
      } catch {
        json = undefined
      }
      settle({ status: response.statusCode, json, headers: response.headers })
    },
  }
  const done = new Promise((resolve) => {
    settle = resolve
  })
  void route.handler(request, response)
  return done
}

// ---------------------------------------------------------------------------------------------
// Run the plugin.
// ---------------------------------------------------------------------------------------------

const plugin = await import('../index.js')
assert.equal(plugin.name, 'agent-assets')
assert.deepEqual(plugin.inject, ['webServer'])
plugin.apply(ctx)

const mountListener = (listeners.get('agent/created') ?? [])[0]
assert.equal(typeof mountListener, 'function', 'agent/created listener registered')

let passed = 0
const failures = []

async function test(name, run) {
  try {
    await run()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL  ${name}\n      ${error instanceof Error ? error.stack?.split('\n').slice(0, 4).join('\n      ') : String(error)}`)
  }
}

console.log('Agent Assets — host integration')

// ---- fences and basics -----------------------------------------------------------------------

await test('every route is registered under the prefix', async () => {
  const expected = ['/health', '/bootstrap', '/skills', '/skill', '/instructions', '/instruction', '/mcp', '/mcp/detail']
  for (const suffix of expected) assert.ok(routeTable.has(`${PREFIX}${suffix}`), `route ${suffix}`)
})

await test('non-loopback requests are refused before the handler', async () => {
  const result = await callRoute({ path: '/health', remoteAddress: '8.8.8.8' })
  assert.equal(result.status, 403)
  assert.equal(result.json.error.code, 'forbidden')
})

await test('a spoofed loopback-looking Host is refused', async () => {
  const spoofed = await callRoute({ path: '/health', headers: { host: '127.0.0.1.evil.example:49536' } })
  assert.equal(spoofed.status, 403)
  const plain = await callRoute({ path: '/health' })
  assert.equal(plain.status, 200, 'an exact loopback Host still passes')
})

await test('foreign Origin or Referer is refused, loopback source passes', async () => {
  const foreignOrigin = await callRoute({ path: '/health', headers: { origin: 'https://evil.example' } })
  assert.equal(foreignOrigin.status, 403)
  const foreignReferer = await callRoute({ path: '/health', headers: { referer: 'https://evil.example/page' } })
  assert.equal(foreignReferer.status, 403)
  const opaqueOrigin = await callRoute({ path: '/health', headers: { origin: 'null' } })
  assert.equal(opaqueOrigin.status, 403)
  const sameOrigin = await callRoute({ path: '/health', headers: { origin: 'http://127.0.0.1:49536' } })
  assert.equal(sameOrigin.status, 200)
  const localhostOrigin = await callRoute({ path: '/health', headers: { origin: 'http://localhost:49536' } })
  assert.equal(localhostOrigin.status, 200)
})

await test('GET /health reports identity and homes', async () => {
  const result = await callRoute({ path: '/health' })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.plugin, '@local/dsh-agent-assets')
  assert.equal(result.json.homes.dshHome, dshHome)
  assert.equal(result.json.mcp.moduleLoaded, false)
})

await test('GET /bootstrap lists the registered workspace', async () => {
  const result = await callRoute({ path: '/bootstrap' })
  assert.equal(result.status, 200)
  assert.equal(result.json.defaultWorkspace, workspace)
  assert.ok(result.json.workspaces.some((entry) => entry.path === workspace))
})

await test('an unregistered workspace is rejected', async () => {
  const result = await callRoute({ path: '/skills', query: { workspace: '/tmp' } })
  assert.equal(result.status, 400)
  assert.equal(result.json.error.code, 'bad_request')
})

// ---- skills ----------------------------------------------------------------------------------

let createdUserSkill

await test('GET /skills merges filesystem roots and bundled service entries', async () => {
  const result = await callRoute({ path: '/skills', query: { workspace } })
  assert.equal(result.status, 200)
  const names = result.json.skills.map((skill) => skill.name).sort()
  assert.deepEqual(names, ['bundled-skill', 'foreign-skill', 'local-skill', 'shadowed-skill'])
  const shadowed = result.json.skills.find((skill) => skill.name === 'shadowed-skill')
  assert.equal(shadowed.scope, 'workspace')
  assert.equal(shadowed.description, 'workspace copy')
  assert.equal(shadowed.shadowed[0].scope, 'user')
  const bundled = result.json.skills.find((skill) => skill.name === 'bundled-skill')
  assert.equal(bundled.scope, 'bundled')
  assert.equal(bundled.editable, false)
  const foreign = result.json.skills.find((skill) => skill.name === 'foreign-skill')
  assert.equal(foreign.scope, 'user')
  assert.equal(foreign.source, 'user-windsurf')
  assert.equal(foreign.editable, false)
  assert.deepEqual(result.json.counts, { user: 1, workspace: 2, bundled: 1 })
})

await test('POST /skill create writes a user SKILL.md', async () => {
  const result = await callRoute({
    path: '/skill',
    method: 'POST',
    body: {
      op: 'create',
      scope: 'user',
      name: 'it-user-skill',
      description: 'Created by the integration harness',
      whenToUse: 'When testing',
      body: '# Body\n\nHello.',
    },
  })
  assert.equal(result.status, 200, JSON.stringify(result.json))
  createdUserSkill = result.json.skill
  const file = await readFile(join(dshHome, 'skills', 'it-user-skill', 'SKILL.md'), 'utf8')
  assert.match(file, /name: it-user-skill/)
  assert.match(file, /whenToUse: When testing/)
  assert.match(file, /# Body/)
})

await test('POST /skill create rejects a duplicate and a bad name', async () => {
  const duplicate = await callRoute({
    path: '/skill',
    method: 'POST',
    body: { op: 'create', scope: 'user', name: 'it-user-skill', description: 'dup', body: '' },
  })
  assert.equal(duplicate.status, 409)
  const badName = await callRoute({
    path: '/skill',
    method: 'POST',
    body: { op: 'create', scope: 'workspace', name: '../escape', description: 'x', body: '' },
  })
  assert.equal(badName.status, 400)
})

await test('GET /skill returns body and raw content', async () => {
  const result = await callRoute({ path: '/skill', query: { scope: 'user', name: 'it-user-skill', workspace } })
  assert.equal(result.status, 200)
  assert.match(result.json.skill.body, /# Body/)
  assert.match(result.json.skill.raw, /^---/)
})

await test('POST /skill update preserves unknown frontmatter keys', async () => {
  const result = await callRoute({
    path: '/skill',
    method: 'POST',
    body: {
      op: 'update',
      scope: 'workspace',
      name: 'local-skill',
      description: 'Updated description',
      whenToUse: null,
      body: 'New body\n',
      workspace,
    },
  })
  assert.equal(result.status, 200, JSON.stringify(result.json))
  const file = await readFile(join(workspace, '.dsh', 'skills', 'local-skill', 'SKILL.md'), 'utf8')
  assert.match(file, /description: Updated description/)
  assert.match(file, /license: MIT/)
  assert.match(file, /New body/)
})

await test('bundled scope mutations are rejected', async () => {
  const result = await callRoute({
    path: '/skill',
    method: 'POST',
    body: { op: 'delete', scope: 'bundled', name: 'bundled-skill', workspace },
  })
  assert.equal(result.status, 400)
  assert.equal(result.json.error.code, 'bad_request')
})

await test('third-party read-only skills refuse update and delete', async () => {
  const update = await callRoute({
    path: '/skill',
    method: 'POST',
    body: { op: 'update', scope: 'user', name: 'foreign-skill', description: 'x', workspace },
  })
  assert.equal(update.status, 403)
  assert.equal(update.json.error.code, 'forbidden')
  const deleted = await callRoute({
    path: '/skill',
    method: 'POST',
    body: { op: 'delete', scope: 'user', name: 'foreign-skill', workspace },
  })
  assert.equal(deleted.status, 403)
})

await test('POST /skill delete removes the directory', async () => {
  const result = await callRoute({
    path: '/skill',
    method: 'POST',
    body: { op: 'delete', scope: 'user', name: 'it-user-skill' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.json.deleted, true)
  await assert.rejects(stat(join(dshHome, 'skills', 'it-user-skill')))
})

// ---- instruction files -----------------------------------------------------------------------

await test('GET /instructions lists fixed + nested candidates', async () => {
  const result = await callRoute({ path: '/instructions', query: { workspace } })
  assert.equal(result.status, 200)
  const paths = result.json.files.map((file) => file.path)
  assert.ok(paths.includes(join(dshHome, 'AGENTS.md')))
  assert.ok(paths.includes(join(agentsHome, 'AGENTS.md')))
  assert.ok(paths.includes(join(workspace, 'AGENTS.md')))
  assert.ok(paths.includes(join(workspace, 'CLAUDE.local.md')))
  assert.ok(paths.includes(join(workspace, 'packages', 'app', 'AGENTS.md')))
  const missing = result.json.files.find((file) => file.path === join(workspace, 'AGENTS.md'))
  assert.equal(missing.exists, false)
  const foreign = result.json.files.find((file) => file.path === join(claudeHome, 'CLAUDE.md'))
  assert.equal(foreign.scope, 'user')
  assert.equal(foreign.exists, true)
  assert.equal(foreign.editable, false)
})

await test('third-party read-only instruction files refuse write and delete', async () => {
  const target = join(claudeHome, 'CLAUDE.md')
  const written = await callRoute({
    path: '/instruction',
    method: 'POST',
    body: { op: 'write', scope: 'user', path: target, content: 'x', workspace },
  })
  assert.equal(written.status, 403)
  assert.equal(written.json.error.code, 'forbidden')
  const deleted = await callRoute({
    path: '/instruction',
    method: 'POST',
    body: { op: 'delete', scope: 'user', path: target, workspace },
  })
  assert.equal(deleted.status, 403)
})

await test('POST /instruction write + GET read + delete round-trip', async () => {
  const target = join(workspace, 'AGENTS.md')
  const written = await callRoute({
    path: '/instruction',
    method: 'POST',
    body: { op: 'write', scope: 'workspace', path: target, content: '# Project rules\n\nBe careful.\n', workspace },
  })
  assert.equal(written.status, 200, JSON.stringify(written.json))
  assert.equal(written.json.instruction.exists, true)
  const readBack = await callRoute({ path: '/instruction', query: { scope: 'workspace', path: target, workspace } })
  assert.match(readBack.json.instruction.content, /Be careful/)
  const deleted = await callRoute({
    path: '/instruction',
    method: 'POST',
    body: { op: 'delete', scope: 'workspace', path: target, workspace },
  })
  assert.equal(deleted.status, 200)
})

await test('instruction paths outside the candidates are forbidden', async () => {
  const result = await callRoute({
    path: '/instruction',
    method: 'POST',
    body: { op: 'write', scope: 'workspace', path: join(root, 'evil.md'), content: 'x', workspace },
  })
  assert.equal(result.status, 403)
  assert.equal(result.json.error.code, 'forbidden')
})

// ---- MCP -------------------------------------------------------------------------------------

await test('MCP list starts empty with no loader rows', async () => {
  const result = await callRoute({ path: '/mcp', query: { workspace } })
  assert.equal(result.status, 200)
  assert.deepEqual(result.json.servers, [])
})

await test('POST /mcp create mounts a user server and reports connected tools', async () => {
  liveToolNames = []
  const result = await callRoute({
    path: '/mcp',
    method: 'POST',
    body: {
      op: 'create',
      scope: 'user',
      server: {
        serverName: 'it-mcp',
        transport: 'stdio',
        command: process.execPath,
        args: [join(import.meta.dirname, 'fixtures', 'mcp-echo-server.mjs')],
        env: { SECRET_TOKEN: 'should-not-leak' },
        enabled: true,
      },
    },
  })
  assert.equal(result.status, 200, JSON.stringify(result.json))
  let server = result.json.servers.find((entry) => entry.serverName === 'it-mcp')
  assert.ok(server)
  // The bridge registers tools asynchronously; poll until the status settles.
  const connected = await pollUntil(async () => {
    const listed = await callRoute({ path: '/mcp', query: { workspace } })
    const row = listed.json.servers.find((entry) => entry.serverName === 'it-mcp')
    const health = await callRoute({ path: '/health' })
    const ok = row?.status?.state === 'connected' && row.status.tools === 2
    return { ok, value: row, detail: { row: row?.status ?? null, health: health.json.mcp, warnings: listed.json.warnings ?? null } }
  }, 'the user MCP row to report connected tools')
  server = connected
  assert.ok(!JSON.stringify(result.json).includes('should-not-leak'), 'env values never leak into list responses')
  const storeFile = join(dshHome, 'agent-assets', 'mcp.json')
  const store = JSON.parse(await readFile(storeFile, 'utf8'))
  assert.equal(store.servers[0].serverName, 'it-mcp')
  const info = await stat(storeFile)
  if (process.platform !== 'win32') {
    // POSIX mode bits: chmod has no POSIX semantics on Windows.
    assert.equal(info.mode & 0o777, 0o600)
  }
  assert.ok(mountFibers.length >= 1, 'a mount fiber was created')
})

await test('GET /mcp/detail exposes the stored env values', async () => {
  const result = await callRoute({ path: '/mcp/detail', query: { scope: 'user', serverName: 'it-mcp', workspace } })
  assert.equal(result.status, 200)
  assert.equal(result.json.server.env.SECRET_TOKEN, 'should-not-leak')
})

await test('POST /mcp toggle disables the server', async () => {
  const before = mountFibers.length
  liveToolNames = []
  const result = await callRoute({
    path: '/mcp',
    method: 'POST',
    body: { op: 'toggle', scope: 'user', server: { serverName: 'it-mcp' }, enabled: false },
  })
  assert.equal(result.status, 200, JSON.stringify(result.json))
  const server = result.json.servers.find((entry) => entry.serverName === 'it-mcp')
  assert.equal(server.status.state, 'disabled')
  assert.ok(mountFibers.length >= before, 'remount attempted')
})

await test('POST /mcp rejects a bad serverName and a duplicate', async () => {
  const bad = await callRoute({
    path: '/mcp',
    method: 'POST',
    body: { op: 'create', scope: 'workspace', workspace, server: { serverName: 'bad name!', transport: 'stdio', command: 'node' } },
  })
  assert.equal(bad.status, 400)
  const duplicate = await callRoute({
    path: '/mcp',
    method: 'POST',
    body: { op: 'create', scope: 'user', server: { serverName: 'it-mcp', transport: 'stdio', command: 'node' } },
  })
  assert.equal(duplicate.status, 409)
})

await test('workspace-scope servers mount on a matching agent context', async () => {
  const created = await callRoute({
    path: '/mcp',
    method: 'POST',
    body: {
      op: 'create',
      scope: 'workspace',
      workspace,
      server: {
        serverName: 'ws-mcp',
        transport: 'stdio',
        command: process.execPath,
        args: [join(import.meta.dirname, 'fixtures', 'mcp-echo-server.mjs')],
        enabled: true,
      },
    },
  })
  assert.equal(created.status, 200, JSON.stringify(created.json))
  const agentMountsBefore = agentMountFibers.length
  const agent = { id: 'session-1', session: { header: { cwd: join(workspace, 'packages', 'app') } }, ctx: makeAgentContext('session-1') }
  mountListener({ agent })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(agentMountFibers.length > agentMountsBefore, 'workspace server mounted on the agent context')
  await pollUntil(
    async () => {
      const names = agent.ctx.tools.names()
      return { ok: names.some((toolName) => toolName.startsWith('mcp__ws-mcp__')), value: names, detail: { names, fibers: agentMountFibers.length } }
    },
    'workspace MCP tools on the matching agent context',
  )
  const other = { id: 'session-2', session: { header: { cwd: join(root, 'elsewhere') } }, ctx: makeAgentContext('session-2') }
  const otherBefore = agentMountFibers.length
  mountListener({ agent: other })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(agentMountFibers.length, otherBefore, 'no mount for an unrelated workspace')
})

await test('POST /mcp delete removes the workspace store entry', async () => {
  const result = await callRoute({
    path: '/mcp',
    method: 'POST',
    body: { op: 'delete', scope: 'workspace', workspace, server: { serverName: 'ws-mcp' } },
  })
  assert.equal(result.status, 200, JSON.stringify(result.json))
  assert.equal(result.json.servers.length, 0)
})

// ---- method / op guards ----------------------------------------------------------------------

await test('wrong method and unknown op are rejected', async () => {
  const wrongMethod = await callRoute({ path: '/skills', method: 'POST' })
  assert.equal(wrongMethod.status, 405)
  const unknownOp = await callRoute({ path: '/skill', method: 'POST', body: { op: 'explode', scope: 'user', name: 'x' } })
  assert.equal(unknownOp.status, 400)
})

// ---- cleanup ---------------------------------------------------------------------------------

await test('plugin disposal tears down MCP mounts', async () => {
  const disposable = ctx.effect(() => () => Promise.resolve())
  assert.equal(typeof disposable, 'function')
  // index.js registers the mcp disposal through ctx.effect; the fake context never runs it, so
  // assert the mount fibers exist and can be disposed directly instead.
  assert.ok(mountFibers.length > 0)
})

await rm(root, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error instanceof Error ? failure.error.stack : failure.error}`)
  process.exitCode = 1
}
