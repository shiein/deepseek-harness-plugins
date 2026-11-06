/** §13 第 8 条统一脱敏规则的单测：每类"必须去除"都有直接证明，"必须转发"不被误伤。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CODE_FRAME_LIMIT, DIAGNOSTIC_TEXT_LIMIT, STACK_FRAME_LIMIT,
  collectEnvPairs, createRedactor, envSecrets, parseEnvPairs, secretLike,
} from '../../src/shared/redact.ts'

const NONCE = 'a'.repeat(48)
const SECRET = 's3cr3t-token-value'

test('env values are replaced wherever they appear in forwarded text', () => {
  const redactor = createRedactor({ secrets: [SECRET] })
  assert.equal(redactor.text(`request to ${SECRET} failed`), 'request to [redacted] failed')
  assert.equal(redactor.text(`both ${SECRET} and ${SECRET}`), 'both [redacted] and [redacted]')
  assert.ok(!redactor.text(`prefix${SECRET}suffix`).includes(SECRET))
  // runtime.env 与文件值合并后的同一列表生效
  const pairs = [{ name: 'FILE_TOKEN', value: 'file-secret-77' }]
  const merged = createRedactor({ secrets: envSecrets({ API_KEY: 'key-9x7y' }, pairs) })
  assert.equal(merged.text('key-9x7y + file-secret-77'), '[redacted] + [redacted]')
})

test('channel nonce is removed from forwarded text and urls', () => {
  const redactor = createRedactor({ channels: [NONCE] })
  assert.equal(redactor.text(`report /__dsh_preview/report?nonce=${NONCE} ok`), 'report /__dsh_preview/report?nonce=[redacted] ok')
  assert.ok(!redactor.url('http://127.0.0.1:9000/__dsh_preview/health?nonce=' + NONCE).includes(NONCE))
})

test('URL userinfo, query and fragment are stripped while origin and path are preserved', () => {
  const redactor = createRedactor()
  assert.equal(redactor.url('http://user:pass@example.com/api/list?token=abc#frag'), 'http://example.com/api/list')
  assert.equal(redactor.url('https://evil.internal/x?secret=DO_NOT_SHOW'), 'https://evil.internal/x')
  // 相对路径也去 query；不可解析时剥离尾部 ?/#。
  assert.equal(redactor.url('/api/items?id=1'), '/api/items')
  assert.equal(redactor.url('unparsable?q=1'), 'unparsable')
})

test('Cookie and Authorization header values are removed from forwarded text', () => {
  const redactor = createRedactor()
  assert.equal(redactor.text('headers: Authorization: Bearer abc.def\nCookie: session=xyz'), 'headers: Authorization: [redacted]\nCookie: [redacted]')
  assert.equal(redactor.text('cookie=sess123 happened'), 'cookie: [redacted]')
})

test('intercepted request forwards method, origin and path but never query', () => {
  const redactor = createRedactor({ secrets: [SECRET], channels: [NONCE] })
  const target = redactor.request('GET', '/api/items?token=' + SECRET + '&nonce=' + NONCE, 'http://127.0.0.1:9000')
  assert.deepEqual(target, { method: 'GET', origin: 'http://127.0.0.1:9000', path: '/api/items' })
  assert.ok(!JSON.stringify(target).includes(SECRET))
  assert.ok(!JSON.stringify(target).includes(NONCE))
  const cross = redactor.request('POST', 'https://user:pw@api.example.com/v1/pay?k=1')
  assert.equal(cross.origin, 'https://api.example.com')
  assert.equal(cross.path, '/v1/pay')
})

test('runtime error stacks keep the message and first N frames only', () => {
  const frames = Array.from({ length: 9 }, (_, i) => `    at fn${i} (/app/src/a.ts:${i}:0)`).join('\n')
  const stack = 'Error: broken\n' + frames
  const redactor = createRedactor()
  const out = redactor.stack(stack)
  assert.ok(out.startsWith('Error: broken'))
  assert.ok(out.includes('fn4'))
  assert.ok(!out.includes('fn5'))
  assert.ok(out.includes('[truncated]'))
  assert.equal((out.match(/    at fn/g) ?? []).length, STACK_FRAME_LIMIT)
})

test('text and frame limits truncate with an explicit marker', () => {
  const redactor = createRedactor()
  const long = 'x'.repeat(DIAGNOSTIC_TEXT_LIMIT + 100)
  const out = redactor.text(long)
  assert.ok(out.length <= DIAGNOSTIC_TEXT_LIMIT + 20)
  assert.ok(out.endsWith('[truncated]'))
  const frame = redactor.text('y'.repeat(CODE_FRAME_LIMIT + 50), CODE_FRAME_LIMIT)
  assert.ok(frame.endsWith('[truncated]'))
})

test('parseEnvPairs collects name/value pairs only from dotenv-style lines', () => {
  const pairs = parseEnvPairs([
    '# comment', 'KEY=value1', 'export TOKEN="quoted secret"', "BARE='single'", 'EMPTY=',
    'INLINE=val # trailing comment', 'not an assignment', 'A_B_C=abc123',
  ].join('\n'))
  assert.deepEqual(pairs.map(pair => pair.value).sort(), ['abc123', 'quoted secret', 'single', 'val', 'value1'].sort())
  assert.ok(pairs.some(pair => pair.name === 'TOKEN' && pair.value === 'quoted secret'))
})

test('collectEnvPairs reads project .env files but skips example/sample templates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-redact-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, '.env'), 'API_SECRET=env-file-secret\n')
  await writeFile(join(root, '.env.local'), 'TOKEN=tok-abc\n')
  await writeFile(join(root, '.env.example'), 'VITE_USE_MOCK=true\nPLACEHOLDER=template-value-xx\n')
  await writeFile(join(root, '.env.sample'), 'SAMPLE_TITLE=sample-value-yy\n')
  await writeFile(join(root, 'notenv.txt'), 'IGNORED=1\n')
  const pairs = await collectEnvPairs(root)
  assert.ok(pairs.some(pair => pair.name === 'API_SECRET' && pair.value === 'env-file-secret'))
  assert.ok(pairs.some(pair => pair.name === 'TOKEN' && pair.value === 'tok-abc'))
  assert.ok(!pairs.some(pair => pair.value === 'template-value-xx'), '.env.example 模板不参与收集')
  assert.ok(!pairs.some(pair => pair.value === 'sample-value-yy'), '.env.sample 模板不参与收集')
  assert.ok(!pairs.some(pair => pair.value === '1'))
  const redactor = createRedactor({ secrets: envSecrets({}, pairs) })
  assert.equal(redactor.text('leaked env-file-secret here'), 'leaked [redacted] here')
})

test('secretLike keeps short/plain values out so line numbers and common words survive (R2-P0-3)', () => {
  // review §2.3 复现值：true/10/3000 绝不允许成为 secrets——否则行号与普通单词全被替换。
  const plainValues = [
    ['VITE_USE_MOCK', 'true'], ['VITE_TIMEOUT', '10'], ['PORT', '3000'], ['VITE_BASE', '/admin/'],
  ] as const
  for (const [name, value] of plainValues) {
    assert.equal(secretLike(name, value), false, name + '=' + value + ' must not be treated as secret')
  }
  assert.equal(secretLike('VITE_API_ORIGIN', 'https://api.example.com'), false, 'plain origin is not a secret')
  assert.equal(secretLike('VITE_APP_VERSION', '1.2.3'), false)
  assert.ok(secretLike('API_TOKEN', 's3cr3t-token-value'))
  assert.ok(secretLike('DB_DSN', 'postgres://u:p@h:5432/db'))
  assert.ok(secretLike('VITE_FEATURE_SEED', 'a1b2c3d4e5f6'), '≥12 非数字/布尔/origin 的长值按密钥对待')
  assert.equal(secretLike('VITE_COUNT_TOTAL', '123456789012345'), false, '≥12 但纯数字仍不是密钥')
  assert.equal(secretLike('API_KEY', 'x9'), false, '一两位短值即使键名敏感也不替换——否则全文被毁')
  // 编译错误的行号与普通单词在真实 env 下完整保留。
  const env = { VITE_USE_MOCK: 'true', VITE_TIMEOUT: '10', PORT: '3000', API_TOKEN: 'tok-do-not-leak' }
  const secrets = envSecrets(env, [])
  const redactor = createRedactor({ secrets })
  const compile = 'src/views/User.vue:10:5 ... expected true, got 3000 (see config port 3000 and flag true)'
  assert.equal(redactor.text(compile), compile)
  assert.equal(redactor.text('call with tok-do-not-leak failed'), 'call with [redacted] failed')
})

test('sensitive-looking names with boolean/short-number values never redact common text (2026-11-03 review)', () => {
  // review 复现：AUTH/SESSION/PASS 段 + true/1800/false 曾把行号与普通单词全文替换。
  const pairs = parseEnvPairs([
    'VITE_AUTH_ENABLED=true', 'VUE_APP_SESSION_TIMEOUT=1800', 'VUE_APP_BYPASS_CACHE=false',
    'VITE_TOKEN_TTL=3600', 'VUE_APP_KEYBOARD_LAYOUT=qwerty', 'VITE_AUTH_URL=http://127.0.0.1:8080',
  ].join('\n'))
  const redactor = createRedactor({ secrets: envSecrets(undefined, pairs) })
  const text = 'User.vue:1800:5 expected true, got false; ttl 3600; layout qwerty; GET http://127.0.0.1:8080/x'
  assert.equal(redactor.text(text), text)
  for (const pair of pairs) assert.equal(secretLike(pair.name, pair.value), false, pair.name)
  // 另一方向：真实密钥仍被替换，含纯数字长口令与驼峰/后缀键名。
  assert.ok(secretLike('DB_PASSWORD', '12345678'), '≥8 位纯数字口令仍按密钥')
  assert.equal(secretLike('DB_PASSWORD', '1234'), false, '4 位纯数字与行号同形，不替换')
  assert.ok(secretLike('VITE_APIKEY', 'abcd-1234'))
  assert.ok(secretLike('accessToken', 'tok-xyz'))
  assert.ok(secretLike('VUE_APP_AUTH', 'Basic dXNlcjpw'))
  const secrets = envSecrets({ DB_PASSWORD: 'hunter2-long' }, parseEnvPairs('VITE_APIKEY=abcd-1234'))
  assert.equal(createRedactor({ secrets }).text('k=abcd-1234 p=hunter2-long'), 'k=[redacted] p=[redacted]')
})

test('forwarded compile fields survive redaction intact', () => {
  const redactor = createRedactor({ secrets: [SECRET], channels: [NONCE] })
  const file = 'src/components/Target.vue'
  const frame = '  3 | const token = useSecret()\n  4 | let x = '
  assert.equal(redactor.text(file), file)
  assert.equal(redactor.text(frame), frame)
  const message = `[plugin:vite:vue] Unexpected token\nfile: ${file}:12:5`
  assert.equal(redactor.text(message), message)
})
