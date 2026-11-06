/** 轮次触发纯决策表（方案 §9.1、R3-5）：off/smart/always 三模式、前缀归属、已有预览不换目标。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideTrigger, DEFAULT_TRIGGER_MODE } from '../../src/host/trigger.ts'
import type { TriggerMode } from '../../src/host/trigger.ts'
import type { Candidate } from '../../src/shared/contracts.ts'
import type { ImpactResult } from '../../src/core/impact/types.ts'

function candidate(projectId: string, evidence: Candidate['evidence'], path = '/a'): Candidate {
  return { projectId, selector: { kind: 'route', path }, relation: ['src/x.ts', 'route ' + path], evidence }
}
function impact(overrides: Partial<ImpactResult> = {}): ImpactResult {
  return {
    candidates: [], omitted: 0, gaps: [], unrelated: [],
    changes: [{ path: 'app/src/x.ts', kind: 'modified', origin: 'workspace-observed' }],
    apps: [], degraded: [], ...overrides,
  }
}
const owned = (previewId: string, projectId: string, state = 'ready') => ({ previewId, projectId, state })

test('off mode never acts regardless of affected previews or candidates', () => {
  const result = decideTrigger('off', impact({
    candidates: [candidate('site', 'strong')],
    apps: [{ projectId: 'site', root: 'app' }],
    changes: [{ path: 'app/src/x.ts', kind: 'modified', origin: 'workspace-observed' }],
  }), [owned('p1', 'site')])
  assert.deepEqual(result, [{ kind: 'none', reason: 'Turn-end triggers are disabled (trigger: off)' }])
})

test('smart notifies owned previews by application-root prefix, including candidate-free build inputs', () => {
  const result = decideTrigger('smart', impact({
    apps: [{ projectId: 'site', root: 'app' }],
    changes: [
      { path: 'app/vite.config.ts', kind: 'modified', origin: 'workspace-observed' },
      { path: 'other/readme.md', kind: 'modified', origin: 'workspace-observed' },
    ],
    // 构建配置变化不产生页面候选，但预览仍须收到 inputs-changed。
    candidates: [],
  }), [owned('p1', 'site'), owned('p2', 'other')])
  assert.deepEqual(result, [{ kind: 'notify-inputs', previewId: 'p1', paths: ['app/vite.config.ts'] }])
})

test('previews in non-notifiable states are skipped; an empty application root matches every path', () => {
  const states = ['preparing', 'starting', 'failed', 'stopped', 'stopping', 'cleanup_failed']
  const value = impact({ apps: [{ projectId: 'site', root: '' }] })
  const result = decideTrigger('smart', value,
    [...states.map((state, index) => owned('skip' + index, 'site', state)), owned('live', 'site', 'degraded')])
  assert.deepEqual(result, [{ kind: 'notify-inputs', previewId: 'live', paths: ['app/src/x.ts'] }])
})

test('an affected preview is refreshed, never replaced by a recommendation', () => {
  const result = decideTrigger('always', impact({
    candidates: [candidate('site', 'strong')],
    apps: [{ projectId: 'site', root: 'app' }],
  }), [owned('p1', 'site')])
  assert.deepEqual(result.map(action => action.kind), ['notify-inputs'])
})

test('no candidates and no affected owned preview produce a none action', () => {
  const result = decideTrigger('smart', impact({
    apps: [{ projectId: 'site', root: 'app' }],
    changes: [{ path: 'docs/readme.md', kind: 'added', origin: 'workspace-observed' }],
    unrelated: ['docs/readme.md'],
  }), [owned('p1', 'site')])
  assert.deepEqual(result, [{ kind: 'none', reason: 'No turn changes affect a previewable target' }])
})

test('smart recommends at most three candidates and never emits auto-open', () => {
  const candidates = ['a', 'b', 'c', 'd'].map((path, index) =>
    candidate('site', index === 0 ? 'strong' : 'medium', '/' + path))
  const result = decideTrigger('smart', impact({ candidates }), [])
  assert.equal(result.length, 1)
  assert.equal(result[0]?.kind, 'recommend')
  assert.deepEqual((result[0] as { candidates: Candidate[] }).candidates.map(item => item.selector),
    candidates.slice(0, 3).map(item => item.selector))
})

test('always adds an auto-open intent only for exactly one strong candidate', () => {
  const single = decideTrigger('always', impact({ candidates: [candidate('site', 'strong')] }), [])
  assert.deepEqual(single.map(action => action.kind), ['recommend', 'auto-open'])
  assert.equal((single[1] as { candidate: Candidate }).candidate.evidence, 'strong')
  for (const candidates of [
    [candidate('site', 'strong'), candidate('site', 'strong', '/b')],
    [candidate('site', 'medium'), candidate('site', 'weak', '/b')],
  ]) {
    const result = decideTrigger('always', impact({ candidates }), [])
    assert.deepEqual(result.map(action => action.kind), ['recommend'])
  }
})

test('the default mode is smart', () => {
  assert.equal(DEFAULT_TRIGGER_MODE satisfies TriggerMode, 'smart')
})
