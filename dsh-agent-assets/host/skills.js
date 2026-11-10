/**
 * Skill discovery and CRUD for the Agent Assets Host module.
 *
 * Writable filesystem roots are scanned in Harness precedence order:
 * `project-dsh` > `project-agents` > `user-dsh` > `user-agents`. Third-party
 * agent directories (`user-claude` / `user-windsurf` / `user-devin`, e.g.
 * `~/.claude/skills`) are scanned last as read-only sources: they are listed
 * for visibility but never accept writes. Read-only provider entries
 * (`bundled` / `runtime` / `custom`) arrive from the live `skills` service
 * through the `serviceSkills` callback supplied by `index.js`.
 *
 * Every mutation re-validates its target: the skill name is kebab-only, the
 * resolved directory must stay inside its scope root, and `realpath` is checked
 * so neither `..` nor a symlink can escape a root.
 */

import { basename, join, relative, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import {
  assertScope,
  assertSkillName,
  assertUnchangedSince,
  displayPath,
  fail,
  isInside,
  listDirSafe,
  matchLineEndings,
  parseSkillFile,
  readTextIfExists,
  removeTree,
  renderSkillFile,
  resolveHomes,
  statIfExists,
  writeTextAtomic,
} from './shared.js'
import { describePackages, expandSource, installPackage, openSource } from './skill-import.js'

/** Filesystem skill sources, highest precedence first. */
const FILESYSTEM_SOURCES = Object.freeze([
  'project-dsh',
  'project-agents',
  'user-dsh',
  'user-agents',
  'user-claude',
  'user-windsurf',
  'user-devin',
])

/** Service entries that are already covered by the filesystem scan. */
const FILESYSTEM_SOURCE_SET = new Set(FILESYSTEM_SOURCES)

const DESCRIPTION_MAX_LENGTH = 1024

/**
 * Create the skills API.
 *
 * @param {{ homes?: { dshHome: string, agentsHome: string, claudeHome: string,
 *           windsurfHome: string, devinHome: string },
 *           serviceSkills?: (input: { workspace: string }) =>
 *             Promise<ReadonlyArray<{ name: string, description?: string, whenToUse?: string,
 *               source?: string, provider?: string }> | null> }} [options]
 */
export function createSkills(options = {}) {
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
    claudeHome:
      typeof options.homes?.claudeHome === 'string' && options.homes.claudeHome.trim() !== ''
        ? resolve(options.homes.claudeHome)
        : fallbackHomes.claudeHome,
    windsurfHome:
      typeof options.homes?.windsurfHome === 'string' && options.homes.windsurfHome.trim() !== ''
        ? resolve(options.homes.windsurfHome)
        : fallbackHomes.windsurfHome,
    devinHome:
      typeof options.homes?.devinHome === 'string' && options.homes.devinHome.trim() !== ''
        ? resolve(options.homes.devinHome)
        : fallbackHomes.devinHome,
  }
  const serviceSkills = typeof options.serviceSkills === 'function' ? options.serviceSkills : null

  /**
   * Ordered filesystem roots for a workspace.
   *
   * @param {string} workspace absolute workspace path
   */
  function rootDefinitions(workspace) {
    return [
      { source: 'project-dsh', scope: 'workspace', path: join(workspace, '.dsh', 'skills') },
      { source: 'project-agents', scope: 'workspace', path: join(workspace, '.agents', 'skills') },
      { source: 'user-dsh', scope: 'user', path: join(homes.dshHome, 'skills') },
      { source: 'user-agents', scope: 'user', path: join(homes.agentsHome, 'skills') },
      {
        source: 'user-claude',
        scope: 'user',
        path: join(homes.claudeHome, 'skills'),
        readonly: true,
      },
      {
        source: 'user-windsurf',
        scope: 'user',
        path: join(homes.windsurfHome, 'skills'),
        readonly: true,
      },
      {
        source: 'user-devin',
        scope: 'user',
        path: join(homes.devinHome, 'skills'),
        readonly: true,
      },
    ]
  }

  /** Roots writable for one API scope, highest precedence first. */
  function scopeRoots(scope, workspace) {
    const roots = rootDefinitions(workspace).filter(
      (root) => root.scope === scope && root.readonly !== true,
    )
    if (roots.length === 0) fail('bad_request', `unknown skill scope: ${String(scope)}`, 400)
    return roots
  }

  /** Read-only third-party roots for one scope; used to explain mutation refusals. */
  function readonlyRoots(scope, workspace) {
    return rootDefinitions(workspace).filter(
      (root) => root.scope === scope && root.readonly === true,
    )
  }

  /**
   * Scan every filesystem root (writable and read-only). Never throws for
   * unreadable/corrupt entries; each problem is recorded in `warnings` and the
   * remaining skills still list.
   */
  async function scanFilesystem(workspace, warnings) {
    const entries = []
    for (const definition of rootDefinitions(workspace)) {
      const rootReal = await realPathOrFallback(definition.path)
      let children
      try {
        children = await listDirSafe(definition.path)
      } catch (error) {
        warnings.push(`cannot list ${displayPath(definition.path)}: ${errorMessage(error)}`)
        continue
      }
      for (const child of children) {
        const info = await statIfExists(child.path)
        if (info === undefined || !info.isDirectory()) continue
        const directoryReal = await realPathOrFallback(child.path)
        // A user-scope link (e.g. ~/.agents/skills/x -> ~/src/x) is the user's own set-up: list it
        // read-only, its SKILL.md fenced to the link's target. A workspace-scope link arrives with a
        // cloned repository and may point anywhere, so it stays skipped.
        const linked = !isInside(rootReal, directoryReal) && definition.scope === 'user'
        if (!isInside(rootReal, directoryReal) && !linked) {
          warnings.push(
            `skipped ${displayPath(child.path)}: resolves outside ${displayPath(definition.path)}`,
          )
          continue
        }
        const fenceReal = linked ? directoryReal : rootReal
        const skillFile = join(child.path, 'SKILL.md')
        /** @type {Record<string, unknown>} */
        const entry = {
          name: child.name,
          description: '',
          whenToUse: null,
          scope: definition.scope,
          source: definition.source,
          provider: 'filesystem',
          path: skillFile,
          dir: child.path,
          root: definition.path,
          editable: definition.readonly !== true && !linked,
          ...(linked ? { linkTarget: directoryReal } : {}),
        }
        const skillFileReal = await realPathOrFallback(skillFile)
        if (!isInside(fenceReal, skillFileReal)) {
          warnings.push(
            `skipped ${displayPath(skillFile)}: resolves outside ${displayPath(definition.path)}`,
          )
          entries.push(entry)
          continue
        }
        let raw
        try {
          raw = await readTextIfExists(skillFile)
        } catch (error) {
          warnings.push(`cannot read ${displayPath(skillFile)}: ${errorMessage(error)}`)
          entries.push(entry)
          continue
        }
        if (raw === undefined) {
          warnings.push(`${displayPath(skillFile)} is missing`)
          entries.push(entry)
          continue
        }
        const parsed = parseSkillFile(raw)
        if (typeof parsed.data.description === 'string') entry.description = parsed.data.description
        if (typeof parsed.data.whenToUse === 'string' && parsed.data.whenToUse.trim() !== '') {
          entry.whenToUse = parsed.data.whenToUse.trim()
        }
        if (String(entry.description).trim() === '') {
          warnings.push(`${displayPath(skillFile)} has no description`)
        }
        entries.push(entry)
      }
    }
    return entries
  }

  /** Read read-only provider entries from the live skills service. */
  async function scanService(workspace, warnings) {
    if (serviceSkills === null) return []
    let provided
    try {
      provided = await serviceSkills({ workspace })
    } catch (error) {
      warnings.push(`skills service unavailable: ${errorMessage(error)}`)
      return []
    }
    if (provided === null || provided === undefined) {
      // `null` means the live Harness skills service is unavailable: list only
      // filesystem skills, but tell the Client that bundled entries are missing.
      warnings.push('skills service unavailable: bundled skills are not listed')
      return []
    }
    if (!Array.isArray(provided)) {
      warnings.push('skills service returned an unexpected value')
      return []
    }
    const entries = []
    for (const item of provided) {
      if (item === null || typeof item !== 'object') {
        warnings.push('skills service entry without a name was skipped')
        continue
      }
      const name = typeof item.name === 'string' ? item.name : ''
      if (name === '') {
        warnings.push('skills service entry without a name was skipped')
        continue
      }
      const source =
        typeof item.source === 'string' && item.source.trim() !== '' ? item.source.trim() : 'bundled'
      // Filesystem sources are scanned directly; skip the service mirror copies.
      if (FILESYSTEM_SOURCE_SET.has(source)) continue
      entries.push({
        name,
        description: typeof item.description === 'string' ? item.description : '',
        whenToUse:
          typeof item.whenToUse === 'string' && item.whenToUse.trim() !== ''
            ? item.whenToUse.trim()
            : null,
        scope: 'bundled',
        source,
        provider:
          typeof item.provider === 'string' && item.provider.trim() !== ''
            ? item.provider.trim()
            : source,
        path: null,
        dir: null,
        editable: false,
      })
    }
    return entries
  }

  /** Collect filesystem + service entries and warnings for one workspace. */
  async function collect(workspace) {
    const warnings = []
    const filesystem = await scanFilesystem(workspace, warnings)
    const service = await scanService(workspace, warnings)
    return { filesystem, service, warnings }
  }

  return {
    /** List every visible skill, grouping duplicate names into `shadowed`. */
    async list(input = {}) {
      const workspace = resolveWorkspace(input.workspace)
      const { filesystem, service, warnings } = await collect(workspace)
      const merged = mergeEntries(filesystem, service)
      const counts = { user: 0, workspace: 0, bundled: 0 }
      const skills = []
      for (const { entry, shadowed } of merged.values()) {
        const view = toView(entry, shadowed)
        skills.push(view)
        if (counts[view.scope] !== undefined) counts[view.scope] += 1
      }
      return { skills, counts, warnings }
    },

    /** Read one skill including its markdown body and raw SKILL.md. */
    async read(input = {}) {
      const scope = assertScope(input.scope)
      // Reads never build a path from the name (the scan supplies it), so a
      // directory that predates the kebab contract can still be opened; only a
      // non-empty string is required here. Mutations stay strict.
      const name = input.name
      if (typeof name !== 'string' || name === '') fail('bad_request', 'name is required', 400)
      const workspace = resolveWorkspace(input.workspace)
      const { filesystem, service } = await collect(workspace)
      const merged = mergeEntries(filesystem, service)
      const winner = merged.get(name)
      const all = [...filesystem, ...service]
      const target =
        winner !== undefined && winner.entry.scope === scope
          ? winner
          : { entry: all.find((entry) => entry.name === name && entry.scope === scope), shadowed: [] }
      if (target.entry === undefined) {
        fail('not_found', `skill not found: ${scope}/${name}`, 404)
      }
      const content = await loadSkillContent(target.entry)
      return { skill: { ...toView(target.entry, target.shadowed), ...content } }
    },

    /** Create `<primary writable root>/<name>/SKILL.md`. */
    async create(input = {}) {
      const scope = assertScope(input.scope)
      rejectBundledMutation(scope, 'create')
      const name = assertSkillName(input.name)
      const workspace = resolveWorkspace(input.workspace)
      const description = assertDescription(input.description)
      const whenToUse = normalizeWhenToUse(input.whenToUse)
      const body = normalizeBody(input.body)
      const roots = scopeRoots(scope, workspace)
      for (const root of roots) {
        const existing = await statIfExists(join(root.path, name))
        if (existing !== undefined) {
          fail('conflict', `skill already exists: ${scope}/${name}`, 409)
        }
      }
      const root = roots[0]
      const directory = join(root.path, name)
      assertLexicalInside(root.path, directory, `skill path is outside its root: ${directory}`)
      const skillFile = join(directory, 'SKILL.md')
      const text = renderSkillFile({
        data: { name, description, whenToUse: whenToUse ?? undefined },
        extraLines: [],
        body,
      })
      try {
        await writeTextAtomic(skillFile, text)
      } catch (error) {
        fail('internal', `cannot write skill file: ${errorMessage(error)}`, 500)
      }
      const entry = {
        name,
        description,
        whenToUse: whenToUse ?? null,
        scope,
        source: root.source,
        provider: 'filesystem',
        path: skillFile,
        dir: directory,
        root: root.path,
        editable: true,
      }
      const shadowed = await shadowedFor(workspace, name, directory)
      return { skill: toView(entry, shadowed) }
    },

    /** Rewrite an existing SKILL.md, preserving unknown frontmatter lines. */
    async update(input = {}) {
      const scope = assertScope(input.scope)
      rejectBundledMutation(scope, 'update')
      const name = assertSkillName(input.name)
      const workspace = resolveWorkspace(input.workspace)
      const located = await locate(scopeRoots(scope, workspace), name)
      if (located === undefined) {
        await refuseIfLinked(scope, workspace, name, 'update')
        await refuseIfReadonly(scope, workspace, name, 'update')
        fail('not_found', `skill not found: ${scope}/${name}`, 404)
      }
      const { root, directory } = located
      const skillFile = join(directory, 'SKILL.md')
      await assertRealInside(root.path, directory, 'skill directory resolves outside its root')
      await assertRealInside(root.path, skillFile, 'skill file resolves outside its root')
      assertUnchangedSince(await statIfExists(skillFile), input.expectedModifiedAt)
      let raw
      try {
        raw = await readTextIfExists(skillFile)
      } catch (error) {
        fail('forbidden', `cannot read skill file: ${errorMessage(error)}`, 403)
      }
      const parsed =
        raw === undefined
          ? { data: {}, extraLines: [], body: '', hasFrontmatter: false }
          : parseSkillFile(raw)
      const description =
        input.description === undefined
          ? assertDescription(flattenDescription(parsed.data.description))
          : assertDescription(input.description)
      const existingWhenToUse =
        typeof parsed.data.whenToUse === 'string' && parsed.data.whenToUse.trim() !== ''
          ? parsed.data.whenToUse.trim()
          : null
      const whenToUse =
        input.whenToUse === undefined ? existingWhenToUse : normalizeWhenToUse(input.whenToUse)
      const body = input.body === undefined ? parsed.body : normalizeBody(input.body)
      const text = renderSkillFile({
        data: { name, description, whenToUse: whenToUse ?? undefined },
        extraLines: parsed.extraLines ?? [],
        body,
      })
      try {
        // assertRealInside has checked where a link points; keep it a link.
        await writeTextAtomic(skillFile, matchLineEndings(raw, text), undefined, { followLink: true })
      } catch (error) {
        fail('internal', `cannot write skill file: ${errorMessage(error)}`, 500)
      }
      const entry = {
        name,
        description,
        whenToUse: whenToUse ?? null,
        scope,
        source: root.source,
        provider: 'filesystem',
        path: skillFile,
        dir: directory,
        root: root.path,
        editable: true,
      }
      const shadowed = await shadowedFor(workspace, name, directory)
      return { skill: toView(entry, shadowed) }
    },

    /**
     * Import SKILL.md packages from a local folder / SKILL.md / .zip|.skill archive.
     * `dryRun` only reports candidates; otherwise imports `names` (or every valid candidate).
     * Existing same-name skills are skipped unless `overwrite`, which replaces them in place.
     */
    async importSkills(input = {}) {
      const scope = assertScope(input.scope)
      rejectBundledMutation(scope, 'import')
      const workspace = resolveWorkspace(input.workspace)
      const roots = scopeRoots(scope, workspace)
      const targetRoot = input.target === 'agents' && roots[1] !== undefined ? roots[1] : roots[0]
      const source = expandSource(input.source)
      const opened = await openSource(source)
      try {
        const packages = await describePackages(opened.root)
        const seen = new Set()
        const candidates = []
        for (const item of packages) {
          let error = item.error
          let conflict = null
          if (error === null && seen.has(item.name)) error = `duplicate skill name "${item.name}" in this source`
          seen.add(item.name)
          if (error === null) {
            const located = await locate(roots, item.name)
            if (located !== undefined) {
              const [from, to] = await Promise.all([realPathOrFallback(item.dir), realPathOrFallback(located.directory)])
              if (from === to) error = 'this folder is already the installed skill'
              else conflict = { root: located.root, path: join(located.directory, 'SKILL.md') }
            }
          }
          const relativeDir = relative(opened.root, item.dir).split('\\').join('/') || basename(item.dir)
          candidates.push({ ...item, error, conflict, relativeDir })
        }
        const view = (item) => ({
          name: item.name,
          description: item.description,
          files: item.files ?? 0,
          bytes: item.bytes ?? 0,
          symlinks: item.symlinks ?? 0,
          source: item.relativeDir || item.name,
          warning: item.warning ?? null,
          error: item.error ?? null,
          conflict: item.conflict ? { path: displayPath(item.conflict.path) } : null,
        })
        if (input.dryRun === true) {
          return {
            source: displayPath(source),
            kind: opened.kind,
            target: displayPath(targetRoot.path),
            candidates: candidates.map(view),
          }
        }
        const wanted = Array.isArray(input.names) ? new Set(input.names.filter((name) => typeof name === 'string')) : null
        const imported = []
        const skipped = []
        for (const item of candidates) {
          if (wanted !== null && !wanted.has(item.name)) continue
          if (item.error) {
            skipped.push({ name: item.name, reason: item.error })
            continue
          }
          if (item.conflict && input.overwrite !== true) {
            skipped.push({ name: item.name, reason: 'a skill with this name already exists' })
            continue
          }
          const root = item.conflict ? item.conflict.root : targetRoot
          assertLexicalInside(root.path, join(root.path, item.name), `skill path is outside its root: ${item.name}`)
          try {
            const directory = await installPackage(item.dir, root.path, item.name, Boolean(item.conflict))
            imported.push({ name: item.name, path: displayPath(join(directory, 'SKILL.md')), replaced: Boolean(item.conflict) })
          } catch (error) {
            skipped.push({ name: item.name, reason: errorMessage(error) })
          }
        }
        if (wanted !== null) {
          for (const name of wanted) {
            if (!candidates.some((item) => item.name === name)) skipped.push({ name, reason: 'not found in source' })
          }
        }
        return { imported, skipped, target: displayPath(targetRoot.path) }
      } finally {
        await opened.cleanup()
      }
    },

    /** Delete a skill directory recursively. */
    async remove(input = {}) {
      const scope = assertScope(input.scope)
      rejectBundledMutation(scope, 'remove')
      const name = assertSkillName(input.name)
      const workspace = resolveWorkspace(input.workspace)
      const located = await locate(scopeRoots(scope, workspace), name)
      if (located === undefined) {
        await refuseIfLinked(scope, workspace, name, 'remove')
        await refuseIfReadonly(scope, workspace, name, 'remove')
        fail('not_found', `skill not found: ${scope}/${name}`, 404)
      }
      const { root, directory } = located
      await assertRealInside(root.path, directory, 'skill directory resolves outside its root')
      try {
        await removeTree(directory)
      } catch (error) {
        fail('internal', `cannot delete skill: ${errorMessage(error)}`, 500)
      }
      return { deleted: true, name, scope }
    },
  }

  /**
   * Find the first existing skill directory for `name` inside `roots`, skipping
   * entries whose real path escapes the root.
   */
  async function locate(roots, name) {
    for (const root of roots) {
      const directory = join(root.path, name)
      if (!isInside(root.path, directory)) continue
      const info = await statIfExists(directory)
      if (info === undefined || !info.isDirectory()) continue
      const rootReal = await realPathOrFallback(root.path)
      const directoryReal = await realPathOrFallback(directory)
      if (!isInside(rootReal, directoryReal)) continue
      return { root, directory }
    }
    return undefined
  }

  /** Throw `forbidden` when `name` only exists under a read-only third-party root. */
  async function refuseIfReadonly(scope, workspace, name, operation) {
    const foreign = await locate(readonlyRoots(scope, workspace), name)
    if (foreign !== undefined) {
      fail(
        'forbidden',
        `cannot ${operation} ${name}: ${displayPath(foreign.directory)} is read-only (third-party agent directory)`,
        403,
      )
    }
  }

  /** Throw `forbidden` when `name` is a user-scope link to a folder outside the skill root. */
  async function refuseIfLinked(scope, workspace, name, operation) {
    if (scope !== 'user') return
    for (const root of scopeRoots(scope, workspace)) {
      const directory = join(root.path, name)
      if (!isInside(root.path, directory)) continue
      const info = await statIfExists(directory)
      if (info === undefined || !info.isDirectory()) continue
      const target = await realPathOrFallback(directory)
      if (isInside(await realPathOrFallback(root.path), target)) continue
      fail('forbidden', `cannot ${operation} ${name}: it links to ${displayPath(target)}; edit it there`, 403)
    }
  }

  /** Other copies of `name` that this entry shadows (or is shadowed by). */
  async function shadowedFor(workspace, name, directory) {
    const { filesystem, service } = await collect(workspace)
    const shadowed = []
    for (const entry of [...filesystem, ...service]) {
      if (entry.name !== name) continue
      if (entry.dir !== null && entry.dir !== undefined && entry.dir === directory) continue
      shadowed.push({ scope: entry.scope, path: entry.path ?? null })
    }
    return shadowed
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

/** Reject mutations aimed at the read-only `bundled` scope. */
function rejectBundledMutation(scope, operation) {
  if (scope === 'bundled') {
    fail('bad_request', `cannot ${operation} bundled skills: the scope is read-only`, 400)
  }
}

/** One line from a stored description: YAML block scalars may span several, which is valid on disk. */
function flattenDescription(value) {
  return typeof value === 'string' ? value.replace(/\s*[\r\n]+\s*/g, ' ').trim() : ''
}

/** Validate a skill description (non-empty, single line, bounded). */
function assertDescription(value) {
  if (typeof value !== 'string') fail('bad_request', 'description must be a string', 400)
  const description = value.trim()
  if (description === '') fail('bad_request', 'description must not be empty', 400)
  if (/[\r\n]/.test(description)) fail('bad_request', 'description must be a single line', 400)
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    fail('bad_request', `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`, 400)
  }
  return description
}

/** Validate an optional `whenToUse` single line; empty normalizes to null. */
function normalizeWhenToUse(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') fail('bad_request', 'whenToUse must be a string', 400)
  const whenToUse = value.trim()
  if (whenToUse === '') return null
  if (/[\r\n]/.test(whenToUse)) fail('bad_request', 'whenToUse must be a single line', 400)
  if (whenToUse.length > DESCRIPTION_MAX_LENGTH) {
    fail('bad_request', `whenToUse must be at most ${DESCRIPTION_MAX_LENGTH} characters`, 400)
  }
  return whenToUse
}

/** Validate a markdown body; absent input becomes an empty body. */
function normalizeBody(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') fail('bad_request', 'body must be a string', 400)
  return value
}

/** Pure lexical containment check with a 403 error. */
function assertLexicalInside(root, target, message) {
  if (!isInside(root, target)) fail('forbidden', message, 403)
}

/** Containment check that also resolves symlinks (target may not exist yet). */
async function assertRealInside(root, target, message) {
  assertLexicalInside(root, target, message)
  const realRoot = await realPathOrFallback(root)
  const realTarget = await realPathOrFallback(target)
  if (!isInside(realRoot, realTarget)) fail('forbidden', message, 403)
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

/**
 * Group entries by skill name. The first entry wins; later entries with the same
 * name become `shadowed` references. Insertion order preserves precedence.
 */
function mergeEntries(filesystem, service) {
  const merged = new Map()
  for (const entry of [...filesystem, ...service]) {
    const existing = merged.get(entry.name)
    if (existing === undefined) {
      merged.set(entry.name, { entry, shadowed: [] })
    } else {
      existing.shadowed.push({ scope: entry.scope, path: entry.path ?? null })
    }
  }
  return merged
}

/** Serialize one internal entry into the API `SkillView` shape. */
function toView(entry, shadowed = []) {
  return {
    name: entry.name,
    description: entry.description ?? '',
    whenToUse: entry.whenToUse ?? null,
    scope: entry.scope,
    source: entry.source,
    provider: entry.provider,
    path: entry.path ?? null,
    dir: entry.dir ?? null,
    editable: entry.editable === true,
    linkTarget: typeof entry.linkTarget === 'string' ? displayPath(entry.linkTarget) : null,
    shadowed: shadowed.map((item) => ({ scope: item.scope, path: item.path ?? null })),
  }
}

/** Load `raw` + markdown `body` for a skill entry, refusing symlink escapes. */
async function loadSkillContent(entry) {
  if (entry.path === null || entry.dir === null) return { body: '', raw: '', modifiedAt: null }
  if (typeof entry.root === 'string') {
    const rootReal = typeof entry.linkTarget === 'string' ? entry.linkTarget : await realPathOrFallback(entry.root)
    const fileReal = await realPathOrFallback(entry.path)
    if (!isInside(rootReal, fileReal)) {
      fail('forbidden', `skill file resolves outside its root: ${entry.path}`, 403)
    }
  }
  let raw
  try {
    raw = await readTextIfExists(entry.path)
  } catch (error) {
    fail('forbidden', `cannot read skill file: ${errorMessage(error)}`, 403)
  }
  if (raw === undefined) return { body: '', raw: '', modifiedAt: null }
  const parsed = parseSkillFile(raw)
  const info = await statIfExists(entry.path)
  return { body: parsed.body, raw, modifiedAt: info?.isFile() ? info.mtime.toISOString() : null }
}
