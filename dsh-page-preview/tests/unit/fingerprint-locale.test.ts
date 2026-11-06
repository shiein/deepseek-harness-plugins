/** Host/Runner 不同语言环境的稳定指纹回归（方案 §6.7、§8）；只执行自身解析函数，不运行项目代码。 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test } from 'node:test'
const execute = promisify(execFile)

test('JSON fingerprints remain identical across actual Node locales and object insertion order', async () => {
  const module = new URL('../../src/shared/fingerprint.ts', import.meta.url).href
  const script = 'import { fingerprintJson } from ' + JSON.stringify(module) + '; console.log(fingerprintJson({z:1,"ä":2,a:3,nested:{Z:1,a:2}}))'
  const results = await Promise.all(['en_US.UTF-8', 'sv_SE.UTF-8', 'zh_CN.UTF-8'].map(LANG => execute(process.execPath, ['--input-type=module', '-e', script], { env: { LANG } })))
  assert.equal(new Set(results.map(value => value.stdout.trim())).size, 1)
  const reversed = await execute(process.execPath, ['--input-type=module', '-e', 'import { fingerprintJson } from ' + JSON.stringify(module) + '; console.log(fingerprintJson({nested:{a:2,Z:1},a:3,"ä":2,z:1}))'], { env: {} })
  assert.equal(reversed.stdout, results[0]?.stdout)
})
