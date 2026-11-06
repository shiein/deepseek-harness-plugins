/** 校验存储样本观察（方案 §7.4、§14）：A/B 只是标签，实际工作区选择仍须有原生 UI 证据。 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [file, offsetText = '0'] = process.argv.slice(2)
if (!file) throw new Error('Usage: verify-phase0-storage.mjs <observations.json> [controlled-observation-offset]')
const offset = Number(offsetText)
assert.ok(Number.isSafeInteger(offset) && offset >= 0)
const record = JSON.parse(await readFile(file, 'utf8'))
assert.equal(record.cleaned, true, 'Stop the sample and verify cleanup before final acceptance')
const events = record.observations.slice(offset)
const empty = { strict: false, lax: false, noneSecure: false, noneInsecure: false }
const seeded = { strict: true, lax: true, noneSecure: true, noneInsecure: false }
let cursor = 0
function storage(label, name, origin, local, cookies) {
  const index = events.findIndex((event, index) => index >= cursor && event.kind === 'storage' && event.label === label && event.case === name && event.sampleOrigin === origin && event.local === local)
  assert.ok(index >= 0, 'Missing storage observation: ' + [label, name, origin, local].join(' '))
  assert.equal(events[index].topLevel, true)
  const request = events[index - 1]
  assert.equal(request.kind, 'request')
  assert.equal(request.case, name)
  assert.equal(request.sampleOrigin, origin)
  assert.deepEqual(request.present, cookies)
  cursor = index + 1
}
storage('A', 'cleared', record.origin, null, empty)
storage('A', 'written', record.origin, 'A', seeded)
storage('A', 'initial', record.origin, 'A', seeded)
storage('A', 'initial', record.otherOrigin, null, seeded)
storage('A', 'initial', record.aliasOrigin, null, empty)
storage('A', 'written', record.aliasOrigin, 'A', seeded)
storage('A', 'initial', record.origin, 'A', seeded)
storage('B', 'initial', record.origin, null, empty)
storage('B', 'written', record.origin, 'B', seeded)
storage('A', 'initial', record.origin, 'A', seeded)
storage('A', 'cleared', record.origin, null, empty)
storage('A', 'initial', record.aliasOrigin, 'A', seeded)
storage('A', 'cleared', record.aliasOrigin, null, empty)
storage('B', 'cleared', record.origin, null, empty)
const crossFetch = events.find(event => event.kind === 'request' && event.case === 'cross-fetch')
assert.ok(crossFetch)
assert.equal(crossFetch.sampleOrigin, record.aliasOrigin)
assert.equal(crossFetch.site, 'cross-site')
assert.equal(crossFetch.mode, 'cors')
assert.deepEqual(crossFetch.present, { strict: false, lax: false, noneSecure: true, noneInsecure: false })
const navigation = events.find(event => event.kind === 'request' && event.case === 'cross-navigation')
assert.ok(navigation)
assert.equal(navigation.site, 'cross-site')
assert.equal(navigation.mode, 'navigate')
assert.deepEqual(navigation.present, { strict: false, lax: true, noneSecure: true, noneInsecure: false })
console.log(JSON.stringify({ sameWorkspaceReopen: 'preserved', crossPort: 'cookies-shared-localStorage-separated', manualWorkspaceSequence: 'A/B/A-markers-separated', crossSiteFetch: 'NoneSecure-only', crossSiteNavigation: 'Lax-and-NoneSecure', sampleStateCleared: true, probeStopped: record.cleaned === true }))
