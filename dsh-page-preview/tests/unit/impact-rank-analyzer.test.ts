/** 影响分析编排与候选排序（方案 §5.2、R3-4）；纯函数，适配器边由桩注入。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { rankCandidates, singleConfidentCandidate } from '../../src/core/impact/rank.ts'
import { analyzeImpact } from '../../src/core/impact/analyzer.ts'
import type { Candidate } from '../../src/shared/contracts.ts'
import type { EffectiveProjectConfig } from '../../src/shared/config/loader.ts'
import type { AdapterImpact, ImpactEdge } from '../../src/core/impact/types.ts'
import type { FileChange } from '../../src/core/change/baseline.ts'

const candidate = (projectId: string, evidence: Candidate['evidence'],
  overrides: Partial<Candidate> = {}): Candidate => ({
  projectId, selector: { kind: 'file', path: 'src/p.vue' },
  relation: ['src/x.ts'], evidence, ...overrides,
})

test('ranking keys: evidence, then origin, then route-bearing relations, chain length, selector order', () => {
  const at = (path: string, evidence: Candidate['evidence'], overrides: Partial<Candidate> = {}) =>
    candidate('app', evidence, { selector: { kind: 'file', path }, ...overrides })
  const ranked = rankCandidates([
    at('src/weak.ts', 'weak', { origin: 'agent-confirmed', relation: ['a'] }),
    at('src/medium.ts', 'medium', { origin: 'agent-confirmed', relation: ['a'] }),
    at('src/unknown.ts', 'strong', { relation: ['a'] }),
    at('src/observed.ts', 'strong', { origin: 'workspace-observed', relation: ['a'] }),
    at('src/long-chain.ts', 'strong', { origin: 'agent-confirmed', relation: ['a', 'b', 'c'] }),
    at('src/short-chain.ts', 'strong', { origin: 'agent-confirmed', relation: ['a', 'b'] }),
    at('src/route-page.ts', 'strong', { origin: 'agent-confirmed', relation: ['a', 'route /p'] }),
  ], 10)
  // strong+agent-confirmed 组内：路由证据 > 链长；之后 observed、unknown；medium/weak 垫底。
  assert.deepEqual(ranked.candidates.map(value => (value.selector as { path: string }).path), [
    'src/route-page.ts', 'src/short-chain.ts', 'src/long-chain.ts',
    'src/observed.ts', 'src/unknown.ts', 'src/medium.ts', 'src/weak.ts',
  ])
})

test('per-change groups keep only maxCandidates representatives and count the rest', () => {
  const shared = Array.from({ length: 5 }, (_, index) => candidate('app', 'strong', {
    relation: ['src/shared.css', 'page' + index],
    selector: { kind: 'file', path: 'src/pages/' + index + '.vue' },
  }))
  const other = candidate('app', 'medium', { relation: ['src/other.css', 'pageX'] })
  const foreign = candidate('other-app', 'strong', { relation: ['src/shared.css', 'page'] })
  const ranked = rankCandidates([...shared, other, foreign], 2)
  assert.equal(ranked.candidates.length, 4, 'two from the shared group, one other, one foreign project')
  assert.equal(ranked.omitted, 3)
  assert.equal(singleConfidentCandidate(ranked), undefined, 'more than one strong candidate is not confident')
})

const change = (path: string): FileChange => ({ kind: 'modified', path, origin: 'workspace-observed' })
const edge = (overrides: Partial<ImpactEdge>): ImpactEdge => ({
  changed: 'src/x.ts', selector: { kind: 'file', path: 'src/p.vue' },
  relation: ['src/x.ts', 'src/p.vue'], evidence: 'medium', scope: 'page', ...overrides,
})
const config = (id: string, targets: EffectiveProjectConfig['project']['targets'] = []): EffectiveProjectConfig =>
  ({ source: { kind: 'detected' }, project: { id, root: '.', runtime: {}, targets }, diagnostics: [] })

test('changes are owned by the longest application root; out-of-app paths become unrelated', async () => {
  const root = join('/', 'ws')
  const calls: string[][] = []
  const result = await analyzeImpact({
    workspaceRoot: root,
    changes: [change('app/deep/x.ts'), change('app/other.ts'), change('nowhere.md')],
    projects: [
      { projectId: 'deep', adapterId: 'a', appRoot: join(root, 'app/deep') },
      { projectId: 'app', adapterId: 'b', appRoot: join(root, 'app') },
    ],
    configs: new Map(),
    adapterImpact: async (project, changes) => {
      calls.push([project.projectId, ...changes.map(value => value.path)])
      return { edges: [], gaps: [], unrelated: [], manualOnly: false }
    },
  })
  assert.deepEqual(calls, [['deep', 'x.ts'], ['app', 'other.ts']])
  assert.deepEqual(result.unrelated, ['nowhere.md'])
  assert.deepEqual(result.apps.map(value => value.projectId + '=' + value.root).sort(),
    ['app=app', 'deep=app/deep'])
})

test('a registered file-target hit wins strong and suppresses the adapter file edge for the same file', async () => {
  const root = join('/', 'ws')
  const adapterEdge = edge({ selector: { kind: 'file', path: 'src/t.vue' }, evidence: 'medium' })
  const result = await analyzeImpact({
    workspaceRoot: root, changes: [change('src/t.vue')],
    projects: [{ projectId: 'app', adapterId: 'a', appRoot: root }],
    configs: new Map([['app', config('app',
      [{ id: 'main', selector: { kind: 'file', path: 'src/t.vue' } }])]]),
    adapterImpact: async () => ({ edges: [adapterEdge], gaps: [], unrelated: [], manualOnly: false }),
  })
  assert.equal(result.candidates.length, 1)
  const hit = result.candidates[0]!
  assert.deepEqual(hit.selector, { kind: 'registered', id: 'main' })
  assert.equal(hit.evidence, 'strong')
  assert.equal(hit.origin, 'workspace-observed')
})

test('adapter edges merge by selector keeping the strongest evidence and shortest relation', async () => {
  const root = join('/', 'ws')
  const weak = edge({ evidence: 'weak', relation: ['a', 'b', 'c'] })
  const strong = edge({ evidence: 'strong', relation: ['a'] })
  const alternate = edge({ selector: { kind: 'route', path: '/p' }, evidence: 'medium' })
  const result = await analyzeImpact({
    workspaceRoot: root, changes: [change('src/x.ts')],
    projects: [{ projectId: 'app', adapterId: 'a', appRoot: root }],
    configs: new Map(),
    adapterImpact: async () => ({ edges: [weak, strong, alternate], gaps: [], unrelated: [], manualOnly: false }),
  })
  assert.equal(result.candidates.length, 2)
  const fileCandidate = result.candidates.find(value => value.selector.kind === 'file')!
  assert.equal(fileCandidate.evidence, 'strong')
  assert.deepEqual(fileCandidate.relation, ['a'])
})

test('manualOnly and adapter gaps reach the result; adapter-unrelated paths stay project-scoped', async () => {
  const root = join('/', 'ws')
  const result = await analyzeImpact({
    workspaceRoot: root, changes: [change('src/x.ts'), change('outside/page.md'), change('stray.md')],
    projects: [
      { projectId: 'app', adapterId: 'a', appRoot: join(root, 'src') },
      { projectId: 'site', adapterId: 'b', appRoot: join(root, 'outside') },
    ],
    configs: new Map(),
    adapterImpact: async project => project.projectId === 'app'
      ? { edges: [], gaps: ['could not parse src/router.ts'], manualOnly: false,
        unrelated: ['inner.md', '../outside/escaped.md'] }
      : { edges: [], gaps: [], unrelated: [], manualOnly: true },
  })
  assert.ok(result.gaps.includes('a: could not parse src/router.ts'))
  assert.ok(result.gaps.includes('b returned manual-only impact analysis'))
  // 适配器上报的 unrelated：解析回工作区内 → 普通相对路径；逃出工作区 → projectId:path 兜底。
  assert.ok(result.unrelated.includes('src/inner.md'), JSON.stringify(result.unrelated))
  assert.ok(result.unrelated.includes('outside/escaped.md'), JSON.stringify(result.unrelated))
  assert.ok(result.unrelated.includes('stray.md'))
})
