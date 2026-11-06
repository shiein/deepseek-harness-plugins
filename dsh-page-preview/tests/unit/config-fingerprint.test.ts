/** 执行项指纹与真实模块字节（方案 §8、§13.1）；不执行模块、不写批准记录。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectExecutionItems, fingerprintExecutionItems } from '../../src/shared/config/fingerprint.ts'
import type { ProjectConfig } from '../../src/shared/config/schema.ts'

async function setup(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-preview-fingerprint-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, 'app')
  await mkdir(app)
  const text = "throw new Error('must never execute during fingerprinting')\n"
  await writeFile(join(app, 'setup.js'), text)
  await writeFile(join(app, 'first.js'), text)
  await writeFile(join(app, 'second.js'), "throw new Error('second module must not execute')\n")
  const project: ProjectConfig = { id: 'sample', root: 'app', runtime: { setup: 'setup.js', env: { FIRST: 'one', SECOND: 'two' }, command: { executable: 'node', args: ['server.mjs', '--preview'], cwd: '.' } }, scenarios: { first: { handlers: 'first.js' }, second: { handlers: 'second.js' } } }
  const hash = async (value: ProjectConfig = project) => fingerprintExecutionItems(await collectExecutionItems(app, value))
  return { root, app, text, project, hash }
}

test('execution items preserve explicit command/env and hash module bytes without executing them', async t => {
  const { app, text, project } = await setup(t)
  const items = await collectExecutionItems(app, project)
  assert.equal(items.version, 2)
  assert.equal(items.bindings.appRoot, app)
  assert.deepEqual(items.command, project.runtime.command)
  assert.deepEqual(items.env, project.runtime.env)
  assert.equal(items.bindings.cwd, app)
  assert.deepEqual(items.bindings.setup, { path: 'setup.js', resolved: join(app, 'setup.js') })
  assert.equal(items.files[join(app, 'setup.js')], createHash('sha256').update(text).digest('hex'))
  assert.equal(Object.keys(items.files).length, 3)
  assert.doesNotMatch(JSON.stringify(items.files), /must never execute|throw new Error/)
  assert.equal(await readFile(join(app, 'setup.js'), 'utf8'), text)
  items.command!.args.push('changed-copy')
  items.env!.FIRST = 'changed-copy'
  assert.deepEqual(project.runtime.command?.args, ['server.mjs', '--preview'])
  assert.equal(project.runtime.env?.FIRST, 'one')
})

test('key order and mtime do not change the fingerprint, while module bytes do', async t => {
  const { app, project, hash } = await setup(t)
  const original = await hash()
  const reordered: ProjectConfig = { ...project, runtime: { ...project.runtime, env: { SECOND: 'two', FIRST: 'one' } }, scenarios: { second: project.scenarios!.second!, first: project.scenarios!.first! } }
  assert.equal(await hash(reordered), original)
  await utimes(join(app, 'setup.js'), new Date(1000), new Date(1000))
  assert.equal(await hash(), original)
  await writeFile(join(app, 'setup.js'), 'throw new Error("new bytes")\n')
  assert.notEqual(await hash(), original)
})

test('command, argument order and declared environment changes alter the fingerprint', async t => {
  const { project, hash } = await setup(t)
  const original = await hash()
  for (const runtime of [
    { ...project.runtime, command: { ...project.runtime.command!, executable: 'other-node' } },
    { ...project.runtime, command: { ...project.runtime.command!, args: ['--preview', 'server.mjs'] } },
    { ...project.runtime, env: { ...project.runtime.env, FIRST: 'changed' } },
  ]) assert.notEqual(await hash({ ...project, runtime }), original)
})

test('swapping scenario handlers changes the fingerprint even when the file set is unchanged', async t => {
  const { app, project, hash } = await setup(t)
  const swapped: ProjectConfig = { ...project, scenarios: { first: { handlers: 'second.js' }, second: { handlers: 'first.js' } } }
  assert.deepEqual((await collectExecutionItems(app, swapped)).files, (await collectExecutionItems(app, project)).files)
  assert.notEqual(await hash(swapped), await hash())
})

test('declared setup reference and actual symlink target both affect the fingerprint', async t => {
  const { app, text, project, hash } = await setup(t)
  await symlink('setup.js', join(app, 'alias.js'))
  const aliased: ProjectConfig = { ...project, runtime: { ...project.runtime, setup: 'alias.js' } }
  assert.notEqual(await hash(aliased), await hash())
  const before = await hash(aliased)
  await writeFile(join(app, 'same-bytes.js'), text)
  await rm(join(app, 'alias.js'))
  await symlink('same-bytes.js', join(app, 'alias.js'))
  assert.notEqual(await hash(aliased), before)
})

test('canonical command working directory changes are part of the execution identity', async t => {
  const { app, project, hash } = await setup(t)
  await mkdir(join(app, 'one'))
  await mkdir(join(app, 'two'))
  await symlink('one', join(app, 'current'))
  const value: ProjectConfig = { ...project, runtime: { ...project.runtime, command: { ...project.runtime.command!, cwd: 'current' } } }
  const before = await hash(value)
  await rm(join(app, 'current'))
  await symlink('two', join(app, 'current'))
  assert.notEqual(await hash(value), before)
})

test('missing/out-of-root modules and environment files fail without returning an approved substitute', async t => {
  const { root, app, project } = await setup(t)
  await assert.rejects(collectExecutionItems(app, { ...project, runtime: { setup: 'missing.js' } }), { code: 'ENOENT' })
  await writeFile(join(root, 'outside.js'), 'throw new Error("not allowed")')
  await symlink(join(root, 'outside.js'), join(app, 'escape.js'))
  await assert.rejects(collectExecutionItems(app, { ...project, runtime: { setup: 'escape.js' } }), /outside/)
  await writeFile(join(app, '.env'), 'SYNTHETIC_ONLY=do-not-read')
  await symlink('.env', join(app, 'env-as-module.js'))
  await assert.rejects(collectExecutionItems(app, { ...project, runtime: { setup: 'env-as-module.js' } }), /Environment files/)
  await assert.rejects(collectExecutionItems(app, { ...project, runtime: { command: { executable: 'node', args: [], cwd: 'setup.js' } } }), /directory/)
})

test('non-executable scenario data is excluded while special scenario names keep their handler binding', async t => {
  const { app, project, hash } = await setup(t)
  assert.equal(await hash({ ...project, scenarios: { ...project.scenarios, fixtureOnly: { props: { count: 10 }, identity: { role: 'viewer' } } } }), await hash())
  const named: ProjectConfig = { ...project, scenarios: { ['__proto__']: { handlers: 'first.js' } } }
  const items = await collectExecutionItems(app, named)
  assert.ok(Object.hasOwn(items.bindings.handlers, '__proto__'))
  assert.equal(Object.getPrototypeOf(items.bindings.handlers), Object.prototype)
  assert.equal(items.bindings.handlers.__proto__?.path, 'first.js')
})
