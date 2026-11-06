/** 轮次变更基线/忽略规则/Agent 写入提取（方案 §5.3、R3-4）；临时工作区真实文件系统。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBaseline, diffBaseline } from '../../src/core/change/baseline.ts'
import { loadIgnoreMatcher } from '../../src/core/change/ignore.ts'
import { extractWrittenPaths } from '../../src/core/change/agent-writes.ts'

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-change-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path: string, content = 'x') => {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return { root, put }
}

test('ignore matcher supports comments, globs, anchoring, directory rules and negation', async t => {
  const { root, put } = await fixture(t)
  await put('.gitignore', [
    '# a comment', '', '*.log', 'build?/', '/rooted.txt', 'docs/*.md',
    'deep/**/gen.txt', 'logs/', 'temp', '!temp/keep.txt', '[abc].txt', 'esc\\aped.txt',
  ].join('\n'))
  const matcher = await loadIgnoreMatcher(root)
  assert.equal(matcher.ignores('error.log', false), true)
  assert.equal(matcher.ignores('a/error.log', false), true, 'unanchored name matches at any level')
  assert.equal(matcher.ignores('build1/x', false), true, '? matches one character')
  assert.equal(matcher.ignores('builds/x', false), true, '? also covers the s in builds')
  assert.equal(matcher.ignores('buildxx/x', false), false, '? does not match two characters')
  assert.equal(matcher.ignores('rooted.txt', false), true)
  assert.equal(matcher.ignores('sub/rooted.txt', false), false, 'anchored rule only binds at the base')
  assert.equal(matcher.ignores('docs/readme.md', false), true)
  assert.equal(matcher.ignores('docs/a/b.md', false), false, '* does not cross a slash')
  assert.equal(matcher.ignores('deep/a/b/gen.txt', false), true, '** crosses directories')
  assert.equal(matcher.ignores('logs/today.txt', false), true, 'directory rule hides the subtree')
  assert.equal(matcher.ignores('temp/note.txt', false), true)
  assert.equal(matcher.ignores('temp/keep.txt', false), false, 'a later negation re-includes')
  // 不支持语法记录且不忽略（宁可多扫）。
  assert.equal(matcher.ignores('a.txt', false), false)
  assert.equal(matcher.ignores('esc aped.txt', false), false)
  assert.deepEqual(matcher.unsupported.sort(),
    ['.gitignore:11', '.gitignore:12'].sort())
})

test('nested .gitignore rules only cover their own subtree; DEFAULT_IGNORES can be negated', async t => {
  const { root, put } = await fixture(t)
  await put('.gitignore', 'top-secret.txt\n!coverage/\n')
  await put('sub/.gitignore', 'inner.txt\n')
  const matcher = await loadIgnoreMatcher(root)
  matcher.addRules('sub', 'sub/.gitignore', await import('node:fs/promises')
    .then(fs => fs.readFile(join(root, 'sub/.gitignore'), 'utf8')))
  assert.equal(matcher.ignores('sub/inner.txt', false), true)
  assert.equal(matcher.ignores('inner.txt', false), false, 'nested rules do not leak to the parent')
  assert.equal(matcher.ignores('sub/deep/inner.txt', false), true, 'nested rules reach their descendants')
  assert.equal(matcher.ignores('coverage/report.txt', false), false, 'negation beats the built-in ignore')
  assert.equal(matcher.ignores('node_modules/pkg/index.js', false), true)
})

test('forceInclude re-includes ignored directories and their ancestors', async t => {
  const { root, put } = await fixture(t)
  await put('.gitignore', 'dist/\n')
  const matcher = await loadIgnoreMatcher(root, { forceInclude: ['dist/site'] })
  assert.equal(matcher.ignores('dist/site/app.js', false), false)
  assert.equal(matcher.ignores('dist', true), false, 'ancestors of a forced directory stay scannable')
  assert.equal(matcher.ignores('dist/other/x.js', false), true, 'siblings outside the forced path stay ignored')
})

test('baseline diffs added, modified and deleted files; identical metadata is not a change', async t => {
  const { root, put } = await fixture(t)
  await put('a.txt', 'alpha')
  await put('sub/b.txt', 'beta')
  await put('.gitignore', 'ignored-dir/\n')
  await put('ignored-dir/skip.txt', 'never indexed')
  const baseline = await createBaseline(root)
  assert.ok(baseline.entries.has('a.txt') && baseline.entries.has('sub/b.txt'))
  assert.ok(!baseline.entries.has('ignored-dir/skip.txt'))
  await put('a.txt', 'alpha-2')
  await put('new.txt', 'fresh')
  await rm(join(root, 'sub/b.txt'))
  const { changes } = await diffBaseline(baseline, new Set())
  // 变化输出按工作区相对路径字典序排序，与 kind 无关。
  assert.deepEqual(changes, [
    { kind: 'modified', path: 'a.txt', origin: 'workspace-observed' },
    { kind: 'added', path: 'new.txt', origin: 'workspace-observed' },
    { kind: 'deleted', path: 'sub/b.txt', origin: 'workspace-observed' },
  ])
})

test('pre-hashed files skip metadata-only touches and detect renames by content', async t => {
  const { root, put } = await fixture(t)
  await put('tracked.ts', 'same content')
  await put('plain.ts', 'other content')
  const baseline = await createBaseline(root, { hashPaths: ['tracked.ts'] })
  assert.ok(baseline.entries.get('tracked.ts')?.hash !== undefined)
  assert.equal(baseline.entries.get('plain.ts')?.hash, undefined)
  // 元数据变化但内容相同：有哈希判同 → 不算变化；无哈希 → 如实 modified。
  const past = new Date(Date.now() - 60000)
  await utimes(join(root, 'tracked.ts'), past, past)
  await utimes(join(root, 'plain.ts'), past, past)
  // 删除 + 相同内容新增 → renamed；改名目标不必是哈希登记路径。
  await put('renamed.ts', 'same content')
  await rm(join(root, 'tracked.ts'))
  const { changes } = await diffBaseline(baseline, new Set())
  assert.deepEqual(changes, [
    { kind: 'modified', path: 'plain.ts', origin: 'workspace-observed' },
    { kind: 'renamed', path: 'renamed.ts', from: 'tracked.ts', origin: 'workspace-observed' },
  ].sort((a, b) => a.path < b.path ? -1 : 1))
})

test('agent-confirmed paths are tagged from workspace-absolute evidence', async t => {
  const { root, put } = await fixture(t)
  await put('mine.ts', 'v1')
  const baseline = await createBaseline(root)
  await put('mine.ts', 'v2')
  await put('theirs.ts', 'v1')
  const { changes } = await diffBaseline(baseline, new Set([join(root, 'mine.ts'), join(root, 'theirs.ts')]))
  assert.deepEqual(changes.find(c => c.path === 'mine.ts')?.origin, 'agent-confirmed')
  assert.deepEqual(changes.find(c => c.path === 'theirs.ts')?.origin, 'agent-confirmed')
})

test('.env files are never content-hashed even when declared as hashPaths', async t => {
  const { root, put } = await fixture(t)
  await put('.env.local', 'SECRET=must-not-leak')
  const baseline = await createBaseline(root, { hashPaths: ['.env.local'] })
  assert.equal(baseline.entries.get('.env.local')?.hash, undefined)
})

test('extractWrittenPaths honors the tool whitelist, success flag and workspace boundary', async t => {
  const { root, put } = await fixture(t)
  await put('src/a.ts', '')
  const absolute = join(root, 'src/a.ts')
  const evidence = (overrides: object) => ({
    toolName: 'write', args: { file_path: 'src/a.ts' }, meta: { path: absolute },
    ok: true, cwd: root, ...overrides,
  })
  assert.deepEqual(await extractWrittenPaths(evidence({}), root), [absolute])
  for (const name of ['bash', 'edit', 'apply_patch', 'read'])
    assert.deepEqual(await extractWrittenPaths(evidence({ toolName: name }), root), [])
  assert.deepEqual(await extractWrittenPaths(evidence({ ok: false }), root), [])
  assert.deepEqual(await extractWrittenPaths(evidence({ toolName: 'search_replace' }), root), [absolute])
  // meta.path 优先；相对 arguments.file_path 按调用时 cwd 解析。
  assert.deepEqual(await extractWrittenPaths(evidence({ meta: {} }), root), [absolute])
  await put('other.ts', '')
  assert.deepEqual(await extractWrittenPaths(evidence({ meta: {}, args: { file_path: 'other.ts' } }), root),
    [join(root, 'other.ts')])
  // 越界与断链不构成写入证据。
  const outside = join(root, '..', 'outside-' + Math.random().toString(36).slice(2) + '.ts')
  await writeFile(outside, '').catch(() => undefined)
  assert.deepEqual(await extractWrittenPaths(evidence({ meta: { path: outside }, args: {} }), root), [])
  await symlink(join(root, 'missing-target'), join(root, 'dangling.ts'))
  assert.deepEqual(await extractWrittenPaths(
    evidence({ meta: { path: join(root, 'dangling.ts') }, args: {} }), root), [])
  await rm(outside, { force: true })
})
