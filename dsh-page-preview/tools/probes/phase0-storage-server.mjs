/**
 * Cookie/Storage 样本服务（方案 §7.4、§14）：只识别随机样本 Cookie 名，不输出原始 Cookie、凭据或其他存储。
 * 两个 loopback 端口和 localhost 别名用于区分 origin、site 与 DSH 工作区分区；无导入副作用。
 */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const cases = new Set(['initial', 'written', 'recheck', 'cleared', 'cross-fetch', 'cross-navigation'])
const labels = new Set(['A', 'B'])

export async function startStorageProbe(onObservation = () => {}) {
  // 这是公开的测试命名空间，不是鉴权 nonce；Cookie 值只是固定的人工样本标记。
  const runId = randomBytes(8).toString('hex')
  const base = '/probe/' + runId + '/'
  const cookieNames = Object.fromEntries(['strict', 'lax', 'noneSecure', 'noneInsecure'].map(kind => [kind, 'dsh_probe_' + runId + '_' + kind]))
  const observations = []
  const servers = []
  const allowedAuthorities = new Set()
  const allowedOrigins = new Set()
  const files = new Map([
    ['app.js', ['../../tests/fixtures/browser-storage/app.js', 'text/javascript; charset=utf-8']],
    ['style.css', ['../../tests/fixtures/vite-hmr/style.css', 'text/css; charset=utf-8']],
  ])
  let origin, aliasOrigin, otherOrigin
  const record = (value) => {
    if (observations.length >= 128) throw new Error('Storage probe observation limit reached')
    observations.push(value)
    onObservation(value)
  }
  function present(header) {
    // 只比较本次固定 Cookie 值，其他名称/值既不保留也不返回。
    const fields = (header || '').split(';').map(field => field.trim())
    return Object.fromEntries(Object.entries(cookieNames).map(([kind, name]) => [kind, fields.includes(name + '=fixture')]))
  }
  function cookies(clear = false) {
    const policies = { strict: 'SameSite=Strict', lax: 'SameSite=Lax', noneSecure: 'SameSite=None; Secure', noneInsecure: 'SameSite=None' }
    return Object.entries(cookieNames).map(([kind, name]) => name + '=' + (clear ? '' : 'fixture') + '; Path=' + base + '; HttpOnly; ' + policies[kind] + (clear ? '; Max-Age=0' : ''))
  }
  const handler = (req, res) => {
    void respond().catch((error) => {
      console.error('Storage sample request failed:', error.message)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
    async function respond() {
      if (!allowedAuthorities.has(req.headers.host)) return reply(403)
      if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return reply(403)
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      if (req.headers.origin) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin)
        res.setHeader('Access-Control-Allow-Credentials', 'true')
        res.setHeader('Vary', 'Origin')
      }
      const url = new URL(req.url || '/', 'http://sample.invalid')
      const path = url.pathname
      if (path === '/phase0/status' && req.method === 'GET') return json({ runId, origin, aliasOrigin, otherOrigin, base, observations })
      if (path === base + 'report') {
        if (req.method !== 'POST') return reply(405)
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 4096) return reply(413)
          chunks.push(chunk)
        }
        let value
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reply(400) }
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'case,label,local,topLevel' ||
            !cases.has(value.case) || !labels.has(value.label) || ![null, 'A', 'B', 'unexpected'].includes(value.local) || typeof value.topLevel !== 'boolean') return reply(400)
        record({ kind: 'storage', ...value, sampleOrigin: 'http://' + req.headers.host })
        return reply(204)
      }
      if (req.method !== 'GET') return reply(405)
      if (path === base || path === base + 'index.html') {
        res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src " + [...allowedOrigins].join(' ') + "; form-action 'self'; frame-ancestors 'none'")
        const html = await readFile(new URL('../../tests/fixtures/browser-storage/index.html', import.meta.url))
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return
      }
      if (path === base + 'config') return json({ runId, base, origin, aliasOrigin, otherOrigin, storageKey: 'dsh-page-preview:' + runId + ':partition' })
      if (path === base + 'seed' || path === base + 'clear') {
        res.setHeader('Set-Cookie', cookies(path.endsWith('/clear')))
        return json({ changedOnlySampleCookies: true })
      }
      if (path === base + 'read') {
        const name = url.searchParams.get('case') || 'recheck'
        if (!cases.has(name)) return reply(400)
        const value = { kind: 'request', case: name, sampleOrigin: 'http://' + req.headers.host, present: present(req.headers.cookie), site: req.headers['sec-fetch-site'] || null, mode: req.headers['sec-fetch-mode'] || null }
        record(value)
        return json(value)
      }
      const file = path.startsWith(base) ? files.get(path.slice(base.length)) : undefined
      if (file) {
        res.writeHead(200, { 'Content-Type': file[1] })
        res.end(await readFile(new URL(file[0], import.meta.url))); return
      }
      return json({ code: 'unmatched_request' }, 404)
    }
    function reply(status) { res.writeHead(status); res.end() }
    function json(value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
  }
  async function close() {
    await Promise.all(servers.map(server => new Promise((resolve, reject) => {
      if (!server.listening) return resolve()
      server.close((error) => error ? reject(error) : resolve())
    })))
  }
  try {
    for (let index = 0; index < 2; index++) {
      const server = createServer(handler)
      servers.push(server)
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    }
    origin = 'http://127.0.0.1:' + servers[0].address().port
    aliasOrigin = 'http://localhost:' + servers[0].address().port
    otherOrigin = 'http://127.0.0.1:' + servers[1].address().port
    for (const item of [origin, aliasOrigin, otherOrigin]) { allowedOrigins.add(item); allowedAuthorities.add(new URL(item).host) }
    return { runId, origin, aliasOrigin, otherOrigin, base, observations, close }
  } catch (error) { await close(); throw error }
}
