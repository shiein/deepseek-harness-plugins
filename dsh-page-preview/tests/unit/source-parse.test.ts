/** 只读 HTML/JS AST 解析与注入定位（方案 §5.2、§6.8、§11）；文本样本从不执行。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHtmlSource } from '../../src/shared/html.ts'
import { parseScriptSource } from '../../src/shared/javascript.ts'
import { injectBootstrap } from '../../src/runner/response-layer/inject.ts'

test('HTML parsing distinguishes active scripts, template/comment text and real resources', () => {
  const source = '<!doctype html><!-- <script src="fake.js"></script> --><html><head><base href="/assets/"><link rel="stylesheet" href="theme.css"><meta http-equiv="Content-Security-Policy" content="connect-src self"></head><body><template><script src="inert.js"></script></template><script type="application/json">{"text":"<head>"}</script><script type="module" src="app.js"></script><script>var text="<head>"</script><img src="a.svg"><iframe src="child.html"></iframe></body></html>'
  const result = parseHtmlSource(source)
  assert.equal(result.base, '/assets/')
  assert.equal(result.metaCsp, true)
  assert.deepEqual(result.references.map(value => value.value), ['theme.css', 'app.js', 'a.svg', 'child.html'])
  assert.equal(result.inlineScripts[0]?.source, 'var text="<head>"')
})

test('bootstrap insertion ignores fake tags and preserves doctype and original quoted attributes', () => {
  for (const source of [
    '<!doctype html><!-- <head> --><html><head data-value=">quoted"><script src="app.js"></script></head></html>',
    '<!doctype html><script>var text="<head>"</script><body>Original</body>',
    '<!doctype html><body><script src="app.js"></script></body>',
  ]) {
    const output = injectBootstrap(source, 'window.__probe = true')
    assert.ok(output.startsWith('<!doctype html>'))
    assert.ok(output.indexOf('data-dsh-preview-bootstrap') < output.indexOf('<script src="app.js"') || !source.includes('<script src="app.js"'))
    assert.ok(output.includes(source.includes('data-value') ? '<head data-value=">quoted"><script data-dsh-preview-bootstrap>' : '<script data-dsh-preview-bootstrap>'))
    assert.equal(output.replace(/<script data-dsh-preview-bootstrap>[\s\S]*?<\/script>/, ''), source)
    assert.equal(parseHtmlSource(output).inlineScripts[0]?.source, 'window.__probe = true')
  }
})

test('script analysis reads imports, dynamic modules, worker URLs and named/default exports without executing', () => {
  const result = parseScriptSource('entry.js', 'import Foo from "./a.js"; export { Named as Alias } from "./b.js"; export default function Page(){}; export const value=1; import("./lazy.js"); new Worker(new URL("./worker.js",import.meta.url)); navigator.serviceWorker.register("./sw.js"); throw new Error("MUST NOT EXECUTE")')
  assert.equal(result.invalid, false)
  assert.equal(result.jsx, false)
  assert.equal(result.typescript, false)
  assert.ok(result.references.some(value => value.value === './lazy.js'))
  assert.ok(result.references.some(value => value.value === './worker.js' && value.kind === 'worker'))
  assert.ok(result.references.some(value => value.value === './sw.js'))
  assert.deepEqual(result.exports.sort(), ['Alias', 'default', 'value'])
})

test('JSX/TypeScript and syntax errors are distinguished from strings/comments and computed dependencies stay unresolved', () => {
  assert.equal(parseScriptSource('plain.js', 'const text = "import Fake from \\\"nope\\\"; <div/>"').references.length, 0)
  assert.equal(parseScriptSource('view.js', 'export const View = () => <div/>').jsx, true)
  assert.equal(parseScriptSource('view.ts', 'export const value: string = "text"').typescript, true)
  assert.equal(parseScriptSource('modifier.js', 'class Value { private field = 1 }').typescript, true)
  assert.equal(parseScriptSource('broken.js', 'export const value = ;').invalid, true)
  assert.ok(parseScriptSource('dynamic.js', 'import(name); new Worker(path)').unresolved.length >= 2)
})

test('minified bundles with very deep expressions parse without stack overflow (2026-11-03 real build)', () => {
  // overview/web 的 2.4 MB vendor chunk 曾让递归遍历抛 RangeError，被 Host 吞成通用 runtime_error。
  const chain = Array.from({ length: 20000 }, (_, index) => 'v' + index).join('+')
  const source = 'import "./first.js"\nexport const total = ' + chain + '\nimport("./last.js")\n'
  const parsed = parseScriptSource('vendor.js', source)
  assert.deepEqual(parsed.references.map(value => value.value), ['./first.js', './last.js'])
  assert.deepEqual(parsed.exports, ['total'])
  assert.equal(parsed.invalid, false)
})
