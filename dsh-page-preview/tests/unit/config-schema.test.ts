/** 配置结构与引用约束（方案 §8、§15.3）；只解析合成数据与仓库文档，不执行项目代码。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { configJsonSchema, validateConfig } from '../../src/shared/config/schema.ts'

const project = () => ({ id: 'sample', root: '.', runtime: { strategy: 'static', adapter: 'static', publicRoot: 'public' }, targets: [{ id: 'home', selector: { kind: 'file', path: 'public/index.html' } }] })
const file = (value: unknown = project()) => ({ schemaVersion: 1, projects: [value] })
function rejected(value: unknown, expected: string) {
  const result = validateConfig(value)
  assert.equal(result.config, undefined)
  assert.ok(result.issues.some(issue => issue.path.includes(expected)), JSON.stringify(result.issues))
}

test('plan config example and declared optional fields pass without normalization or execution', async () => {
  const plan = await readFile(new URL('../../dsh-page-preview-development-plan.md', import.meta.url), 'utf8')
  const example = /```json\n([\s\S]*?)\n```/.exec(plan.slice(plan.indexOf('## 8. 项目配置协议')))?.[1]
  assert.ok(example)
  const raw: unknown = JSON.parse(example)
  assert.deepEqual(validateConfig(raw), { config: raw, issues: [] })
  const complete = {
    ...file({ ...project(), runtime: { strategy: 'isolated', adapter: 'vue-vite', requirements: ['mock-only'], entry: 'src/main.js', setup: 'preview/setup.js', styles: ['src/style.css'], dependencyRoots: ['../shared'], readiness: { serviceDeadlineMs: 1000, targetDeadlineMs: 2000 } }, scenarios: { admin: { identity: { id: 'synthetic' }, props: { count: 1 }, state: { empty: false }, permissions: ['read'], locale: 'zh-CN', route: { path: '/home', params: { id: '1' }, query: { tab: 'all' } }, handlers: 'preview/handlers.js', businessPaths: ['/api/**'], http: [{ origin: 'http://localhost:1234', method: 'POST', path: '/api', query: { x: '1' }, body: { input: true }, response: { status: 201, headers: { 'Content-Type': 'application/json' }, body: { ok: true } } }] } } }),
    $schema: './page-preview.config.schema.json',
  }
  assert.deepEqual(validateConfig(complete), { config: complete, issues: [] })
})

test('config rejects unknown fields, unknown versions and malformed nested values', () => {
  for (const raw of [null, { schemaVersion: 2, projects: [] }, { ...file(), unknown: true }, file({ ...project(), unknown: true }), file({ ...project(), runtime: { ...project().runtime, typo: true } }), file({ ...project(), scenarios: { x: { http: [{ method: 'GET', path: '/', response: { status: 700 } }] } } }), file({ ...project(), targets: [{ id: 'home', selector: { kind: 'registered', id: 'home' } }] }), file({ ...project(), runtime: { env: { TEST: 1 } } })]) {
    assert.ok(validateConfig(raw).issues.length > 0)
    assert.equal(validateConfig(raw).config, undefined)
  }
})

test('duplicate IDs, duplicate requirements and missing default scenarios fail visibly', () => {
  rejected({ schemaVersion: 1, projects: [project(), project()] }, '/projects/1/id')
  rejected(file({ ...project(), targets: [project().targets[0], project().targets[0]] }), '/targets/1/id')
  rejected(file({ ...project(), targets: [{ ...project().targets[0], defaultScenario: 'absent' }] }), '/defaultScenario')
  rejected(file({ ...project(), runtime: { requirements: ['mock-only', 'mock-only'] } }), '/requirements')
})

test('adapter consistency and project/attach constraints apply when strategy is inferred', () => {
  rejected(file({ ...project(), runtime: { strategy: 'isolated', adapter: 'project-command' } }), '/adapter')
  rejected(file({ ...project(), runtime: { adapter: 'project-command' } }), '/command')
  rejected(file({ ...project(), runtime: { adapter: 'project-command', command: { executable: 'node', args: ['preview.mjs'], cwd: '.' } } }), '/readiness')
  rejected(file({ ...project(), runtime: { adapter: 'existing-server' } }), '/origin')
  rejected(file({ ...project(), runtime: { strategy: 'attach', origin: 'http://127.0.0.1:3000', command: { executable: 'node', args: [], cwd: '.' }, env: {} } }), '/command')
  rejected(file({ ...project(), runtime: { strategy: 'attach', origin: 'http://127.0.0.1:3000', env: {} } }), '/env')
  const command = file({ ...project(), runtime: { adapter: 'project-command', command: { executable: 'node', args: ['preview.mjs'], cwd: '.' }, readiness: { probePath: '/health', serviceDeadlineMs: 1000 } } })
  assert.deepEqual(validateConfig(command), { config: command, issues: [] })
})

test('relative fields reject POSIX, Windows and UNC absolute paths', () => {
  for (const path of ['/absolute', 'C:\\absolute', 'C:/absolute', '\\\\server\\share']) {
    rejected(file({ ...project(), root: path }), '/root')
    rejected(file({ ...project(), runtime: { setup: path } }), '/setup')
    rejected(file({ ...project(), runtime: { command: { executable: 'node', args: [], cwd: path } } }), '/cwd')
  }
  // 越界与符号链接由文件系统路径校验处理；结构层不把相对依赖根误判为绝对路径。
  assert.equal(validateConfig(file({ ...project(), runtime: { setup: '../shared/setup.js' } })).issues.length, 0)
})

test('origins and URL targets stay on the explicit loopback origin without credentials', () => {
  const attached = (origin: string, url: string) => file({ ...project(), runtime: { adapter: 'existing-server', requirements: [], origin }, targets: [{ id: 'home', selector: { kind: 'url', url } }] })
  const valid = attached('http://[::1]:3000', 'http://[::1]:3000/orders?tab=all#detail')
  assert.deepEqual(validateConfig(valid), { config: valid, issues: [] })
  for (const [origin, url] of [['http://example.com', 'http://example.com'], ['http://127.0.0.1:99999', 'http://127.0.0.1:99999'], ['http://127.0.0.1:3000', 'http://127.0.0.1:4000/orders'], ['http://127.0.0.1:3000', 'http://user:synthetic-secret@127.0.0.1:3000/orders']]) {
    assert.ok(validateConfig(attached(origin!, url!)).issues.length > 0)
  }
})

test('validation diagnostics never contain configured env or arbitrary data values', () => {
  const result = validateConfig(file({ ...project(), runtime: { adapter: 'existing-server', origin: 'http://localhost:3000', env: { SYNTHETIC: 'synthetic-secret-do-not-log' } } }))
  assert.ok(result.issues.length)
  assert.doesNotMatch(JSON.stringify(result.issues), /synthetic-secret-do-not-log/)
  const malformed = validateConfig(file({ ...project(), runtime: { strategy: 'synthetic-secret-do-not-log' } }))
  assert.doesNotMatch(JSON.stringify(malformed.issues), /synthetic-secret-do-not-log/)
})

test('checked-in JSON Schema is generated from the same runtime structure', async () => {
  const schema: unknown = JSON.parse(await readFile(new URL('../../schema/page-preview.config.schema.json', import.meta.url), 'utf8'))
  assert.deepEqual(schema, configJsonSchema())
})
