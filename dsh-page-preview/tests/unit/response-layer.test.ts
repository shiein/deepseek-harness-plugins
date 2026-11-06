import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCsp } from '../../src/runner/response-layer/csp.ts'
import { isAllowedHost } from '../../src/runner/response-layer/host-check.ts'
import { injectBootstrap } from '../../src/runner/response-layer/inject.ts'
import { withOwnedResponseHeaders } from '../../src/runner/response-layer/server.ts'

test('bootstrap is injected right after <head>', () => {
  const html = '<!doctype html><html><head><script src="/app.js"></script></head></html>'
  const out = injectBootstrap(html, 'void 0')
  assert.ok(out.indexOf('data-dsh-preview-bootstrap') < out.indexOf('/app.js'))
})

test('bootstrap body cannot close its script tag early', () => {
  const out = injectBootstrap('<head></head>', 'var s = "</script>"')
  assert.equal(out.match(/<\/script>/g)?.length, 1)
})

test('host check rejects rebinding hosts', () => {
  assert.ok(isAllowedHost('127.0.0.1:5173'))
  assert.ok(isAllowedHost('localhost'))
  assert.ok(isAllowedHost('[::1]:8080'))
  assert.equal(isAllowedHost('evil.example.com:5173'), false)
  assert.equal(isAllowedHost(undefined), false)
})

test('csp defaults to self-only connections', () => {
  const policy = buildCsp()
  for (const directive of ["default-src 'self'", "connect-src 'self'", "form-action 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'", "style-src 'self' 'unsafe-inline'", "worker-src 'self' blob:", "frame-src 'self'", "img-src 'self' data: blob:"]) assert.ok(policy.split('; ').includes(directive))
})

test('project response headers preserve ordinary values but cannot override owned CSP/CORS/cache/frame policy by case variants', () => {
  assert.deepEqual(withOwnedResponseHeaders({ 'Content-Security-Policy': 'unsafe-one', 'content-security-policy': 'unsafe-two', 'Access-Control-Allow-Origin': '*', 'X-Frame-Options': 'DENY', 'Cache-Control': 'public', 'X-Custom': 'kept' }, { 'Content-Security-Policy': 'owned', 'Cache-Control': 'no-store' }), { 'X-Custom': 'kept', 'Content-Security-Policy': 'owned', 'Cache-Control': 'no-store' })
})
