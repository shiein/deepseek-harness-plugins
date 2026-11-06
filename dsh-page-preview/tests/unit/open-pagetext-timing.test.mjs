/** R5-0a（决策 P-A）：setup.install 先 await 动态 import 再挂载时，open 不输出早于挂载信号的 pageText。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { RunnerClient } from '../../src/host/runner-client.ts'
import { SessionRegistry } from '../../src/host/session-registry.ts'
import { requestExecutionApproval } from '../../src/host/execution-approval.ts'
import { registerTools } from '../../src/host/tools/index.ts'
import { createVueViteFixture } from '../helpers/vue-vite-fixture.ts'
import { testModules as modules, integrationSkip } from '../helpers/test-gate.ts'
import { chromeAvailable, launchChrome } from '../helpers/headless-chrome.ts'

const options = { skip: integrationSkip, timeout: 60000 }
const openArgs = { projectId: 'vue-app', target: { kind: 'file', path: 'src/Target.vue' }, scope: 'component', requirements: ['isolated-target'] }

test('open pageText is post-mount only; earlier observations are annotated, never reported as page text',
  { ...options, skip: integrationSkip || !chromeAvailable() }, async t => {
  const fixture = await createVueViteFixture(modules)
  const dataDir = join(fixture.root, 'plugin')
  const project = structuredClone(fixture.input.config.project)
  project.runtime.setup = 'setup.js'
  // 真实案例形态：setup 安装前 await 一个异步 import，挂载必然晚于 DOMContentLoaded。
  await fixture.put('setup.js', `export default { async install() { await import('./heavy.js') } }`)
  await fixture.put('heavy.js', 'export const heavy = 1')
  await writeFile(join(fixture.root, 'page-preview.config.json'), JSON.stringify({ schemaVersion: 1, projects: [project] }))
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  const sessions = new SessionStore(ctx)
  new ApprovalService(ctx, {})
  const session = sessions.create(SessionId('open-pagetext-user'), { meta: { cwd: fixture.root } })
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session, ctx, options: {} }
  const client = new RunnerClient({ dataDir, nodeExecutable: process.execPath })
  const registry = new SessionRegistry(client, undefined, { dataDir,
    requestApproval: (caller, config, exec, previous, generated) =>
      requestExecutionApproval(ctx.get('approval'), dataDir, caller, config, exec, previous, generated) })
  registerTools(ctx, registry)
  ctx.on('approval/request', async () => 'allowed-once')
  let call = 0
  const invoke = async (name, args = {}) => {
    const result = await tools.execute({ callId: ToolCallId('open-pagetext-' + ++call), name: 'page_preview_' + name, arguments: args, signal: AbortSignal.timeout(15000), agent })
    assert.equal(result.isError, false, 'SDK must return a domain result')
    return result.value
  }
  const release = registry.trackFollower('open-pagetext-user')
  const chrome = await launchChrome(t)
  t.after(async () => {
    release(); await chrome.close()
    assert.deepEqual(await client.dispose(), { residual: [] })
    ctx.fiber.dispose()
  })
  let navigated = false
  client.onMessage(message => {
    if (message.type !== 'state' || navigated || !message.url || message.state !== 'reachable') return
    navigated = true
    void chrome.navigate(message.url)
  })
  const opened = await invoke('open', openArgs)
  assert.equal(opened.status, 'ok', JSON.stringify(opened.diagnostics ?? opened))
  // 新语义（决策 P-A）：早于挂载信号的观测（首帧空文本）不当作页面文本——
  // open 输出不带 pageText，改由 page_text_pending 如实标注"尚未采集到"，hint 指向 status。
  assert.equal(opened.pageText, undefined, 'pre-mount text must not be reported as pageText')
  // F7：hint 是条件化表述（需要核对页面内容才调一次 status），
  // 不与 preview_shown_in_sidebar 的"收尾、不要轮询"措辞互相矛盾。
  assert.ok(opened.diagnostics.some(value => value.code === 'page_text_pending'
    && /Only if you need to verify the page content, call page_preview_status once/
      .test(value.hint ?? '')),
    'open annotates the missing post-mount text with a conditional page_preview_status hint')
  assert.equal(opened.preview.readiness.targetMounted.status, 'unverified')
  await delay(2500)
  const later = await invoke('status', { previewId: opened.preview.previewId, detail: true })
  // 页面并未渲染失败：status 的同一份快照里 pageText 已是真实文本（观测仅晚 ~90ms），
  // status 始终返回最新观测，不受 open 的"挂载后"投影影响。
  assert.ok(later.pageText?.text && later.pageText.text.length > 0,
    'the deferred mount produces real page text shortly after open returned')
  // 挂载信号到达后 Runner 已记录证据时间戳；其后的文本观测才属于"挂载后"。
  assert.ok(Number.isFinite(Date.parse(later.preview.readiness.targetMounted.at ?? '')),
    'mount evidence carries a Runner-side timestamp for the post-mount boundary')
  assert.equal((await invoke('stop', { previewId: opened.preview.previewId })).stopped[0].state, 'stopped')
})
