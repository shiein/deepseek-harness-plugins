/**
 * Shared filesystem, validation and SKILL.md helpers for the Agent Assets Host modules.
 *
 * Lead-owned. Consumers: host/skills.js, host/instructions.js, host/mcp.js, index.js.
 * Ask the Lead for additions instead of editing this file (one writer per file).
 */

import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

/** Error carrying an API error code and HTTP status. */
export class AssetsError extends Error {
  /**
   * @param {string} code stable machine code, e.g. `bad_request`
   * @param {string} message short English diagnostic
   * @param {number} [status] HTTP status
   */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'AssetsError'
    this.code = code
    this.status = status
  }
}

/** Stable API error codes. */
export const ERROR_CODES = Object.freeze({
  badRequest: 'bad_request',
  notFound: 'not_found',
  conflict: 'conflict',
  forbidden: 'forbidden',
  internal: 'internal',
})

/** Throw an {@link AssetsError}. */
export function fail(code, message, status = 400) {
  throw new AssetsError(code, message, status)
}

/** Recognized asset scopes. */
export const SCOPES = Object.freeze(['user', 'workspace', 'bundled'])

/** Validate a scope value; `bundled` is display-only and rejected by mutating callers themselves. */
export function assertScope(scope) {
  if (typeof scope !== 'string' || !SCOPES.includes(scope)) {
    fail('bad_request', `unknown scope: ${String(scope)}`, 400)
  }
  return scope
}

/** Kebab-case skill name contract. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Validate a skill directory name. */
export function assertSkillName(name) {
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
    fail('bad_request', 'skill name must be kebab-case ([a-z0-9-], max 64 chars)', 400)
  }
  return name
}

/**
 * Resolved user-data homes, matching the Harness home-path rules.
 *
 * `claudeHome` / `windsurfHome` / `devinHome` locate third-party agent config
 * directories (e.g. Claude Code, Windsurf, Devin). Assets living under them are
 * exposed read-only: they are owned by those agents, not by the Harness.
 */
export function resolveHomes(env = process.env) {
  const dshEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const agentsEnv = typeof env.DSH_AGENTS_HOME === 'string' ? env.DSH_AGENTS_HOME.trim() : ''
  const claudeEnv = typeof env.DSH_CLAUDE_HOME === 'string' ? env.DSH_CLAUDE_HOME.trim() : ''
  const windsurfEnv = typeof env.DSH_WINDSURF_HOME === 'string' ? env.DSH_WINDSURF_HOME.trim() : ''
  const devinEnv = typeof env.DSH_DEVIN_HOME === 'string' ? env.DSH_DEVIN_HOME.trim() : ''
  return {
    dshHome: dshEnv.length > 0 ? resolve(dshEnv) : join(homedir(), '.dsh'),
    agentsHome: agentsEnv.length > 0 ? resolve(agentsEnv) : join(homedir(), '.agents'),
    claudeHome: claudeEnv.length > 0 ? resolve(claudeEnv) : join(homedir(), '.claude'),
    windsurfHome:
      windsurfEnv.length > 0 ? resolve(windsurfEnv) : join(homedir(), '.codeium', 'windsurf'),
    devinHome: devinEnv.length > 0 ? resolve(devinEnv) : join(homedir(), '.devin'),
  }
}

/** Replace the user's home prefix with `~` for display. */
export function displayPath(path) {
  const home = homedir()
  if (!path.startsWith(home + sep) && path !== home) return path
  return '~' + path.slice(home.length)
}

/** Normalize a path for prefix comparisons. */
export function pathKey(path) {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** True when `child` equals `parent` or lives below it (no symlink resolution). */
export function isInside(parent, child) {
  const p = pathKey(parent)
  const c = pathKey(child)
  return c === p || c.startsWith(p + sep)
}

/** True when the entry is a real directory (symlinks to dirs count). */
export async function isDirectory(path) {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

/** Read a text file, or return `undefined` when it does not exist. */
export async function readTextIfExists(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    if (error && error.code === 'EISDIR') return undefined
    throw error
  }
}

/** Stat a path without throwing on absence. */
export async function statIfExists(path) {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

/** Create a directory recursively. */
export async function ensureDir(path) {
  await mkdir(path, { recursive: true })
}

/**
 * Write a file atomically (temp file in the same directory + rename). Without a `mode` an existing
 * file keeps its permissions.
 *
 * rename replaces a symlink with a regular file, which is the safe default for plugin-owned stores.
 * `followLink` writes through it instead, so `CLAUDE.md -> AGENTS.md` stays one file; only pass it
 * after checking that the link's real path is allowed.
 */
export async function writeTextAtomic(path, text, mode, { followLink = false } = {}) {
  const target = followLink ? await realpath(path).catch(() => path) : path
  await ensureDir(dirname(target))
  const existing = mode === undefined ? await statIfExists(target) : undefined
  const finalMode = mode ?? (existing?.isFile() ? existing.mode & 0o777 : undefined)
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(temporary, text, 'utf8')
    if (finalMode !== undefined) await chmod(temporary, finalMode)
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/** Remove a file or directory tree, tolerating absence. */
export async function removeTree(path) {
  await rm(path, { recursive: true, force: true })
}

/** List a directory into `{ name, path, isDirectory }`; absence yields `[]`. */
export async function listDirSafe(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => ({
        name: entry.name,
        path: join(path, entry.name),
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return []
    throw error
  }
}

/**
 * Parse a SKILL.md file into frontmatter values, untouched extra frontmatter lines, and body.
 *
 * Minimal YAML subset: top-level `key: value` pairs between `---` fences. Quoted and plain scalars
 * are accepted; unknown keys are preserved verbatim so an edit never destroys metadata such as
 * `license`. When no frontmatter exists, `data.name` is empty and the caller derives it.
 *
 * @param {string} raw full file text
 * @returns {{ data: Record<string, string>, extraLines: string[], body: string, hasFrontmatter: boolean }}
 */
export function parseSkillFile(raw) {
  const text = typeof raw === 'string' ? raw : ''
  if (!text.startsWith('---')) {
    return { data: {}, extraLines: [], body: text, hasFrontmatter: false }
  }
  const lines = text.split(/\r?\n/)
  if (lines[0].trim() !== '---') {
    return { data: {}, extraLines: [], body: text, hasFrontmatter: false }
  }
  let closing = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      closing = index
      break
    }
  }
  if (closing < 0) {
    return { data: {}, extraLines: [], body: text, hasFrontmatter: false }
  }
  const data = {}
  const extraLines = []
  const known = new Set(['name', 'description', 'whenToUse', 'when_to_use', 'when-to-use'])
  const front = lines.slice(1, closing)
  for (let index = 0; index < front.length; index += 1) {
    const line = front[index]
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) {
      extraLines.push(line)
      continue
    }
    // A top-level key owns every following indented (or blank-then-indented) line: block scalars
    // (`|`, `>-`, …), folded plain/quoted continuations and nested maps all live there.
    let end = index + 1
    while (end < front.length) {
      const next = front[end]
      if (/^\s+\S/.test(next)) {
        end += 1
        continue
      }
      if (next.trim() === '') {
        let probe = end + 1
        while (probe < front.length && front[probe].trim() === '') probe += 1
        if (probe < front.length && /^\s+\S/.test(front[probe])) {
          end = probe
          continue
        }
      }
      break
    }
    const continuation = front.slice(index + 1, end)
    index = end - 1
    const key = match[1]
    if (!known.has(key)) {
      extraLines.push(line, ...continuation)
      continue
    }
    const value = readScalar(match[2], continuation)
    data[key === 'whenToUse' || key === 'when_to_use' || key === 'when-to-use' ? 'whenToUse' : key] = value
  }
  return {
    data,
    extraLines,
    body: lines.slice(closing + 1).join('\n'),
    hasFrontmatter: true,
  }
}

/**
 * Read one scalar value from its header text plus its indented continuation lines.
 * Supports block scalars (`|`, `>`, with `-`/`+` chomping and an optional indent digit) and
 * multi-line plain / quoted scalars (folded with single spaces, blank line = newline).
 */
function readScalar(head, continuation) {
  const header = head.trim()
  const block = /^([|>])([+-]?)(\d?)([+-]?)\s*(#.*)?$/.exec(header)
  if (block !== null) {
    const folded = block[1] === '>'
    const nonEmpty = continuation.filter((item) => item.trim() !== '')
    const indent = block[3]
      ? Number(block[3])
      : nonEmpty.reduce((min, item) => Math.min(min, item.length - item.trimStart().length), Infinity)
    const body = continuation.map((item) => (item.trim() === '' ? '' : item.slice(Number.isFinite(indent) ? indent : 0)))
    if (!folded) return body.join('\n').replace(/\s+$/, '')
    let out = ''
    for (const item of body) {
      if (item === '') out += '\n'
      else if (out === '' || out.endsWith('\n')) out += item
      else out += ` ${item}`
    }
    return out.replace(/\s+$/, '')
  }
  if (continuation.length === 0) return unquoteScalar(header)
  let joined = header
  for (const item of continuation) {
    const text = item.trim()
    if (text === '') joined += '\n'
    else joined += joined === '' || joined.endsWith('\n') ? text : ` ${text}`
  }
  return unquoteScalar(joined)
}

/** Double-quoted escapes `quoteScalar` can emit (it uses JSON.stringify). */
const DOUBLE_QUOTED_ESCAPES = Object.freeze({
  n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/',
})

/**
 * Strip matching surrounding quotes from a YAML scalar and unescape it. Double-quoted text is
 * decoded in one left-to-right pass, so the `\n` inside an escaped `\\new` stays literal text.
 * Escapes outside that table are kept as written.
 */
function unquoteScalar(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed
      .slice(1, -1)
      .replace(/\\(u[0-9a-fA-F]{4}|[ntrbf"\\/])/g, (_, escape) =>
        escape.length === 5 ? String.fromCharCode(Number.parseInt(escape.slice(1), 16)) : DOUBLE_QUOTED_ESCAPES[escape])
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

/** Quote a scalar for the frontmatter when needed. */
function quoteScalar(value) {
  const text = String(value ?? '')
  if (text.includes('\n')) return JSON.stringify(text)
  if (/^[A-Za-z0-9_\-./ ]+$/.test(text) && !text.startsWith(' ') && !text.endsWith(' ')) {
    // Plain is fine unless it could be read as a number/bool/null or contains `: `.
    if (!/^(true|false|null|~|-?\d+(\.\d+)?)$/is.test(text) && !text.includes(': ')) return text
  }
  return JSON.stringify(text)
}

/**
 * Render a SKILL.md file.
 *
 * @param {{ data: Record<string, string|undefined>, extraLines?: string[], body: string }} input
 * @returns {string}
 */
export function renderSkillFile(input) {
  const data = input.data ?? {}
  const lines = ['---', `name: ${quoteScalar(data.name)}`, `description: ${quoteScalar(data.description)}`]
  if (typeof data.whenToUse === 'string' && data.whenToUse.trim() !== '') {
    lines.push(`whenToUse: ${quoteScalar(data.whenToUse.trim())}`)
  }
  for (const line of input.extraLines ?? []) lines.push(line)
  lines.push('---', '')
  const body = typeof input.body === 'string' ? input.body : ''
  return `${lines.join('\n')}${body.replace(/^\n+/, '')}`
}

/** Response headers shared by every JSON route. */
export const ENVELOPE_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
})

/** Convert an arbitrary thrown value into `{ code, message, status }`. */
export function toErrorPayload(error) {
  if (error instanceof AssetsError) {
    return { code: error.code, message: error.message, status: error.status }
  }
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    status: 500,
  }
}
