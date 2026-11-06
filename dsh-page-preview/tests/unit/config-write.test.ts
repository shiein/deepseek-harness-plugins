/** page-preview.config.json 场景写回的合并计划与备份写入（R5-1a、R5-F3/F4）：创建/合并/追加与全部拒绝路径。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ConfigWriteError, commitScenarioWrite, planScenarioWrite,
} from '../../src/host/config-write.ts'
import { validateConfig } from '../../src/shared/config/schema.ts'
import type { ScenarioConfig } from '../../src/shared/config/schema.ts'

const definition: ScenarioConfig = {
  businessPaths: ['/api/**'],
  http: [{ method: 'GET', path: '/api/orders', response: { status: 200, body: { items: [] } } }],
}

async function dir() { return mkdtemp(join(tmpdir(), 'dsh-config-write-')) }

test('a missing config file produces a created plan whose commit writes a valid minimal file', async () => {
  const workspace = await dir()
  const store = await dir()
  const plan = await planScenarioWrite(workspace, { id: 'site', root: '.' }, 'filled', definition, store)
  assert.equal(plan.mode, 'created')
  assert.equal(plan.backup, undefined)
  await commitScenarioWrite(plan)
  const written = JSON.parse(await readFile(join(workspace, 'page-preview.config.json'), 'utf8'))
  assert.equal(validateConfig(written).issues.length, 0)
  assert.equal(written.projects[0].scenarios.filled.http[0].path, '/api/orders')
})

test('an existing file merges the scenario and backs up inside the plugin dataDir bucket', async () => {
  const workspace = await dir()
  const store = await dir()
  const file = join(workspace, 'page-preview.config.json')
  const original = {
    schemaVersion: 1,
    projects: [{ id: 'site', root: '.', runtime: { strategy: 'static' },
      scenarios: { base: { businessPaths: ['/x/**'] } } }],
  }
  await writeFile(file, JSON.stringify(original))
  const plan = await planScenarioWrite(workspace, { id: 'site', root: '.' }, 'filled', definition, store)
  assert.equal(plan.mode, 'merged')
  assert.ok(plan.backup)
  assert.ok(plan.backup!.startsWith(join(store, 'config-backups')),
    'backups live under <dataDir>/config-backups/, not in the project: ' + plan.backup)
  await commitScenarioWrite(plan)
  // 备份保留写前内容；合并文件含新旧两个场景并仍通过校验；项目目录不堆积 .bak 文件。
  assert.deepEqual(JSON.parse(await readFile(plan.backup!, 'utf8')), original)
  const merged = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(validateConfig(merged).issues.length, 0)
  assert.deepEqual(Object.keys(merged.projects[0].scenarios).sort(), ['base', 'filled'])
  assert.deepEqual((await readdir(workspace)).filter(name => name.includes('.bak-')), [],
    'no backup files accumulate in the user workspace')
})

test('backups keep only the newest ten per workspace and isolate by workspace path', async () => {
  const workspace = await dir()
  const other = await dir()
  const store = await dir()
  const seed = { schemaVersion: 1, projects: [{ id: 'site', root: '.', runtime: {}, scenarios: { base: {} } }] }
  await writeFile(join(workspace, 'page-preview.config.json'), JSON.stringify(seed))
  await writeFile(join(other, 'page-preview.config.json'), JSON.stringify(seed))
  for (let i = 0; i < 12; i++) {
    const plan = await planScenarioWrite(workspace, { id: 'site', root: '.' }, 's' + i, definition, store)
    await commitScenarioWrite(plan)
    await delay(2) // 备份名以毫秒时间戳区分；同毫秒同名会如实 EXCL 拒绝。
  }
  const buckets = join(store, 'config-backups')
  const bucketOf = async (ws: string) =>
    join(buckets, createHash('sha256').update(await realpath(ws)).digest('hex'))
  const main = await readdir(await bucketOf(workspace))
  assert.equal(main.length, 10, 'only the newest ten backups are kept: ' + main.join(','))
  await commitScenarioWrite(await planScenarioWrite(other, { id: 'site', root: '.' }, 's0', definition, store))
  const secondary = await readdir(await bucketOf(other))
  assert.equal(secondary.length, 1, 'the other workspace gets its own bucket')
})

test('an existing same-name scenario and a project-less file refuse honestly', async () => {
  const workspace = await dir()
  const store = await dir()
  const file = join(workspace, 'page-preview.config.json')
  const withScenario = {
    schemaVersion: 1,
    projects: [{ id: 'site', root: '.', runtime: {}, scenarios: { filled: {} } }],
  }
  await writeFile(file, JSON.stringify(withScenario))
  await assert.rejects(planScenarioWrite(workspace, { id: 'site', root: '.' }, 'filled', definition, store),
    /already exists/)
  // 项目不在文件里时追加带 runtime: {} 的最小条目。
  const appended = await planScenarioWrite(workspace, { id: 'site-2', root: '.' }, 'other', definition, store)
  assert.equal(appended.mode, 'appended')
  await commitScenarioWrite(appended)
  const merged = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(merged.projects.length, 2)
  assert.equal(merged.projects[1].id, 'site-2')
})

test('unparseable or invalid existing config is refused before any write', async () => {
  const workspace = await dir()
  const store = await dir()
  const file = join(workspace, 'page-preview.config.json')
  await writeFile(file, '{broken')
  await assert.rejects(planScenarioWrite(workspace, { id: 'site', root: '.' }, 's', definition, store),
    ConfigWriteError)
  await writeFile(file, JSON.stringify({
    schemaVersion: 1, projects: [{ id: 'site', root: '.', runtime: { nope: 1 } }],
  }))
  await assert.rejects(planScenarioWrite(workspace, { id: 'site', root: '.' }, 's', definition, store),
    /does not validate/)
  // 拒绝后原文件未被改动。
  assert.match(await readFile(file, 'utf8'), /nope/)
})

test('a created-mode commit refuses when the file appeared concurrently', async () => {
  const workspace = await dir()
  const store = await dir()
  const plan = await planScenarioWrite(workspace, { id: 'site', root: '.' }, 'filled', definition, store)
  await writeFile(join(workspace, 'page-preview.config.json'), '{}')
  const error = await commitScenarioWrite(plan).then(
    () => { throw new Error('commit must reject') },
    (reason: unknown) => reason)
  assert.ok(error instanceof ConfigWriteError && error.stale,
    'a file appearing after planning is a stale plan, not an overwrite')
})

test('a merged-mode commit refuses when the base file changed after planning (TOCTOU)', async () => {
  const workspace = await dir()
  const store = await dir()
  const file = join(workspace, 'page-preview.config.json')
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    projects: [{ id: 'site', root: '.', runtime: {}, scenarios: { base: {} } }],
  }))
  const plan = await planScenarioWrite(workspace, { id: 'site', root: '.' }, 'filled', definition, store)
  assert.equal(plan.mode, 'merged')
  // 审批窗口内文件被外部改掉：commit 必须拒绝，既不覆盖它也不产出备份。
  await writeFile(file, JSON.stringify({ schemaVersion: 1, projects: [{ id: 'other', root: '.' }] }))
  const error = await commitScenarioWrite(plan).then(
    () => { throw new Error('commit must reject') },
    (reason: unknown) => reason)
  assert.ok(error instanceof ConfigWriteError && error.stale, 'a changed base file is a stale plan')
  assert.match(await readFile(file, 'utf8'), /other/, 'the concurrently edited file is left untouched')
  assert.deepEqual((await readdir(workspace)).filter(name => name.includes('.bak-')), [],
    'a stale plan produces no backup either')
  const buckets = join(store, 'config-backups')
  const total = await readdir(buckets).catch(() => [] as string[])
  for (const bucket of total) {
    assert.deepEqual(await readdir(join(buckets, bucket)), [], 'a stale plan leaves its bucket empty')
  }
})

test("merge mode appends only new fixture keys and adds absent scenario fields", async () => {
  const workspace = await dir()
  const store = await dir()
  const file = join(workspace, 'page-preview.config.json')
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    projects: [{ id: 'site', root: '.', runtime: {},
      scenarios: { guest: { businessPaths: ['/api/**'],
        http: [{ method: 'GET', path: '/api/orders', response: { status: 200, body: { a: 1 } } }] } } }],
  }))
  const incoming: ScenarioConfig = {
    // 与既有值完全相同（键序无关）→ 幂等；envelope 是新增字段 → 允许加进既有场景。
    businessPaths: ['/api/**'],
    envelope: { template: { code: 0, msg: 'ok', data: '__DSH_PREVIEW_DATA__' } },
    http: [
      { method: 'GET', path: '/api/menu', response: { status: 200, body: { items: [] } } },
      // query 不同即不同键，不冲突、原样追加。
      { method: 'GET', path: '/api/orders', query: { page: '2' },
        response: { status: 200, body: { a: 2 } } },
    ],
  }
  const plan = await planScenarioWrite(workspace, { id: 'site', root: '.' }, 'guest', incoming, store, 'merge')
  assert.equal(plan.mode, 'merged')
  await commitScenarioWrite(plan)
  const merged = JSON.parse(await readFile(file, 'utf8'))
  const guest = merged.projects[0].scenarios.guest
  assert.equal(guest.http.length, 3)
  assert.deepEqual(guest.http.map((f: { path: string }) => f.path),
    ['/api/orders', '/api/menu', '/api/orders'])
  assert.equal(guest.http[2].query.page, '2')
  // 既有 fixture 字段原样保留——merge 不覆盖。
  assert.deepEqual(guest.http[0].response.body, { a: 1 })
  assert.deepEqual(guest.envelope.template, { code: 0, msg: 'ok', data: '__DSH_PREVIEW_DATA__' })
})

test("merge mode rejects wholly on fixture key or field conflicts, listing the keys", async () => {
  const workspace = await dir()
  const store = await dir()
  const file = join(workspace, 'page-preview.config.json')
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    projects: [{ id: 'site', root: '.', runtime: {},
      scenarios: { guest: { businessPaths: ['/api/**'], envelope: { template: { code: 0, data: '__DSH_PREVIEW_DATA__' } },
        http: [{ method: 'GET', path: '/api/orders', response: { status: 200, body: {} } }] } } }],
  }))
  const before = await readFile(file, 'utf8')
  // fixture 键冲突 + 场景级字段值冲突：整体拒绝、列出冲突键，文件原样。
  await assert.rejects(planScenarioWrite(workspace, { id: 'site', root: '.' }, 'guest', {
    http: [{ method: 'get', path: '/api/orders', response: { status: 200, body: { b: 2 } } }],
  }, store, 'merge'), /conflicts on GET  \/api\/orders/)
  await assert.rejects(planScenarioWrite(workspace, { id: 'site', root: '.' }, 'guest', {
    envelope: { template: { code: 200, data: '__DSH_PREVIEW_DATA__' } },
  }, store, 'merge'), /field envelope/)
  assert.equal(await readFile(file, 'utf8'), before, 'a rejected merge leaves the file byte-identical')
  // merge 要求场景与项目条目已存在；不存在时如实拒绝并指向 create。
  await assert.rejects(planScenarioWrite(workspace, { id: 'site', root: '.' }, 'other', {
    http: [],  }, store, 'merge'), /does not exist.*mode create/)
  await assert.rejects(planScenarioWrite(workspace, { id: 'site-2', root: '.' }, 'guest', {
    http: [],  }, store, 'merge'), /has no entry.*mode create/)
  const empty = await dir()
  await assert.rejects(planScenarioWrite(empty, { id: 'site', root: '.' }, 'guest', {
    http: [],  }, store, 'merge'), /does not exist.*mode create/)
})

test('a merged-mode commit refuses when the base file was deleted after planning', async () => {
  const workspace = await dir()
  const store = await dir()
  const file = join(workspace, 'page-preview.config.json')
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    projects: [{ id: 'site', root: '.', runtime: {}, scenarios: { base: {} } }],
  }))
  const plan = await planScenarioWrite(workspace, { id: 'site', root: '.' }, 'filled', definition, store)
  await rm(file)
  const error = await commitScenarioWrite(plan).then(
    () => { throw new Error('commit must reject') },
    (reason: unknown) => reason)
  assert.ok(error instanceof ConfigWriteError && error.stale, 'a deleted base file is a stale plan')
})
