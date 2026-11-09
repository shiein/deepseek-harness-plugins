/**
 * Agent Assets — Host half.
 *
 * Serves one JSON API for the three agent-asset families the sidebar page manages, each grouped by
 * the scope the Harness itself uses:
 *
 *   - skills        workspace/.dsh/skills, workspace/.agents/skills, ~/.dsh/skills, ~/.agents/skills,
 *                   plus read-only bundled/runtime skills from the live `skills` service
 *   - agent prompts AGENTS.md / CLAUDE.md instruction files (user-global and workspace) — the files
 *                   `@deepseek-ai/dsh-agent-instructions` loads into the system prompt
 *   - MCP servers   plugin-owned stores per scope, mounted live through the Harness MCP client
 *
 * All routes are loopback-only: this page edits the user's own harness configuration, so requests
 * that did not arrive on the machine itself are rejected.
 *
 * The Client half (client.js) renders the left-sidebar entry and the management page.
 */

import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

import {
  AssetsError,
  ENVELOPE_HEADERS,
  pathKey,
  resolveHomes,
  toErrorPayload,
} from './host/shared.js'
import { createSkills } from './host/skills.js'
import { createInstructions } from './host/instructions.js'
import { createMcp } from './host/mcp.js'
import { isLoopbackRequest } from './host/loopback.js'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'agent-assets'

/** Hard dependency: the browser HTTP carrier that serves the Web GUI this page renders in. */
export const inject = ['webServer']

/** Reported by `/health`; keep in sync with package.json. */
const VERSION = '0.1.0'

/** Route prefix shared by every endpoint. */
const PREFIX = '/api/dsh-agent-assets'

/** Upper bound for a JSON request body (skill bodies and instruction files are text). */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Write a JSON response, tolerating an already-closed socket. */
function writeJson(response, status, body) {
  try {
    response.writeHead(status, ENVELOPE_HEADERS)
    response.end(JSON.stringify(body))
  } catch (error) {
    // The browser may have navigated away; nothing to repair. Debug mode keeps serialization
    // failures visible instead of turning them into a silent never-ending request.
    if (process.env.AGENT_ASSETS_DEBUG === '1') console.error('[agent-assets] response write failed:', error)
  }
}

/** Success envelope. */
function ok(response, payload = {}) {
  writeJson(response, 200, { ok: true, ...payload })
}

/** Failure envelope from any thrown value. */
function failResponse(response, error) {
  const payload = toErrorPayload(error)
  writeJson(response, payload.status, { ok: false, error: { code: payload.code, message: payload.message } })
}

/** Read and parse a JSON request body, bounded by {@link MAX_BODY_BYTES}. */
async function readJsonBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      throw new AssetsError('bad_request', `request body exceeds ${MAX_BODY_BYTES} bytes`, 413)
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new AssetsError('bad_request', 'request body must be a JSON object', 400)
    }
    return value
  } catch (error) {
    if (error instanceof AssetsError) throw error
    throw new AssetsError('bad_request', 'request body is not valid JSON', 400)
  }
}

/** Query parameter as a trimmed string, or undefined. */
function queryValue(url, key) {
  const value = url.searchParams.get(key)
  if (value === null) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Require a string field from a JSON body. */
function requireString(body, key) {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AssetsError('bad_request', `missing required field: ${key}`, 400)
  }
  return value
}

/** Optional string field from a JSON body (null/undefined/"" collapse to null). */
function optionalString(body, key) {
  const value = body[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new AssetsError('bad_request', `field ${key} must be a string`, 400)
  return value
}

/** Method gate. */
function requireMethod(request, method) {
  if (request.method !== method) {
    throw new AssetsError('bad_request', `method not allowed: ${request.method}; use ${method}`, 405)
  }
}

/**
 * Resolve the Electron-installed Harness package that ships the MCP client bridge.
 *
 * A linked workspace bundle cannot resolve the Harness packages by bare specifier, but the Host
 * process runs from `<resources>/app.asar/dsh`, and Electron's asar-aware ESM loader imports files
 * under that archive. Resolution is anchored at the running Host entry first, then at the archive
 * root, and returns the real namespace `{ Config, apply, inject, name }`.
 */
function createClientPluginLoader(logger) {
  /** @type {Promise<any>|null} */
  let pending = null
  /** @type {any} */
  let loaded = null
  /** @type {string|null} */
  let lastError = null

  async function resolveClientPlugin() {
    // Test seam: the pre-install integration harness substitutes a dependency-free fake bridge so
    // the whole mount/status/teardown wiring runs under plain Node (no Electron app.asar).
    const override = process.env.AGENT_ASSETS_MCP_CLIENT_MODULE
    if (typeof override === 'string' && override.trim() !== '') {
      const namespace = await import(pathToFileURL(resolve(override.trim())).href)
      if (typeof namespace.apply !== 'function') {
        throw new Error(`${override} did not export apply()`)
      }
      return namespace
    }
    const anchors = []
    const argv1 = process.argv?.[1]
    if (typeof argv1 === 'string' && argv1.length > 0) anchors.push(argv1)
    const resourcesPath = process.resourcesPath
    if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
      anchors.push(join(resourcesPath, 'app.asar', 'dsh', 'package.json'))
    }
    let fallbackError = null
    for (const anchor of anchors) {
      try {
        const requireFromAnchor = createRequire(anchor)
        const resolved = requireFromAnchor.resolve('@deepseek-ai/dsh-mcp-client')
        const namespace = await import(pathToFileURL(resolved).href)
        if (typeof namespace.apply !== 'function') {
          throw new Error('@deepseek-ai/dsh-mcp-client did not export apply()')
        }
        return namespace
      } catch (error) {
        fallbackError = error
      }
    }
    throw fallbackError ?? new Error('cannot resolve @deepseek-ai/dsh-mcp-client')
  }

  return function loadClientPlugin() {
    if (loaded !== null) return Promise.resolve(loaded)
    if (pending !== null) return pending
    pending = resolveClientPlugin()
      .then((namespace) => {
        loaded = namespace
        logger?.info?.('[agent-assets] mounted the Harness MCP client bridge')
        return namespace
      })
      .catch((error) => {
        lastError = error instanceof Error ? error.message : String(error)
        logger?.warn?.(`[agent-assets] MCP bridge unavailable: ${lastError}`)
        throw error
      })
      .finally(() => {
        pending = null
      })
    return pending
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const logger = typeof ctx.logger?.info === 'function' ? ctx.logger : undefined
  const homes = resolveHomes()
  const loadClientPlugin = createClientPluginLoader(logger)

  // -------------------------------------------------------------------------------------------
  // Optional Harness services. Every read is guarded: the plugin must stay usable in a profile
  // that lacks one of them.
  // -------------------------------------------------------------------------------------------

  const getService = (key) => {
    try {
      return ctx.get(key)
    } catch {
      return undefined
    }
  }

  /** Live read-only skills from the Harness registry (bundled/runtime/custom providers). */
  async function serviceSkills({ workspace }) {
    const service = getService('skills')
    if (service === undefined || typeof service.list !== 'function') return null
    try {
      const skills = await service.list({ cwd: workspace })
      const filesystemSources = new Set(['project-dsh', 'project-agents', 'user-dsh', 'user-agents'])
      return skills
        .filter((skill) => !filesystemSources.has(skill.source))
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse ?? null,
          source: skill.source,
          provider: skill.provider,
        }))
    } catch (error) {
      logger?.warn?.(`[agent-assets] skills service read failed: ${String(error)}`)
      return null
    }
  }

  const skills = createSkills({ homes, serviceSkills })
  const instructions = createInstructions({ homes })
  const mcp = createMcp({ ctx, homes, loadClientPlugin })

  // -------------------------------------------------------------------------------------------
  // Workspace resolution. A request may address any registered workspace (or the default
  // directory); anything else is rejected instead of touching arbitrary paths.
  // -------------------------------------------------------------------------------------------

  function workspaceSnapshot() {
    const workingDirectory = getService('workingDirectory')
    const registry = getService('workspaceRegistry')
    let defaultDirectory = process.cwd()
    if (typeof workingDirectory?.defaultDirectory === 'string' && workingDirectory.defaultDirectory.length > 0) {
      defaultDirectory = workingDirectory.defaultDirectory
    }
    const workspaces = []
    if (registry !== undefined && typeof registry.list === 'function') {
      let rows = []
      try {
        rows = registry.list() ?? []
      } catch {
        rows = []
      }
      for (const row of rows) {
        if (row === null || row === undefined) continue
        const path = typeof row.path === 'string' ? row.path : typeof row.directory === 'string' ? row.directory : null
        if (path === null) continue
        const title =
          typeof row.title === 'string' && row.title.length > 0
            ? row.title
            : typeof row.name === 'string' && row.name.length > 0
              ? row.name
              : basename(path)
        workspaces.push({
          id: String(row.id ?? row.workspaceId ?? path),
          title,
          path,
        })
      }
    }
    const seen = new Set()
    const unique = []
    for (const workspace of workspaces) {
      const key = pathKey(workspace.path)
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(workspace)
    }
    if (!seen.has(pathKey(defaultDirectory))) {
      unique.unshift({ id: 'default', title: basename(defaultDirectory), path: defaultDirectory })
    }
    return { defaultDirectory, workspaces: unique }
  }

  function resolveWorkspace(requested) {
    const snapshot = workspaceSnapshot()
    if (typeof requested !== 'string' || requested.trim() === '') {
      return { workspace: snapshot.defaultDirectory, snapshot }
    }
    const absolute = resolve(requested.trim())
    const known =
      pathKey(absolute) === pathKey(snapshot.defaultDirectory) ||
      snapshot.workspaces.some((workspace) => pathKey(workspace.path) === pathKey(absolute))
    if (!known) {
      throw new AssetsError('bad_request', 'workspace is not registered with this Harness', 400)
    }
    return { workspace: absolute, snapshot }
  }

  /** `workspace` from query (GET) or body (POST), resolved and validated. */
  function workspaceFrom(params) {
    return resolveWorkspace(params.workspace).workspace
  }

  // -------------------------------------------------------------------------------------------
  // Route handlers.
  // -------------------------------------------------------------------------------------------

  const handlers = {
    async health(request, url) {
      requireMethod(request, 'GET')
      const { workspace } = resolveWorkspace(undefined)
      const mcpHealth = typeof mcp.health === 'function' ? mcp.health() : { moduleLoaded: false, moduleError: null, mounted: [] }
      return {
        plugin: '@local/dsh-agent-assets',
        version: VERSION,
        homes,
        workspace,
        mcp: mcpHealth,
      }
    },

    async bootstrap(request) {
      requireMethod(request, 'GET')
      const snapshot = workspaceSnapshot()
      return {
        version: VERSION,
        defaultWorkspace: snapshot.defaultDirectory,
        workspaces: snapshot.workspaces,
        homes,
        supports: { skills: true, instructions: true, mcp: true },
      }
    },

    async skills(request, url) {
      requireMethod(request, 'GET')
      const workspace = workspaceFrom({ workspace: queryValue(url, 'workspace') })
      const result = await skills.list({ workspace })
      return result
    },

    async skill(request, url) {
      if (request.method === 'GET') {
        const scope = requireString({ scope: queryValue(url, 'scope') }, 'scope')
        const name = requireString({ name: queryValue(url, 'name') }, 'name')
        const workspace = workspaceFrom({ workspace: queryValue(url, 'workspace') })
        const result = await skills.read({ scope, workspace, name })
        return result
      }
      requireMethod(request, 'POST')
      const body = await readJsonBody(request)
      const op = requireString(body, 'op')
      const scope = requireString(body, 'scope')
      const name = requireString(body, 'name')
      const workspace = workspaceFrom(body)
      if (op === 'create') {
        const result = await skills.create({
          scope,
          workspace,
          name,
          description: requireString(body, 'description'),
          whenToUse: optionalString(body, 'whenToUse'),
          body: optionalString(body, 'body') ?? '',
        })
        return result
      }
      if (op === 'update') {
        const result = await skills.update({
          scope,
          workspace,
          name,
          description: requireString(body, 'description'),
          whenToUse: optionalString(body, 'whenToUse'),
          body: optionalString(body, 'body') ?? '',
        })
        return result
      }
      if (op === 'delete') {
        const result = await skills.remove({ scope, workspace, name })
        return result
      }
      throw new AssetsError('bad_request', `unknown skill op: ${op}`, 400)
    },

    async skillsImport(request) {
      requireMethod(request, 'POST')
      const body = await readJsonBody(request)
      return skills.importSkills({
        scope: requireString(body, 'scope'),
        workspace: workspaceFrom(body),
        source: requireString(body, 'source'),
        target: optionalString(body, 'target') ?? undefined,
        dryRun: body.dryRun === true,
        overwrite: body.overwrite === true,
        names: Array.isArray(body.names) ? body.names : undefined,
      })
    },

    async instructions(request, url) {
      requireMethod(request, 'GET')
      const workspace = workspaceFrom({ workspace: queryValue(url, 'workspace') })
      const result = await instructions.list({ workspace })
      return result
    },

    async instruction(request, url) {
      if (request.method === 'GET') {
        const scope = requireString({ scope: queryValue(url, 'scope') }, 'scope')
        const path = requireString({ path: queryValue(url, 'path') }, 'path')
        const workspace = workspaceFrom({ workspace: queryValue(url, 'workspace') })
        const result = await instructions.read({ scope, workspace, path })
        return result
      }
      requireMethod(request, 'POST')
      const body = await readJsonBody(request)
      const op = requireString(body, 'op')
      const scope = requireString(body, 'scope')
      const path = requireString(body, 'path')
      const workspace = workspaceFrom(body)
      if (op === 'write') {
        const result = await instructions.write({
          scope,
          workspace,
          path,
          content: optionalString(body, 'content') ?? '',
        })
        return result
      }
      if (op === 'delete') {
        const result = await instructions.remove({ scope, workspace, path })
        return result
      }
      throw new AssetsError('bad_request', `unknown instruction op: ${op}`, 400)
    },

    async mcp(request, url) {
      if (request.method === 'GET') {
        const workspace = workspaceFrom({ workspace: queryValue(url, 'workspace') })
        const result = await mcp.list({ workspace })
        return result
      }
      requireMethod(request, 'POST')
      const body = await readJsonBody(request)
      const op = requireString(body, 'op')
      const scope = requireString(body, 'scope')
      const workspace = workspaceFrom(body)
      if (op === 'toggle') {
        const server = body.server
        if (server === null || typeof server !== 'object' || Array.isArray(server)) {
          throw new AssetsError('bad_request', 'missing required field: server', 400)
        }
        const enabled = body.enabled
        if (typeof enabled !== 'boolean') {
          throw new AssetsError('bad_request', 'missing required field: enabled (boolean)', 400)
        }
        const result = await mcp.apply({ op, scope, workspace, server, enabled })
        return result
      }
      if (op === 'trust') {
        const server = body.server
        if (server === null || typeof server !== 'object' || Array.isArray(server)) {
          throw new AssetsError('bad_request', 'missing required field: server', 400)
        }
        const result = await mcp.apply({ op, scope, workspace, server, fingerprint: requireString(body, 'fingerprint') })
        return result
      }
      if (op === 'create' || op === 'update' || op === 'delete') {
        const server = body.server
        if (server === null || typeof server !== 'object' || Array.isArray(server)) {
          throw new AssetsError('bad_request', 'missing required field: server', 400)
        }
        const result = await mcp.apply({ op, scope, workspace, server })
        return result
      }
      throw new AssetsError('bad_request', `unknown mcp op: ${op}`, 400)
    },

    async mcpDetail(request, url) {
      requireMethod(request, 'GET')
      const scope = requireString({ scope: queryValue(url, 'scope') }, 'scope')
      const serverName = requireString({ serverName: queryValue(url, 'serverName') }, 'serverName')
      const workspace = workspaceFrom({ workspace: queryValue(url, 'workspace') })
      const result = await mcp.detail({ scope, workspace, serverName })
      return result
    },
  }

  /** One exact route per endpoint, registered as one effect. */
  const ROUTES = [
    ['/health', handlers.health],
    ['/bootstrap', handlers.bootstrap],
    ['/skills', handlers.skills],
    ['/skills/import', handlers.skillsImport],
    ['/skill', handlers.skill],
    ['/instructions', handlers.instructions],
    ['/instruction', handlers.instruction],
    ['/mcp', handlers.mcp],
    ['/mcp/detail', handlers.mcpDetail],
  ]

  ctx.effect(() => {
    const disposers = ROUTES.map(([suffix, handler]) =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${PREFIX}${suffix}`,
        handler: async (request, response) => {
          try {
            if (!isLoopbackRequest(request, { checkReferer: true })) {
              writeJson(response, 403, {
                ok: false,
                error: { code: 'forbidden', message: 'forbidden: loopback-only' },
              })
              return
            }
            const url = new URL(request.url ?? '/', 'http://127.0.0.1')
            const payload = await handler(request, url)
            if (payload !== undefined) ok(response, payload)
          } catch (error) {
            failResponse(response, error)
          }
        },
      }),
    )
    logger?.info?.(`[agent-assets] mounted ${ROUTES.length} routes under ${PREFIX}`)
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // ignore disposal errors
        }
      }
    }
  }, 'agent-assets: routes')

  // -------------------------------------------------------------------------------------------
  // Per-Session workspace-scope MCP mounts. Never awaited: a slow server must not stall the
  // Agent creation path. agent.ctx disposes those mounts with the Agent.
  // -------------------------------------------------------------------------------------------

  ctx.effect(
    () =>
      ctx.on('agent/created', ({ agent }) => {
        void Promise.resolve()
          .then(() => mcp.attachAgent?.(agent))
          .catch((error) => {
            logger?.warn?.(`[agent-assets] workspace MCP attach failed: ${String(error)}`)
          })
      }),
    'agent-assets: agent mcp mounts',
  )

  // Tear down global mounts when the plugin unloads.
  ctx.effect(
    () => () => {
      void Promise.resolve()
        .then(() => mcp.dispose?.())
        .catch(() => {})
    },
    'agent-assets: mcp disposal',
  )

  // Keep the entry file honest about its diagnostics in a profile without a browser.
  ctx.effect(() => {
    logger?.info?.(`[agent-assets] ready; dshHome=${homes.dshHome} agentsHome=${homes.agentsHome}`)
  }, 'agent-assets: diagnostics')
}

/** Exposed for diagnostics and tests: the installed bundle's own version. */
export const version = VERSION
