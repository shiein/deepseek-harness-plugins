/** Vite 路径规范化（方案 §6.5）：Windows 盘符路径与 POSIX 路径都要和 Vite 自己的请求、模块图键逐字一致。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAbsoluteFile, viteFsUrl, viteFsUrlFile, viteGraphFile } from '../../src/adapters/vite/paths.ts'

test('Windows paths become the drive-letter form Vite requests and keys its module graph by', () => {
  const env = 'C:\\Users\\aesc\\proj\\node_modules\\vite\\dist\\client\\env.mjs'
  assert.equal(viteFsUrl(env, 'win32'), '/@fs/C:/Users/aesc/proj/node_modules/vite/dist/client/env.mjs')
  assert.equal(viteGraphFile('C:\\Users\\aesc\\proj\\src\\App.vue', 'win32'), 'C:/Users/aesc/proj/src/App.vue')
  assert.equal(viteFsUrlFile('/@fs/C:/Users/aesc/proj/src/App.vue', 'win32'), 'C:/Users/aesc/proj/src/App.vue')
  // The planned file and the request for it meet at the same key.
  const planned = 'C:\\Users\\aesc\\proj\\src\\App.vue'
  assert.equal(viteFsUrlFile(viteFsUrl(planned, 'win32'), 'win32'), viteGraphFile(planned, 'win32'))
})

test('POSIX behaviour is unchanged: leading slash kept, request paths compared verbatim', () => {
  assert.equal(viteFsUrl('/Users/aesc/proj/node_modules/vite/dist/client/env.mjs', 'darwin'),
    '/@fs/Users/aesc/proj/node_modules/vite/dist/client/env.mjs')
  assert.equal(viteFsUrlFile('/@fs/Users/aesc/proj/src/App.vue', 'linux'), '/Users/aesc/proj/src/App.vue')
  assert.equal(viteFsUrlFile('/@fs//Users/aesc/App.vue', 'linux'), '/Users/aesc/App.vue')
  // No normalisation of request paths: a `..` request must not collapse onto a planned file.
  assert.equal(viteFsUrlFile('/@fs/Users/aesc/proj/../secret.vue', 'linux'), '/Users/aesc/proj/../secret.vue')
  assert.equal(viteGraphFile('/Users/aesc/proj/src/App.vue', 'darwin'), '/Users/aesc/proj/src/App.vue')
  // A backslash is a legal POSIX file-name character and must not be rewritten there.
  assert.equal(viteGraphFile('/tmp/a\\b.js', 'linux'), '/tmp/a\\b.js')
})

test('absolute-path detection follows the target platform', () => {
  assert.equal(isAbsoluteFile('C:\\proj\\src\\App.tsx', 'win32'), true)
  assert.equal(isAbsoluteFile('C:\\proj\\src\\App.tsx', 'linux'), false)
  assert.equal(isAbsoluteFile('/proj/src/App.tsx', 'linux'), true)
  assert.equal(isAbsoluteFile('./App.tsx', 'win32'), false)
  assert.equal(isAbsoluteFile('react-router-dom', 'win32'), false)
})
