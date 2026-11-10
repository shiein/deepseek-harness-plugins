import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTrash } from '../host/trash.js'

test('a trashed folder can be restored, once, and only into an empty place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-trash-'))
  try {
    const trash = createTrash({ dshHome: join(root, 'dsh') })
    const skill = join(root, 'skills', 'demo')
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), 'body')
    const id = await trash.put(skill, 'skill')
    await assert.rejects(readFile(join(skill, 'SKILL.md')))
    await mkdir(skill, { recursive: true })
    await assert.rejects(trash.restore(id), { code: 'conflict' })
    await rm(skill, { recursive: true })
    assert.deepEqual(await trash.restore(id), { restored: true, path: skill, kind: 'skill' })
    assert.equal(await readFile(join(skill, 'SKILL.md'), 'utf8'), 'body')
    await assert.rejects(trash.restore(id), { code: 'not_found' })
    await assert.rejects(trash.restore('../../etc'), { code: 'bad_request' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('entries older than 30 days are purged on the next delete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-trash-'))
  try {
    let clock = Date.UTC(2026, 0, 1)
    const trash = createTrash({ dshHome: join(root, 'dsh'), now: () => clock })
    await writeFile(join(root, 'a.md'), 'a')
    await writeFile(join(root, 'b.md'), 'b')
    const old = await trash.put(join(root, 'a.md'), 'instruction')
    clock += 31 * 24 * 60 * 60 * 1000
    const fresh = await trash.put(join(root, 'b.md'), 'instruction')
    assert.deepEqual(await readdir(trash.root), [fresh])
    assert.ok(old !== fresh)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
