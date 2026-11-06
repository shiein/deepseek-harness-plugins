// R2-4：可读性硬门槛。只检查相对 HEAD 新增/修改的源代码行（>120 字符失败），存量不一次性清理。
// 覆盖：git diff HEAD（staged+unstaged）的新增行；未跟踪新文件的全部行。范围限 src/ 与 tests/ 的代码文件。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url).pathname
const LIMIT = 120
const WATCH = /^(src|tests)\/.*\.(ts|mts|js|mjs)$/

const violations = []
const diff = execFileSync('git', ['diff', 'HEAD', '--unified=0', '--', 'src', 'tests'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
let file = ''
let line = 0
for (const raw of diff.split('\n')) {
  if (raw.startsWith('+++ b/')) { file = raw.slice(6); continue }
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
  if (hunk) { line = Number(hunk[1]); continue }
  if (!raw.startsWith('+') || raw.startsWith('++')) continue
  const text = raw.slice(1)
  if (WATCH.test(file) && text.length > LIMIT) violations.push(file + ':' + line + ' (' + text.length + ' chars)')
  line++
}
for (const path of execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'src', 'tests'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)) {
  if (!WATCH.test(path)) continue
  readFileSync(root + path, 'utf8').split('\n').forEach((text, index) => {
    if (text.length > LIMIT) violations.push(path + ':' + (index + 1) + ' (' + text.length + ' chars)')
  })
}
if (violations.length) {
  console.error('[line-length] ' + violations.length + ' added/modified line(s) exceed ' + LIMIT + ' chars:')
  for (const item of violations) console.error('  ' + item)
  process.exit(1)
}
console.log('[line-length] ok')
