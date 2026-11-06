/** 非 Vite 模拟项目复制（方案 §14）：创建独立目录，拒绝覆盖现有内容，不安装依赖。 */
import { cp, mkdir, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const destination = process.argv[2]
if (!destination || !isAbsolute(destination)) throw new Error('Usage: node scripts/prepare-phase0-non-vite.mjs <new-absolute-directory>')
await mkdir(destination)
const source = new URL('../../tests/fixtures/non-vite-existing-server/', import.meta.url)
for (const file of await readdir(source)) {
  await cp(new URL(file, source), join(destination, file), { recursive: true, force: false, errorOnExist: true })
}
console.log('Disposable non-Vite sample prepared: ' + destination)
console.log('Start separately with: node server.mjs 0')
