/** Phase 0 HMR 判定步骤（方案 §14、§15.3）：只改当前账本登记的临时模块，不操作 Browser UI。 */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createFileLedger, readProcessStartTime } from '../../src/runner/ledger.ts'

const [output, step] = process.argv.slice(2)
const steps = {
  update: { expected: 1, source: "export const revision = 'revision-2'\n" },
  'module-error': { expected: 2, source: 'export const revision =\n' },
  'recover-module': { expected: 2, source: "export const revision = 'revision-3'\n" },
  'compile-error': { expected: 3, source: "export { revision } from './missing.js'\n" },
  'recover-compile': { expected: 3, source: "export const revision = 'revision-4'\n" },
  verify: { expected: 4 },
}
if (!output || !isAbsolute(output) || !Object.hasOwn(steps, step)) throw new Error('Usage: phase0-hmr-step.mjs <absolute-output> <update|module-error|recover-module|compile-error|recover-compile|verify>')
const operation = steps[step]
const record = JSON.parse(await readFile(join(output, 'hmr-observations.json'), 'utf8'))
assert.equal(await readProcessStartTime(record.pid), record.startTime, 'Probe process identity changed')
const entries = await createFileLedger(output).listByPreview('phase0-vite-hmr')
assert.ok(entries.some(entry => entry.resource.kind === 'path' && entry.resource.path === record.root), 'Temporary root is not owned by this probe')
const status = await fetch(record.origin + '/phase0/status').then(response => {
  assert.equal(response.status, 200)
  return response.json()
})
assert.equal(status.pid, record.pid)
assert.equal(status.startTime, record.startTime)
assert.equal(status.reports.filter(report => report.kind === 'document-loaded').length, 1, 'Document unexpectedly reloaded')
const mounts = status.reports.filter(report => report.kind === 'target-mounted').map(report => report.detail)
assert.deepEqual(mounts, Array.from({ length: operation.expected }, (_, index) => 'revision-' + (index + 1)))
assert.equal(status.reports.filter(report => report.kind === 'csp-violation').length, 0)
await writeFile(join(output, step + '-before.json'), JSON.stringify(status, null, 2))
if (operation.source) await writeFile(join(record.root, 'target.js'), operation.source)
console.log(JSON.stringify({ step, verifiedMounts: mounts, documentLoads: 1, processUnchanged: true, sourceChanged: Boolean(operation.source) }))
