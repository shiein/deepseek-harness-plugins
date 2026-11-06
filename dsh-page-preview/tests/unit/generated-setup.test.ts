/** 自动生成 setup 的摘要核对与预览文档外壳（方案 §0.3 第 10 条）；只读临时样本，不执行项目代码。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildGeneratedSetup, verifiedGeneratedSetup } from '../../src/adapters/vue/generated-setup.ts'
import { documentShell } from '../../src/shared/html.ts'

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-generated-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  await put('package.json', JSON.stringify({ dependencies: { vue: '^3', 'test-ui': '^1' } }))
  return { root, put }
}

test('the worker rebuilds the generated setup and refuses it when the entry changed after approval', async t => {
  const { root, put } = await fixture(t)
  await put('src/main.js', `import { createApp } from 'vue'; import App from './App.vue'; import Kit from 'test-ui'
createApp(App).use(Kit).mount('#app')`)
  const built = await buildGeneratedSetup(root, 'src/main.js', '3')
  assert.ok(!('reason' in built))
  if ('reason' in built) return
  const planned = { entry: built.entry, hash: built.hash }
  assert.equal(await verifiedGeneratedSetup(root, planned, '3.4.27'), built.source)
  await put('src/main.js', `import { createApp } from 'vue'; import App from './App.vue'; import Kit from 'test-ui'
createApp(App).use(Kit, { size: 'small' }).mount('#app')`)
  await assert.rejects(verifiedGeneratedSetup(root, planned, '3.4.27'), /entry changed after the generated setup/)
  await assert.rejects(verifiedGeneratedSetup(root, planned, undefined), /version is unresolved/)
  await put('src/main.js', 'import { createApp } from')
  assert.ok('reason' in await buildGeneratedSetup(root, 'src/main.js', '3'))
})

test('the document shell keeps static html/body attributes and inline classic scripts only', () => {
  const shell = documentShell(`<!doctype html><html class="dark" lang="zh" onload="steal()" data-x="<%= v %>">
<head><script>window.a = 1</script><script type="module">import x from './x'</script><script src="/app.js"></script>
<script>var s = "</script>"</script></head><body data-shell="app" onclick="x()">
<script>window.b = 2</script></body></html>`)
  assert.equal(shell.htmlAttributes, ' class="dark" lang="zh"')
  assert.equal(shell.bodyAttributes, ' data-shell="app"')
  assert.deepEqual(shell.inlineScripts, ['window.a = 1', 'var s = "', 'window.b = 2'])
})
