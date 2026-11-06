/** 目标身份、固定路径基准与歧义回归（方案 §4.2、§5.2、§8、§15.3）；仅临时文件元数据，不执行模块。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseSelector, resolveTarget } from '../../src/core/target/resolve.ts'
import type { ResolvedTarget } from '../../src/core/target/resolve.ts'
import type { EffectiveProjectConfig } from '../../src/shared/config/loader.ts'
import type { TargetSelector } from '../../src/shared/contracts.ts'
import { localRoute } from '../../src/shared/route.ts'

async function setup(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-target-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const app of ['one', 'two']) {
    await mkdir(join(root, app, 'src'), { recursive: true })
    await writeFile(join(root, app, 'src', 'page.js'), 'throw new Error("MUST NOT EXECUTE")')
    await writeFile(join(root, app, 'index.html'), '<h1>Original document</h1>')
  }
  const projects: EffectiveProjectConfig[] = ['one', 'two'].map(id => ({ source: { kind: 'detected' }, diagnostics: [], project: { id, root: id, runtime: {}, targets: [{ id: 'home', selector: { kind: 'file', path: 'index.html' } }, { id: 'named', selector: { kind: 'file', path: 'src/page.js', exportName: 'NamedPage' }, scope: 'component', route: { path: '/page' } }, { id: 'orders', selector: { kind: 'route', path: '/orders/:id' } }, { id: 'story', selector: { kind: 'story', id: 'button--primary' } }] } }))
  return { root, projects }
}
async function resolved(...args: Parameters<typeof resolveTarget>): Promise<ResolvedTarget> {
  const result = await resolveTarget(...args)
  assert.equal(result.kind, 'resolved')
  if (result.kind !== 'resolved') throw new Error('Expected an unambiguous target')
  return result.target
}

test('selector parser rejects unknown/combined fields and unsafe absolute paths without echoing values', () => {
  for (const value of [null, [], { kind: 'unknown' }, { kind: 'file', path: 'a', url: 'synthetic-no-echo' }, { kind: 'registered', id: '' }, { kind: 'file', path: '/tmp/private' }, { kind: 'file', path: 'C:\\private' }, { kind: 'file', path: '\\\\server\\share' }, { kind: 'route', path: '//remote/a' }, { kind: 'route', path: '/a', params: { id: 1 } }, { kind: 'url', url: 'https://remote.example/a' }, { kind: 'url', url: 'http://user:synthetic-no-echo@localhost/a' }]) {
    const result = parseSelector(value)
    assert.ok('error' in result)
    assert.doesNotMatch(result.error, /synthetic-no-echo/)
  }
  const selector = { kind: 'file', path: 'src/page.js', exportName: 'NamedPage' } as const
  assert.deepEqual(parseSelector(selector), selector)
})

test('registered and story identities are scoped to applications and duplicate names remain selectable candidates', async t => {
  const { root, projects } = await setup(t)
  for (const selector of [{ kind: 'registered', id: 'home' }, { kind: 'story', id: 'button--primary' }] as const) {
    const result = await resolveTarget(selector, projects, root)
    assert.equal(result.kind, 'ambiguous')
    if (result.kind !== 'ambiguous') throw new Error('Expected candidates')
    assert.deepEqual(result.candidates.map(value => value.projectId), ['one', 'two'])
    for (const candidate of result.candidates) assert.equal((await resolved(candidate.selector, projects, root, candidate.projectId)).projectId, candidate.projectId)
  }
  const target = await resolved({ kind: 'registered', id: 'named' }, projects, root, 'one')
  assert.equal(target.scope, 'component')
  assert.deepEqual(target.selector, { kind: 'file', path: 'src/page.js', exportName: 'NamedPage' })
  assert.deepEqual(target.route, { path: '/page' })
  assert.equal(target.sourceFiles?.[0], join(root, 'one/src/page.js'))
})

test('file paths use exactly the declared workspace/application base and never retry another base', async t => {
  const { root, projects } = await setup(t)
  assert.equal((await resolved({ kind: 'file', path: 'one/index.html' }, projects, root)).projectId, 'one')
  assert.equal((await resolved({ kind: 'file', path: 'index.html' }, projects, root, 'one')).targetId, 'home')
  assert.equal((await resolveTarget({ kind: 'file', path: 'index.html' }, projects, root)).kind, 'not-found')
  assert.equal((await resolveTarget({ kind: 'file', path: 'one/index.html' }, projects, root, 'one')).kind, 'not-found')
  assert.equal((await resolveTarget({ kind: 'file', path: 'index.html' }, projects, root, 'missing')).kind, 'not-found')
})

test('canonical aliases preserve registered IDs and escaped paths require an explicitly declared dependency root', async t => {
  const { root, projects } = await setup(t)
  await symlink('index.html', join(root, 'one/alias.html'))
  assert.equal((await resolved({ kind: 'file', path: 'alias.html' }, projects, root, 'one')).targetId, 'home')
  await symlink('../two/index.html', join(root, 'one/escape.html'))
  await assert.rejects(resolveTarget({ kind: 'file', path: 'escape.html' }, projects, root, 'one'), /outside/)
  projects[0]!.project.runtime.dependencyRoots = ['../two']
  const shared = await resolved({ kind: 'file', path: 'escape.html' }, projects, root, 'one')
  assert.deepEqual(shared.sourceFiles, [join(root, 'two/index.html')])
  await symlink('../missing.html', join(root, 'one/broken.html'))
  await assert.rejects(resolveTarget({ kind: 'file', path: 'broken.html' }, projects, root, 'one'), /symbolic link/)
})

test('one source registered as several real pages is ambiguous and an unspecified export is never forced to default', async t => {
  const { root, projects } = await setup(t)
  projects[0]!.project.targets!.push({ id: 'same-document', selector: { kind: 'file', path: 'index.html' }, scope: 'shell' })
  const result = await resolveTarget({ kind: 'file', path: 'index.html' }, projects, root, 'one')
  assert.equal(result.kind, 'ambiguous')
  const named = await resolved({ kind: 'file', path: 'src/page.js', exportName: 'NamedPage' }, projects, root, 'one')
  assert.equal(named.targetId, 'named')
  const unspecified = await resolved({ kind: 'file', path: 'src/page.js' }, projects, root, 'one')
  assert.ok(unspecified.selector.kind === 'file' && unspecified.selector.exportName === undefined)
  assert.notEqual(unspecified.targetId, 'named')
})

test('route mapping requires concrete parameters and preserves requested query and file navigation context', async t => {
  const { root, projects } = await setup(t)
  const selector: TargetSelector = { kind: 'route', path: '/orders/:id', params: { id: '汉字 42' }, query: { filter: 'open' } }
  const target = await resolved(selector, projects, root, 'one')
  assert.equal(target.targetId, 'orders')
  assert.deepEqual(target.selector, selector)
  assert.equal(localRoute(target.selector as Extract<TargetSelector, { kind: 'route' }>).searchParams.get('filter'), 'open')
  assert.equal((await resolveTarget({ kind: 'route', path: '/orders/:id' }, projects, root, 'one')).kind, 'not-found')
  const file = await resolved({ kind: 'route', path: '/page', query: { tab: 'details' } }, projects, root, 'one')
  assert.equal(file.targetId, 'named')
  assert.equal(file.selector.kind, 'file')
  assert.deepEqual(file.route, { path: '/page', query: { tab: 'details' } })
})

test('unregistered local routes need an application choice and derived IDs are stable across object key order', async t => {
  const { root, projects } = await setup(t)
  const first: TargetSelector = { kind: 'route', path: '/new', query: { a: '1', b: '2' } }
  const outcome = await resolveTarget(first, projects, root)
  assert.equal(outcome.kind, 'ambiguous')
  if (outcome.kind !== 'ambiguous') throw new Error('Expected application candidates')
  for (const candidate of outcome.candidates) assert.equal((await resolved(candidate.selector, projects, root, candidate.projectId)).projectId, candidate.projectId)
  const a = await resolved(first, projects, root, 'one')
  const b = await resolved({ kind: 'route', query: { b: '2', a: '1' }, path: '/new' }, projects, root, 'one')
  assert.equal(a.targetId, b.targetId)
  assert.notEqual(a.targetId, (await resolved({ ...first, query: { a: 'different' } }, projects, root, 'one')).targetId)
})

test('hash navigation stays distinct and overlapping configured routes remain ambiguous', async t => {
  const { root, projects } = await setup(t)
  projects[0]!.project.targets!.push(
    { id: 'hash-one', selector: { kind: 'route', path: '/#/one/:id' } },
    { id: 'hash-two', selector: { kind: 'route', path: '/#/two/:id' } },
    { id: 'fixed-order', selector: { kind: 'route', path: '/orders/42' } },
  )
  assert.equal((await resolved({ kind: 'route', path: '/#/one/42' }, projects, root, 'one')).targetId, 'hash-one')
  assert.equal((await resolveTarget({ kind: 'route', path: '/orders/42' }, projects, root, 'one')).kind, 'ambiguous')
  for (const route of [{ path: '/orders/:id' }, { path: '//external/' }, { path: '/%broken' }, { path: '/a\\b' }]) assert.throws(() => localRoute(route))
})

test('URL targets accept only explicitly configured matching loopback origins, including IPv6', async t => {
  const { root, projects } = await setup(t)
  projects[0]!.project.runtime.origin = 'http://localhost:1234'
  const url = { kind: 'url', url: 'http://localhost:1234/orders?state=open' } as const
  assert.equal((await resolved(url, projects, root)).projectId, 'one')
  assert.equal((await resolveTarget({ kind: 'url', url: 'http://127.0.0.1:1234/' }, projects, root)).kind, 'not-found')
  assert.equal((await resolveTarget(url, projects, root, 'two')).kind, 'not-found')
  projects[1]!.project.runtime.origin = 'http://localhost:1234'
  assert.equal((await resolveTarget(url, projects, root)).kind, 'ambiguous')
  projects[1]!.project.runtime.origin = 'http://[::1]:4321'
  assert.equal((await resolved({ kind: 'url', url: 'http://[::1]:4321/' }, projects, root)).projectId, 'two')
})

test('missing files, directories, environment-file aliases and unknown registered IDs are never resolved', async t => {
  const { root, projects } = await setup(t)
  await writeFile(join(root, 'one/.env.test'), 'SYNTHETIC=must-not-read')
  await symlink('.env.test', join(root, 'one/environment.js'))
  for (const selector of [{ kind: 'file', path: 'missing.html' }, { kind: 'file', path: '.' }, { kind: 'file', path: 'environment.js' }, { kind: 'registered', id: 'missing' }] as const) assert.equal((await resolveTarget(selector, projects, root, 'one')).kind, 'not-found')
  assert.equal((await resolveTarget({ kind: 'story', id: 'unmapped' }, projects, root)).kind, 'not-found')
  projects[0]!.project.targets!.push({ id: 'missing-mapped', selector: { kind: 'file', path: 'missing.vue' }, route: { path: '/missing-mapped' } })
  assert.equal((await resolveTarget({ kind: 'route', path: '/missing-mapped' }, projects, root)).kind, 'not-found')
  projects[1]!.project.targets!.push({ id: 'other-mapped', selector: { kind: 'file', path: 'index.html' }, route: { path: '/missing-mapped' } })
  assert.equal((await resolveTarget({ kind: 'route', path: '/missing-mapped' }, projects, root)).kind, 'ambiguous')
})
