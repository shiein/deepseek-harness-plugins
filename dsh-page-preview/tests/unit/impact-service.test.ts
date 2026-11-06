/** Host 影响服务：轮次基线/项目装配/适配器调用（方案 §5.2、§5.3；R3-4）；临时工作区真扫盘，不起进程。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { ImpactService } from '../../src/host/impact-service.ts'

async function workspace(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-impact-service-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path: string, content: string) => {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return { root, put }
}
const config = (runtime: object) =>
  JSON.stringify({ schemaVersion: 1, projects: [{ id: 'web', root: '.', runtime }] })

test('analyzeNow without a turn baseline reports degraded instead of guessing', async t => {
  const { root } = await workspace(t)
  const service = new ImpactService()
  const result = await service.analyzeNow('s-unknown')
  assert.deepEqual(result.candidates, [])
  assert.ok(result.degraded.some(value => value.includes('No turn baseline')))
  assert.equal(service.latest('s-unknown'), undefined)
})

test('configured static project: an edited public page becomes a strong candidate and is cached', async t => {
  const { root, put } = await workspace(t)
  await put('page-preview.config.json', config({ adapter: 'static', publicRoot: 'public' }))
  await put('public/index.html', '<html><body>v1</body></html>')
  await put('notes/todo.md', 'not an app file')
  const service = new ImpactService()
  await service.beginTurn('s1', root)
  await put('public/index.html', '<html><body>v2</body></html>')
  await put('notes/todo.md', 'still not an app file')
  const result = await service.analyzeNow('s1')
  const hit = result.candidates.find(value =>
    value.selector.kind === 'file' && (value.selector as { path: string }).path === 'public/index.html')
  assert.ok(hit, JSON.stringify(result))
  assert.equal(hit.evidence, 'strong')
  assert.equal(hit.origin, 'workspace-observed')
  assert.ok(result.unrelated.includes('notes/todo.md'), JSON.stringify(result.unrelated))
  // apps 投影供 R3-5 通知判定：工作区根即应用根时记 ''。
  assert.deepEqual(result.apps, [{ projectId: 'web', root: '' }])
  assert.equal(service.latest('s1'), result, 'latest() returns the cached analysis')
})

test('recordAgentWrites marks agent-confirmed paths and ignores unknown sessions', async t => {
  const { root, put } = await workspace(t)
  await put('page-preview.config.json', config({ adapter: 'static', publicRoot: 'public' }))
  await put('public/index.html', '<html />')
  const service = new ImpactService()
  service.recordAgentWrites('no-such-session', [join(root, 'x')])
  await service.beginTurn('s2', root)
  const file = join(root, 'public', 'index.html')
  await put('public/index.html', '<html>v2</html>')
  service.recordAgentWrites('s2', [file])
  const result = await service.analyzeNow('s2')
  const change = result.changes.find(value => value.path === 'public/index.html')!
  assert.equal(change.origin, 'agent-confirmed')
  assert.equal(result.candidates[0]!.origin, 'agent-confirmed')
})

test('publicRoot inside a default-ignored directory is force-included into the baseline', async t => {
  const { root, put } = await workspace(t)
  // node_modules 属 DEFAULT_IGNORES；显式声明为 publicRoot 的目录必须经 forceInclude 重新进入扫描。
  await put('page-preview.config.json',
    config({ adapter: 'static', publicRoot: 'node_modules/pkg/dist' }))
  await put('node_modules/pkg/dist/index.html', '<html><body>v1</body></html>')
  const service = new ImpactService()
  await service.beginTurn('s3', root)
  await put('node_modules/pkg/dist/index.html', '<html><body>v2</body></html>')
  const result = await service.analyzeNow('s3')
  assert.ok(result.candidates.some(value => value.selector.kind === 'file'
    && (value.selector as { path: string }).path === 'node_modules/pkg/dist/index.html'),
    JSON.stringify(result))
})

test('an adapter without read-only impact keeps changes manual and says so', async t => {
  const { root, put } = await workspace(t)
  await put('page-preview.config.json',
    config({ adapter: 'existing-server', origin: 'http://127.0.0.1:8080', publicRoot: 'public' }))
  await put('public/index.html', '<html />')
  const service = new ImpactService()
  await service.beginTurn('s4', root)
  await put('public/index.html', '<html>v2</html>')
  const result = await service.analyzeNow('s4')
  assert.deepEqual(result.candidates, [])
  assert.ok(result.degraded.some(value => value.includes('existing-server')
    && value.includes('no read-only impact analysis')), JSON.stringify(result.degraded))
  // 没有 impact 能力的适配器不组装 project，改动如实落 unrelated，候选不伪造。
  assert.ok(result.unrelated.includes('public/index.html'), JSON.stringify(result.unrelated))
})

test('forget releases turn state; a baseline that cannot be built degrades instead of throwing', async t => {
  const { root } = await workspace(t)
  const service = new ImpactService()
  await service.beginTurn('s5', root)
  service.forget('s5')
  const gone = await service.analyzeNow('s5')
  assert.ok(gone.degraded.some(value => value.includes('No turn baseline')))
  // canonicalPath 对缺失末级回落到最近存在父目录；扫盘在 baseline 阶段如实失败。
  await service.beginTurn('s6', join(root, 'missing', 'dir'))
  const failed = await service.analyzeNow('s6')
  assert.ok(failed.degraded.some(value => value.includes('Baseline creation failed')),
    JSON.stringify(failed.degraded))
})
