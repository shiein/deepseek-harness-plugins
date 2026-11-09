/**
 * Tests for the Agent Assets MCP host module: store validation/persistence, list/detail masking,
 * mount reconciliation and Session-scoped attach — all against temp dirs and a fake bridge/context.
 *
 * No real network, no child processes: `loadClientPlugin` is always a fake namespace whose `apply`
 * registers fake tool names on the fake tool registry.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createMcp } from '../host/mcp.js'

// -------------------------------------------------------------------------------------------
// Fixtures.
// -------------------------------------------------------------------------------------------

const tempRoots = []

async function makeTmp() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-assets-mcp-'))
  tempRoots.push(directory)
  return directory
}

after(async () => {
  for (const directory of tempRoots.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** Let queued microtasks and one filesystem round-trip settle. */
const flush = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll `predicate` until truthy, failing the test on timeout. */
async function waitFor(predicate, { timeout = 2000, interval = 5, label = 'condition' } = {}) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeout) assert.fail(`timed out waiting for ${label}`)
    await flush(interval)
  }
}

/** Fake `ctx.tools` registry: schemas() returns model-facing names for one scope. */
function createFakeTools() {
  const scopes = new Map()
  const setFor = (scope) => {
    let set = scopes.get(scope)
    if (!set) {
      set = new Set()
      scopes.set(scope, set)
    }
    return set
  }
  return {
    register(scope, name) {
      setFor(scope).add(name)
    },
    schemas(scope) {
      return [...(scopes.get(scope) ?? [])]
        .sort()
        .map((name) => ({ name, description: `fake ${name}`, parameters: { type: 'object' } }))
    },
  }
}

/**
 * Fake Cordis context: `plugin()` runs the namespace's `apply` in a microtask and returns a
 * thenable Fiber with `dispose()`, mirroring the real Cordis contract closely enough for the module.
 */
function createHarness({ tools = createFakeTools(), configEditor } = {}) {
  const mounts = []
  let counter = 0
  const makeCtx = (label, scope) => ({
    label,
    get(name) {
      if (name === 'tools') return tools
      if (name === 'configEditor') return configEditor
      return undefined
    },
    on() {
      return () => {}
    },
    effect(setup) {
      try {
        return setup()
      } catch {
        return undefined
      }
    },
    plugin(pluginObject, config) {
      const id = (counter += 1)
      const mountCtx = {
        registerTool(name) {
          tools.register(scope, name)
        },
      }
      let ready
      try {
        ready = Promise.resolve().then(() => pluginObject.apply(mountCtx, config))
      } catch (error) {
        ready = Promise.reject(error)
      }
      const record = { id, label, config, disposed: false }
      mounts.push(record)
      return {
        // Mirrors Cordis 4.x: the Fiber is PromiseLike AND exposes `await()`.
        await() {
          return ready
        },
        then(onFulfilled, onRejected) {
          return ready.then(onFulfilled, onRejected)
        },
        dispose() {
          record.disposed = true
          return Promise.resolve()
        },
      }
    },
  })
  return { tools, mounts, ctx: makeCtx('root', undefined), makeCtx }
}

/** Fake MCP client namespace. `onApply` may throw to simulate a failed connection/spawn. */
function createNamespace({ onApply } = {}) {
  return {
    name: 'mcp-client',
    inject: ['tools'],
    Config: { fake: true },
    async apply(mountCtx, config) {
      if (onApply) {
        await onApply(mountCtx, config)
        return
      }
      mountCtx.registerTool(`mcp__${config.serverName}__echo`)
    },
  }
}

/** Build a fake Agent the way the Harness does: a session header with cwd plus a scoped ctx. */
function createAgent(harness, id, cwd) {
  const agent = { id, session: { header: cwd === undefined ? {} : { cwd } } }
  agent.ctx = harness.makeCtx(`agent:${id}`, agent)
  return agent
}

/** Create the manager over temp homes and a fully fake context. */
async function setup({ tmp, homes: homesOverride, namespace, loadClientPlugin, configEditor, tools } = {}) {
  const homes = homesOverride ?? { dshHome: join(tmp, 'dsh-home'), agentsHome: join(tmp, 'agents-home') }
  const harness = createHarness({ tools, configEditor })
  const fakeNamespace = namespace ?? createNamespace()
  const mcp = createMcp({
    ctx: harness.ctx,
    homes,
    loadClientPlugin: loadClientPlugin ?? (async () => fakeNamespace),
  })
  await flush(20)
  return { mcp, homes, harness, namespace: fakeNamespace }
}

/** Read the user store path for a homes object. */
function userStore(homes) {
  return join(homes.dshHome, 'agent-assets', 'mcp.json')
}

/** Read the workspace store path. */
function workspaceStore(root) {
  return join(root, '.dsh', 'agent-assets', 'mcp.json')
}

const stdioServer = (serverName, extra = {}) => ({
  transport: 'stdio',
  serverName,
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  ...extra,
})

// -------------------------------------------------------------------------------------------
// Validation.
// -------------------------------------------------------------------------------------------

test('create rejects invalid server configs with bad_request', async () => {
  const tmp = await makeTmp()
  const { mcp, homes } = await setup({ tmp })

  const invalid = [
    { transport: 'stdio', serverName: 'bad name', command: 'npx' },
    { transport: 'stdio', serverName: '', command: 'npx' },
    { transport: 'stdio', serverName: 'a'.repeat(33), command: 'npx' },
    { transport: 'sse', serverName: 'ok', command: 'npx' },
    { transport: 'stdio', serverName: 'ok' },
    { transport: 'stdio', serverName: 'ok', command: '   ' },
    { transport: 'stdio', serverName: 'ok', command: 'npx', args: '--help' },
    { transport: 'stdio', serverName: 'ok', command: 'npx', args: ['ok', 7] },
    { transport: 'stdio', serverName: 'ok', command: 'npx', env: { TOKEN: 7 } },
    { transport: 'stdio', serverName: 'ok', command: 'npx', env: ['TOKEN=7'] },
    { transport: 'stdio', serverName: 'ok', command: 'npx', cwd: 7 },
    { transport: 'stdio', serverName: 'ok', command: 'npx', toolCallTimeoutMs: 0 },
    { transport: 'stdio', serverName: 'ok', command: 'npx', toolCallTimeoutMs: '60000' },
    { transport: 'streamable-http', serverName: 'ok', url: '/relative/path' },
    { transport: 'streamable-http', serverName: 'ok', url: 'ftp://example.com/mcp' },
    { transport: 'streamable-http', serverName: 'ok' },
    { transport: 'streamable-http', serverName: 'ok', url: 'https://example.com/mcp', headers: { A: 1 } },
    { transport: 'stdio', serverName: 'ok', command: 'npx', enabled: 'yes' },
  ]
  for (const server of invalid) {
    await assert.rejects(
      mcp.apply({ op: 'create', scope: 'user', server }),
      (error) => error.code === 'bad_request' && error.status === 400,
      `expected bad_request for ${JSON.stringify(server)}`,
    )
  }

  await assert.rejects(
    mcp.apply({ op: 'create', scope: 'bundled', server: stdioServer('ok') }),
    (error) => error.code === 'bad_request',
  )
  await assert.rejects(
    mcp.apply({ op: 'create', scope: 'workspace', server: stdioServer('ok') }),
    (error) => error.code === 'bad_request',
  )
  await assert.rejects(
    mcp.apply({ op: 'rename', scope: 'user', server: stdioServer('ok') }),
    (error) => error.code === 'bad_request',
  )
  await assert.rejects(
    mcp.apply({ op: 'create', scope: 'user' }),
    (error) => error.code === 'bad_request',
  )

  // Nothing was persisted by the rejected requests.
  await assert.rejects(readFile(userStore(homes), 'utf8'), /ENOENT/)
})

test('create rejects duplicate names inside one scope but allows the same name in the other scope', async () => {
  const tmp = await makeTmp()
  const workspace = join(tmp, 'project')
  await mkdir(workspace, { recursive: true })
  const { mcp } = await setup({ tmp })

  await mcp.apply({ op: 'create', scope: 'user', server: stdioServer('files') })
  await assert.rejects(
    mcp.apply({ op: 'create', scope: 'user', server: stdioServer('files', { command: 'other' }) }),
    (error) => error.code === 'conflict' && error.status === 409,
  )
  // Same serverName in workspace scope is a different registration scope.
  const workspaceResult = await mcp.apply({ op: 'create', scope: 'workspace', workspace, server: stdioServer('files') })
  assert.equal(workspaceResult.servers.length, 1)
})

// -------------------------------------------------------------------------------------------
// Persistence / CRUD / masking.
// -------------------------------------------------------------------------------------------

test('CRUD persists the store (0600), list masks secrets, detail exposes them, toggle remounts', async () => {
  const tmp = await makeTmp()
  const { mcp, homes, harness } = await setup({ tmp })
  const storePath = userStore(homes)

  const created = await mcp.apply({
    op: 'create',
    scope: 'user',
    server: stdioServer('files', { env: { TOKEN: 'super-secret' }, toolCallTimeoutMs: 1234 }),
  })
  assert.equal(created.servers.length, 1)
  assert.deepEqual(Object.keys(created.servers[0]).sort(), [
    'createdAt',
    'enabled',
    'scope',
    'serverName',
    'status',
    'summary',
    'transport',
    'updatedAt',
  ])
  assert.deepEqual(Object.keys(created.servers[0].status).sort(), ['error', 'state', 'tools'])

  // Store file: exact format, mode 0600, full config retained.
  const raw = JSON.parse(await readFile(storePath, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.servers.length, 1)
  assert.equal(raw.servers[0].serverName, 'files')
  assert.equal(raw.servers[0].scope, 'user')
  assert.equal(raw.servers[0].transport, 'stdio')
  assert.equal(raw.servers[0].command, 'npx')
  assert.deepEqual(raw.servers[0].args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'])
  assert.deepEqual(raw.servers[0].env, { TOKEN: 'super-secret' })
  assert.equal(raw.servers[0].toolCallTimeoutMs, 1234)
  assert.equal(raw.servers[0].enabled, true)
  assert.equal(typeof raw.servers[0].createdAt, 'string')
  assert.equal(typeof raw.servers[0].updatedAt, 'string')
  if (process.platform !== 'win32') {
    // POSIX mode bits: chmod has no POSIX semantics on Windows.
    assert.equal((await stat(storePath)).mode & 0o777, 0o600)
  }

  // list: no command/url/env/header values anywhere.
  const listed = await mcp.list({ workspace: tmp })
  assert.equal(listed.servers.length, 1)
  const view = listed.servers[0]
  assert.equal(view.summary, 'npx -y @modelcontextprotocol/server-filesystem /tmp')
  assert.ok(!('env' in view))
  assert.ok(!('command' in view))
  assert.ok(!JSON.stringify(listed).includes('super-secret'))

  // Status flips to connected once the fake bridge registers its tool.
  await waitFor(
    async () => (await mcp.list({ workspace: tmp })).servers[0].status.state === 'connected',
    { label: 'connected status' },
  )
  const connected = (await mcp.list({ workspace: tmp })).servers[0].status
  assert.equal(connected.tools, 1)
  assert.equal(connected.error, null)
  assert.deepEqual(mcp.health().mounted, ['files'])

  // detail: full config, including the secret.
  const detail = await mcp.detail({ scope: 'user', serverName: 'files', workspace: tmp })
  assert.equal(detail.server.command, 'npx')
  assert.deepEqual(detail.server.env, { TOKEN: 'super-secret' })
  assert.equal(detail.server.summary, 'npx -y @modelcontextprotocol/server-filesystem /tmp')
  assert.equal(detail.server.status.state, 'connected')
  assert.equal(detail.server.createdAt, raw.servers[0].createdAt)

  // update: replaces config, preserves createdAt, timestamps updatedAt.
  const firstMount = harness.mounts.find((mount) => mount.label === 'root')
  assert.ok(firstMount)
  const updated = await mcp.apply({
    op: 'update',
    scope: 'user',
    server: { serverName: 'files', transport: 'stdio', command: 'node', args: [] },
  })
  assert.equal(updated.servers.length, 1)
  const storedAfterUpdate = JSON.parse(await readFile(storePath, 'utf8')).servers[0]
  assert.equal(storedAfterUpdate.command, 'node')
  assert.deepEqual(storedAfterUpdate.args, [])
  assert.equal(storedAfterUpdate.createdAt, raw.servers[0].createdAt)
  assert.deepEqual(storedAfterUpdate.env, { TOKEN: 'super-secret' })
  await waitFor(() => firstMount.disposed === true, { label: 'old mount disposed' })
  await waitFor(
    async () => (await mcp.list({ workspace: tmp })).servers[0].status.state === 'connected',
    { label: 'reconnected after update' },
  )

  // toggle off: disposed and reported disabled.
  const toggledOff = await mcp.apply({ op: 'toggle', scope: 'user', server: { serverName: 'files' }, enabled: false })
  assert.equal(toggledOff.servers[0].enabled, false)
  assert.equal(toggledOff.servers[0].status.state, 'disabled')
  assert.equal(JSON.parse(await readFile(storePath, 'utf8')).servers[0].enabled, false)
  assert.ok(harness.mounts.every((mount) => mount.config.serverName !== 'files' || mount.disposed === true))

  // toggle on: mounted again.
  const toggledOn = await mcp.apply({ op: 'toggle', scope: 'user', server: { serverName: 'files' }, enabled: true })
  assert.equal(toggledOn.servers[0].enabled, true)
  await waitFor(
    () => harness.mounts.some((mount) => mount.config.serverName === 'files' && mount.disposed === false),
    { label: 're-enabled mount' },
  )

  // toggle validation + missing rows.
  await assert.rejects(
    mcp.apply({ op: 'toggle', scope: 'user', server: { serverName: 'files' }, enabled: 'yes' }),
    (error) => error.code === 'bad_request',
  )
  await assert.rejects(
    mcp.apply({ op: 'toggle', scope: 'user', server: { serverName: 'ghost' }, enabled: true }),
    (error) => error.code === 'not_found',
  )
  await assert.rejects(
    mcp.apply({ op: 'update', scope: 'user', server: stdioServer('ghost') }),
    (error) => error.code === 'not_found',
  )

  // delete: removed from store, disposed, omitted from list, 404 on detail.
  const deleted = await mcp.apply({ op: 'delete', scope: 'user', server: { serverName: 'files' } })
  assert.deepEqual(deleted.servers, [])
  assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')).servers, [])
  assert.deepEqual((await mcp.list({ workspace: tmp })).servers, [])
  await assert.rejects(
    mcp.detail({ scope: 'user', serverName: 'files', workspace: tmp }),
    (error) => error.code === 'not_found' && error.status === 404,
  )
  await assert.rejects(
    mcp.apply({ op: 'delete', scope: 'user', server: { serverName: 'files' } }),
    (error) => error.code === 'not_found',
  )
})

test('streamable-http servers persist headers, mask them in list and expose them in detail', async () => {
  const tmp = await makeTmp()
  const { mcp, homes } = await setup({ tmp })

  await mcp.apply({
    op: 'create',
    scope: 'user',
    server: {
      transport: 'streamable-http',
      serverName: 'remote',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer sup3r-s3cret' },
    },
  })
  const stored = JSON.parse(await readFile(userStore(homes), 'utf8')).servers[0]
  assert.equal(stored.transport, 'streamable-http')
  assert.equal(stored.url, 'https://example.com/mcp')
  assert.deepEqual(stored.headers, { Authorization: 'Bearer sup3r-s3cret' })

  const listed = await mcp.list({ workspace: tmp })
  assert.equal(listed.servers[0].summary, 'https://example.com/mcp')
  assert.ok(!JSON.stringify(listed).includes('sup3r-s3cret'))
  assert.ok(!('headers' in listed.servers[0]))

  const detail = await mcp.detail({ scope: 'user', serverName: 'remote', workspace: tmp })
  assert.deepEqual(detail.server.headers, { Authorization: 'Bearer sup3r-s3cret' })
  assert.equal(detail.server.status.state, 'connected')
})

test('invalid stored rows are skipped with a warning while valid rows still list', async () => {
  const tmp = await makeTmp()
  const homes = { dshHome: join(tmp, 'dsh-home'), agentsHome: join(tmp, 'agents-home') }
  await mkdir(join(homes.dshHome, 'agent-assets'), { recursive: true })
  await writeFile(
    userStore(homes),
    JSON.stringify({
      version: 1,
      servers: [
        stdioServer('good'),
        { transport: 'carrier-pigeon', serverName: 'bad-transport' },
        { transport: 'stdio', serverName: 'bad name', command: 'npx' },
        { transport: 'stdio', serverName: 'no-command' },
        'not-an-object',
      ],
    }),
  )
  const { mcp } = await setup({ tmp, homes })
  const listed = await mcp.list({ workspace: tmp })
  assert.deepEqual(
    listed.servers.map((server) => server.serverName),
    ['good'],
  )
  assert.equal(listed.warnings.filter((warning) => warning.includes('skipped invalid MCP server entry')).length, 4)
})

test('a corrupt store is a warning and an empty list, and writes are refused without touching it', async () => {
  const tmp = await makeTmp()
  const homes = { dshHome: join(tmp, 'dsh-home'), agentsHome: join(tmp, 'agents-home') }
  await mkdir(join(homes.dshHome, 'agent-assets'), { recursive: true })
  const corrupt = '{ "servers": [ { "serverName": "keep-me", }, ] }'
  await writeFile(userStore(homes), corrupt)
  const { mcp } = await setup({ tmp, homes })

  const listed = await mcp.list({ workspace: tmp })
  assert.deepEqual(listed.servers, [])
  assert.ok(listed.warnings.some((warning) => warning.includes('not valid JSON')))

  await assert.rejects(
    () => mcp.apply({ op: 'create', scope: 'user', server: stdioServer('fresh') }),
    (error) => error.code === 'conflict' && error.status === 409 && /corrupt/.test(error.message),
  )
  assert.equal(await readFile(userStore(homes), 'utf8'), corrupt, 'the original file must stay untouched')

  // A store without a servers array is refused the same way.
  await writeFile(userStore(homes), '{"version":1}')
  await assert.rejects(
    () => mcp.apply({ op: 'create', scope: 'user', server: stdioServer('fresh') }),
    (error) => error.code === 'conflict',
  )
  assert.equal(await readFile(userStore(homes), 'utf8'), '{"version":1}')

  // Once the user fixes (or removes) the file, writes work again.
  await rm(userStore(homes))
  const created = await mcp.apply({ op: 'create', scope: 'user', server: stdioServer('fresh') })
  assert.equal(created.servers.length, 1)
  const repaired = JSON.parse(await readFile(userStore(homes), 'utf8'))
  assert.equal(repaired.version, 1)
  assert.equal(repaired.servers[0].serverName, 'fresh')
})

// -------------------------------------------------------------------------------------------
// Failure handling.
// -------------------------------------------------------------------------------------------

test('a failed bridge load never crashes: status/warnings report it and CRUD keeps working', async () => {
  const tmp = await makeTmp()
  const { mcp, homes } = await setup({
    tmp,
    loadClientPlugin: async () => {
      throw new Error('cannot resolve @deepseek-ai/dsh-mcp-client')
    },
  })

  const created = await mcp.apply({ op: 'create', scope: 'user', server: stdioServer('files', { env: { TOKEN: 'v' } }) })
  assert.equal(created.servers.length, 1)
  assert.equal(created.servers[0].status.state, 'error')

  const health = mcp.health()
  assert.equal(health.moduleLoaded, false)
  assert.match(health.moduleError, /cannot resolve/)
  assert.deepEqual(health.mounted, [])

  const listed = await mcp.list({ workspace: tmp })
  assert.equal(listed.servers.length, 1)
  assert.equal(listed.servers[0].status.state, 'error')
  assert.match(listed.servers[0].status.error, /cannot resolve/)
  assert.ok(listed.warnings.some((warning) => warning.includes('MCP client module unavailable')))

  // detail still exposes the stored config.
  const detail = await mcp.detail({ scope: 'user', serverName: 'files', workspace: tmp })
  assert.deepEqual(detail.server.env, { TOKEN: 'v' })

  // the store survived a failed mount attempt.
  assert.equal(JSON.parse(await readFile(userStore(homes), 'utf8')).servers.length, 1)
})

test('a connection failure surfaces as status error without failing the request', async () => {
  const tmp = await makeTmp()
  const namespace = createNamespace({
    onApply: async () => {
      throw new Error('spawn npx ENOENT')
    },
  })
  const { mcp } = await setup({ tmp, namespace })

  const created = await mcp.apply({ op: 'create', scope: 'user', server: stdioServer('broken') })
  assert.equal(created.servers.length, 1)
  await waitFor(
    async () => (await mcp.list({ workspace: tmp })).servers[0].status.state === 'error',
    { label: 'error status' },
  )
  const listed = await mcp.list({ workspace: tmp })
  assert.match(listed.servers[0].status.error, /spawn npx ENOENT/)
  assert.ok(listed.warnings.some((warning) => warning.includes('spawn npx ENOENT')))
  assert.equal(mcp.health().moduleLoaded, true)
})

test('a mount that settled with zero tools reports connecting first, then error', async () => {
  const tmp = await makeTmp()
  const namespace = createNamespace({ onApply: async () => {} }) // connects, but registers nothing
  const { mcp } = await setup({ tmp, namespace })
  await mcp.apply({ op: 'create', scope: 'user', server: stdioServer('empty') })

  // Immediately after registration the mount is allowed to still be connecting.
  let state = (await mcp.list({ workspace: tmp })).servers[0].status.state
  assert.ok(state === 'connecting' || state === 'error')
  // With no tools and a settled mount, the status becomes error once the grace window closes.
  await waitFor(
    async () => (await mcp.list({ workspace: tmp })).servers[0].status.state === 'error',
    { label: 'empty mount error status', timeout: 7000 },
  )
})

// -------------------------------------------------------------------------------------------
// Workspace scope.
// -------------------------------------------------------------------------------------------

test('workspace-scope rows use the workspace store and never touch global mounts', async () => {
  const tmp = await makeTmp()
  const workspace = join(tmp, 'project')
  await mkdir(workspace, { recursive: true })
  const { mcp, harness } = await setup({ tmp })

  await mcp.apply({ op: 'create', scope: 'user', server: stdioServer('files') })
  await waitFor(
    async () => (await mcp.list({ workspace })).servers.find((server) => server.serverName === 'files')?.status.state === 'connected',
    { label: 'global mount connected' },
  )
  const globalMounts = harness.mounts.filter((mount) => mount.label === 'root')
  assert.equal(globalMounts.length, 1)

  const created = await mcp.apply({
    op: 'create',
    scope: 'workspace',
    workspace,
    server: stdioServer('repo', { command: 'node', args: ['server.js'], env: { REPO_TOKEN: 'workspace-secret' } }),
  })
  assert.equal(created.servers.length, 1)
  assert.equal(created.servers[0].scope, 'workspace')
  assert.equal(created.servers[0].status.state, 'session-scoped')

  const stored = JSON.parse(await readFile(workspaceStore(workspace), 'utf8'))
  assert.equal(stored.version, 1)
  assert.equal(stored.servers[0].serverName, 'repo')
  assert.equal(stored.servers[0].scope, 'workspace')
  assert.deepEqual(stored.servers[0].env, { REPO_TOKEN: 'workspace-secret' })
  if (process.platform !== 'win32') {
    // POSIX mode bits: chmod has no POSIX semantics on Windows.
    assert.equal((await stat(workspaceStore(workspace))).mode & 0o777, 0o600)
  }

  // Workspace mutations never remount or dispose the global rows.
  assert.equal(globalMounts[0].disposed, false)
  assert.equal(harness.mounts.filter((mount) => mount.label === 'root').length, 1)

  const listed = await mcp.list({ workspace })
  assert.deepEqual(
    listed.servers.map((server) => [server.serverName, server.scope]),
    [
      ['files', 'user'],
      ['repo', 'workspace'],
    ],
  )
  assert.ok(!JSON.stringify(listed).includes('workspace-secret'))

  const detail = await mcp.detail({ scope: 'workspace', workspace, serverName: 'repo' })
  assert.deepEqual(detail.server.env, { REPO_TOKEN: 'workspace-secret' })
  assert.equal(detail.server.status.state, 'session-scoped')
})

/** Confirm every workspace row of `workspace`, as the panel's trust button does. */
async function trustAll(mcp, workspace) {
  const { servers } = await mcp.list({ workspace })
  for (const server of servers.filter((row) => row.scope === 'workspace')) {
    await mcp.apply({
      op: 'trust', scope: 'workspace', workspace, server: { serverName: server.serverName }, fingerprint: server.fingerprint,
    })
  }
}

test('a workspace store that arrived with a repository does not run until the user trusts it', async () => {
  const tmp = await makeTmp()
  const workspace = join(tmp, 'cloned')
  await mkdir(join(workspace, '.dsh', 'agent-assets'), { recursive: true })
  const write = (row) => writeFile(workspaceStore(workspace), JSON.stringify({ version: 1, servers: [row] }))
  await write(stdioServer('evil', { command: 'node', args: ['run.js'] }))
  const { mcp, harness } = await setup({ tmp })
  const mountsOf = (id) => harness.mounts.filter((mount) => mount.label === `agent:${id}`)

  mcp.attachAgent(createAgent(harness, 'before', join(workspace, 'src')))
  await flush(20)
  assert.equal(mountsOf('before').length, 0, 'an untrusted row must not start')
  assert.equal(mcp.health().untrustedSkipped, 1)
  const [row] = (await mcp.list({ workspace })).servers.filter((server) => server.scope === 'workspace')
  assert.equal(row.status.state, 'untrusted')
  assert.equal(row.trusted, false)

  // Toggling is not consent.
  await mcp.apply({ op: 'toggle', scope: 'workspace', workspace, server: { serverName: 'evil' }, enabled: false })
  await mcp.apply({ op: 'toggle', scope: 'workspace', workspace, server: { serverName: 'evil' }, enabled: true })
  mcp.attachAgent(createAgent(harness, 'toggled', workspace))
  await flush(20)
  assert.equal(mountsOf('toggled').length, 0)

  // Trust binds to what was shown: the row changed after the list above.
  await write(stdioServer('evil', { command: 'node', args: ['other.js'] }))
  await assert.rejects(
    mcp.apply({ op: 'trust', scope: 'workspace', workspace, server: { serverName: 'evil' }, fingerprint: row.fingerprint }),
    (error) => error.code === 'conflict',
  )

  await trustAll(mcp, workspace)
  mcp.attachAgent(createAgent(harness, 'trusted', workspace))
  await waitFor(() => mountsOf('trusted').length === 1, { label: 'trusted mount' })

  // A later edit on disk needs confirming again.
  await write(stdioServer('evil', { command: 'node', args: ['changed.js'] }))
  mcp.attachAgent(createAgent(harness, 'edited', workspace))
  await flush(20)
  assert.equal(mountsOf('edited').length, 0)
})

test('rows saved through the panel are trusted as saved, and trust is per workspace', async () => {
  const tmp = await makeTmp()
  const first = join(tmp, 'first')
  const second = join(tmp, 'second')
  await mkdir(join(second, '.dsh', 'agent-assets'), { recursive: true })
  await writeFile(workspaceStore(second), JSON.stringify({ version: 1, servers: [stdioServer('repo', { command: 'node', args: ['x.js'] })] }))
  const { mcp, harness, homes } = await setup({ tmp })
  const created = await mcp.apply({
    op: 'create', scope: 'workspace', workspace: first, server: stdioServer('repo', { command: 'node', args: ['x.js'] }),
  })
  assert.equal(created.servers[0].trusted, true)
  assert.equal(created.servers[0].status.state, 'session-scoped')
  mcp.attachAgent(createAgent(harness, 'one', first))
  await waitFor(() => harness.mounts.some((mount) => mount.label === 'agent:one'), { label: 'first workspace mount' })
  mcp.attachAgent(createAgent(harness, 'two', second))
  await flush(20)
  assert.equal(harness.mounts.filter((mount) => mount.label === 'agent:two').length, 0)

  await mcp.apply({ op: 'delete', scope: 'workspace', workspace: first, server: { serverName: 'repo' } })
  const trustFile = JSON.parse(await readFile(join(homes.dshHome, 'agent-assets', 'mcp-trust.json'), 'utf8'))
  assert.deepEqual(trustFile.workspaces, {}, 'deleting a row forgets its trust')
})

test('a corrupt trust file trusts nothing and is never written over', async () => {
  const tmp = await makeTmp()
  const homes = { dshHome: join(tmp, 'home', '.dsh'), agentsHome: join(tmp, 'home', '.agents') }
  const workspace = join(tmp, 'ws')
  await mkdir(join(workspace, '.dsh', 'agent-assets'), { recursive: true })
  await mkdir(join(homes.dshHome, 'agent-assets'), { recursive: true })
  await writeFile(workspaceStore(workspace), JSON.stringify({ version: 1, servers: [stdioServer('repo', { command: 'node', args: ['x.js'] })] }))
  const trustPath = join(homes.dshHome, 'agent-assets', 'mcp-trust.json')
  await writeFile(trustPath, '{broken')
  const { mcp, harness } = await setup({ tmp, homes })
  mcp.attachAgent(createAgent(harness, 'a', workspace))
  await flush(20)
  assert.equal(harness.mounts.filter((mount) => mount.label === 'agent:a').length, 0)
  const listed = await mcp.list({ workspace })
  assert.ok(listed.warnings.some((message) => /trust file/.test(message)))
  await assert.rejects(
    mcp.apply({ op: 'create', scope: 'workspace', workspace, server: stdioServer('other', { command: 'node' }) }),
    (error) => error.code === 'conflict',
  )
  assert.equal(await readFile(trustPath, 'utf8'), '{broken')
})

test('attachAgent mounts enabled workspace rows only into Sessions whose cwd is inside that workspace', async () => {
  const tmp = await makeTmp()
  const workspace = join(tmp, 'ws')
  await mkdir(join(workspace, '.dsh', 'agent-assets'), { recursive: true })
  await writeFile(
    workspaceStore(workspace),
    JSON.stringify({
      version: 1,
      servers: [
        stdioServer('repo', { command: 'node', args: ['server.js'] }),
        stdioServer('disabled-one', { enabled: false }),
      ],
    }),
  )
  const { mcp, harness } = await setup({ tmp })
  await trustAll(mcp, workspace)

  const inside = createAgent(harness, 'a1', join(workspace, 'src'))
  const outside = createAgent(harness, 'a2', join(tmp, 'elsewhere'))
  const noCwd = createAgent(harness, 'a3', undefined)

  // attachAgent is synchronous from the caller's perspective and returns undefined.
  assert.equal(mcp.attachAgent(inside), undefined)
  mcp.attachAgent(outside)
  mcp.attachAgent(noCwd)

  await waitFor(() => harness.mounts.some((mount) => mount.label === 'agent:a1'), { label: 'agent mount' })
  await flush(20)

  const agentMounts = harness.mounts.filter((mount) => mount.label === 'agent:a1')
  assert.equal(agentMounts.length, 1)
  assert.equal(agentMounts[0].config.serverName, 'repo')
  assert.equal(agentMounts[0].config.transport, 'stdio')
  assert.equal(agentMounts[0].config.failOnStartupError, false)
  assert.equal(harness.mounts.filter((mount) => mount.label === 'agent:a2').length, 0)
  assert.equal(harness.mounts.filter((mount) => mount.label === 'agent:a3').length, 0)
  assert.ok(mcp.health().skippedAgents >= 2)

  await mcp.dispose()
  assert.ok(harness.mounts.every((mount) => mount.disposed === true))
  assert.deepEqual(mcp.health().mounted, [])
})

test('the user store is never mistaken for a workspace store of the home directory', async () => {
  const tmp = await makeTmp()
  const home = join(tmp, 'home')
  const homes = { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents') }
  await mkdir(join(homes.dshHome, 'agent-assets'), { recursive: true })
  await writeFile(userStore(homes), JSON.stringify({ version: 1, servers: [stdioServer('user-global')] }))
  const { mcp, harness } = await setup({ tmp, homes })

  // A Session whose cwd merely lives under $HOME must not mount user-scope servers on agent.ctx.
  const agent = createAgent(harness, 'home-agent', join(home, 'project'))
  mcp.attachAgent(agent)
  await flush(20)
  assert.equal(harness.mounts.filter((mount) => mount.label === 'agent:home-agent').length, 0)

  // A real workspace below $HOME still mounts its own store.
  const workspace = join(home, 'project')
  await mkdir(join(workspace, '.dsh', 'agent-assets'), { recursive: true })
  await writeFile(workspaceStore(workspace), JSON.stringify({ version: 1, servers: [stdioServer('ws-server')] }))
  await trustAll(mcp, workspace)
  mcp.attachAgent(createAgent(harness, 'ws-agent', workspace))
  await waitFor(() => harness.mounts.some((mount) => mount.label === 'agent:ws-agent'), { label: 'workspace mount below home' })
  const wsMounts = harness.mounts.filter((mount) => mount.label === 'agent:ws-agent')
  assert.equal(wsMounts.length, 1)
  assert.equal(wsMounts[0].config.serverName, 'ws-server')

  // The home directory cannot be used as a workspace: its store path would equal the user store.
  await assert.rejects(
    mcp.apply({ op: 'create', scope: 'workspace', workspace: home, server: stdioServer('clash') }),
    (error) => error.code === 'bad_request' && /collide/.test(error.message),
  )
})

// -------------------------------------------------------------------------------------------
// External rows, health, dispose.
// -------------------------------------------------------------------------------------------

test('external lists MCP client rows from the config editor and stays empty on failure', async () => {
  const tmp = await makeTmp()
  const configEditor = {
    configuration: () => [
      {
        entry: {
          options: {
            id: 'ext-1',
            name: '@deepseek-ai/dsh-mcp-client',
            config: { transport: 'stdio', serverName: 'bundle', command: 'npx', args: ['-y', 'some-server'] },
          },
        },
        inherited: {},
        override: {},
      },
      {
        entry: {
          moduleName: '@deepseek-ai/dsh-mcp-client',
          options: { id: 'ext-2' },
          config: { transport: 'streamable-http', serverName: 'remote', url: 'https://example.com/mcp' },
        },
      },
      { entry: { options: { id: 'other', name: '@deepseek-ai/dsh-other' } }, inherited: {}, override: {} },
    ],
  }
  const { mcp } = await setup({ tmp, configEditor })
  const { external } = await mcp.list({ workspace: tmp })
  assert.equal(external.length, 2)
  const bundle = external.find((row) => row.serverName === 'bundle')
  assert.deepEqual(bundle, {
    entryId: 'ext-1',
    moduleName: '@deepseek-ai/dsh-mcp-client',
    serverName: 'bundle',
    transport: 'stdio',
    summary: 'npx -y some-server',
    configurable: false,
  })
  const remote = external.find((row) => row.serverName === 'remote')
  assert.equal(remote.entryId, 'ext-2')
  assert.equal(remote.transport, 'streamable-http')

  const failing = {
    configuration: () => {
      throw new Error('config editor exploded')
    },
  }
  const second = await setup({ tmp, configEditor: failing })
  const listed = await second.mcp.list({ workspace: tmp })
  assert.deepEqual(listed.external, [])
  assert.ok(listed.warnings.some((warning) => warning.includes('config editor')))
})

test('health reflects loaded module, mounted names and cleared state after dispose', async () => {
  const tmp = await makeTmp()
  const { mcp } = await setup({ tmp })
  assert.equal(mcp.health().moduleLoaded, true)
  assert.equal(mcp.health().moduleError, null)

  await mcp.apply({ op: 'create', scope: 'user', server: stdioServer('zeta') })
  await mcp.apply({ op: 'create', scope: 'user', server: stdioServer('alpha') })
  await waitFor(
    async () => (await mcp.list({ workspace: tmp })).servers.every((server) => server.status.state === 'connected'),
    { label: 'both mounts connected' },
  )
  assert.deepEqual(mcp.health().mounted, ['alpha', 'zeta'])

  await mcp.dispose()
  assert.deepEqual(mcp.health().mounted, [])
  await mcp.dispose() // idempotent
})

test('detail rejects unknown scopes and names', async () => {
  const tmp = await makeTmp()
  const { mcp } = await setup({ tmp })
  await assert.rejects(mcp.detail({ scope: 'bundled', serverName: 'x', workspace: tmp }), (error) => error.code === 'bad_request')
  await assert.rejects(mcp.detail({ scope: 'user', serverName: 'nope', workspace: tmp }), (error) => error.code === 'not_found')
  await assert.rejects(mcp.detail({ scope: 'user', serverName: 'bad name', workspace: tmp }), (error) => error.code === 'bad_request')
})
