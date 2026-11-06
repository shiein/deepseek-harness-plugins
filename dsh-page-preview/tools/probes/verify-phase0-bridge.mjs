/** 校验真实 DSH 探针记录（方案 §14）；成功不等于产品 open/status/stop 已实现。 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const path = process.argv[2] ?? new URL('../../output/phase0/carrier-observations.json', import.meta.url)
const value = JSON.parse(await readFile(path, 'utf8'))
assert.equal(value.completed, true)
assert.equal(value.error, undefined)
assert.ok(Number.isFinite(Date.parse(value.startedAt)))
assert.deepEqual(value.commands.map((item) => item.kind), ['open', 'refresh', 'close'])
assert.deepEqual(value.replies.map((item) => item.id), [1, 2, 3])
assert.deepEqual(value.replies.map((item) => item.status), ['accepted', 'accepted', 'accepted'])
assert.equal(value.documentLoads - value.initialDocumentLoads, 2)
console.log('Host→Client: open/refresh/close accepted; 2 actual document loads; target readiness unverified')
