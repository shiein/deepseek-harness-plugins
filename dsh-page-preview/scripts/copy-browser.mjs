// 构建时把 src/browser/（纯 JS，不经 tsc）复制到发布目录 browser/。
import { cp, rm } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const target = new URL('browser/', root)
await rm(target, { recursive: true, force: true })
await cp(new URL('src/browser/', root), target, { recursive: true })
