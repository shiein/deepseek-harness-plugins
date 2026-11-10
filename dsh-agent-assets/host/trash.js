/**
 * Recoverable deletes for skills and instruction files.
 *
 * A delete moves the item into `<dshHome>/agent-assets/trash/<id>/item` next to a `meta.json` with
 * its original path, so the page can offer Undo. Entries older than RETENTION_MS are purged on the
 * next delete. This is the plugin's own trash, not the OS one: moving into ~/.Trash is restricted by
 * macOS privacy controls and the Windows recycle bin needs the Shell API.
 */

import { randomBytes } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import { fail, statIfExists } from './shared.js'

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const ID_PATTERN = /^\d{13}-[0-9a-f]{8}$/

/** rename, or copy + remove across volumes (a workspace on another disk than the DSH home). */
async function move(from, to) {
  try {
    await rename(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
    await rm(from, { recursive: true, force: true })
  }
}

export function createTrash({ dshHome, now = () => Date.now() }) {
  const root = join(dshHome, 'agent-assets', 'trash')

  async function purgeOld() {
    let names = []
    try {
      names = await readdir(root)
    } catch {
      return
    }
    const cutoff = now() - RETENTION_MS
    for (const name of names) {
      if (ID_PATTERN.test(name) && Number(name.slice(0, 13)) < cutoff) {
        await rm(join(root, name), { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  return {
    root,

    /**
     * Move `path` into the trash. `kind` is informational ('skill' | 'instruction').
     * @returns {Promise<string>} the trash id to restore with
     */
    async put(path, kind) {
      await purgeOld()
      const id = `${now()}-${randomBytes(4).toString('hex')}`
      const slot = join(root, id)
      await mkdir(slot, { recursive: true })
      await writeFile(join(slot, 'meta.json'), JSON.stringify({ originalPath: path, kind, deletedAt: new Date(now()).toISOString() }))
      try {
        await move(path, join(slot, 'item'))
      } catch (error) {
        await rm(slot, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      return id
    },

    /** Put a trashed item back where it was; refuses when something new is there now. */
    async restore(id) {
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) fail('bad_request', 'invalid trash id', 400)
      const slot = join(root, id)
      let meta
      try {
        meta = JSON.parse(await readFile(join(slot, 'meta.json'), 'utf8'))
      } catch {
        fail('not_found', 'this item is no longer in the trash', 404)
      }
      const original = meta?.originalPath
      if (typeof original !== 'string' || !isAbsolute(original)) fail('internal', 'trash entry has no original path', 500)
      if (await statIfExists(original)) fail('conflict', `something already exists at ${original}`, 409)
      if (!await statIfExists(join(slot, 'item'))) fail('not_found', 'this item is no longer in the trash', 404)
      await mkdir(dirname(original), { recursive: true })
      await move(join(slot, 'item'), original)
      await rm(slot, { recursive: true, force: true }).catch(() => {})
      return { restored: true, path: original, kind: meta.kind ?? null }
    },
  }
}
