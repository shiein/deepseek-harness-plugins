/**
 * Managed MCP servers: plugin-owned scope stores plus live mounting through the Harness MCP client.
 *
 * Durable contract (two plugin-owned files, `{ "version": 1, "servers": [McpStored] }`, mode 0600):
 *
 *   - user      `<dshHome>/agent-assets/mcp.json`
 *   - workspace `<workspace>/.dsh/agent-assets/mcp.json`
 *
 * Mounting strategy:
 *
 *   - user-scope rows mount once, process-wide, on this plugin's own `ctx` (their tools land in the
 *     global tool layer).
 *   - workspace-scope rows never mount globally: every Session mounts the rows of the workspace that
 *     contains its `cwd` on its own `agent.ctx` (`attachAgent`, called from `agent/created`), so the
 *     tools disappear with that Agent and never leak into other Sessions.
 *
 * The Harness MCP client bridge (`@deepseek-ai/dsh-mcp-client`) is injected as `loadClientPlugin`
 * because a linked workspace bundle cannot resolve Harness packages by bare specifier. A failed
 * module load is a permanent, reportable status — never a crash: list/detail keep working with
 * `status.state === 'error'` and `warnings` explaining why nothing is mounted.
 *
 * Workspace trust: a workspace store travels with its repository, so a stdio row in it is a command a
 * cloned project could run. A row mounts only when `<dshHome>/agent-assets/mcp-trust.json` records the
 * hash of its exact connection config. Rows created or edited through this API are trusted as saved;
 * any other row reports `untrusted` until the user confirms it (`op: 'trust'`), and a changed row
 * needs confirming again.
 *
 * Live status is evidence-based, not cached: after a mount, the row counts tool schemas whose name
 * starts with `mcp__<serverName>__` (`ctx.tools.schemas()`). A mount whose connection has not settled
 * reports `connecting`; one that settled with zero tools keeps `connecting` for a short grace window
 * and then reports `error` with a generic reason (the client keeps retrying in the background and a
 * later successful sync flips the row to `connected` on the next read).
 */

import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import {
  assertScope,
  displayPath,
  fail,
  isInside,
  pathKey,
  readTextIfExists,
  resolveHomes,
  statIfExists,
  writeTextAtomic,
} from './shared.js'

/** Package name of the Harness MCP client bridge; also the `external` filter. */
const CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/** `serverName` contract (matches the mcp-client plugin schema and the public tool namespace). */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Serialized store version. */
const STORE_VERSION = 1

/** Supported transports. */
const TRANSPORTS = new Set(['stdio', 'streamable-http'])

/** Supported store mutations. */
const OPS = new Set(['create', 'update', 'delete', 'toggle', 'trust'])

/** Prefix of every model-facing tool name registered by the MCP client. */
const TOOL_PREFIX = 'mcp__'

/**
 * A mount that settled with no tools keeps reporting `connecting` for this long before reporting
 * `error`; the MCP client reconnects with backoff, so a successful retry simply flips to `connected`.
 */
const EMPTY_MOUNT_GRACE_MS = 5000

/** Ancestor levels inspected for `.dsh/agent-assets/mcp.json` when attaching a Session. */
const MAX_WORKSPACE_DEPTH = 64

/** True for `{ ... }` JSON objects. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Human-readable message from any thrown value. */
function messageOf(error) {
  try {
    if (error instanceof Error) return error.message
    if (isPlainObject(error) && typeof error.message === 'string') return error.message
    return String(error)
  } catch {
    return 'unknown error'
  }
}

/** Throw a `bad_request` AssetsError. */
function bad(message) {
  fail('bad_request', message, 400)
}

/** Validate and return a server name. */
function assertServerName(value) {
  if (typeof value !== 'string' || !SERVER_NAME_PATTERN.test(value)) {
    bad('serverName must match ^[A-Za-z0-9_-]{1,32}$')
  }
  return value
}

/** Validate and return a transport. */
function assertTransport(value) {
  if (typeof value !== 'string' || !TRANSPORTS.has(value)) {
    bad("transport must be 'stdio' or 'streamable-http'")
  }
  return value
}

/** Validate a boolean field with a fallback when omitted. */
function readBoolean(value, fallback, field) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') bad(`${field} must be a boolean`)
  return value
}

/** Validate an optional string field (`undefined`/`null` -> fallback). */
function readOptionalString(value, field, fallback = null) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') bad(`${field} must be a string`)
  return value
}

/** Validate a string array field (`undefined`/`null` -> `[]`). */
function readStringArray(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) bad(`${field} must be an array of strings`)
  return value.map((item, index) => {
    if (typeof item !== 'string') bad(`${field}[${index}] must be a string`)
    return item
  })
}

/** Validate a string -> string map field (`undefined`/`null` -> `{}`). */
function readStringMap(value, field) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) bad(`${field} must be an object of string values`)
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') bad(`${field}.${key} must be a string`)
    // defineProperty keeps a literal `__proto__` key a plain entry instead of a prototype write.
    Object.defineProperty(result, key, { value: item, enumerable: true, writable: true, configurable: true })
  }
  return result
}

/** Validate `toolCallTimeoutMs` (`null`/absent means "use the client default"). */
function readTimeout(value, fallback = null) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    bad('toolCallTimeoutMs must be a positive number or null')
  }
  return value
}

/** Validate an absolute http(s) URL. */
function readHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') bad('url is required for streamable-http servers')
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    bad('url must be an absolute http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') bad('url must be an absolute http(s) URL')
  return value.trim()
}

/** Required non-empty stdio command. */
function readCommand(value) {
  const command = readOptionalString(value, 'command')
  if (command === null || command.trim() === '') bad('command is required for stdio servers')
  return command
}

/** A one-line description of a stored row (`command args…` or the URL); never secrets. */
function summarizeStored(stored) {
  if (stored.transport === 'stdio') {
    const command = typeof stored.command === 'string' ? stored.command : ''
    const args = Array.isArray(stored.args) ? stored.args.filter((item) => typeof item === 'string') : []
    return [command, ...args].filter((part) => part !== '').join(' ')
  }
  return typeof stored.url === 'string' ? stored.url : ''
}

/**
 * Normalize one persisted row for reading; `null` when unusable (the caller records a warning).
 * Defensive by design: a hand-edited or older store must never abort a list.
 */
function normalizeStoredRow(raw, scope) {
  if (!isPlainObject(raw)) return null
  try {
    const serverName = assertServerName(raw.serverName)
    const transport = assertTransport(raw.transport)
    const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : true
    const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : null
    const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null
    if (transport === 'stdio') {
      const command = readOptionalString(raw.command, 'command')
      if (command === null || command.trim() === '') return null
      return {
        serverName,
        scope,
        transport: 'stdio',
        command,
        args: readStringArray(raw.args, 'args'),
        cwd: readOptionalString(raw.cwd, 'cwd', '') ?? '',
        env: readStringMap(raw.env, 'env'),
        toolCallTimeoutMs: readTimeout(raw.toolCallTimeoutMs),
        enabled,
        createdAt,
        updatedAt,
      }
    }
    const url = readOptionalString(raw.url, 'url')
    if (url === null || url.trim() === '') return null
    return {
      serverName,
      scope,
      transport: 'streamable-http',
      url,
      headers: readStringMap(raw.headers, 'headers'),
      toolCallTimeoutMs: readTimeout(raw.toolCallTimeoutMs),
      enabled,
      createdAt,
      updatedAt,
    }
  } catch {
    return null
  }
}

/**
 * Build the complete stored row for `create`.
 * @param {Record<string, unknown>} raw request `server` object
 * @param {'user'|'workspace'} scope owning scope
 * @param {string} now ISO timestamp
 */
function createStored(raw, scope, now) {
  if (!isPlainObject(raw)) bad('server is required')
  const serverName = assertServerName(raw.serverName)
  const transport = assertTransport(raw.transport)
  const enabled = readBoolean(raw.enabled, true, 'enabled')
  if (transport === 'stdio') {
    return {
      serverName,
      scope,
      transport: 'stdio',
      command: readCommand(raw.command),
      args: readStringArray(raw.args, 'args'),
      cwd: readOptionalString(raw.cwd, 'cwd', '') ?? '',
      env: readStringMap(raw.env, 'env'),
      toolCallTimeoutMs: readTimeout(raw.toolCallTimeoutMs),
      enabled,
      createdAt: now,
      updatedAt: now,
    }
  }
  return {
    serverName,
    scope,
    transport: 'streamable-http',
    url: readHttpUrl(raw.url),
    headers: readStringMap(raw.headers, 'headers'),
    toolCallTimeoutMs: readTimeout(raw.toolCallTimeoutMs),
    enabled,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Build the next stored row for `update`: supplied fields win, omitted fields keep the stored value
 * of the same transport (a transport switch drops the other transport's fields).
 * @param {Record<string, unknown>} raw request `server` object
 * @param {Record<string, unknown>} existing stored row
 * @param {'user'|'workspace'} scope owning scope
 * @param {string} now ISO timestamp
 */
function updateStored(raw, existing, scope, now) {
  assertServerName(raw.serverName)
  const transport = raw.transport === undefined ? existing.transport : assertTransport(raw.transport)
  const enabled = readBoolean(raw.enabled, existing.enabled, 'enabled')
  const sameTransport = existing.transport === transport
  const fallback = (value, previous, defaultValue) => (value === undefined ? (sameTransport ? previous : defaultValue) : value)
  if (transport === 'stdio') {
    return {
      serverName: existing.serverName,
      scope,
      transport: 'stdio',
      command: raw.command === undefined ? (sameTransport ? existing.command : bad('command is required for stdio servers')) : readCommand(raw.command),
      args: readStringArray(fallback(raw.args, existing.args, []), 'args'),
      cwd: readOptionalString(fallback(raw.cwd, existing.cwd, ''), 'cwd', '') ?? '',
      env: readStringMap(fallback(raw.env, existing.env, {}), 'env'),
      toolCallTimeoutMs: readTimeout(fallback(raw.toolCallTimeoutMs, existing.toolCallTimeoutMs, null)),
      enabled,
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
    }
  }
  return {
    serverName: existing.serverName,
    scope,
    transport: 'streamable-http',
    url: raw.url === undefined ? (sameTransport ? existing.url : bad('url is required for streamable-http servers')) : readHttpUrl(raw.url),
    headers: readStringMap(fallback(raw.headers, existing.headers, {}), 'headers'),
    toolCallTimeoutMs: readTimeout(fallback(raw.toolCallTimeoutMs, existing.toolCallTimeoutMs, null)),
    enabled,
    createdAt: existing.createdAt ?? now,
    updatedAt: now,
  }
}

/**
 * Map one stored row onto the bridge's `Config` for `ctx.plugin`.
 * `failOnStartupError: false` is load-bearing: a dead server must never fail the mount fiber; the
 * live status reports the failure instead (and the client keeps retrying with backoff).
 */
function toClientConfig(stored) {
  const timeout = typeof stored.toolCallTimeoutMs === 'number' && stored.toolCallTimeoutMs > 0 ? { toolCallTimeoutMs: stored.toolCallTimeoutMs } : {}
  if (stored.transport === 'stdio') {
    return {
      transport: 'stdio',
      serverName: stored.serverName,
      command: stored.command,
      args: Array.isArray(stored.args) ? stored.args : [],
      env: isPlainObject(stored.env) ? stored.env : {},
      cwd: typeof stored.cwd === 'string' ? stored.cwd : '',
      ...timeout,
      failOnStartupError: false,
    }
  }
  return {
    transport: 'streamable-http',
    serverName: stored.serverName,
    url: stored.url,
    headers: isPlainObject(stored.headers) ? stored.headers : {},
    ...timeout,
    failOnStartupError: false,
  }
}

/** Hash of what a row would run or connect to; toggling `enabled` does not change it. */
function trustFingerprint(stored) {
  return createHash('sha256').update(JSON.stringify(toClientConfig(stored))).digest('hex')
}

/**
 * Create the MCP manager.
 *
 * @param {{
 *   ctx: any,
 *   homes: { dshHome: string, agentsHome?: string },
 *   loadClientPlugin: () => Promise<any>,
 * }} options
 * @returns {{
 *   list: (input: { workspace?: string }) => Promise<{ servers: any[], external: any[], warnings: string[] }>,
 *   detail: (input: { scope: string, workspace?: string, serverName: string }) => Promise<{ server: any }>,
 *   apply: (input: { op: string, scope: string, workspace?: string, server?: any, enabled?: boolean, fingerprint?: string }) => Promise<{ servers: any[] }>,
 *   attachAgent: (agent: any) => void,
 *   health: () => { moduleLoaded: boolean, moduleError: string|null, mounted: string[], skippedAgents: number },
 *   dispose: () => Promise<void>,
 * }}
 */
export function createMcp({ ctx, homes, loadClientPlugin } = {}) {
  const resolvedHomes =
    homes && typeof homes.dshHome === 'string'
      ? { dshHome: homes.dshHome, agentsHome: typeof homes.agentsHome === 'string' ? homes.agentsHome : undefined }
      : resolveHomes()

  if (typeof loadClientPlugin !== 'function') {
    fail('internal', 'createMcp requires a loadClientPlugin function', 500)
  }

  // -----------------------------------------------------------------------------------------
  // Diagnostics and optional logging.
  // -----------------------------------------------------------------------------------------

  /** Mount records alive on the plugin's own (global) context, keyed by `serverName`. */
  let userMounts = new Map()
  /** Mount records alive on Session `agent.ctx` contexts. */
  let agentMounts = []
  /** serverNames mounted per Agent (duplicate guards and the attachAgent idempotency). */
  const agentMountedNames = new WeakMap()
  /** Agents seen without a usable cwd / matching workspace (health diagnostics only). */
  let skippedAgents = 0
  /** Workspace rows left unmounted because the user has not confirmed them (health diagnostics only). */
  let untrustedSkipped = 0
  let disposed = false

  /** Best-effort warning sink; the Host logger is optional. */
  function warn(message) {
    try {
      ctx?.logger?.warn?.(`[agent-assets] ${message}`)
    } catch {
      // logging must never throw
    }
  }

  // -----------------------------------------------------------------------------------------
  // Store paths and serialization.
  // -----------------------------------------------------------------------------------------

  const userStorePath = () => join(resolvedHomes.dshHome, 'agent-assets', 'mcp.json')

  const workspaceStorePath = (workspaceRoot) => join(workspaceRoot, '.dsh', 'agent-assets', 'mcp.json')

  /**
   * Validate an API scope + workspace pair.
   * @returns {{ scope: 'user'|'workspace', workspaceRoot: string|null }}
   */
  function resolveScope(scope, workspace) {
    assertScope(scope)
    if (scope === 'bundled') bad('scope bundled is read-only')
    if (scope === 'user') return { scope: 'user', workspaceRoot: null }
    if (typeof workspace !== 'string' || workspace.trim() === '') bad('workspace is required for workspace scope')
    const root = resolve(workspace.trim())
    if (!isAbsolute(root)) bad('workspace must be an absolute directory path')
    if (pathKey(workspaceStorePath(root)) === pathKey(userStorePath())) {
      bad('workspace store path would collide with the user store; pick another workspace directory')
    }
    return { scope: 'workspace', workspaceRoot: root }
  }

  /**
   * Read one store. `failed` means the file exists but could not be read or parsed: callers may
   * display it as empty, but must never write back on top of it (that would drop the original rows).
   * @returns {Promise<{ path: string, servers: any[], warnings: string[], failed: boolean }>}
   */
  async function readStore(scope, workspaceRoot) {
    const path = scope === 'workspace' ? workspaceStorePath(workspaceRoot) : userStorePath()
    const warnings = []
    let text
    try {
      text = await readTextIfExists(path)
    } catch (error) {
      warnings.push(`MCP store ${displayPath(path)} could not be read: ${messageOf(error)}`)
      return { path, servers: [], warnings, failed: true }
    }
    if (text === undefined) return { path, servers: [], warnings, failed: false }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      warnings.push(`MCP store ${displayPath(path)} is not valid JSON; treated as empty`)
      return { path, servers: [], warnings, failed: true }
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.servers)) {
      warnings.push(`MCP store ${displayPath(path)} does not contain a servers array; treated as empty`)
      return { path, servers: [], warnings, failed: true }
    }
    const servers = []
    parsed.servers.forEach((row, index) => {
      const stored = normalizeStoredRow(row, scope)
      if (stored === null) {
        warnings.push(`skipped invalid MCP server entry #${index + 1} in ${displayPath(path)}`)
        return
      }
      servers.push(stored)
    })
    return { path, servers, warnings, failed: false }
  }

  /** Persist one store atomically with mode 0600. */
  async function writeStore(scope, workspaceRoot, servers) {
    const path = scope === 'workspace' ? workspaceStorePath(workspaceRoot) : userStorePath()
    const text = `${JSON.stringify({ version: STORE_VERSION, servers }, null, 2)}\n`
    await writeTextAtomic(path, text, 0o600)
    return path
  }

  const trustStorePath = () => join(resolvedHomes.dshHome, 'agent-assets', 'mcp-trust.json')

  /**
   * Read the workspace trust records. Maps, not objects: `__proto__` is a legal server name.
   * `failed` trusts nothing and, like a corrupt store, must never be written over.
   * @returns {Promise<{ workspaces: Map<string, Map<string, string>>, warnings: string[], failed: boolean }>}
   */
  async function readTrust() {
    const path = trustStorePath()
    const unusable = (why) => ({
      workspaces: new Map(),
      warnings: [`MCP trust file ${displayPath(path)} ${why}; workspace servers are not mounted`],
      failed: true,
    })
    let text
    try {
      text = await readTextIfExists(path)
    } catch (error) {
      return unusable(`could not be read: ${messageOf(error)}`)
    }
    if (text === undefined) return { workspaces: new Map(), warnings: [], failed: false }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return unusable('is not valid JSON')
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.workspaces)) return unusable('has an unexpected shape')
    const workspaces = new Map()
    for (const [root, rows] of Object.entries(parsed.workspaces)) {
      if (isPlainObject(rows)) workspaces.set(root, new Map(Object.entries(rows).filter(([, hash]) => typeof hash === 'string')))
    }
    return { workspaces, warnings: [], failed: false }
  }

  /** Persist the trust records atomically with mode 0600. */
  async function writeTrust(workspaces) {
    const serialized = Object.fromEntries([...workspaces].map(([root, rows]) => [root, Object.fromEntries(rows)]))
    await writeTextAtomic(trustStorePath(), `${JSON.stringify({ version: STORE_VERSION, workspaces: serialized }, null, 2)}\n`, 0o600)
  }

  /** Serialize store mutations (read-modify-write). */
  let storeChain = Promise.resolve()
  function withStoreLock(task) {
    const run = storeChain.then(task)
    storeChain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  // -----------------------------------------------------------------------------------------
  // Harness MCP client module loading (never fatal).
  // -----------------------------------------------------------------------------------------

  let clientNamespace = null
  let clientModuleError = null
  let clientLoadPromise = null

  /** Load and validate the bridge namespace; a failure is recorded as `clientModuleError`. */
  async function ensureClientPlugin({ retry = false } = {}) {
    if (clientNamespace !== null) return clientNamespace
    if (clientLoadPromise !== null) return await clientLoadPromise
    if (clientModuleError !== null && !retry) throw new Error(clientModuleError)
    if (retry) clientModuleError = null
    clientLoadPromise = (async () => {
      try {
        const namespace = await loadClientPlugin()
        if (!namespace || typeof namespace.apply !== 'function') {
          throw new Error(`${CLIENT_MODULE} did not export apply()`)
        }
        clientNamespace = namespace
        clientModuleError = null
        return namespace
      } catch (error) {
        clientModuleError = messageOf(error)
        throw new Error(clientModuleError)
      } finally {
        clientLoadPromise = null
      }
    })()
    return await clientLoadPromise
  }

  // -----------------------------------------------------------------------------------------
  // Mount management.
  // -----------------------------------------------------------------------------------------

  /**
   * Record the mount's startup settlement.
   *
   * Real Cordis fibers are PromiseLike AND expose a stable `await()` that rethrows startup/config
   * errors. We deliberately use `await()` instead of assimilating the fiber as a thenable: arbitrary
   * PromiseLike doubles may implement `then` recursively, and a throwaway double must never be able
   * to wedge the manager in a microtask loop. Registration alone already yields a usable mount, so a
   * fiber without `await()` is reported settled immediately; live tool counts still decide status.
   *
   * @param {any} record mount record to update
   * @param {any} fiber value returned by `ctx.plugin()`
   */
  function observeFiberSettlement(record, fiber) {
    if (fiber && typeof fiber.await === 'function') {
      record.ready = Promise.resolve()
        .then(() => fiber.await())
        .then(
          () => {
            record.settled = true
            record.settledAt = Date.now()
          },
          (error) => {
            record.settled = true
            record.settledAt = Date.now()
            record.error = messageOf(error)
          },
        )
      return
    }
    record.settled = true
    record.settledAt = Date.now()
    record.ready = Promise.resolve()
  }

  /**
   * Mount one stored server on `targetCtx`, fire-and-forget.
   *
   * `ctx.plugin()` performs synchronous registration and returns a Fiber; the bridge's `apply`
   * resolves after its FIRST connection attempt settles (success or failure, because
   * `failOnStartupError` is false). We attach that settle to the record but never await it here.
   *
   * @param {any} targetCtx context to mount on (the plugin ctx for user rows, `agent.ctx` otherwise)
   * @param {{ scope: 'user'|'workspace', config: Record<string, unknown> }} want
   * @param {{ agent?: any, workspace?: string }} [meta]
   */
  function mountServer(targetCtx, want, meta = {}) {
    const config = want.config
    const record = {
      scope: want.scope,
      serverName: config.serverName,
      key: JSON.stringify(config),
      config,
      fiber: null,
      settled: false,
      settledAt: 0,
      error: null,
      disposed: false,
      agent: meta.agent ?? null,
      workspace: meta.workspace ?? null,
    }
    if (disposed) {
      record.settled = true
      record.settledAt = Date.now()
      record.error = 'agent-assets plugin is disposed'
      return record
    }
    try {
      if (!targetCtx || typeof targetCtx.plugin !== 'function') throw new Error('no Cordis context to mount on')
      const namespace = clientNamespace
      if (namespace === null) throw new Error(clientModuleError ?? 'MCP client module is not loaded')
      const pluginObject = {
        name: typeof namespace.name === 'string' && namespace.name !== '' ? namespace.name : 'mcp-client',
        inject: Array.isArray(namespace.inject) ? namespace.inject : ['tools'],
        apply: namespace.apply,
        Config: namespace.Config,
      }
      const fiber = targetCtx.plugin(pluginObject, config)
      record.fiber = fiber
      observeFiberSettlement(record, fiber)
    } catch (error) {
      record.settled = true
      record.settledAt = Date.now()
      record.error = messageOf(error)
      record.ready = Promise.resolve()
    }
    return record
  }

  /** Dispose one mount; idempotent and never throws. */
  async function disposeMount(record) {
    if (!record || record.disposed === true) return
    record.disposed = true
    try {
      if (record.fiber && typeof record.fiber.dispose === 'function') await record.fiber.dispose()
    } catch (error) {
      warn(`disposing MCP server "${record.serverName}" failed: ${messageOf(error)}`)
    }
    try {
      if (record.ready) await record.ready
    } catch {
      // settling errors were already folded into record.error
    }
  }

  /** Serialize user-scope mount reconciliation so dispose-then-mount cannot overlap. */
  let userMountChain = Promise.resolve()
  function serializeUserMounts(task) {
    const run = userMountChain.then(task)
    userMountChain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /**
   * Reconcile global (user-scope) mounts against the user store: dispose removed/changed mounts,
   * mount new/changed enabled rows. Never throws; failures land in mount records / module error.
   */
  async function reconcileUserMounts({ retry = false } = {}) {
    if (disposed) return
    const store = await readStore('user', null)
    if (store.failed) return
    let namespace
    try {
      namespace = await ensureClientPlugin({ retry })
    } catch {
      return
    }
    const desired = new Map()
    for (const stored of store.servers) {
      if (!stored.enabled) continue
      const config = toClientConfig(stored)
      desired.set(stored.serverName, { scope: 'user', config })
    }
    for (const [serverName, record] of [...userMounts]) {
      const next = desired.get(serverName)
      if (next !== undefined && next.config && record.key === JSON.stringify(next.config)) continue
      userMounts.delete(serverName)
      await disposeMount(record)
    }
    if (disposed) return
    for (const [serverName, want] of desired) {
      if (userMounts.has(serverName)) continue
      const record = mountServer(ctx, want)
      userMounts.set(serverName, record)
    }
  }

  /** Start (or restart) global mounts, awaiting only mount registration, never connections. */
  function scheduleUserMounts(options = {}) {
    return serializeUserMounts(async () => {
      try {
        await reconcileUserMounts(options)
      } catch (error) {
        warn(`MCP mount reconciliation failed: ${messageOf(error)}`)
      }
    })
  }

  // -----------------------------------------------------------------------------------------
  // Live status evidence.
  // -----------------------------------------------------------------------------------------

  /** All model-facing tool names visible to one scope (global when `scope` is undefined). */
  function toolNames(scope) {
    try {
      const tools = typeof ctx?.get === 'function' ? ctx.get('tools') : undefined
      if (!tools || typeof tools.schemas !== 'function') return []
      const schemas = tools.schemas(scope)
      if (!Array.isArray(schemas)) return []
      return schemas.map((schema) => (schema && typeof schema.name === 'string' ? schema.name : '')).filter((name) => name !== '')
    } catch {
      return []
    }
  }

  /** Name and description of every tool this server registered globally (user-scope rows). */
  function serverTools(serverName) {
    try {
      const tools = typeof ctx?.get === 'function' ? ctx.get('tools') : undefined
      const schemas = tools && typeof tools.schemas === 'function' ? tools.schemas(undefined) : []
      if (!Array.isArray(schemas)) return []
      const prefix = `${TOOL_PREFIX}${serverName}__`
      return schemas
        .filter((schema) => typeof schema?.name === 'string' && schema.name.startsWith(prefix))
        .map((schema) => ({
          name: schema.name.slice(prefix.length),
          description: typeof schema.description === 'string' ? schema.description.slice(0, 300) : '',
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return []
    }
  }

  /** Count this server's registered tools from a tool-name snapshot. */
  function countServerTools(names, serverName) {
    const prefix = `${TOOL_PREFIX}${serverName}__`
    let count = 0
    for (const name of names) if (name.startsWith(prefix)) count += 1
    return count
  }

  /**
   * Status for one stored row.
   * @param {any} stored stored row
   * @param {'user'|'workspace'} scope owning scope
   * @param {string[]} globalToolNames precomputed `ctx.tools.schemas()` snapshot for user rows
   * @param {boolean} [trusted] whether a workspace row may mount
   */
  function statusFor(stored, scope, globalToolNames, trusted = true) {
    if (!stored.enabled) return { state: 'disabled', tools: 0, error: null }
    if (scope === 'workspace' && !trusted) return { state: 'untrusted', tools: 0, error: null }
    if (clientModuleError !== null) return { state: 'error', tools: 0, error: clientModuleError }
    if (scope === 'workspace') return { state: 'session-scoped', tools: 0, error: null }
    const record = userMounts.get(stored.serverName)
    if (!record) return { state: 'connecting', tools: 0, error: null }
    if (record.error) return { state: 'error', tools: 0, error: record.error }
    const tools = countServerTools(globalToolNames, stored.serverName)
    if (tools > 0) return { state: 'connected', tools, error: null }
    if (!record.settled) return { state: 'connecting', tools: 0, error: null }
    if (Date.now() - record.settledAt < EMPTY_MOUNT_GRACE_MS) return { state: 'connecting', tools: 0, error: null }
    return {
      state: 'error',
      tools: 0,
      error: 'the MCP server registered no tools after startup; the client keeps retrying in the background',
    }
  }

  /** `{ trusted, fingerprint }` of a workspace row; user rows are the user's own and carry neither. */
  function trustOf(stored, scope, trustRows) {
    if (scope !== 'workspace') return {}
    const fingerprint = trustFingerprint(stored)
    return { trusted: trustRows?.get(stored.serverName) === fingerprint, fingerprint }
  }

  /** Public row: deliberately never contains env/header values; `summary` shows the command or URL. */
  function viewOf(stored, scope, globalToolNames, trustRows) {
    const trust = trustOf(stored, scope, trustRows)
    return {
      serverName: stored.serverName,
      scope,
      transport: stored.transport,
      summary: summarizeStored(stored),
      enabled: stored.enabled === true,
      status: statusFor(stored, scope, globalToolNames, trust.trusted),
      ...trust,
      createdAt: stored.createdAt ?? null,
      updatedAt: stored.updatedAt ?? null,
    }
  }

  /** Views for one store snapshot. */
  function viewsFor(scope, servers, globalToolNames, trustRows) {
    return servers
      .map((stored) => viewOf(stored, scope, globalToolNames, trustRows))
      .sort((left, right) => left.serverName.localeCompare(right.serverName))
  }

  // -----------------------------------------------------------------------------------------
  // `external`: MCP client rows already declared by installed bundles/profile entries (read-only).
  // -----------------------------------------------------------------------------------------

  /** Read one candidate row's effective config, tolerating every editor shape. */
  function externalConfigOf(row) {
    const entry = isPlainObject(row?.entry) ? row.entry : isPlainObject(row) ? row : null
    if (entry === null) return null
    const config = {}
    for (const candidate of [entry.options?.config, entry.config, row?.inherited, row?.override]) {
      if (isPlainObject(candidate)) Object.assign(config, candidate)
    }
    return { entry, config }
  }

  /**
   * Read the read-only `external` rows.
   * @returns {Promise<{ rows: any[], warnings: string[] }>}
   */
  async function externalRows() {
    try {
      const editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined
      if (!editor || typeof editor.configuration !== 'function') return { rows: [], warnings: [] }
      let rows = editor.configuration()
      if (rows && typeof rows.then === 'function') rows = await rows
      if (!Array.isArray(rows)) return { rows: [], warnings: [] }
      const result = []
      for (const row of rows) {
        try {
          const parsed = externalConfigOf(row)
          if (parsed === null) continue
          const { entry, config } = parsed
          const moduleName =
            (typeof entry.moduleName === 'string' && entry.moduleName) ||
            (typeof entry.options?.name === 'string' && entry.options.name) ||
            (typeof entry.name === 'string' && entry.name) ||
            null
          if (moduleName !== CLIENT_MODULE) continue
          const serverName = typeof config.serverName === 'string' ? config.serverName : ''
          if (serverName === '') continue
          const transport =
            config.transport === 'stdio' || config.transport === 'streamable-http' ? config.transport : null
          result.push({
            entryId:
              (typeof entry.options?.id === 'string' && entry.options.id) ||
              (typeof entry.id === 'string' && entry.id) ||
              null,
            moduleName: CLIENT_MODULE,
            serverName,
            transport,
            summary: summarizeStored({
              transport: transport ?? 'stdio',
              command: config.command,
              args: config.args,
              url: config.url,
            }),
            configurable: false,
          })
        } catch {
          // one malformed editor row must not hide the others
        }
      }
      return { rows: result, warnings: [] }
    } catch (error) {
      const message = `reading MCP client rows from the config editor failed: ${messageOf(error)}`
      warn(message)
      return { rows: [], warnings: [message] }
    }
  }

  // -----------------------------------------------------------------------------------------
  // Session (workspace-scope) mounts.
  // -----------------------------------------------------------------------------------------

  /** Serialize Agent attaches so two creations cannot race the same bridge namespace. */
  let agentChain = Promise.resolve()
  function serializeAgentMounts(task) {
    const run = agentChain.then(task)
    agentChain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /** Read `agent.session?.header?.cwd` defensively; `null` when absent/unusable. */
  function agentCwd(agent) {
    try {
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd.trim() === '') return null
      const absolute = resolve(cwd.trim())
      return isAbsolute(absolute) ? absolute : null
    } catch {
      return null
    }
  }

  /**
   * Ancestor workspace roots of `cwd` that own an MCP store, nearest first. A root qualifies only
   * when `<root>/.dsh/agent-assets/mcp.json` exists, so a Session mounts exactly the workspaces whose
   * stored path contains its cwd. The user store (`<dshHome>/agent-assets/mcp.json`) is never treated
   * as a workspace store.
   */
  async function findWorkspaceRoots(cwd) {
    const roots = []
    let current = cwd
    for (let depth = 0; depth < MAX_WORKSPACE_DEPTH; depth += 1) {
      if (!isInside(resolvedHomes.dshHome, current)) {
        const storePath = workspaceStorePath(current)
        // `<home>/.dsh/agent-assets/mcp.json` IS the user store when dshHome is `~/.dsh`; never
        // treat the user's home directory as a workspace just because that file exists.
        if (pathKey(storePath) === pathKey(userStorePath())) {
          const parentSkip = dirname(current)
          if (parentSkip === current) break
          current = parentSkip
          continue
        }
        try {
          const info = await statIfExists(storePath)
          if (info && typeof info.isFile === 'function' && info.isFile()) roots.push(current)
        } catch {
          // an unreadable ancestor simply does not qualify
        }
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return roots
  }

  /** Mount every enabled workspace-scope row of this Agent's containing workspaces on `agent.ctx`. */
  async function mountWorkspaceServers(agent, cwd) {
    if (disposed) return
    const agentCtx = agent?.ctx
    if (!agentCtx || typeof agentCtx.plugin !== 'function') {
      skippedAgents += 1
      return
    }
    let namespace
    try {
      namespace = await ensureClientPlugin()
    } catch {
      skippedAgents += 1
      return
    }
    const roots = await findWorkspaceRoots(cwd)
    if (roots.length === 0) {
      skippedAgents += 1
      return
    }
    let mountedNames = agentMountedNames.get(agent)
    if (!mountedNames) {
      mountedNames = new Set()
      agentMountedNames.set(agent, mountedNames)
    }
    const trust = await readTrust()
    for (const message of trust.warnings) warn(message)
    for (const root of roots) {
      if (disposed) return
      const store = await readStore('workspace', root)
      const trustRows = trust.workspaces.get(pathKey(root))
      for (const stored of store.servers) {
        if (!stored.enabled) continue
        if (mountedNames.has(stored.serverName)) continue
        if (disposed) return
        if (trustRows?.get(stored.serverName) !== trustFingerprint(stored)) {
          untrustedSkipped += 1
          warn(`workspace MCP server "${stored.serverName}" in ${displayPath(root)} is not trusted yet; not mounted`)
          continue
        }
        const record = mountServer(agentCtx, { scope: 'workspace', config: toClientConfig(stored) }, { agent, workspace: root })
        mountedNames.add(stored.serverName)
        agentMounts.push(record)
      }
    }
  }

  /** Dispose and forget every mount owned by one Agent (also covered by `agent.ctx` disposal). */
  async function releaseAgent(agent) {
    const records = agentMounts.filter((record) => record.agent === agent)
    if (records.length === 0) return
    agentMounts = agentMounts.filter((record) => record.agent !== agent)
    await Promise.all(records.map((record) => disposeMount(record)))
  }

  // Optional `agent/disposed` cleanup keeps our record list bounded; disposal of `agent.ctx...`
  // still owns the fibers, this only releases our references early. Guarded for test doubles.
  try {
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => {
        const disposers = []
        try {
          if (typeof ctx.on === 'function') {
            const off = ctx.on('agent/disposed', ({ agent } = {}) => {
              void releaseAgent(agent).catch(() => {})
            })
            if (typeof off === 'function') disposers.push(off)
          }
        } catch {
          // event subscription is optional
        }
        return () => {
          for (const off of disposers) {
            try {
              off()
            } catch {
              // ignore
            }
          }
        }
      }, 'agent-assets: mcp agent mount cleanup')
    }
  } catch {
    // a context without effect support (tests) simply skips the cleanup hook
  }

  // Kick off the initial global mounts immediately; connections continue in the background.
  void scheduleUserMounts().catch(() => {})

  // -----------------------------------------------------------------------------------------
  // Public API.
  // -----------------------------------------------------------------------------------------

  /** `GET /mcp` */
  async function list({ workspace } = {}) {
    const warnings = []
    try {
      let workspaceRoot = null
      if (typeof workspace === 'string' && workspace.trim() !== '') workspaceRoot = resolve(workspace.trim())
      const user = await readStore('user', null)
      warnings.push(...user.warnings)
      const workspaceStore =
        workspaceRoot === null
          ? { servers: [], warnings: [] }
          : await readStore('workspace', workspaceRoot)
      warnings.push(...workspaceStore.warnings)
      const trust = await readTrust()
      warnings.push(...trust.warnings)
      const trustRows = workspaceRoot === null ? undefined : trust.workspaces.get(pathKey(workspaceRoot))
      const globalToolNames = toolNames(undefined)
      const servers = [
        ...viewsFor('user', user.servers, globalToolNames),
        ...viewsFor('workspace', workspaceStore.servers, globalToolNames, trustRows),
      ]
      if (clientModuleError !== null) warnings.push(`MCP client module unavailable: ${clientModuleError}`)
      for (const record of userMounts.values()) {
        if (record.error) warnings.push(`MCP server "${record.serverName}" failed to mount: ${record.error}`)
      }
      const external = await externalRows()
      warnings.push(...external.warnings)
      return { servers, external: external.rows, warnings }
    } catch (error) {
      warn(`MCP list failed: ${messageOf(error)}`)
      return { servers: [], external: [], warnings: [`MCP list failed: ${messageOf(error)}`] }
    }
  }

  /** `GET /mcp/detail` — full stored config including env/header values plus live status. */
  async function detail({ scope, workspace, serverName } = {}) {
    const resolved = resolveScope(scope, workspace)
    assertServerName(serverName)
    const store = await readStore(resolved.scope, resolved.workspaceRoot)
    const stored = store.servers.find((row) => row.serverName === serverName)
    if (stored === undefined) fail('not_found', `MCP server not found: ${serverName}`, 404)
    const globalToolNames = toolNames(undefined)
    const trustRows = resolved.scope === 'workspace'
      ? (await readTrust()).workspaces.get(pathKey(resolved.workspaceRoot))
      : undefined
    const trust = trustOf(stored, resolved.scope, trustRows)
    return {
      server: {
        ...stored,
        summary: summarizeStored(stored),
        status: statusFor(stored, resolved.scope, globalToolNames, trust.trusted),
        // Workspace rows mount per Session, so only user rows have a global tool list to show.
        tools: resolved.scope === 'user' ? serverTools(stored.serverName) : [],
        ...trust,
      },
    }
  }

  /** `POST /mcp` — validate, persist, then (user scope) reconcile live mounts. */
  async function apply(input = {}) {
    const op = input.op
    if (typeof op !== 'string' || !OPS.has(op)) bad(`unknown mcp op: ${String(op)}`)
    const resolved = resolveScope(input.scope, input.workspace)
    const now = new Date().toISOString()
    const raw = input.server
    if (!isPlainObject(raw)) bad('missing required field: server')
    const serverName = assertServerName(raw.serverName)
    if (op === 'trust' && resolved.scope !== 'workspace') bad('only workspace-scope servers need trust')

    let rowsForScope = []
    let trustRowsForScope
    await withStoreLock(async () => {
      const store = await readStore(resolved.scope, resolved.workspaceRoot)
      if (store.failed) {
        fail(
          'conflict',
          `MCP store ${displayPath(store.path)} is unreadable or corrupt; fix or remove it before editing (${store.warnings.join('; ')})`,
          409,
        )
      }
      const trust = resolved.scope === 'workspace' ? await readTrust() : null
      if (trust?.failed && op !== 'toggle') {
        fail('conflict', `${trust.warnings.join('; ')}; fix or remove the file before editing`, 409)
      }
      const servers = [...store.servers]
      const index = servers.findIndex((row) => row.serverName === serverName)
      let nextServerName = serverName
      switch (op) {
        case 'create': {
          if (index >= 0) fail('conflict', `MCP server already exists in this scope: ${serverName}`, 409)
          servers.push(createStored(raw, resolved.scope, now))
          break
        }
        case 'update': {
          if (index < 0) fail('not_found', `MCP server not found: ${serverName}`, 404)
          servers[index] = updateStored(raw, servers[index], resolved.scope, now)
          break
        }
        case 'delete': {
          if (index < 0) fail('not_found', `MCP server not found: ${serverName}`, 404)
          servers.splice(index, 1)
          break
        }
        case 'toggle': {
          if (index < 0) fail('not_found', `MCP server not found: ${serverName}`, 404)
          const enabled = input.enabled
          if (typeof enabled !== 'boolean') bad('missing required field: enabled (boolean)')
          servers[index] = { ...servers[index], enabled, updatedAt: now }
          break
        }
        case 'trust': {
          if (index < 0) fail('not_found', `MCP server not found: ${serverName}`, 404)
          // Trust exactly what the user was shown; the file may have changed since.
          if (input.fingerprint !== trustFingerprint(servers[index])) {
            fail('conflict', `MCP server "${serverName}" changed since it was shown; review it again`, 409)
          }
          break
        }
        default:
          // OPS was validated above; unreachable.
          bad(`unknown mcp op: ${String(op)}`)
      }
      if (op !== 'trust') await writeStore(resolved.scope, resolved.workspaceRoot, servers)
      rowsForScope = servers
      if (trust === null) return
      const key = pathKey(resolved.workspaceRoot)
      if (op !== 'toggle') {
        // Toggling must not grant anything. Written after the store, so a crash leaves the row untrusted.
        const rows = new Map(trust.workspaces.get(key) ?? [])
        const saved = servers.find((row) => row.serverName === serverName)
        if (saved === undefined) rows.delete(serverName)
        else rows.set(serverName, trustFingerprint(saved))
        if (rows.size > 0) trust.workspaces.set(key, rows)
        else trust.workspaces.delete(key)
        await writeTrust(trust.workspaces)
      }
      trustRowsForScope = trust.workspaces.get(key)
    })

    if (resolved.scope === 'user') await scheduleUserMounts({ retry: true })
    const globalToolNames = toolNames(undefined)
    return { servers: viewsFor(resolved.scope, rowsForScope, globalToolNames, trustRowsForScope) }
  }

  /**
   * Called from `agent/created` (never awaited there). Starts Session mounts and returns
   * immediately: store I/O, module import and the connection all continue in the background.
   */
  function attachAgent(agent) {
    if (disposed) return
    let cwd = null
    try {
      cwd = agentCwd(agent)
    } catch {
      cwd = null
    }
    if (cwd === null) {
      skippedAgents += 1
      return
    }
    void serializeAgentMounts(async () => {
      try {
        await mountWorkspaceServers(agent, cwd)
      } catch (error) {
        skippedAgents += 1
        warn(`workspace MCP attach failed: ${messageOf(error)}`)
      }
    }).catch(() => {})
  }

  /** `/health` diagnostics — fully guarded, never throws. */
  function health() {
    try {
      const mounted = [...userMounts.values()]
        .filter((record) => record.disposed !== true && record.fiber !== null && record.error === null)
        .map((record) => record.serverName)
        .sort()
      return {
        moduleLoaded: clientNamespace !== null,
        moduleError: clientModuleError,
        mounted,
        skippedAgents,
        untrustedSkipped,
      }
    } catch {
      return { moduleLoaded: false, moduleError: null, mounted: [], skippedAgents: 0, untrustedSkipped: 0 }
    }
  }

  /** Dispose every mount (global and Session) and stop scheduling new ones. */
  async function dispose() {
    if (disposed) return
    disposed = true
    // 1) Tear down what is mounted right now, promptly, even if an in-flight scheduling task is slow.
    const records = [...userMounts.values(), ...agentMounts]
    userMounts = new Map()
    agentMounts = []
    try {
      await Promise.all(records.map((record) => disposeMount(record)))
    } catch {
      // disposeMount never throws; guard the aggregate anyway
    }
    // 2) Drain schedulers that were already running/queued when dispose() started...
    try {
      await userMountChain
    } catch {
      // swallowed by the chain
    }
    try {
      await agentChain
    } catch {
      // swallowed by the chain
    }
    // 3) ...and tear down anything such a task managed to mount before observing `disposed`.
    const late = [...userMounts.values(), ...agentMounts]
    if (late.length > 0) {
      userMounts = new Map()
      agentMounts = []
      try {
        await Promise.all(late.map((record) => disposeMount(record)))
      } catch {
        // as above
      }
    }
  }

  return { list, detail, apply, attachAgent, health, dispose }
}
