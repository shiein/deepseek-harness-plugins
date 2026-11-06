/**
 * Agent-prompt instruction-file discovery and CRUD for the Agent Assets Host module.
 *
 * The editable set is fixed: two user-global `AGENTS.md` files, four workspace
 * candidates, plus nested `AGENTS.md` / `CLAUDE.md` files that already exist up to
 * depth 2 under the workspace. Anything else is rejected with `forbidden` before a
 * single byte is read or written, and every candidate is checked against its root
 * with `realpath` so a symlink cannot redirect IO outside the allowed tree.
 */

import { join, relative, resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import {
  displayPath,
  fail,
  isInside,
  listDirSafe,
  pathKey,
  readTextIfExists,
  removeTree,
  resolveHomes,
  statIfExists,
  writeTextAtomic,
} from './shared.js'

/** User-global instruction files: `<dshHome>/AGENTS.md`, `<agentsHome>/AGENTS.md`. */
const USER_INSTRUCTION_FILES = Object.freeze(['AGENTS.md'])

/** Fixed workspace-scope candidates, in display order. */
const WORKSPACE_INSTRUCTION_FILES = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
  'AGENTS.local.md',
  'CLAUDE.local.md',
])

/** File names discovered in already-existing nested workspace directories. */
const NESTED_INSTRUCTION_FILES = Object.freeze(['AGENTS.md', 'CLAUDE.md'])

/** Directories never scanned for nested instruction files. */
const NESTED_SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'target',
  'vendor',
])

/** Maximum nested directory depth (workspace root = 0). */
const NESTED_MAX_DEPTH = 2

/**
 * Create the instruction-file API.
 *
 * @param {{ homes?: { dshHome: string, agentsHome: string } }} [options]
 */
export function createInstructions(options = {}) {
  const fallbackHomes = resolveHomes()
  const homes = {
    dshHome:
      typeof options.homes?.dshHome === 'string' && options.homes.dshHome.trim() !== ''
        ? resolve(options.homes.dshHome)
        : fallbackHomes.dshHome,
    agentsHome:
      typeof options.homes?.agentsHome === 'string' && options.homes.agentsHome.trim() !== ''
        ? resolve(options.homes.agentsHome)
        : fallbackHomes.agentsHome,
  }

  /**
   * Enumerate every allowed instruction-file candidate for one workspace.
   *
   * @returns {Promise<Array<{
   *   scope: 'user' | 'workspace', baseRoot: string, path: string, file: string,
   *   label: string, displayPath: string }>>}
   */
  async function enumerate(workspace, warnings) {
    const candidates = []
    const seen = new Set()
    const push = (candidate) => {
      const key = `${candidate.scope}\u0000${pathKey(candidate.path)}`
      if (seen.has(key)) return
      seen.add(key)
      candidates.push(candidate)
    }

    // 1. User-global files.
    for (const home of [homes.dshHome, homes.agentsHome]) {
      for (const file of USER_INSTRUCTION_FILES) {
        const path = join(home, file)
        const shown = displayPath(path)
        push({ scope: 'user', baseRoot: home, path, file, label: shown, displayPath: shown })
      }
    }

    // 2. Fixed workspace candidates.
    for (const file of WORKSPACE_INSTRUCTION_FILES) {
      const path = join(workspace, file)
      push({
        scope: 'workspace',
        baseRoot: workspace,
        path,
        file,
        label: file,
        displayPath: `./${file}`,
      })
    }

    // 3. Nested files that already exist (depth <= 2), sorted by path.
    const nested = await findNested(workspace, warnings)
    nested.sort((left, right) => left.path.localeCompare(right.path))
    for (const item of nested) {
      push({
        scope: 'workspace',
        baseRoot: workspace,
        path: item.path,
        file: item.file,
        label: item.relativePath,
        displayPath: `./${item.relativePath}`,
      })
    }

    return candidates
  }

  /** Depth-limited scan for existing nested AGENTS.md / CLAUDE.md files. */
  async function findNested(workspace, warnings) {
    const found = []
    const visit = async (directory, depth) => {
      let children
      try {
        children = await listDirSafe(directory)
      } catch (error) {
        warnings.push(`cannot list ${displayPath(directory)}: ${errorMessage(error)}`)
        return
      }
      for (const child of children) {
        if (!child.isDirectory) continue
        if (NESTED_SKIP_DIRECTORIES.has(child.name)) continue
        for (const file of NESTED_INSTRUCTION_FILES) {
          const path = join(child.path, file)
          const info = await statIfExists(path)
          if (info === undefined || !info.isFile()) continue
          found.push({
            path,
            file,
            relativePath: relative(workspace, path).split(sep).join('/'),
          })
        }
        if (depth < NESTED_MAX_DEPTH) await visit(child.path, depth + 1)
      }
    }
    await visit(workspace, 1)
    return found
  }

  /** Resolve the `path` argument to one enumerated candidate, or throw `forbidden`. */
  async function resolveCandidate(input) {
    const scope = input.scope
    if (scope !== 'user' && scope !== 'workspace') {
      fail('bad_request', `unknown instruction scope: ${String(scope)}`, 400)
    }
    const workspace = resolveWorkspace(input.workspace)
    if (typeof input.path !== 'string' || input.path.trim() === '') {
      fail('bad_request', 'path is required', 400)
    }
    const warnings = []
    const candidates = await enumerate(workspace, warnings)
    const wanted = pathKey(input.path)
    const candidate = candidates.find(
      (item) => item.scope === scope && pathKey(item.path) === wanted,
    )
    if (candidate === undefined) {
      fail('forbidden', `instruction file is not an allowed candidate: ${input.path}`, 403)
    }
    return candidate
  }

  /**
   * Reject a candidate that resolves outside its root (symlink escape), and
   * refuse a lexically out-of-root path outright.
   */
  async function assertCandidateInside(candidate) {
    if (!isInside(candidate.baseRoot, candidate.path)) {
      fail('forbidden', `instruction path is outside its root: ${candidate.path}`, 403)
    }
    const info = await statIfExists(candidate.path)
    if (info === undefined) return
    const realBase = await realPathOrFallback(candidate.baseRoot)
    const realTarget = await realPathOrFallback(candidate.path)
    if (!isInside(realBase, realTarget)) {
      fail('forbidden', `instruction path resolves outside its root: ${candidate.path}`, 403)
    }
  }

  /** Build the `InstructionView` for a candidate (without file content). */
  async function describeCandidate(candidate) {
    const info = await statIfExists(candidate.path)
    const exists = info !== undefined && info.isFile()
    return {
      id: `${candidate.scope}|${candidate.path}`,
      scope: candidate.scope,
      file: candidate.file,
      label: candidate.label,
      path: candidate.path,
      displayPath: candidate.displayPath,
      editable: true,
      exists,
      size: exists ? info.size : 0,
      modifiedAt: exists ? info.mtime.toISOString() : null,
    }
  }

  return {
    /** List all candidates (fixed + nested), with `exists` metadata. */
    async list(input = {}) {
      const workspace = resolveWorkspace(input.workspace)
      const warnings = []
      const candidates = await enumerate(workspace, warnings)
      const files = []
      for (const candidate of candidates) files.push(await describeCandidate(candidate))
      return { files, warnings }
    },

    /** Read one candidate; a missing file is `{ exists: false, content: '' }`, never 404. */
    async read(input = {}) {
      const candidate = await resolveCandidate(input)
      await assertCandidateInside(candidate)
      let content
      try {
        content = await readTextIfExists(candidate.path)
      } catch (error) {
        fail('forbidden', `cannot read instruction file: ${errorMessage(error)}`, 403)
      }
      const view = await describeCandidate(candidate)
      return { instruction: { ...view, content: content ?? '' } }
    },

    /** Write (atomically, creating parents) one candidate file. */
    async write(input = {}) {
      const candidate = await resolveCandidate(input)
      await assertCandidateInside(candidate)
      const content = input.content
      if (typeof content !== 'string') fail('bad_request', 'content must be a string', 400)
      const info = await statIfExists(candidate.path)
      if (info !== undefined && info.isDirectory()) {
        fail('bad_request', 'instruction path is a directory', 400)
      }
      try {
        await writeTextAtomic(candidate.path, content)
      } catch (error) {
        fail('internal', `cannot write instruction file: ${errorMessage(error)}`, 500)
      }
      let view = await describeCandidate(candidate)
      if (!view.exists) {
        view = {
          ...view,
          exists: true,
          size: Buffer.byteLength(content, 'utf8'),
          modifiedAt: new Date().toISOString(),
        }
      }
      return { instruction: { ...view, content } }
    },

    /** Delete one candidate file; 404 when it does not exist. */
    async remove(input = {}) {
      const candidate = await resolveCandidate(input)
      await assertCandidateInside(candidate)
      const info = await statIfExists(candidate.path)
      if (info === undefined) {
        fail('not_found', `instruction file not found: ${candidate.path}`, 404)
      }
      if (info.isDirectory()) fail('bad_request', 'instruction path is a directory', 400)
      try {
        await removeTree(candidate.path)
      } catch (error) {
        fail('internal', `cannot delete instruction file: ${errorMessage(error)}`, 500)
      }
      return { deleted: true }
    },
  }
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

/** Resolve the workspace argument, defaulting to the process working directory. */
function resolveWorkspace(value) {
  if (value === undefined || value === null || value === '') return process.cwd()
  if (typeof value !== 'string') fail('bad_request', 'workspace must be a filesystem path', 400)
  return resolve(value)
}

/** `realpath` that falls back to the input for paths that do not exist yet. */
async function realPathOrFallback(path) {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/** Translate an unknown thrown value into a short message. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
