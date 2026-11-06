/**
 * Skill import helpers: discover SKILL.md packages under a local source (a skill folder, a folder of
 * skills, a repository with `skills/<name>/`, a SKILL.md file, or a .zip/.skill archive), measure
 * them, and copy them into a writable skill root.
 *
 * Safety rules (mirrors the CRUD module):
 * - symlinks inside the source are never followed nor copied (they could point outside the root);
 * - `node_modules`, `.git` and OS litter are skipped;
 * - a package above IMPORT_LIMITS is refused instead of half-copied;
 * - copies land in a hidden staging directory next to the target and are renamed into place, so a
 *   failed copy never leaves a half-written skill visible to the Harness.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'

import { fail, parseSkillFile, readTextIfExists, SKILL_NAME_PATTERN, statIfExists } from './shared.js'

export const IMPORT_LIMITS = Object.freeze({ files: 5000, bytes: 100 * 1024 * 1024, candidates: 200 })

const SKIP_NAMES = new Set(['node_modules', '.git', '.hg', '.svn', '.DS_Store', 'Thumbs.db', '__MACOSX'])
const ARCHIVE_EXTS = new Set(['.zip', '.skill'])

/** Expand `~` and resolve to an absolute path. */
export function expandSource(value) {
  const raw = typeof value === 'string' ? value.trim().replace(/^["']|["']$/g, '') : ''
  if (raw === '') fail('bad_request', 'import requires a source path', 400)
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  return resolve(raw)
}

/** Directory walk statistics, ignoring skipped names and symlinks. */
export async function measureTree(root) {
  let files = 0
  let bytes = 0
  let symlinks = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        symlinks += 1
        continue
      }
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      files += 1
      const info = await statIfExists(full)
      bytes += info?.size ?? 0
      if (files > IMPORT_LIMITS.files || bytes > IMPORT_LIMITS.bytes) {
        return { files, bytes, symlinks, tooLarge: true }
      }
    }
  }
  return { files, bytes, symlinks, tooLarge: false }
}

/** Read one candidate package directory into an import descriptor. */
async function describeCandidate(dir) {
  const skillFile = join(dir, 'SKILL.md')
  let raw
  try {
    raw = await readTextIfExists(skillFile)
  } catch (error) {
    return { dir, name: basename(dir), description: '', error: `cannot read SKILL.md: ${error?.message || error}` }
  }
  const parsed = parseSkillFile(raw ?? '')
  const declared = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : ''
  const name = declared !== '' ? declared : basename(dir)
  const description = typeof parsed.data.description === 'string' ? parsed.data.description.trim() : ''
  const size = await measureTree(dir)
  let error = null
  if (!SKILL_NAME_PATTERN.test(name)) error = `name "${name}" is not kebab-case ([a-z0-9-], max 64)`
  else if (size.tooLarge) {
    error = `package exceeds ${IMPORT_LIMITS.files} files / ${Math.round(IMPORT_LIMITS.bytes / 1048576)} MB`
  }
  return {
    dir,
    name,
    description,
    files: size.files,
    bytes: size.bytes,
    symlinks: size.symlinks,
    warning: description === '' ? 'SKILL.md has no description; the agent may never pick this skill' : null,
    error,
  }
}

async function hasSkillFile(dir) {
  const info = await statIfExists(join(dir, 'SKILL.md'))
  return info !== undefined && info.isFile()
}

/** Child directories (no symlinks, no skipped names) of `dir`. */
async function childDirs(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && !SKIP_NAMES.has(entry.name) && !entry.name.startsWith('.'))
    .map((entry) => join(dir, entry.name))
    .sort()
}

/**
 * Find skill package directories under `root`: the root itself, its children, and the common
 * repository layouts `<root>/skills/<name>` / `<root>/<child>/skills/<name>`.
 */
export async function discoverPackages(root) {
  if (await hasSkillFile(root)) return [root]
  const found = []
  const visit = async (dir, depth) => {
    if (found.length >= IMPORT_LIMITS.candidates || depth > 3) return
    for (const child of await childDirs(dir)) {
      if (found.length >= IMPORT_LIMITS.candidates) return
      if (await hasSkillFile(child)) found.push(child)
      else await visit(child, depth + 1)
    }
  }
  await visit(root, 1)
  return found
}

function runTar(args) {
  const tar = process.platform === 'win32'
    ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : existsSync('/usr/bin/tar') ? '/usr/bin/tar' : 'tar'
  return new Promise((resolvePromise, reject) => {
    execFile(tar, args, { timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(0, 300)))
      else resolvePromise()
    })
  })
}

/**
 * Resolve an import source to a directory to scan. Archives are unpacked with the platform tar
 * (bsdtar on macOS and Windows 10+, which reads zip) into a temp directory the caller must clean.
 *
 * @returns {Promise<{ root: string, cleanup: () => Promise<void>, kind: 'dir'|'file'|'archive' }>}
 */
export async function openSource(source) {
  const info = await statIfExists(source)
  if (info === undefined) fail('not_found', `import source does not exist: ${source}`, 404)
  if (info.isDirectory()) return { root: source, kind: 'dir', cleanup: async () => {} }
  if (basename(source).toLowerCase() === 'skill.md') {
    return { root: dirname(source), kind: 'file', cleanup: async () => {} }
  }
  if (ARCHIVE_EXTS.has(extname(source).toLowerCase())) {
    if (info.size > IMPORT_LIMITS.bytes) fail('bad_request', 'archive is larger than the import limit', 400)
    const temp = await mkdtemp(join(tmpdir(), 'agent-assets-import-'))
    const cleanup = () => rm(temp, { recursive: true, force: true }).catch(() => {})
    try {
      await runTar(['-xf', source, '-C', temp])
    } catch (error) {
      await cleanup()
      fail('bad_request', `cannot unpack archive: ${error?.message || error}`, 400)
    }
    return { root: temp, kind: 'archive', cleanup }
  }
  fail('bad_request', 'import source must be a folder, a SKILL.md file or a .zip/.skill archive', 400)
}

/** Describe every package found under an opened source. */
export async function describePackages(root) {
  const dirs = await discoverPackages(root)
  const out = []
  for (const dir of dirs) out.push(await describeCandidate(dir))
  return out
}

/** Copy filter: drop skipped names and symlinks. */
async function copyFilter(source) {
  if (SKIP_NAMES.has(basename(source))) return false
  try {
    return !(await lstat(source)).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Copy `fromDir` to `<rootPath>/<name>` via a hidden staging directory. With `replace`, an existing
 * target is swapped out only after the new copy is complete.
 */
export async function installPackage(fromDir, rootPath, name, replace) {
  const target = join(rootPath, name)
  const stamp = `${process.pid}-${Date.now().toString(36)}`
  const staging = join(rootPath, `.${name}.import-${stamp}`)
  const backup = join(rootPath, `.${name}.replaced-${stamp}`)
  await rm(staging, { recursive: true, force: true })
  try {
    await cp(fromDir, staging, { recursive: true, filter: copyFilter, errorOnExist: false, force: true })
    const existing = await statIfExists(target)
    if (existing !== undefined) {
      if (!replace) fail('conflict', `skill already exists: ${name}`, 409)
      await rename(target, backup)
      try {
        await rename(staging, target)
      } catch (error) {
        await rename(backup, target).catch(() => {})
        throw error
      }
      await rm(backup, { recursive: true, force: true }).catch(() => {})
    } else {
      await rename(staging, target)
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
  return target
}
