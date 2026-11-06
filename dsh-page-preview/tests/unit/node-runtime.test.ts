/** Node 选择规则回归（方案 §6.5）；只执行本机 Node --version，不读项目配置或环境文件。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveNodeRuntime } from '../../src/host/node-runtime.ts'

test('Node runtime uses an explicit executable or user PATH and records the actual version', async () => {
  const expected = { executable: await realpath(process.execPath), version: process.version }
  assert.deepEqual(await resolveNodeRuntime(process.execPath, ''), expected)
  assert.deepEqual(await resolveNodeRuntime(undefined, dirname(process.execPath)), expected)
  await assert.rejects(resolveNodeRuntime(undefined, ''), /not found/)
  await assert.rejects(resolveNodeRuntime('node'), /absolute/)
  await assert.rejects(resolveNodeRuntime('/nonexistent-dsh-test-node', dirname(process.execPath)))
})
