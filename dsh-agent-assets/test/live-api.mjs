#!/usr/bin/env node
/**
 * Live verification for the *installed* Agent Assets bundle.
 *
 * Drives the running DSH Web GUI origin (the Host half must already be installed and the Web GUI
 * running) and checks the deployed plugin against `API.md`, the bundle manifest and the live client
 * boot graph. Dependency-free: plain Node >= 20 (`fetch`, `AbortSignal.timeout`).
 *
 *   node test/live-api.mjs                          # read-only checks
 *   node test/live-api.mjs --write                  # + workspace-scope CRUD round-trip
 *   DSH_WEB_ORIGIN=http://127.0.0.1:49536 node test/live-api.mjs
 *   node test/live-api.mjs --workspace /abs/path    # choose the workspace explicitly
 *
 * `--write` only ever touches *workspace-scope* assets:
 *   - a workspace skill named `verify-<pid>` (create, read, update, delete, assert gone)
 *   - one *missing* fixed workspace instruction candidate (AGENTS.local.md / CLAUDE.local.md /
 *     AGENTS.md / CLAUDE.md — created, read, deleted, asserted gone; never a file that already
 *     exists)
 *   - a disabled workspace MCP store row (create, toggle, update, delete; the plugin-owned
 *     `.dsh/agent-assets/mcp.json` is removed when this run created it)
 * It never writes user-scope (~/.dsh, ~/.agents) files. Cleanup runs in a `finally` block; a
 * leftover is a FAIL.
 *
 * Output: one PASS/FAIL/WARN/SKIP line per check, then a summary. Exit code 1 when a check failed.
 */

import http from 'node:http'
import { createHash } from 'node:crypto'
import { access, readFile, readdir, rmdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

const ORIGIN = (process.env.DSH_WEB_ORIGIN || 'http://127.0.0.1:49536').replace(/\/+$/, '')
const ORIGIN_URL = new URL(ORIGIN)
const API_BASE = '/api/dsh-agent-assets'
const BUNDLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = join(BUNDLE_DIR, 'package.json')
const ARGS = process.argv.slice(2)
const WRITE = ARGS.includes('--write')
const PID = process.pid
const REQUEST_TIMEOUT_MS = 20_000

/** Results of every check, in execution order. */
const results = []

function argValue(flag) {
  const index = ARGS.indexOf(flag)
  return index >= 0 && ARGS[index + 1] !== undefined ? ARGS[index + 1] : undefined
}

function section(title) {
  process.stdout.write(`\n=== ${title} ===\n`)
}

function record(status, name, detail) {
  results.push({ status, name, detail: detail === undefined ? '' : String(detail) })
  const line = detail === undefined || detail === '' ? name : `${name} — ${detail}`
  process.stdout.write(`${status.padEnd(4, ' ')} ${line}\n`)
}

function pass(name, detail) {
  record('PASS', name, detail)
}

function warn(name, detail) {
  record('WARN', name, detail)
}

function skip(name, detail) {
  record('SKIP', name, detail)
}

function fail(name, detail) {
  record('FAIL', name, detail)
}

/** Run one synchronous check; a thrown Error becomes a FAIL. */
function check(name, fn) {
  try {
    pass(name, fn())
    return true
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error))
    return false
  }
}

/** Run one asynchronous check; a thrown Error becomes a FAIL. */
async function checkAsync(name, fn) {
  try {
    pass(name, await fn())
    return true
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error))
    return false
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function expectType(value, type, label) {
  expect(typeof value === type, `${label} must be a ${type}, got ${typeof value}`)
}

function expectAbsolute(value, label) {
  expectType(value, 'string', label)
  expect(isAbsolute(value), `${label} must be absolute, got ${JSON.stringify(value)}`)
}

function expectArray(value, label) {
  expect(Array.isArray(value), `${label} must be an array`)
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------

/**
 * Call one plugin route. Never throws for HTTP errors; returns the parsed envelope.
 * @returns {Promise<{status:number, headers:Headers, text:string, json:any, url:string}>}
 */
async function api(pathname, options = {}) {
  const url = new URL(ORIGIN + API_BASE + pathname)
  for (const [key, value] of Object.entries(options.params || {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  const headers = { accept: 'application/json' }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, headers: response.headers, text, json, url: url.href }
}

/** Validate the shared envelope/header contract of a response. */
function expectEnvelope(response, wantOk, label = 'response') {
  const contentType = response.headers.get('content-type') || ''
  expect(
    contentType.includes('application/json'),
    `${label}: content-type must be application/json, got ${JSON.stringify(contentType)}`,
  )
  const cacheControl = response.headers.get('cache-control') || ''
  expect(cacheControl.includes('no-store'), `${label}: cache-control must be no-store, got ${JSON.stringify(cacheControl)}`)
  expect(response.json !== null, `${label}: body is not JSON: ${JSON.stringify(response.text.slice(0, 160))}`)
  if (wantOk) {
    expect(response.status === 200, `${label}: expected HTTP 200, got ${response.status}`)
    expect(response.json.ok === true, `${label}: expected { ok: true }`)
    return response.json
  }
  expect(response.status >= 400, `${label}: expected a 4xx/5xx status, got ${response.status}`)
  expect(response.json.ok === false, `${label}: expected { ok: false }`)
  expect(response.json.error && typeof response.json.error.code === 'string', `${label}: missing error.code`)
  expect(response.json.error && typeof response.json.error.message === 'string', `${label}: missing error.message`)
  return response.json
}

/** Expect a success envelope for a plugin route, validating headers. */
async function okJson(pathname, options = {}, label = `${options.method || 'GET'} ${pathname}`) {
  const response = await api(pathname, options)
  const payload = expectEnvelope(response, true, label)
  return { response, payload }
}

/** Expect a failure envelope for a plugin route, validating headers and the documented code. */
async function errorJson(pathname, options = {}, expectedCode, label = `${options.method || 'GET'} ${pathname}`) {
  const response = await api(pathname, options)
  const payload = expectEnvelope(response, false, label)
  if (expectedCode !== undefined) {
    expect(
      payload.error.code === expectedCode,
      `${label}: expected error.code ${JSON.stringify(expectedCode)}, got ${JSON.stringify(payload.error.code)}`,
    )
  }
  return { response, payload }
}

/** Raw HTTP request that can override the `Host` / `Sec-Fetch-Site` headers (fence tests). */
function rawRequest({ path = `${API_BASE}/health`, headers = {} } = {}) {
  const port = Number(ORIGIN_URL.port || (ORIGIN_URL.protocol === 'https:' ? 443 : 80))
  return new Promise((resolvePromise, rejectPromise) => {
    const request = http.request(
      {
        hostname: ORIGIN_URL.hostname.replace(/^\[|\]$/g, ''),
        port,
        path,
        method: 'GET',
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolvePromise({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }),
        )
        response.on('error', rejectPromise)
      },
    )
    request.on('timeout', () => request.destroy(new Error('raw request timed out')))
    request.on('error', rejectPromise)
    request.end()
  })
}

// ---------------------------------------------------------------------------------------------
// Small filesystem helpers (write phase only touches paths it created)
// ---------------------------------------------------------------------------------------------

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readTextIfExists(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR')) return undefined
    throw error
  }
}

async function statIfExists(path) {
  try {
    return await stat(path)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    throw error
  }
}

function isInside(parent, child) {
  const p = resolve(parent)
  const c = resolve(child)
  return c === p || c.startsWith(p + sep)
}

function bytesOf(text) {
  return Buffer.byteLength(text, 'utf8')
}

// ---------------------------------------------------------------------------------------------
// Shape validators derived from API.md
// ---------------------------------------------------------------------------------------------

const SKILL_SOURCES = new Set([
  'user-dsh',
  'user-agents',
  'project-dsh',
  'project-agents',
  'bundled',
  'runtime',
  'custom',
])

function validateHomes(homes, label) {
  expect(homes && typeof homes === 'object', `${label}.homes must be an object`)
  expectAbsolute(homes.dshHome, `${label}.homes.dshHome`)
  expectAbsolute(homes.agentsHome, `${label}.homes.agentsHome`)
}

function validateSkillView(view, label) {
  expect(view && typeof view === 'object', `${label} must be an object`)
  expectType(view.name, 'string', `${label}.name`)
  expect(view.name.length > 0, `${label}.name must not be empty`)
  expectType(view.description, 'string', `${label}.description`)
  expect(view.whenToUse === null || typeof view.whenToUse === 'string', `${label}.whenToUse must be a string or null`)
  expect(['user', 'workspace', 'bundled'].includes(view.scope), `${label}.scope is invalid: ${view.scope}`)
  expectType(view.source, 'string', `${label}.source`)
  expect(SKILL_SOURCES.has(view.source) || view.source.length > 0, `${label}.source must be non-empty`)
  expectType(view.provider, 'string', `${label}.provider`)
  expect(view.path === null || typeof view.path === 'string', `${label}.path must be a string or null`)
  expect(view.dir === null || typeof view.dir === 'string', `${label}.dir must be a string or null`)
  expectType(view.editable, 'boolean', `${label}.editable`)
  expectArray(view.shadowed, `${label}.shadowed`)
  for (const [index, shadowed] of view.shadowed.entries()) {
    expect(shadowed && typeof shadowed === 'object', `${label}.shadowed[${index}] must be an object`)
    expect(['user', 'workspace', 'bundled'].includes(shadowed.scope), `${label}.shadowed[${index}].scope is invalid`)
    expect(
      shadowed.path === null || typeof shadowed.path === 'string',
      `${label}.shadowed[${index}].path must be a string or null`,
    )
  }
  if (view.scope === 'bundled') {
    expect(view.editable === false, `${label}: bundled entries must be read-only (editable false)`)
    expect(view.path === null && view.dir === null, `${label}: bundled entries must have path/dir null`)
  } else {
    expect(view.editable === true, `${label}: user/workspace entries must be editable`)
    expectType(view.path, 'string', `${label}.path`)
    expectType(view.dir, 'string', `${label}.dir`)
  }
}

function validateInstructionView(view, label) {
  expect(view && typeof view === 'object', `${label} must be an object`)
  expectType(view.id, 'string', `${label}.id`)
  expect(view.id.length > 0, `${label}.id must not be empty`)
  expect(['user', 'workspace'].includes(view.scope), `${label}.scope is invalid: ${view.scope}`)
  expectType(view.file, 'string', `${label}.file`)
  expectType(view.label, 'string', `${label}.label`)
  expectAbsolute(view.path, `${label}.path`)
  expectType(view.displayPath, 'string', `${label}.displayPath`)
  expectType(view.exists, 'boolean', `${label}.exists`)
  expectType(view.editable, 'boolean', `${label}.editable`)
  expect(view.editable === true, `${label}.editable must be true for user/workspace candidates`)
  expect(Number.isInteger(view.size), `${label}.size must be an integer`)
  expect(view.modifiedAt === null || typeof view.modifiedAt === 'string', `${label}.modifiedAt must be an ISO string or null`)
}

function validateMcpView(view, label) {
  expect(view && typeof view === 'object', `${label} must be an object`)
  expectType(view.serverName, 'string', `${label}.serverName`)
  expect(['user', 'workspace'].includes(view.scope), `${label}.scope is invalid: ${view.scope}`)
  expect(['stdio', 'streamable-http'].includes(view.transport), `${label}.transport is invalid`)
  expectType(view.summary, 'string', `${label}.summary`)
  expectType(view.enabled, 'boolean', `${label}.enabled`)
  expect(view.status && typeof view.status === 'object', `${label}.status must be an object`)
  expect(
    ['connected', 'connecting', 'disabled', 'error', 'session-scoped'].includes(view.status.state),
    `${label}.status.state is invalid: ${view.status.state}`,
  )
  expect(Number.isInteger(view.status.tools), `${label}.status.tools must be an integer`)
  expect(
    view.status.error === null || typeof view.status.error === 'string',
    `${label}.status.error must be a string or null`,
  )
  // Secret-leak guard: list responses must never carry command/url/cwd/env/headers values.
  for (const forbidden of ['env', 'headers', 'command', 'url', 'cwd', 'args']) {
    expect(!(forbidden in view), `${label}: list response leaks ${forbidden}`)
  }
  expect(view.createdAt === null || typeof view.createdAt === 'string', `${label}.createdAt must be a string or null`)
  expect(view.updatedAt === null || typeof view.updatedAt === 'string', `${label}.updatedAt must be a string or null`)
}

// ---------------------------------------------------------------------------------------------
// Workspace selection
// ---------------------------------------------------------------------------------------------

async function pickWorkspace(bootstrap) {
  const registered = (Array.isArray(bootstrap.workspaces) ? bootstrap.workspaces : [])
    .map((workspace) => workspace && workspace.path)
    .filter((path) => typeof path === 'string' && isAbsolute(path))
  const candidates = []
  const explicit = argValue('--workspace') || process.env.DSH_WORKSPACE
  if (explicit !== undefined && explicit.trim() !== '') candidates.push(resolve(explicit.trim()))
  // The registered workspace that contains this bundle's directory (longest prefix first) is the
  // real project this checkout belongs to; prefer it over the process cwd (the bundle dir itself).
  const containing = registered
    .filter((path) => isInside(path, BUNDLE_DIR))
    .sort((left, right) => right.length - left.length)
  candidates.push(...containing)
  candidates.push(process.cwd())
  if (typeof bootstrap.defaultWorkspace === 'string') candidates.push(bootstrap.defaultWorkspace)
  candidates.push(...registered)

  const tried = new Set()
  for (const candidate of candidates) {
    const key = resolve(candidate)
    if (tried.has(key)) continue
    tried.add(key)
    const response = await api('/skills', { params: { workspace: key } })
    if (response.status === 200 && response.json && response.json.ok === true) {
      return { workspace: key, registered: registered.includes(key) }
    }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Phase 1 — read-only checks
// ---------------------------------------------------------------------------------------------

async function readOnlyChecks(manifest) {
  // --- health -------------------------------------------------------------------------------
  section('Health')
  let health = null
  const pluginHealthy = await checkAsync('GET /health returns the documented plugin diagnostics', async () => {
    const { payload } = await okJson('/health')
    health = payload
    expect(payload.plugin === manifest.name, `plugin must be ${manifest.name}, got ${JSON.stringify(payload.plugin)}`)
    expect(payload.version === manifest.version, `version must be ${manifest.version}, got ${JSON.stringify(payload.version)}`)
    validateHomes(payload.homes, 'health')
    expectAbsolute(payload.workspace, 'health.workspace')
    expect(payload.mcp && typeof payload.mcp === 'object', 'health.mcp must be an object')
    expectType(payload.mcp.moduleLoaded, 'boolean', 'health.mcp.moduleLoaded')
    expectArray(payload.mcp.mounted, 'health.mcp.mounted')
    expect(
      payload.mcp.moduleError === null || typeof payload.mcp.moduleError === 'string',
      'health.mcp.moduleError must be a string or null',
    )
    return `plugin=${payload.plugin} v${payload.version} workspace=${payload.workspace}`
  })

  if (!pluginHealthy) {
    skip(
      'remaining read-only checks',
      'GET /health did not return the plugin JSON envelope; is the Host half installed and the Web GUI running?',
    )
    return { workspace: null, health: null }
  }

  await checkAsync('health reports the live MCP client bridge as loaded (mcp.moduleLoaded === true)', async () => {
    expect(health.mcp.moduleLoaded === true, `mcp.moduleLoaded must be true; moduleError=${JSON.stringify(health.mcp.moduleError)}`)
    return `mounted=${JSON.stringify(health.mcp.mounted)}`
  })

  await checkAsync('health reports mcp.skippedAgents as an integer (API.md: nested under mcp)', async () => {
    expect(
      Number.isInteger(health.mcp.skippedAgents),
      `health.mcp.skippedAgents must be an integer, got ${JSON.stringify(health.mcp.skippedAgents)}`,
    )
    const stray = ['skippedAgents', 'routes'].filter((key) => Object.prototype.hasOwnProperty.call(health, key))
    expect(stray.length === 0, `unexpected top-level health keys: ${stray.join(', ')}`)
    return `mcp.skippedAgents=${health.mcp.skippedAgents}`
  })

  await checkAsync('every documented route is registered under /api/dsh-agent-assets', async () => {
    // A missing route falls through to the API gateway (a plain-text 401), so any answer that
    // parses as the plugin's JSON envelope proves the exact route is mounted.
    const probes = [
      ['/health', 200],
      ['/bootstrap', 200],
      ['/skills', 200],
      ['/skill', 400],
      ['/instructions', 200],
      ['/instruction', 400],
      ['/mcp', 200],
      ['/mcp/detail', 400],
    ]
    const unexpected = []
    for (const [pathname, expected] of probes) {
      const response = await api(pathname)
      if (response.status !== expected) unexpected.push(`${pathname} -> ${response.status}`)
    }
    expect(unexpected.length === 0, `unexpected statuses: ${unexpected.join(', ')}`)
    return `${probes.length}/${probes.length} routes answered (missing routes would fall through to the gateway)`
  })

  // --- loopback fence ------------------------------------------------------------------------
  section('Loopback fence')
  await checkAsync('a non-loopback Host header is refused with 403 forbidden', async () => {
    const response = await rawRequest({ headers: { host: 'assets.example.com' } })
    expect(response.status === 403, `expected 403, got ${response.status}`)
    let payload = null
    try {
      payload = JSON.parse(response.text)
    } catch {
      payload = null
    }
    expect(payload && payload.ok === false, 'expected a JSON failure envelope')
    expect(payload.error.code === 'forbidden', `expected error.code forbidden, got ${JSON.stringify(payload.error.code)}`)
    return 'Host: assets.example.com -> 403 forbidden'
  })

  await checkAsync('sec-fetch-site: cross-site is refused with 403 forbidden', async () => {
    const response = await rawRequest({
      headers: { host: `${ORIGIN_URL.hostname}:${ORIGIN_URL.port}`, 'sec-fetch-site': 'cross-site' },
    })
    expect(response.status === 403, `expected 403, got ${response.status}`)
    return 'sec-fetch-site: cross-site -> 403 forbidden'
  })

  // Host names that merely *start* with `127.` must not pass an exact loopback-authority check.
  await checkAsync('a spoofed DNS Host starting with "127." is refused with 403 forbidden', async () => {
    const response = await rawRequest({ headers: { host: '127.0.0.1.evil.example:49536' } })
    expect(response.status === 403, `expected 403, got ${response.status}`)
    return 'Host: 127.0.0.1.evil.example -> 403 forbidden'
  })

  await checkAsync('a foreign Origin (no Sec-Fetch-Site) is refused with 403 forbidden', async () => {
    const response = await rawRequest({
      headers: { host: `${ORIGIN_URL.hostname}:${ORIGIN_URL.port}`, origin: 'https://evil.example' },
    })
    expect(response.status === 403, `expected 403, got ${response.status}`)
    return 'Origin: https://evil.example -> 403 forbidden'
  })

  await checkAsync('Origin: null is refused with 403 forbidden', async () => {
    const response = await rawRequest({
      headers: { host: `${ORIGIN_URL.hostname}:${ORIGIN_URL.port}`, origin: 'null' },
    })
    expect(response.status === 403, `expected 403, got ${response.status}`)
    return 'Origin: null -> 403 forbidden'
  })

  await checkAsync('a foreign Referer is refused with 403 forbidden', async () => {
    const response = await rawRequest({
      headers: { host: `${ORIGIN_URL.hostname}:${ORIGIN_URL.port}`, referer: 'https://evil.example/page' },
    })
    expect(response.status === 403, `expected 403, got ${response.status}`)
    return 'Referer: https://evil.example/page -> 403 forbidden'
  })

  await checkAsync('a normal loopback request is served (the fence does not over-block)', async () => {
    const response = await rawRequest({ headers: { host: `${ORIGIN_URL.hostname}:${ORIGIN_URL.port}` } })
    expect(response.status === 200, `expected 200, got ${response.status}`)
    expect(JSON.parse(response.text).ok === true, 'expected ok:true')
    return 'loopback Host -> 200 ok'
  })

  await checkAsync('a loopback Origin is served (the fence does not over-block same-origin pages)', async () => {
    const response = await rawRequest({
      headers: { host: `${ORIGIN_URL.hostname}:${ORIGIN_URL.port}`, origin: ORIGIN },
    })
    expect(response.status === 200, `expected 200, got ${response.status}`)
    return `Origin: ${ORIGIN} -> 200 ok`
  })

  await checkAsync('the method gate returns 405 with code bad_request (API.md §Conventions)', async () => {
    const response = await api('/health', { method: 'POST', body: {} })
    expect(response.status === 405, `expected 405, got ${response.status}`)
    expect(response.json && response.json.ok === false, 'expected { ok:false }')
    expect(
      response.json.error.code === 'bad_request',
      `expected code bad_request, got ${JSON.stringify(response.json.error.code)}`,
    )
    return `POST /health -> 405 bad_request`
  })

  // --- bootstrap -----------------------------------------------------------------------------
  section('Bootstrap and workspace resolution')
  let bootstrap = null
  const bootstrapOk = await checkAsync('GET /bootstrap matches the documented shape', async () => {
    const { payload } = await okJson('/bootstrap')
    bootstrap = payload
    expect(payload.version === manifest.version, `version must be ${manifest.version}`)
    expectAbsolute(payload.defaultWorkspace, 'bootstrap.defaultWorkspace')
    expectArray(payload.workspaces, 'bootstrap.workspaces')
    const seen = new Set()
    for (const [index, workspace] of payload.workspaces.entries()) {
      expect(workspace && typeof workspace === 'object', `bootstrap.workspaces[${index}] must be an object`)
      expectType(workspace.id, 'string', `bootstrap.workspaces[${index}].id`)
      expectType(workspace.title, 'string', `bootstrap.workspaces[${index}].title`)
      expectAbsolute(workspace.path, `bootstrap.workspaces[${index}].path`)
      expect(!seen.has(workspace.path), `bootstrap.workspaces duplicates path ${workspace.path}`)
      seen.add(workspace.path)
      if (workspace.title.length === 0) {
        warn(
          'workspace title',
          `bootstrap.workspaces[${index}] (${workspace.path}) has an empty title; the selector would render an empty option`,
        )
      }
    }
    validateHomes(payload.homes, 'bootstrap')
    expect(payload.supports && typeof payload.supports === 'object', 'bootstrap.supports must be an object')
    for (const feature of ['skills', 'instructions', 'mcp']) {
      expect(payload.supports[feature] === true, `bootstrap.supports.${feature} must be true`)
    }
    return `defaultWorkspace=${payload.defaultWorkspace}; ${payload.workspaces.length} workspace(s)`
  })

  if (!bootstrapOk) {
    skip('remaining read-only checks', 'GET /bootstrap failed')
    return { workspace: null, health }
  }

  if (!bootstrap.workspaces.some((workspace) => workspace.path === bootstrap.defaultWorkspace)) {
    warn(
      'defaultWorkspace not in bootstrap.workspaces',
      `${bootstrap.defaultWorkspace} is the default workspace but is absent from the selector list; the page would open on a workspace the selector cannot show`,
    )
  }

  const picked = await pickWorkspace(bootstrap)
  if (picked === null) {
    skip('skills/instructions/mcp checks', 'no workspace is accepted by GET /skills?workspace=…')
    return { workspace: null, health }
  }
  const workspace = picked.workspace
  if (!picked.registered) {
    warn(
      'workspace not in bootstrap.workspaces',
      `${workspace} was accepted by /skills but is absent from /bootstrap.workspaces; the page would not offer it in the selector`,
    )
  }
  pass('workspace resolution', `using ${workspace} (${picked.registered ? 'registered' : 'accepted'})`)

  await checkAsync('an unregistered workspace is rejected with 400 bad_request', async () => {
    const unregistered = `/nonexistent-agent-assets-verify-${PID}`
    const { payload } = await errorJson('/skills', { params: { workspace: unregistered } }, 'bad_request')
    return `workspace=${unregistered} -> ${payload.error.code}`
  })

  // --- skills --------------------------------------------------------------------------------
  section('Skills')
  let skillsPayload = null
  const skillsOk = await checkAsync('GET /skills matches the documented shape', async () => {
    const { payload } = await okJson('/skills', { params: { workspace } })
    skillsPayload = payload
    expect(payload.counts && typeof payload.counts === 'object', 'skills.counts must be an object')
    for (const scope of ['user', 'workspace', 'bundled']) {
      expect(Number.isInteger(payload.counts[scope]), `skills.counts.${scope} must be an integer`)
    }
    expectArray(payload.skills, 'skills.skills')
    expectArray(payload.warnings, 'skills.warnings')
    const names = new Set()
    for (const [index, view] of payload.skills.entries()) {
      validateSkillView(view, `skills.skills[${index}]`)
      expect(!names.has(view.name), `skills list contains duplicate name ${view.name} (precedence merge failed)`)
      names.add(view.name)
    }
    const total = payload.counts.user + payload.counts.workspace + payload.counts.bundled
    expect(total === payload.skills.length, `counts sum ${total} does not match ${payload.skills.length} listed skills`)
    if (payload.counts.bundled === 0) {
      warn('bundled skills listing', 'counts.bundled is 0; the live skills service may be unavailable (check skills.warnings)')
    }
    if (payload.warnings.length > 0) {
      warn('skills warnings', JSON.stringify(payload.warnings.slice(0, 5)))
    }
    return `${payload.skills.length} skills (user=${payload.counts.user} workspace=${payload.counts.workspace} bundled=${payload.counts.bundled})`
  })

  if (skillsOk && skillsPayload.skills.length > 0) {
    const firstBundled = skillsPayload.skills.find((skill) => skill.scope === 'bundled')
    if (firstBundled !== undefined) {
      await checkAsync('GET /skill reads a bundled (read-only) skill', async () => {
        const { payload } = await okJson('/skill', { params: { scope: 'bundled', name: firstBundled.name, workspace } })
        expect(payload.skill && payload.skill.name === firstBundled.name, 'skill.name mismatch')
        expectType(payload.skill.body, 'string', 'skill.body')
        expectType(payload.skill.raw, 'string', 'skill.raw')
        expect(payload.skill.editable === false, 'bundled skill must not be editable')
        return `${firstBundled.name} (body ${bytesOf(payload.skill.body)} bytes)`
      })
      await checkAsync('mutating the bundled scope is rejected with bad_request', async () => {
        const { payload } = await errorJson(
          '/skill',
          { method: 'POST', body: { op: 'delete', scope: 'bundled', name: firstBundled.name, workspace } },
          'bad_request',
        )
        return `POST /skill scope=bundled -> ${payload.error.code}`
      })
    }

    await checkAsync('GET /skill for an unknown name returns 404 not_found', async () => {
      const { payload } = await errorJson(
        '/skill',
        { params: { scope: 'workspace', name: `verify-missing-${PID}`, workspace } },
        'not_found',
      )
      return `missing skill -> ${payload.error.code}`
    })

    await checkAsync('skill names cannot escape the scope root (path traversal rejected)', async () => {
      const response = await api('/skill', {
        method: 'POST',
        body: {
          op: 'create',
          scope: 'workspace',
          workspace,
          name: '../verify-escape',
          description: 'must be rejected',
          body: '',
        },
      })
      expect(response.status === 400, `expected 400, got ${response.status}`)
      expect(response.json && response.json.ok === false, 'expected { ok:false }')
      expect(
        response.json.error.code === 'bad_request',
        `expected bad_request, got ${JSON.stringify(response.json.error.code)}`,
      )
      return response.json.error.message
    })
  }

  // --- agent prompt instruction files ----------------------------------------------------------
  section('Agent prompt instruction files')
  let instructionsPayload = null
  await checkAsync('GET /instructions lists the fixed candidates and existing nested files', async () => {
    const { payload } = await okJson('/instructions', { params: { workspace } })
    instructionsPayload = payload
    expectArray(payload.files, 'instructions.files')
    expectArray(payload.warnings, 'instructions.warnings')
    for (const [index, view] of payload.files.entries()) validateInstructionView(view, `instructions.files[${index}]`)

    const userFixed = payload.files.filter((file) => file.scope === 'user' && file.file === 'AGENTS.md')
    expect(userFixed.length === 2, `expected 2 user-scope AGENTS.md candidates, got ${userFixed.length}`)
    expect(
      userFixed.some((file) => resolve(file.path) === resolve(join(health.homes.dshHome, 'AGENTS.md'))),
      `missing user candidate ${join(health.homes.dshHome, 'AGENTS.md')}`,
    )
    expect(
      userFixed.some((file) => resolve(file.path) === resolve(join(health.homes.agentsHome, 'AGENTS.md'))),
      `missing user candidate ${join(health.homes.agentsHome, 'AGENTS.md')}`,
    )

    const workspaceFixed = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
    for (const file of workspaceFixed) {
      const candidate = payload.files.find((item) => item.scope === 'workspace' && resolve(item.path) === resolve(join(workspace, file)))
      expect(candidate !== undefined, `missing workspace candidate ${join(workspace, file)}`)
      expect(candidate.file === file, `workspace candidate ${file} has file=${candidate.file}`)
    }

    const order = payload.files.map((file) => file.scope)
    const firstWorkspace = order.indexOf('workspace')
    expect(firstWorkspace >= 2, 'user candidates must precede workspace candidates')
    expect(order.slice(0, firstWorkspace).every((scope) => scope === 'user'), 'the leading candidates must all be user-scope')

    const nested = payload.files.filter(
      (file) => file.scope === 'workspace' && resolve(file.path) !== resolve(join(workspace, file.file)),
    )
    for (const file of nested) {
      expect(isInside(workspace, file.path), `nested candidate escapes the workspace: ${file.path}`)
      expect(file.displayPath.startsWith('./'), `nested candidate displayPath must start with './': ${file.displayPath}`)
    }
    const nestedPaths = nested.map((file) => file.path)
    expect(
      JSON.stringify(nestedPaths) === JSON.stringify([...nestedPaths].sort((a, b) => a.localeCompare(b))),
      'nested candidates must be sorted by path',
    )

    // `exists`/`size` for workspace candidates must match the filesystem (read-only stat).
    for (const candidate of payload.files.filter((file) => file.scope === 'workspace')) {
      const info = await statIfExists(candidate.path)
      const onDisk = info !== undefined && info.isFile()
      expect(candidate.exists === onDisk, `exists flag ${candidate.exists} != fs presence ${onDisk} for ${candidate.path}`)
      if (onDisk) expect(candidate.size === info.size, `size ${candidate.size} != fs size ${info.size} for ${candidate.path}`)
      else expect(candidate.size === 0, `missing candidate ${candidate.path} must report size 0`)
    }
    return `${payload.files.length} candidates (${userFixed.length} user, ${workspaceFixed.length} fixed workspace, ${nested.length} nested)`
  })

  if (instructionsPayload && instructionsPayload.files.length > 0) {
    await checkAsync('GET /instruction returns an existing file with its content', async () => {
      const candidate = instructionsPayload.files.find((file) => file.scope === 'workspace' && file.exists)
      if (candidate === undefined) {
        skip('GET /instruction existing file read', 'no workspace-scope instruction file exists; never touching a user-scope file')
        return 'skipped: no existing workspace candidate'
      }
      const { payload } = await okJson('/instruction', { params: { scope: 'workspace', path: candidate.path, workspace } })
      const instruction = payload.instruction
      validateInstructionView(instruction, 'instruction')
      expectType(instruction.content, 'string', 'instruction.content')
      const fsText = await readFile(candidate.path, 'utf8')
      expect(instruction.content === fsText, 'instruction.content does not match the file on disk')
      return `${candidate.label || candidate.file} (${bytesOf(instruction.content)} bytes)`
    })

    await checkAsync('GET /instruction for a missing fixed candidate is a create target, not a 404', async () => {
      const missing = instructionsPayload.files.find((file) => file.scope === 'workspace' && !file.exists)
      if (missing === undefined) return 'skipped: every workspace candidate already exists'
      const { payload } = await okJson('/instruction', { params: { scope: 'workspace', path: missing.path, workspace } })
      expect(payload.instruction.exists === false, 'missing candidate must report exists:false')
      expect(payload.instruction.content === '', 'missing candidate must report content:""')
      return `${missing.file} -> exists:false, content:""`
    })

    await checkAsync('GET /instruction rejects a non-candidate path with 403 forbidden', async () => {
      const outside = join(workspace, 'verify-not-a-candidate.md')
      const { payload } = await errorJson(
        '/instruction',
        { params: { scope: 'workspace', path: outside, workspace } },
        'forbidden',
      )
      expect(!(await exists(outside)), 'a forbidden path must not be created')
      return `path=${outside} -> ${payload.error.code}`
    })

    await checkAsync('GET /instruction rejects a candidate from the other scope', async () => {
      const workspaceCandidate = instructionsPayload.files.find((file) => file.scope === 'workspace')
      expect(workspaceCandidate !== undefined, 'missing workspace fixture')
      const { payload } = await errorJson(
        '/instruction',
        { params: { scope: 'user', path: workspaceCandidate.path, workspace } },
        'forbidden',
      )
      return `scope mismatch -> ${payload.error.code}`
    })
  }

  // --- MCP -----------------------------------------------------------------------------------
  section('MCP servers')
  let mcpPayload = null
  await checkAsync('GET /mcp matches the documented shape and does not leak secrets', async () => {
    const { payload } = await okJson('/mcp', { params: { workspace } })
    mcpPayload = payload
    expectArray(payload.servers, 'mcp.servers')
    expectArray(payload.external, 'mcp.external')
    expectArray(payload.warnings, 'mcp.warnings')
    const seen = new Set()
    for (const [index, view] of payload.servers.entries()) {
      validateMcpView(view, `mcp.servers[${index}]`)
      const key = `${view.scope}:${view.serverName}`
      expect(!seen.has(key), `duplicate MCP server row ${key}`)
      seen.add(key)
    }
    for (const [index, view] of payload.external.entries()) {
      expect(view && typeof view === 'object', `mcp.external[${index}] must be an object`)
      expectType(view.moduleName, 'string', `mcp.external[${index}].moduleName`)
      expectType(view.serverName, 'string', `mcp.external[${index}].serverName`)
      expect(view.configurable === false, `mcp.external[${index}].configurable must be false`)
    }
    return `${payload.servers.length} managed + ${payload.external.length} external server(s)`
  })

  if (mcpPayload && mcpPayload.servers.length > 0) {
    await checkAsync('GET /mcp/detail exposes the stored config for a managed server', async () => {
      const view = mcpPayload.servers[0]
      const { payload } = await okJson('/mcp/detail', { params: { scope: view.scope, serverName: view.serverName, workspace } })
      expect(payload.server && payload.server.serverName === view.serverName, 'server.serverName mismatch')
      expect(['stdio', 'streamable-http'].includes(payload.server.transport), 'server.transport is invalid')
      expect(payload.server.status && typeof payload.server.status === 'object', 'server.status must be an object')
      return `${view.scope}:${view.serverName} transport=${payload.server.transport} state=${payload.server.status.state}`
    })
  }

  await checkAsync('GET /mcp/detail for an unknown server returns 404 not_found', async () => {
    const { payload } = await errorJson(
      '/mcp/detail',
      { params: { scope: 'user', serverName: `verify_missing_${PID}`, workspace } },
      'not_found',
    )
    return `missing server -> ${payload.error.code}`
  })

  await checkAsync('invalid MCP config is rejected before any store write', async () => {
    const base = { op: 'create', scope: 'workspace', workspace }
    const cases = [
      ['bad server name', { ...base, server: { serverName: 'bad name!', transport: 'stdio', command: 'true' } }],
      ['bad transport', { ...base, server: { serverName: `verify_bad_${PID}`, transport: 'websocket' } }],
      ['stdio without command', { ...base, server: { serverName: `verify_bad_${PID}`, transport: 'stdio' } }],
      ['http without url', { ...base, server: { serverName: `verify_bad_${PID}`, transport: 'streamable-http' } }],
    ]
    const failures = []
    for (const [label, body] of cases) {
      const response = await api('/mcp', { method: 'POST', body })
      if (response.status !== 400 || !response.json || response.json.ok !== false || response.json.error.code !== 'bad_request') {
        failures.push(`${label} -> ${response.status}`)
      }
    }
    expect(failures.length === 0, `unexpected results: ${failures.join(', ')}`)
    return `${cases.length} invalid payloads -> 400 bad_request`
  })

  // --- client half served --------------------------------------------------------------------
  await checkClientHalf(manifest)

  return { workspace, health }
}

/** sha1 framing identical to `@deepseek-ai/dsh-client-modules`' artifact revision. */
function artifactRevision(info) {
  const framedHash = (domain, parts) => {
    const hash = createHash('sha1').update(domain).update('\0')
    for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
    return hash.digest('hex').slice(0, 12)
  }
  return framedHash('plugin-artifact', [String(info.mtimeMs), String(info.ctimeMs), String(info.size)])
}

/** Locate the installed client artifact of `pkgName` under a profile's node_modules. */
async function findInstalledClientPath(pkgName) {
  const profileRoots = []
  if (process.env.DSH_HOME) profileRoots.push(join(process.env.DSH_HOME, 'profiles'))
  profileRoots.push(join(homedir(), '.dsh', 'profiles'))
  for (const profiles of profileRoots) {
    let entries
    try {
      entries = await readdir(profiles, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = join(profiles, entry.name, 'node_modules', ...pkgName.split('/'), 'client.js')
      if (await exists(candidate)) return candidate
    }
  }
  return undefined
}

/** Assert the served bytes are the plugin's client half and parse as JavaScript. */
async function assertServedClientBundle(manifest, url, installedPath) {
  return checkAsync('the served client bundle registers the sidebar entry and main page', async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    expect(
      response.status === 200,
      `client bundle -> ${response.status}; the served composition may predate the current client.js (a page refresh/HMR may be pending)`,
    )
    const contentType = response.headers.get('content-type') || ''
    expect(contentType.includes('javascript'), `client bundle content-type is not javascript: ${contentType}`)
    const source = await response.text()
    expect(source.includes('__ModuleLoader__'), 'served client bundle does not use __ModuleLoader__')
    expect(
      source.includes(`id: '${manifest.name}'`) || source.includes(`id: "${manifest.name}"`),
      `served client bundle does not register id ${manifest.name}`,
    )
    expect(source.includes('sidebar.panellist'), 'served client bundle does not register sidebar.panellist')
    expect(source.includes("'main'") || source.includes('"main"'), "served client bundle does not register the 'main' slot")
    if (installedPath !== undefined) {
      const local = await readFile(installedPath, 'utf8')
      expect(source.startsWith(local), 'served bytes are not the current installed client.js (stale composition)')
    }
    try {
      // Parse only — `new Function` never executes the body.
      new Function(source)
    } catch (error) {
      throw new Error(`served client bundle is not parseable: ${error.message}`)
    }
    return `${bytesOf(source)} bytes from ${url.replace(ORIGIN, '')}`
  })
}

async function checkClientHalf(manifest) {
  section('Client half (served bundle)')
  let pageStatus = 0
  try {
    const response = await fetch(ORIGIN + '/', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    pageStatus = response.status
    await response.text()
  } catch (error) {
    fail('GET / for the client boot graph', error.message)
    return undefined
  }

  if (pageStatus === 200) {
    let entry
    const composed = await checkAsync('the client module is composed into the served boot graph', async () => {
      const response = await fetch(ORIGIN + '/', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      const html = await response.text()
      const marker = 'globalThis["__DSH_BOOT__"]'
      const at = html.indexOf(marker)
      expect(at >= 0, 'the served page has no __DSH_BOOT__ global')
      const eq = html.indexOf('=', at)
      expect(eq > at, 'malformed __DSH_BOOT__ assignment')
      const end = html.indexOf('</script>', eq)
      expect(end > eq, 'unterminated __DSH_BOOT__ script')
      const jsonText = html.slice(eq + 1, end).trim()
      let graph
      try {
        graph = JSON.parse(jsonText)
      } catch (error) {
        throw new Error(`cannot parse __DSH_BOOT__ JSON: ${error.message}`)
      }
      expect(Array.isArray(graph.entries), 'boot graph has no entries array')
      entry = graph.entries.find((row) => row && row.id === manifest.name)
      expect(entry !== undefined, `${manifest.name} is not in the client boot graph (client half missing or activation failed)`)
      expectType(entry.url, 'string', 'boot entry.url')
      expectType(entry.rev, 'string', 'boot entry.rev')
      expect(Array.isArray(entry.inject), 'boot entry.inject must be an array')
      for (const dependency of manifest.dsh?.client?.inject || []) {
        expect(entry.inject.includes(dependency), `boot entry.inject is missing declared dependency ${dependency}`)
      }
      return `${manifest.name} rev=${entry.rev} url=${entry.url}`
    })
    if (!composed) return undefined
    await assertServedClientBundle(manifest, new URL(entry.url, ORIGIN + '/').href, undefined)
    return entry
  }

  if (pageStatus !== 401 && pageStatus !== 403) {
    fail('GET / for the client boot graph', `unexpected HTTP ${pageStatus}`)
    return undefined
  }

  // The Web GUI index is behind the dsh-web browser cookie, which no shell client holds. The served
  // bundle route (`/plugins/…`) is a plain webserver prefix route, so address the artifact directly
  // with the revision client-modules derives from the installed file's stat metadata.
  skip(
    'client boot graph via GET /',
    `GET / requires the dsh-web browser cookie (HTTP ${pageStatus}); verifying the served client artifact by its computed revision instead`,
  )
  const installed = await findInstalledClientPath(manifest.name)
  if (installed === undefined) {
    skip('served client bundle', 'installed client.js not found under <DSH_HOME>/profiles/*/node_modules; cannot compute its artifact revision')
    return undefined
  }
  const info = await stat(installed)
  const url = `${ORIGIN}/plugins/??${manifest.name}/client.js&rev=${artifactRevision(info)}`
  const served = await assertServedClientBundle(manifest, url, installed)
  return served ? { id: manifest.name, url, rev: artifactRevision(info) } : undefined
}

// ---------------------------------------------------------------------------------------------
// Phase 2 — write round-trip (workspace scope only)
// ---------------------------------------------------------------------------------------------

async function writeChecks({ workspace }) {
  section('Write round-trip (workspace scope)')
  if (workspace === null) {
    skip('write round-trip', 'no accepted workspace')
    return
  }

  const skillName = `verify-${PID}`
  const skillDir = join(workspace, '.dsh', 'skills', skillName)
  const skillFile = join(skillDir, 'SKILL.md')
  const serverName = `verify_${PID}`
  const mcpStorePath = join(workspace, '.dsh', 'agent-assets', 'mcp.json')
  const mcpStoreDir = dirname(mcpStorePath)
  const marker = `agent-assets live verification ${PID} @ ${new Date().toISOString()}`

  const cleanupState = {
    workspace,
    skill: { dir: skillDir, file: skillFile },
    instruction: null, // { path, existedBefore, contentBefore }
    mcpStore: {
      path: mcpStorePath,
      textBefore: await readTextIfExists(mcpStorePath),
      dirExistedBefore: await exists(mcpStoreDir),
      rowName: serverName,
    },
  }

  try {
    // --- skill CRUD -------------------------------------------------------------------------
    section('Write: skill CRUD')
    await checkAsync('no stale verify skill exists before the run', async () => {
      expect(!(await exists(skillDir)), `leftover skill directory exists before the run: ${skillDir}`)
      return skillDir
    })

    const createBody = {
      op: 'create',
      scope: 'workspace',
      workspace,
      name: skillName,
      description: 'Live verification skill',
      whenToUse: 'Only while test/live-api.mjs runs',
      body: `# ${skillName}\n\n${marker}\n`,
    }
    await checkAsync('POST /skill create writes <workspace>/.dsh/skills/<name>/SKILL.md', async () => {
      const { payload } = await okJson('/skill', { method: 'POST', body: createBody }, 'POST /skill create')
      const skill = payload.skill
      validateSkillView(skill, 'created skill')
      expect(skill.name === skillName, `created skill name ${skill.name}`)
      expect(skill.scope === 'workspace', `created skill scope ${skill.scope}`)
      expect(skill.editable === true, 'created skill must be editable')
      expect(resolve(skill.path) === resolve(skillFile), `created skill path ${skill.path} != ${skillFile}`)
      expect(resolve(skill.dir) === resolve(skillDir), `created skill dir ${skill.dir} != ${skillDir}`)
      expect(skill.description === createBody.description, 'created skill description mismatch')
      expect(skill.whenToUse === createBody.whenToUse, 'created skill whenToUse mismatch')
      const info = await statIfExists(skillFile)
      expect(info !== undefined && info.isFile(), `SKILL.md was not created at ${skillFile}`)
      const raw = await readFile(skillFile, 'utf8')
      expect(raw.includes(createBody.description), 'SKILL.md misses the description')
      expect(raw.includes(marker), 'SKILL.md misses the body marker')
      return skillFile
    })

    await checkAsync('GET /skill round-trips the body and raw SKILL.md', async () => {
      const { payload } = await okJson('/skill', { params: { scope: 'workspace', name: skillName, workspace } })
      expect(payload.skill.body.includes(marker), 'skill.body does not contain the created body')
      expect(payload.skill.raw.includes('---'), 'skill.raw does not contain frontmatter')
      expect(payload.skill.raw.includes(`name: ${skillName}`), 'skill.raw does not contain the name')
      return `${bytesOf(payload.skill.body)} body bytes`
    })

    await checkAsync('GET /skills lists the created skill under the workspace scope', async () => {
      const { payload } = await okJson('/skills', { params: { workspace } })
      const listed = payload.skills.find((skill) => skill.name === skillName)
      expect(listed !== undefined, 'created skill is not listed')
      expect(listed.scope === 'workspace', `listed scope ${listed.scope}`)
      expect(payload.counts.workspace >= 1, 'counts.workspace must include the created skill')
      return `counts=${JSON.stringify(payload.counts)}`
    })

    await checkAsync('creating the same skill again returns 409 conflict', async () => {
      const { response, payload } = await errorJson('/skill', { method: 'POST', body: createBody }, 'conflict', 'POST /skill duplicate')
      expect(response.status === 409, `expected 409, got ${response.status}`)
      return `duplicate create -> ${payload.error.code}`
    })

    await checkAsync('POST /skill update preserves unknown frontmatter keys', async () => {
      // Inject an unknown key the UI never edits (e.g. license) and then update through the API.
      const raw = await readFile(skillFile, 'utf8')
      const withLicense = raw.replace(/^(description: .*)$/m, '$1\nlicense: MIT')
      expect(withLicense !== raw, 'could not inject the license frontmatter key')
      await writeFile(skillFile, withLicense, 'utf8')

      const updatedBody = `# ${skillName}\n\n${marker}\n\nupdated body\n`
      await okJson(
        '/skill',
        {
          method: 'POST',
          body: {
            op: 'update',
            scope: 'workspace',
            workspace,
            name: skillName,
            description: 'Updated live verification skill',
            whenToUse: null,
            body: updatedBody,
          },
        },
        'POST /skill update',
      )
      const after = await readFile(skillFile, 'utf8')
      expect(after.includes('license: MIT'), 'update dropped the unknown `license` frontmatter key')
      expect(after.includes('updated body'), 'update did not write the new body')
      const readBack = await okJson('/skill', { params: { scope: 'workspace', name: skillName, workspace } })
      expect(readBack.payload.skill.description === 'Updated live verification skill', 'GET does not reflect the update')
      expect(readBack.payload.skill.whenToUse === null, 'GET does not reflect the cleared whenToUse')
      return 'license preserved; description/body updated'
    })

    await checkAsync('POST /skill delete removes the directory and 404s afterwards', async () => {
      const { payload } = await okJson(
        '/skill',
        { method: 'POST', body: { op: 'delete', scope: 'workspace', workspace, name: skillName } },
        'POST /skill delete',
      )
      expect(payload.deleted === true, 'delete response must set deleted:true')
      expect(payload.name === skillName && payload.scope === 'workspace', 'delete response payload mismatch')
      expect(!(await exists(skillDir)), `skill directory still exists after delete: ${skillDir}`)
      await errorJson('/skill', { params: { scope: 'workspace', name: skillName, workspace } }, 'not_found')
      await errorJson(
        '/skill',
        { method: 'POST', body: { op: 'delete', scope: 'workspace', workspace, name: skillName } },
        'not_found',
      )
      cleanupState.skill = null
      return 'deleted, 404 afterwards, second delete 404s'
    })

    // --- instruction file CRUD --------------------------------------------------------------
    section('Write: agent prompt file CRUD')
    const candidatesResponse = await okJson('/instructions', { params: { workspace } })
    const fixedFiles = ['AGENTS.local.md', 'CLAUDE.local.md', 'AGENTS.md', 'CLAUDE.md']
    let chosen = null
    for (const file of fixedFiles) {
      const path = join(workspace, file)
      const candidate = candidatesResponse.payload.files.find(
        (item) => item.scope === 'workspace' && resolve(item.path) === resolve(path),
      )
      if (candidate !== undefined && candidate.exists === false) {
        chosen = candidate
        break
      }
    }
    if (chosen === null) {
      skip('instruction write round-trip', 'every fixed workspace instruction candidate already exists; refusing to touch a real file')
    } else {
      cleanupState.instruction = { path: chosen.path, existedBefore: false, contentBefore: undefined }
      const content = `# ${marker}\n\nOnly while test/live-api.mjs runs.\n`
      await checkAsync(`POST /instruction creates ${chosen.file} in the workspace`, async () => {
        const { payload } = await okJson(
          '/instruction',
          { method: 'POST', body: { op: 'write', scope: 'workspace', workspace, path: chosen.path, content } },
          'POST /instruction write',
        )
        const instruction = payload.instruction
        validateInstructionView(instruction, 'written instruction')
        expect(instruction.exists === true, 'write response must report exists:true')
        expect(instruction.content === content, 'write response content mismatch')
        expect(instruction.size === bytesOf(content), `write response size ${instruction.size} != ${bytesOf(content)}`)
        expect(resolve(instruction.path) === resolve(chosen.path), 'write response path mismatch')
        expect(await exists(chosen.path), 'instruction file was not created on disk')
        expect((await readFile(chosen.path, 'utf8')) === content, 'instruction file content mismatch on disk')
        return chosen.path
      })

      await checkAsync('GET /instruction reads the written file back', async () => {
        const { payload } = await okJson('/instruction', { params: { scope: 'workspace', path: chosen.path, workspace } })
        expect(payload.instruction.exists === true, 'exists must be true')
        expect(payload.instruction.content === content, 'content mismatch after write')
        return `${chosen.file} (${bytesOf(content)} bytes)`
      })

      await checkAsync('POST /instruction delete removes the file and 404s afterwards', async () => {
        const { payload } = await okJson(
          '/instruction',
          { method: 'POST', body: { op: 'delete', scope: 'workspace', workspace, path: chosen.path } },
          'POST /instruction delete',
        )
        expect(payload.deleted === true, 'delete response must set deleted:true')
        expect(!(await exists(chosen.path)), `instruction file still exists after delete: ${chosen.path}`)
        const readBack = await okJson('/instruction', { params: { scope: 'workspace', path: chosen.path, workspace } })
        expect(readBack.payload.instruction.exists === false, 'exists must be false after delete')
        expect(readBack.payload.instruction.content === '', 'content must be empty after delete')
        await errorJson(
          '/instruction',
          { method: 'POST', body: { op: 'delete', scope: 'workspace', workspace, path: chosen.path } },
          'not_found',
        )
        cleanupState.instruction = null
        return 'deleted, exists:false afterwards, second delete 404s'
      })
    }

    await checkAsync('POST /instruction refuses a path outside the candidate set', async () => {
      const outside = join(workspace, `verify-not-a-candidate-${PID}.md`)
      const { payload } = await errorJson(
        '/instruction',
        { method: 'POST', body: { op: 'write', scope: 'workspace', workspace, path: outside, content: 'nope' } },
        'forbidden',
        'POST /instruction outside path',
      )
      expect(!(await exists(outside)), 'forbidden write created a file')
      return `path=${outside} -> ${payload.error.code}`
    })

    // --- MCP store CRUD (disabled row; no process is spawned) --------------------------------
    section('Write: MCP store CRUD')
    const createServer = {
      serverName,
      transport: 'stdio',
      command: 'true',
      args: [],
      cwd: '',
      env: { LIVE_TEST: '1' },
      enabled: false,
    }
    await checkAsync('POST /mcp create stores a disabled workspace row', async () => {
      const { payload } = await okJson(
        '/mcp',
        { method: 'POST', body: { op: 'create', scope: 'workspace', workspace, server: createServer } },
        'POST /mcp create',
      )
      expectArray(payload.servers, 'POST /mcp servers')
      expect(
        payload.servers.every((view) => view.scope === 'workspace'),
        'POST /mcp must return the workspace scope rows',
      )
      const row = payload.servers.find((view) => view.serverName === serverName)
      expect(row !== undefined, 'created MCP row is missing from the response')
      validateMcpView(row, 'created MCP row')
      expect(row.enabled === false, 'created MCP row must stay disabled')
      expect(row.status.state === 'disabled', `created MCP row status.state ${row.status.state}`)
      const storeText = await readTextIfExists(mcpStorePath)
      expect(storeText !== undefined, `MCP store was not written at ${mcpStorePath}`)
      const store = JSON.parse(storeText)
      expect(store.version === 1, 'store version must be 1')
      expectArray(store.servers, 'store.servers')
      expect(store.servers.some((item) => item.serverName === serverName), 'store does not contain the created row')
      const info = await stat(mcpStorePath)
      if (process.platform !== 'win32') {
        expect((info.mode & 0o777) === 0o600, `store mode must be 0600, got 0${(info.mode & 0o777).toString(8)}`)
      }
      return `${mcpStorePath} (${store.servers.length} row(s))`
    })

    await checkAsync('GET /mcp and GET /mcp/detail reflect the created row', async () => {
      const list = await okJson('/mcp', { params: { workspace } })
      const row = list.payload.servers.find((view) => view.serverName === serverName)
      expect(row !== undefined, 'listed MCP rows miss the created row')
      const detail = await okJson('/mcp/detail', { params: { scope: 'workspace', serverName, workspace } })
      expect(detail.payload.server.command === 'true', 'detail misses the stored command')
      expect(detail.payload.server.enabled === false, 'detail misses the stored enabled flag')
      expect(detail.payload.server.env && detail.payload.server.env.LIVE_TEST === '1', 'detail misses the stored env value')
      return 'list + detail round-trip'
    })

    await checkAsync('POST /mcp toggle flips enabled and back', async () => {
      const on = await okJson(
        '/mcp',
        { method: 'POST', body: { op: 'toggle', scope: 'workspace', workspace, server: { serverName }, enabled: true } },
        'POST /mcp toggle on',
      )
      const enabledRow = on.payload.servers.find((view) => view.serverName === serverName)
      expect(enabledRow !== undefined && enabledRow.enabled === true, 'toggle on did not enable the row')
      expect(enabledRow.status.state === 'session-scoped', `toggle on state ${enabledRow.status.state}`)
      const off = await okJson(
        '/mcp',
        { method: 'POST', body: { op: 'toggle', scope: 'workspace', workspace, server: { serverName }, enabled: false } },
        'POST /mcp toggle off',
      )
      const disabledRow = off.payload.servers.find((view) => view.serverName === serverName)
      expect(disabledRow !== undefined && disabledRow.enabled === false, 'toggle off did not disable the row')
      return 'enabled -> disabled'
    })

    await checkAsync('POST /mcp update changes the stored args', async () => {
      await okJson(
        '/mcp',
        {
          method: 'POST',
          body: { op: 'update', scope: 'workspace', workspace, server: { serverName, transport: 'stdio', args: ['--verify'] } },
        },
        'POST /mcp update',
      )
      const detail = await okJson('/mcp/detail', { params: { scope: 'workspace', serverName, workspace } })
      expect(
        JSON.stringify(detail.payload.server.args) === JSON.stringify(['--verify']),
        `detail args ${JSON.stringify(detail.payload.server.args)}`,
      )
      return 'args updated'
    })

    await checkAsync('POST /mcp create rejects a duplicate name with 409 conflict', async () => {
      await errorJson(
        '/mcp',
        { method: 'POST', body: { op: 'create', scope: 'workspace', workspace, server: createServer } },
        'conflict',
        'POST /mcp duplicate',
      )
      return 'duplicate create -> conflict'
    })

    await checkAsync('POST /mcp delete removes the row from the store', async () => {
      await okJson(
        '/mcp',
        { method: 'POST', body: { op: 'delete', scope: 'workspace', workspace, server: { serverName } } },
        'POST /mcp delete',
      )
      const list = await okJson('/mcp', { params: { workspace } })
      expect(!list.payload.servers.some((view) => view.serverName === serverName), 'row is still listed after delete')
      await errorJson('/mcp/detail', { params: { scope: 'workspace', serverName, workspace } }, 'not_found')
      return 'deleted, list/detail absent'
    })
  } finally {
    section('Cleanup')
    await cleanup(cleanupState)
  }
}

// ---------------------------------------------------------------------------------------------
// Cleanup (always runs; a leftover is a FAIL)
// ---------------------------------------------------------------------------------------------

async function cleanup(state) {
  const leftovers = []

  // Skill: prefer the public API, then remove only a directory that carries this run's marker.
  if (state.skill !== null) {
    try {
      await api('/skill', {
        method: 'POST',
        body: { op: 'delete', scope: 'workspace', workspace: state.workspace, name: `verify-${PID}` },
      })
    } catch {
      // fall through to the filesystem safety net
    }
    const raw = await readTextIfExists(state.skill.file)
    if (raw !== undefined && raw.includes(`agent-assets live verification ${PID}`)) {
      await rm(state.skill.dir, { recursive: true, force: true })
    } else if (raw !== undefined) {
      fail('cleanup: skill directory', `refusing to delete ${state.skill.dir}: content is not this run's fixture`)
      leftovers.push(state.skill.dir)
    }
    if (await exists(state.skill.dir)) leftovers.push(state.skill.dir)
  }

  // Instruction file: only ever a file this run created (it did not exist before).
  if (state.instruction !== null) {
    if (state.instruction.existedBefore === false) {
      const text = await readTextIfExists(state.instruction.path)
      if (text === undefined) {
        // already removed through the API
      } else if (!text.includes(`agent-assets live verification ${PID}`)) {
        fail('cleanup: instruction file', `refusing to delete ${state.instruction.path}: content is not this run's fixture`)
        leftovers.push(state.instruction.path)
      } else {
        await rm(state.instruction.path, { force: true })
      }
      if (await exists(state.instruction.path)) leftovers.push(state.instruction.path)
    } else if (state.instruction.contentBefore !== undefined) {
      await writeFile(state.instruction.path, state.instruction.contentBefore, 'utf8')
    }
  }

  // MCP store: restore the exact pre-run state.
  if (state.mcpStore !== null) {
    const { path, textBefore, dirExistedBefore, rowName } = state.mcpStore
    const textAfter = await readTextIfExists(path)
    if (textBefore === undefined) {
      // This run created the store: remove it when no foreign rows remain.
      if (textAfter !== undefined) {
        let parsed = null
        try {
          parsed = JSON.parse(textAfter)
        } catch {
          parsed = null
        }
        const servers = parsed && Array.isArray(parsed.servers) ? parsed.servers : []
        const ownRow = servers.some((row) => row && row.serverName === rowName)
        const foreign = servers.filter((row) => row && row.serverName !== rowName)
        if (ownRow) {
          fail('cleanup: MCP store', `this run's row ${rowName} is still present in ${path}`)
          leftovers.push(path)
        } else if (foreign.length > 0) {
          // A concurrent writer (e.g. the Lead's live MCP verification) created its own rows in the
          // same store; the store is no longer ours to delete, but our row is gone.
          warn('cleanup: MCP store', `store ${path} retained with foreign rows: ${foreign.map((row) => row.serverName).join(', ')}`)
        } else {
          await rm(path, { force: true })
          if (!dirExistedBefore) {
            try {
              await rmdir(dirname(path))
            } catch {
              // not empty (foreign content) — leave it
            }
          }
          if (await exists(path)) leftovers.push(path)
        }
      }
    } else {
      // The store existed before: the run must have restored its server rows.
      let before = null
      let after = null
      try {
        before = JSON.parse(textBefore)
      } catch {
        before = null
      }
      try {
        after = textAfter === undefined ? null : JSON.parse(textAfter)
      } catch {
        after = null
      }
      if (before !== null && after !== null) {
        const afterServers = Array.isArray(after.servers) ? after.servers : []
        if (afterServers.some((row) => row && row.serverName === rowName)) {
          fail('cleanup: MCP store', `this run's row ${rowName} is still present in ${path}`)
          leftovers.push(path)
        } else if (JSON.stringify(before.servers ?? []) !== JSON.stringify(afterServers)) {
          // The pre-existing store was legitimately changed by a concurrent writer; our row is gone.
          warn('cleanup: MCP store', 'the pre-existing store changed during the run (concurrent writer); this run\'s row is absent')
        }
      } else if (textBefore !== textAfter) {
        fail('cleanup: MCP store', 'store content changed and could not be compared as JSON')
        leftovers.push(path)
      }
    }
  }

  if (leftovers.length === 0) pass('cleanup: zero leftovers', 'workspace returned to its pre-run state')
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main() {
  process.stdout.write('Agent Assets — live API verification\n')
  process.stdout.write(`origin:    ${ORIGIN}\n`)
  process.stdout.write(`mode:      ${WRITE ? 'read-only + --write CRUD round-trip' : 'read-only'}\n`)

  let manifest
  try {
    manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  } catch (error) {
    fail('read bundle manifest', `${MANIFEST_PATH}: ${error.message}`)
    return summarize()
  }

  const phase1 = await readOnlyChecks(manifest)
  if (WRITE) await writeChecks({ workspace: phase1.workspace })
  return summarize()
}

function summarize() {
  const counts = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 }
  for (const result of results) counts[result.status] += 1
  process.stdout.write(
    `\n${'-'.repeat(72)}\nSummary: ${counts.PASS} passed, ${counts.FAIL} failed, ${counts.WARN} warning(s), ${counts.SKIP} skipped\n`,
  )
  if (counts.FAIL > 0) {
    process.stdout.write('RESULT: FAIL\n')
    for (const result of results.filter((item) => item.status === 'FAIL')) {
      process.stdout.write(`  - ${result.name}: ${result.detail}\n`)
    }
    return 1
  }
  process.stdout.write('RESULT: PASS\n')
  return 0
}

let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  fail('unhandled verification error', error instanceof Error ? error.stack || error.message : String(error))
  exitCode = summarize()
}
process.exit(exitCode)
