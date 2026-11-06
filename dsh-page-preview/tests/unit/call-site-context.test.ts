/**
 * R6-2 collectCallSiteContext 单测（`docs/r6-plan.md` §3 R6-2）。
 * 覆盖：字面量命中、静态模板前缀、baseURL 前缀不一致（suffix）、不安全前缀不误配、
 * 无类型 API 只给 sites/consumers、显式类型给 typeHint、预算触顶 limited、
 * env 文件与 node_modules 等目录排除、敏感片段脱敏。样本均为临时目录内合成源码。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectCallSiteContext } from '../../src/scenario/call-site-context.ts'
import { createRedactor } from '../../src/shared/redact.ts'

const SECRET = 'bearer-secret-token-9f8e'

async function project(files: Record<string, string>): Promise<{ root: string; clean: () => Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-callsite-')))
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, text)
  }
  return { root, clean: () => rm(root, { recursive: true, force: true }) }
}

const key = (contexts: Map<string, unknown>, path: string, method = 'GET') =>
  contexts.get(method + ' ' + path) as
    | { requestSites: Array<{ file: string; line: number; snippet: string; match: string }>
        consumers: Array<{ file: string; line: number; fields: string[] }>
        typeHint?: { shape: unknown; provenance: string } }
    | undefined

test('collectCallSiteContext matches literal URLs and reports request sites', async t => {
  const { root, clean } = await project({
    'src/api/user.ts': "export const getUserInfo = () => getRequest('/api/user/info')\n",
    'src/api/request.ts': 'export function getRequest<T>(u: string): Promise<T> { return fetch(u) as Promise<T> }\n',
  })
  t.after(clean)
  const { contexts, limited } = await collectCallSiteContext(root, [{ method: 'GET', path: '/api/user/info' }])
  assert.equal(limited, false)
  const context = key(contexts, '/api/user/info')
  assert.equal(context?.requestSites.length, 1)
  assert.equal(context?.requestSites[0]?.file, 'src/api/user.ts')
  assert.equal(context?.requestSites[0]?.match, 'exact')
  assert.match(context?.requestSites[0]?.snippet ?? '', /getRequest/)
})

test('collectCallSiteContext matches static template prefixes', async t => {
  const { root, clean } = await project({
    'src/api/items.ts': 'export const getItem = (id: string) => getRequest(`/api/items/${id}`)\n',
  })
  t.after(clean)
  const { contexts } = await collectCallSiteContext(root, [{ method: 'GET', path: '/api/items/42' }])
  const context = key(contexts, '/api/items/42')
  assert.equal(context?.requestSites.length, 1)
  assert.equal(context?.requestSites[0]?.match, 'template-prefix')
})

test('collectCallSiteContext marks baseURL prefix mismatch as suffix only at / boundary', async t => {
  const { root, clean } = await project({
    'src/api/user.ts': "export const getUserInfo = () => getRequest('/user/info')\n",
    'src/api/misc.ts': [
      "export const misc = () => getRequest('/api')",
      "export const odd = () => getRequest('user/info')",
      '',
    ].join('\n'),
  })
  t.after(clean)
  const { contexts } = await collectCallSiteContext(root, [{ method: 'GET', path: '/api/user/info' }])
  const context = key(contexts, '/api/user/info')
  assert.equal(context?.requestSites.length, 1)
  assert.equal(context?.requestSites[0]?.match, 'suffix')
  // '/api' 不是 path 的后缀；'user/info' 不在 '/' 边界切片内——都不得误配。
  assert.equal(context?.requestSites.some(site => site.snippet.includes("'/api'")), false)
  assert.equal(context?.requestSites.some(site => site.snippet.includes("'user/info'")), false)
})

// R6-F1：单段后缀（/list、/info）与非请求语法位置（路由表 path、localStorage）一律不误配。
test('collectCallSiteContext never misfires single-segment suffixes or non-request literals', async t => {
  const { root, clean } = await project({
    'src/api/menu.ts': "export const getMenu = () => getRequest('/menu/list')\n",
    'src/router/index.ts': [
      "import { createRouter } from 'vue-router'",
      'const routes = [',
      "  { path: '/menu/list', component: MenuPage },",
      "  { path: '/list', component: ListPage },",
      ']',
      'createRouter({ routes })',
      '',
    ].join('\n'),
    'src/storage.ts': [
      "export const keep = () => localStorage.getItem('/user/info')",
      "export const drop = () => sessionStorage.removeItem('/menu/list')",
      "export const nav = () => router.push('/user/info')",
      '',
    ].join('\n'),
  })
  t.after(clean)
  const { contexts } = await collectCallSiteContext(root, [
    { method: 'GET', path: '/api/menu/list' },
    { method: 'GET', path: '/api/user/info' },
  ])
  const menu = key(contexts, '/api/menu/list')
  assert.equal(menu?.requestSites.length, 1)
  assert.equal(menu?.requestSites[0]?.file, 'src/api/menu.ts')
  assert.equal(menu?.requestSites[0]?.match, 'suffix')
  // '/api/user/info' 无真实请求点：/info 单段后缀与 storage/router 调用都不得给出条目。
  assert.equal(key(contexts, '/api/user/info'), undefined)
})

// R6-F1：同一条目存在 exact/template-prefix 命中时，suffix 命中被压制。
test('collectCallSiteContext suppresses suffix sites when an exact site exists for the entry', async t => {
  const { root, clean } = await project({
    'src/api/a-first.ts': "export const legacy = () => getRequest('/user/info')\n",
    'src/api/b-second.ts': "export const current = () => getRequest('/api/user/info')\n",
  })
  t.after(clean)
  const { contexts } = await collectCallSiteContext(root, [{ method: 'GET', path: '/api/user/info' }])
  const context = key(contexts, '/api/user/info')
  assert.equal(context?.requestSites.length, 1)
  assert.equal(context?.requestSites[0]?.match, 'exact')
  assert.equal(context?.requestSites[0]?.file, 'src/api/b-second.ts')
})

// R6-F1：误配候选不占 perEntry 名额——被过滤掉的字面量不挤掉真实请求点。
test('collectCallSiteContext keeps the per-entry budget for real request calls', async t => {
  const { root, clean } = await project({
    'src/a-router.ts': 'export const routes = [{ path: \'/menu/list\' }]\n',
    'src/b-store.ts': "export const keep = () => localStorage.getItem('/menu/list')\n",
    'src/c-api.ts': "export const getMenu = () => getRequest('/menu/list')\n",
  })
  t.after(clean)
  const { contexts, limited } = await collectCallSiteContext(root,
    [{ method: 'GET', path: '/api/menu/list' }], { files: 5000, timeMs: 1500, perEntry: 1 })
  const context = key(contexts, '/api/menu/list')
  assert.equal(limited, false)
  assert.equal(context?.requestSites.length, 1)
  assert.equal(context?.requestSites[0]?.file, 'src/c-api.ts')
  assert.equal(context?.requestSites[0]?.match, 'suffix')
})

test('collectCallSiteContext does not match unrelated literal prefixes', async t => {
  const { root, clean } = await project({
    'src/api/a.ts': [
      "export const a = () => getRequest('/api/use')",
      "export const b = () => getRequest('/user/information')",
      '',
    ].join('\n'),
  })
  t.after(clean)
  const { contexts } = await collectCallSiteContext(root, [{ method: 'GET', path: '/api/user/info' }])
  const context = key(contexts, '/api/user/info')
  assert.equal(context, undefined)
})

test('collectCallSiteContext collects consumers with property chains', async t => {
  const { root, clean } = await project({
    'src/api/user.ts': "export const getMenu = () => getRequest('/api/menu')\n",
    'src/page.ts': [
      "import { getMenu } from './api/user'",
      'const load = async () => {',
      '  const res = await getMenu()',
      '  state.list = res.data.menuList',
      '  state.total = res.data.total',
      '}',
      'getMenu().then(d => d.data.code)',
      '',
    ].join('\n'),
  })
  t.after(clean)
  const { contexts } = await collectCallSiteContext(root, [{ method: 'GET', path: '/api/menu' }])
  const context = key(contexts, '/api/menu')
  assert.equal(context?.requestSites.length, 1)
  assert.equal(context?.consumers.length, 2)
  const bound = context?.consumers.find(value => value.fields.includes('data.menuList'))
  assert.deepEqual(bound?.fields, ['data.menuList', 'data.total'])
  assert.equal(bound?.file, 'src/page.ts')
  assert.ok(context?.consumers.some(value => value.fields.includes('data.code')))
})

test('collectCallSiteContext expands explicit type arguments into typeHint', async t => {
  const { root, clean } = await project({
    'src/api/user.ts': [
      'interface UserInfo { name: string; roles: string[]; detail?: { level: number } }',
      "export const getUserInfo = () => getRequest<UserInfo>('/api/user/info')",
      "export const getAny = () => getRequest<any>('/api/any')",
      "export const getUntyped = () => getRequest('/api/untyped')",
      '',
    ].join('\n'),
  })
  t.after(clean)
  const { contexts } = await collectCallSiteContext(root, [
    { method: 'GET', path: '/api/user/info' },
    { method: 'GET', path: '/api/any' },
    { method: 'GET', path: '/api/untyped' },
  ])
  const typed = key(contexts, '/api/user/info')
  assert.deepEqual(typed?.typeHint?.shape, { name: 'string', roles: ['string'], detail: { level: 'number' } })
  assert.match(typed?.typeHint?.provenance ?? '', /UserInfo/)
  assert.match(typed?.typeHint?.provenance ?? '', /src\/api\/user\.ts/)
  // any 与未注解不给 typeHint；但 sites/consumers 仍照常。
  const untypedAny = key(contexts, '/api/any')
  assert.equal(untypedAny?.typeHint, undefined)
  assert.equal(untypedAny?.requestSites.length, 1)
  const untyped = key(contexts, '/api/untyped')
  assert.equal(untyped?.typeHint, undefined)
  assert.equal(untyped?.requestSites.length, 1)
})

test('collectCallSiteContext uses explicit return annotations when generics are absent', async t => {
  const { root, clean } = await project({
    'src/api/types.ts': 'export interface Menu { items: { id: number; title: string }[] }\n',
    'src/api/menu.ts': [
      "import type { Menu } from './types'",
      'export function getMenu(): Promise<Menu> {',
      "  return getRequest('/api/menu') as Promise<Menu>",
      '}',
      '',
    ].join('\n'),
  })
  t.after(clean)
  const { contexts } = await collectCallSiteContext(root, [{ method: 'GET', path: '/api/menu' }])
  const context = key(contexts, '/api/menu')
  assert.deepEqual(context?.typeHint?.shape, { items: [{ id: 'number', title: 'string' }] })
  assert.match(context?.typeHint?.provenance ?? '', /Menu/)
})

test('collectCallSiteContext parses <script> blocks of .vue files', async t => {
  const { root, clean } = await project({
    'src/api/menu.ts': "export const getMenu = () => getRequest('/api/menu')\n",
    'src/Home.vue': [
      '<template><div /></template>',
      '<script setup lang="ts">',
      "import { getMenu } from './api/menu'",
      'const res = await getMenu()',
      'console.log(res.data.items)',
      '</script>',
      '',
    ].join('\n'),
  })
  t.after(clean)
  const { contexts } = await collectCallSiteContext(root, [{ method: 'GET', path: '/api/menu' }])
  const context = key(contexts, '/api/menu')
  assert.equal(context?.requestSites.length, 1)
  const consumer = context?.consumers.find(value => value.file === 'src/Home.vue')
  assert.equal(consumer?.line, 4)
  assert.deepEqual(consumer?.fields, ['data.items'])
})

test('collectCallSiteContext reports limited when per-entry budget is exceeded', async t => {
  const files: Record<string, string> = {}
  for (const name of ['a', 'b', 'c']) files[`src/${name}.ts`] = `export const ${name} = () => getRequest('/api/x')\n`
  const { root, clean } = await project(files)
  t.after(clean)
  const { contexts, limited } = await collectCallSiteContext(root,
    [{ method: 'GET', path: '/api/x' }], { files: 5000, timeMs: 1500, perEntry: 1 })
  assert.equal(limited, true)
  assert.equal(key(contexts, '/api/x')?.requestSites.length, 1)
})

test('collectCallSiteContext reports limited when the time budget is exhausted', async t => {
  const files: Record<string, string> = { 'src/a.ts': "export const a = () => getRequest('/api/x')\n" }
  for (let i = 0; i < 8; i++) files[`src/f${i}.ts`] = `export const f${i} = ${i}\n`
  const { root, clean } = await project(files)
  t.after(clean)
  let tick = 0
  const { limited } = await collectCallSiteContext(root,
    [{ method: 'GET', path: '/api/x' }], { files: 5000, timeMs: 2, perEntry: 3 }, { now: () => (tick += 1) })
  assert.equal(limited, true)
})

test('collectCallSiteContext skips .env, node_modules, dist, build, coverage', async t => {
  const { root, clean } = await project({
    'src/api.ts': "export const api = () => getRequest('/api/x')\n",
    '.env.local': 'X=/api/x\nSECRET=1\n',
    'node_modules/pkg/index.ts': "export const n = () => getRequest('/api/x')\n",
    'dist/bundle.js': "const d = () => getRequest('/api/x')\n",
    'coverage/lcov-report/x.js': "const c = () => getRequest('/api/x')\n",
    'build/out.js': "const b = () => getRequest('/api/x')\n",
  })
  t.after(clean)
  const { contexts } = await collectCallSiteContext(root, [{ method: 'GET', path: '/api/x' }])
  const context = key(contexts, '/api/x')
  assert.equal(context?.requestSites.length, 1)
  assert.equal(context?.requestSites[0]?.file, 'src/api.ts')
})

test('collectCallSiteContext redacts credentials and channel values in snippets', async t => {
  const { root, clean } = await project({
    'src/api.ts': [
      `const headers = { Authorization: 'Bearer ${SECRET}' }`,
      "export const api = () => getRequest('/api/x', { headers })",
      '',
    ].join('\n'),
  })
  t.after(clean)
  const redactor = createRedactor({ secrets: [SECRET], channels: ['nonce-value-123'] })
  const { contexts } = await collectCallSiteContext(root, [{ method: 'GET', path: '/api/x' }],
    undefined, { redact: redactor.text })
  const snippets = JSON.stringify(key(contexts, '/api/x'))
  assert.equal(snippets.includes(SECRET), false)
  assert.equal(snippets.includes('nonce-value-123'), false)
})
