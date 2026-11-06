/** 真实 Vite SIGTERM 清理回归（方案 §9.2、§14）：独立子进程，仅使用本轮临时资源。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFileLedger, readProcessStartTime } from '../../src/runner/ledger.ts'
import { findListeningPids } from '../../src/runner/port-ownership.ts'

const [viteDirectory, output] = process.argv.slice(2)
if (!viteDirectory || !isAbsolute(viteDirectory) || !output || !isAbsolute(output)) throw new Error('Absolute Vite package and output directories are required')
const child = spawn(process.execPath, [fileURLToPath(new URL('./phase0-hmr.mjs', import.meta.url)), viteDirectory, output], {
  env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: '/private/tmp' }, stdio: ['ignore', 'pipe', 'pipe'],
})
const exited = once(child, 'exit')
void exited.catch(() => {})
let stderr = ''
child.stderr.on('data', (data) => { stderr += data.toString() })
let runtime
let childStartTime
try {
  childStartTime = await readProcessStartTime(child.pid)
  let timer
  runtime = await new Promise((resolve, reject) => {
    let stdout = ''
    timer = setTimeout(() => reject(new Error('HMR probe startup timed out')), 20000)
    child.once('error', reject)
    child.once('exit', () => reject(new Error('Probe exited before readiness: ' + stderr)))
    child.stdout.on('data', (data) => {
      stdout += data.toString()
      const line = stdout.split('\n').find((value) => value.startsWith('{'))
      if (line) {
        try { resolve(JSON.parse(line)); clearTimeout(timer) } catch (error) { reject(error) }
      }
    })
  }).finally(() => clearTimeout(timer))
  assert.equal(runtime.pid, child.pid)
  assert.equal(await readProcessStartTime(runtime.pid), runtime.startTime)
  const port = Number(new URL(runtime.origin).port)
  assert.deepEqual(await findListeningPids(port), [runtime.pid])
  child.kill('SIGTERM')
  const [code, signal] = await exited
  assert.equal(code, 0, stderr)
  assert.equal(signal, null)
  const record = JSON.parse(await readFile(join(output, 'hmr-observations.json'), 'utf8'))
  assert.equal(record.cleaned, true)
  assert.equal(await readProcessStartTime(runtime.pid), undefined)
  await assert.rejects(access(runtime.root), { code: 'ENOENT' })
  assert.deepEqual(await findListeningPids(port), [])
  assert.deepEqual(await createFileLedger(output).listByPreview('phase0-vite-hmr'), [])
  console.log('Real Vite SIGTERM: exit 0; temporary root removed; resource ledger empty; port released')
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const expected = runtime?.startTime ?? childStartTime
    if (expected && await readProcessStartTime(child.pid) === expected) child.kill('SIGTERM')
  }
}
