/** 场景响应字节预检/运行共用边界（方案 §7.2、§8、§13）；只读自有临时文件，不读取环境内容。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readScenarioBodyFile } from '../../src/scenario/files.ts'
import { RunnerSessionError } from '../../src/shared/errors.ts'

test('scenario body files retain binary bytes and require explicit roots while environment aliases are rejected', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-scene-files-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, 'app')
  const shared = join(root, 'shared')
  await mkdir(app); await mkdir(shared)
  await writeFile(join(app, 'response.bin'), Uint8Array.from([0, 1, 255]))
  await writeFile(join(shared, 'response.json'), '{"source":"declared"}')
  await writeFile(join(app, '.env'), 'OWN_PRIVATE_FIXTURE')
  await symlink(join(app, '.env'), join(app, 'alias.json'))
  assert.deepEqual([...await readScenarioBodyFile(app, 'response.bin')], [0, 1, 255])
  assert.equal((await readScenarioBodyFile(app, '../shared/response.json', ['../shared'])).toString(), '{"source":"declared"}')
  for (const path of ['../shared/response.json', '.env', 'alias.json', 'missing.json', '.']) await assert.rejects(readScenarioBodyFile(app, path), error => error instanceof RunnerSessionError && error.diagnostic.code === 'config_invalid' && !JSON.stringify(error.diagnostic).includes('OWN_PRIVATE_FIXTURE'))
})
