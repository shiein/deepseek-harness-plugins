/** 未命中响应草稿的项目数据来源（R5-1b）：mock 数据 → OpenAPI 显式 example；schema 取样只进 shapeHint。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectFixtureSources } from '../../src/scenario/fixture-sources.ts'
import { draftFixtures, FIXTURE_PLACEHOLDER } from '../../src/scenario/fixture-draft.ts'
import { validateConfig } from '../../src/shared/config/schema.ts'

async function root(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sources-'))
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name.split('/').slice(0, -1).join('/')), { recursive: true })
    await writeFile(join(dir, name), content)
  }
  return dir
}

test('project mock JSON files resolve bodies verbatim, method-suffixed files gate the method', async () => {
  const dir = await root({
    'mock/api/orders.get.json': JSON.stringify({ items: [{ id: 7, total: 30 }] }),
    'mock/any/list.json': JSON.stringify({ rows: ['a'] }),
    'mock/broken/bad.json': '{not json',
    'mock/get.json': '{}',
    'mock/null/empty.json': 'null',
  })
  const { resolve } = await collectFixtureSources(dir)
  const orders = resolve({ method: 'GET', path: '/api/orders' })
  assert.ok(orders !== undefined && 'body' in orders)
  assert.deepEqual(orders.body, { items: [{ id: 7, total: 30 }] })
  assert.match(orders.provenance, /mock\/api\/orders\.get\.json/)
  // 方法不匹配的后缀文件不命中。
  assert.equal(resolve({ method: 'POST', path: '/api/orders' }), undefined)
  // 无方法后缀的文件匹配任意方法。
  const list = resolve({ method: 'DELETE', path: '/any/list' })
  assert.ok(list !== undefined && 'body' in list && list.body !== undefined)
  // mock 文件内容为 null 也是真实数据，不回落成占位标记。
  const empty = resolve({ method: 'GET', path: '/null/empty' })
  assert.ok(empty !== undefined && 'body' in empty && empty.body === null)
  // 非法 JSON 与只有方法名没有路径的文件被跳过。
  assert.equal(resolve({ method: 'GET', path: '/broken/bad' }), undefined)
  assert.equal(resolve({ method: 'GET', path: '/' }), undefined)
})

test('OpenAPI explicit examples resolve real bodies; schema-only responses become shape hints', async () => {
  const dir = await root({
    'docs/openapi.yaml': [
      'openapi: 3.0.0',
      'paths:',
      '  /api/orders/{id}:',
      '    get:',
      '      responses:',
      "        '200':",
      '          content:',
      '            application/json:',
      '              schema: { $ref: "#/components/schemas/Order" }',
      '  /api/health:',
      '    get:',
      '      responses:',
      "        '200':",
      '          content:',
      '            application/json:',
      '              example: { ok: true }',
      '  /api/examples/orders:',
      '    get:',
      '      responses:',
      "        '200':",
      '          content:',
      '            application/json:',
      '              examples:',
      '                first: { value: { id: 1 } }',
      'components:',
      '  schemas:',
      '    Order:',
      '      type: object',
      '      properties:',
      '        id: { type: integer, example: 42 }',
      '        paid: { type: boolean }',
      '    ',
    ].join('\n'),
  })
  const { resolve } = await collectFixtureSources(dir)
  const health = resolve({ method: 'GET', path: '/api/health' })
  assert.ok(health !== undefined && 'body' in health)
  assert.deepEqual(health.body, { ok: true })
  assert.match(health.provenance, /docs\/openapi\.yaml.*GET \/api\/health/)
  // media.examples 首个条目的 .value 也是显式写出的真实数据。
  const examples = resolve({ method: 'GET', path: '/api/examples/orders' })
  assert.ok(examples !== undefined && 'body' in examples)
  assert.deepEqual(examples.body, { id: 1 })
  // {id} 模板匹配具体路径；只有 schema 可取样时给 shapeHint，绝不产生 body（R5-fix1）。
  const order = resolve({ method: 'GET', path: '/api/orders/42' })
  assert.ok(order !== undefined && 'shapeHint' in order && !('body' in order))
  assert.deepEqual(order.shapeHint.shape, { id: 42, paid: false })
  assert.match(order.shapeHint.provenance, /values are schema-derived examples, not real data/)
  // 模板不匹配不同段数的路径。
  assert.equal(resolve({ method: 'GET', path: '/api/orders' }), undefined)
  assert.equal(resolve({ method: 'POST', path: '/api/orders/42' }), undefined)
})

test('TypeScript types never produce sources: values guessed from type names are not real data', async () => {
  // R5-fix1：按 URL 猜 TS 类型名一层已删除（精度低、属过度设计）——类型字段即使名字
  // 恰好匹配路径段也不能当作响应数据，保持未命中（占位标记由调用方保留）。
  const dir = await root({
    'src/types/order.ts': [
      'export interface Order {',
      '  id: number',
      "  status: 'paid' | 'open'",
      '  owner: string',
      '}',
    ].join('\n'),
  })
  const { resolve } = await collectFixtureSources(dir)
  assert.equal(resolve({ method: 'GET', path: '/api/orders' }), undefined)
  assert.equal(resolve({ method: 'GET', path: '/api/order' }), undefined)
})

test('precedence is project mock data, then OpenAPI example, then schema hint', async () => {
  const dir = await root({
    'mock/api/orders.get.json': '"mock wins"',
    'openapi.json': JSON.stringify({
      paths: {
        '/api/orders': {
          get: { responses: { '200': { content: { 'application/json': { example: 'openapi' } } } } },
        },
        '/api/schema-only': {
          get: { responses: { '200': { content: { 'application/json': {
            schema: { type: 'object', properties: { id: { type: 'integer' } } } } } } },
          },
        },
      },
    }),
    'src/types.ts': 'interface Order { id: number }',
  })
  const { resolve } = await collectFixtureSources(dir)
  const orders = resolve({ method: 'GET', path: '/api/orders' })
  assert.ok(orders !== undefined && 'body' in orders && orders.body === 'mock wins')
  const schemaOnly = resolve({ method: 'GET', path: '/api/schema-only' })
  assert.ok(schemaOnly !== undefined && 'shapeHint' in schemaOnly)
  assert.deepEqual(schemaOnly.shapeHint.shape, { id: 0 })
})

test('missing application root rejects; a schema-hint draft keeps the placeholder and fails write-back', async () => {
  await assert.rejects(collectFixtureSources(join(tmpdir(), 'dsh-sources-missing-' + Date.now())))
  // draftFixtures：body 命中替换占位，shapeHint 只进提示、响应体保持标记。
  const resolve = (entry: { method: string; path: string }) => {
    if (entry.path === '/api/real') return { body: { real: true }, provenance: 'test source' }
    if (entry.path === '/api/schema') {
      return { shapeHint: { shape: { id: 0 }, provenance: 'sampled schema; not real data' } }
    }
    return undefined
  }
  const draft = draftFixtures('s', [
    { method: 'get', path: '/api/real', queryKeys: [], count: 1 },
    { method: 'get', path: '/api/schema', queryKeys: [], count: 1 },
    { method: 'get', path: '/api/miss', queryKeys: [], count: 1 },
  ], 20, resolve)
  const real = draft.fixtures.find(fixture => fixture.path === '/api/real')
  const hinted = draft.fixtures.find(fixture => fixture.path === '/api/schema')
  const miss = draft.fixtures.find(fixture => fixture.path === '/api/miss')
  assert.deepEqual(real?.response.body, { real: true })
  assert.equal(real?.provenance, 'test source')
  assert.equal(hinted?.response.body, FIXTURE_PLACEHOLDER)
  assert.equal(miss?.response.body, FIXTURE_PLACEHOLDER)
  assert.equal(draft.shapeHints?.length, 1)
  assert.equal(draft.shapeHints[0]?.path, '/api/schema')
  assert.deepEqual(draft.shapeHints[0]?.shape, { id: 0 })
  assert.match(draft.shapeHints[0]!.provenance, /not real data/)
  // 带 shapeHint 的草稿直接写回必须被拒绝：configSnippet 仍含占位标记，config_invalid。
  const config = {
    schemaVersion: 1,
    projects: [{ id: 'app', root: '.', runtime: { strategy: 'static', adapter: 'static' },
      scenarios: JSON.parse(draft.configSnippet) }],
  }
  const result = validateConfig(config)
  assert.ok(result.issues.some(issue => issue.message.includes('placeholder')),
    'a draft with only a shape hint must stay rejected: ' + JSON.stringify(result.issues))
})
