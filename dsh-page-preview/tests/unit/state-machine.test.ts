import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canTransition } from '../../src/shared/state-machine.ts'
import { RunnerSession } from '../../src/runner/session.ts'
import type { PreviewPlan } from '../../src/shared/contracts.ts'

test('stop is reachable from every non-terminal state', () => {
  for (const state of ['preparing', 'starting', 'reachable', 'ready', 'degraded', 'updating', 'failed', 'cleanup_failed'] as const) {
    assert.ok(canTransition(state, 'stopping'), state)
  }
  assert.equal(canTransition('stopped', 'stopping'), false)
})

test('cleanup failure is not stopped', () => {
  assert.ok(canTransition('stopping', 'cleanup_failed'))
  assert.equal(canTransition('cleanup_failed', 'stopped'), false)
})

test('compile error during update keeps previous state and marks stale', () => {
  const session = new RunnerSession('p1', {} as PreviewPlan)
  session.transition('starting')
  session.transition('reachable')
  session.transition('ready')
  session.freshness = 'current'
  session.transition('updating')
  session.applyUpdateResult({ kind: 'compile-error', diagnostics: [] })
  assert.equal(session.state, 'ready')
  assert.equal(session.freshness, 'stale')
  assert.equal(session.diagnostics[0]?.code, 'compile_error')
})
