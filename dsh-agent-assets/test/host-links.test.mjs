/**
 * Editing keeps symlinks and permissions; plugin-owned stores never write through a link.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createInstructions } from '../host/instructions.js'
import { createSkills } from '../host/skills.js'
import { writeTextAtomic } from '../host/shared.js'

const roots = []
after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))

async function workspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-assets-links-'))
  roots.push(root)
  const workspace = join(root, 'ws')
  await mkdir(workspace)
  const homes = {
    dshHome: join(root, 'dsh'), agentsHome: join(root, 'agents'), claudeHome: join(root, 'claude'),
    windsurfHome: join(root, 'windsurf'), devinHome: join(root, 'devin'),
  }
  return { root, workspace, homes }
}

test('saving CLAUDE.md through its link updates AGENTS.md and keeps the link', { skip: process.platform === 'win32' }, async () => {
  const { workspace, homes } = await workspaceFixture()
  await writeFile(join(workspace, 'AGENTS.md'), 'old\n')
  await symlink('AGENTS.md', join(workspace, 'CLAUDE.md'))
  await createInstructions({ homes }).write({ scope: 'workspace', workspace, path: join(workspace, 'CLAUDE.md'), content: 'new\n' })
  assert.ok((await lstat(join(workspace, 'CLAUDE.md'))).isSymbolicLink())
  assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), 'new\n')
  assert.deepEqual((await readdir(workspace)).sort(), ['AGENTS.md', 'CLAUDE.md'], 'no temp file left behind')
})

test('a link that leaves the workspace is still refused', { skip: process.platform === 'win32' }, async () => {
  const { root, workspace, homes } = await workspaceFixture()
  await writeFile(join(root, 'outside.md'), 'outside\n')
  await symlink(join(root, 'outside.md'), join(workspace, 'AGENTS.md'))
  await assert.rejects(
    createInstructions({ homes }).write({ scope: 'workspace', workspace, path: join(workspace, 'AGENTS.md'), content: 'x' }),
    (error) => error.code === 'forbidden',
  )
  assert.equal(await readFile(join(root, 'outside.md'), 'utf8'), 'outside\n')
})

test('updating a linked SKILL.md keeps the link', { skip: process.platform === 'win32' }, async () => {
  const { root, workspace, homes } = await workspaceFixture()
  const dir = join(homes.dshHome, 'skills', 'linked')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'shared.md'), '---\nname: linked\ndescription: old\n---\nbody\n')
  await symlink('shared.md', join(dir, 'SKILL.md'))
  await createSkills({ homes }).update({ scope: 'user', workspace, name: 'linked', description: 'new', body: 'b' })
  assert.ok((await lstat(join(dir, 'SKILL.md'))).isSymbolicLink())
  assert.match(await readFile(join(dir, 'shared.md'), 'utf8'), /description: new/)
  assert.ok(root)
})

test('an existing file keeps its mode; an explicit mode still wins', { skip: process.platform === 'win32' }, async () => {
  const { root } = await workspaceFixture()
  const file = join(root, 'f.md')
  await writeFile(file, 'a')
  await chmod(file, 0o640)
  await writeTextAtomic(file, 'b')
  assert.equal((await stat(file)).mode & 0o777, 0o640)
  await writeTextAtomic(file, 'c', 0o600)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test('without followLink a store replaces a link instead of writing through it', { skip: process.platform === 'win32' }, async () => {
  const { root } = await workspaceFixture()
  const victim = join(root, 'victim')
  await writeFile(victim, 'keep')
  const store = join(root, 'mcp.json')
  await symlink(victim, store)
  await writeTextAtomic(store, '{}', 0o600)
  assert.equal(await readFile(victim, 'utf8'), 'keep')
  assert.equal((await lstat(store)).isSymbolicLink(), false)
})
