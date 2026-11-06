/** React+Vite 适配器自有样本（方案 §6.5、§15.3；R5-7）；复用显式已有依赖，所有源码/配置/环境/缓存均在可丢弃目录。 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile, readdir, lstat, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { inspectApp } from '../../src/shared/profile.ts'
import { reactViteAdapter } from '../../src/adapters/react/vite/index.ts'
import type { AdapterContext, RunEvent, StartContext } from '../../src/adapters/types.ts'
import type { ResolvedTarget } from '../../src/core/target/resolve.ts'
import { createFileLedger } from '../../src/runner/ledger.ts'

export interface ReactFixtureOptions {
  /** 入口 main.jsx 自定义（默认 StrictMode+BrowserRouter+App）。 */
  main?: string
  /** 入口文件路径（默认 src/main.jsx）；TS 入口用例传 src/main.tsx。 */
  entryFile?: string
  /** 额外依赖软链（如 antd/@mui/material）。 */
  extraModules?: string[]
}

export async function createReactViteFixture(modules: string, options: ReactFixtureOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-react-adapter-')))
  try {
    const appRoot = join(root, 'app')
    const configMarker = join(root, 'config-evaluated')
    const put = async (path: string, source: string) => {
      const file = join(appRoot, path)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, source)
    }
    const deps = ['react', 'react-dom', 'vite', '@vitejs/plugin-react', 'react-router-dom',
      ...(options.extraModules ?? [])]
    await put('package.json', JSON.stringify({ private: true, type: 'module',
      dependencies: Object.fromEntries(deps.map(name => [name, '*'])) }))
    for (const name of deps) {
      const target = join(modules, name)
      try { await realpath(target) } catch { throw new Error('React toolchain module is missing: ' + name) }
      await mkdir(dirname(join(appRoot, 'node_modules', name)), { recursive: true })
      await symlink(await realpath(target), join(appRoot, 'node_modules', name))
    }
    const entryFile = options.entryFile ?? 'src/main.jsx'
    await put('index.html', '<div id="root"></div><script type="module" src="/' + entryFile + '"></script>')
    await put(entryFile, options.main ?? `import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
createRoot(document.getElementById('root')).render(
  <React.StrictMode><BrowserRouter><App /></BrowserRouter></React.StrictMode>)`)
    await put('src/App.jsx', `import { Link } from 'react-router-dom'
export default function App() { return <main><h1>App shell</h1><Link to="/about">about</Link></main> }`)
    await put('src/Target.jsx', `import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
export default function Target() {
  const [count, setCount] = useState(0)
  const location = useLocation()
  return <article>
    <h1>Real adapter target</h1>
    <p>adapter-revision-1</p>
    <p data-testid="location">{location.pathname}</p>
    <Link to="/about">about</Link>
    <button onClick={function () { setCount(count + 1) }}>Adapter counter: {count}</button>
  </article>
}`)
    await put('.env', 'VITE_DSH_FIXTURE_PRIVATE=THIS_VALUE_MUST_NOT_BE_EXPOSED\n')
    const pluginEntry = join(await realpath(join(modules, '@vitejs/plugin-react')), 'dist/index.js')
    await put('vite.config.mjs', `import react from ${JSON.stringify(pathToFileURL(pluginEntry).href)}
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
export default {
  plugins: [(function () {
    writeFileSync(${JSON.stringify(configMarker)}, String(process.pid), { mode: 0o600 })
    return react()
  })()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
}`)
    const runtime = { adapter: 'react-vite' as const, strategy: 'isolated' as const,
      requirements: [], entry: entryFile }
    const context: AdapterContext = { workspaceRoot: root, appRoot, profile: await inspectApp(root, appRoot),
      config: { source: { kind: 'detected' }, diagnostics: [],
        project: { id: 'react-app', root: 'app', runtime } } }
    const target: ResolvedTarget = { projectId: 'react-app', targetId: 'actual', scope: 'component',
      selector: { kind: 'file', path: 'src/Target.jsx' } }
    const outcome = await reactViteAdapter.plan(context, target)
    if (outcome.kind !== 'plan') throw new Error('Own React fixture plan failed: ' +
      (outcome.kind === 'missing'
        ? outcome.missing.map(value => value.code + ':' + value.message).join(' | ')
        : outcome.reason))
    const ledger = createFileLedger(join(root, 'control'))
    const events: RunEvent[] = []
    let verifications = 0
    const input: StartContext = { ...context, previewId: 'react-vite-owned-fixture',
      ownerSessionId: 'own-test', plan: outcome.plan, signal: new AbortController().signal,
      deadline: Date.now() + 15000, ledger,
      async verifyExecution() { verifications++ }, emit(event) { events.push(event) },
    }
    const cleanup = async () => {
      if ((await ledger.listByPreview(input.previewId)).length)
        throw new Error('Own React fixture still has resource records: ' + join(root, 'control'))
      await rm(root, { recursive: true, force: true })
    }
    return { root, appRoot, configMarker, context, input, events, ledger, put,
      verifications: () => verifications, cleanup }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}

/** 对实际源文件作前后比较；跳过显式借用的依赖目录，不读取其内容。 */
export async function fixtureFiles(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const name of await readdir(root)) {
    if (name === 'node_modules') continue
    const file = join(root, name)
    if ((await lstat(file)).isDirectory()) {
      for (const [child, hash] of Object.entries(await fixtureFiles(file)))
        result[name + '/' + child] = hash
    }
    else result[name] = createHash('sha256').update(await readFile(file)).digest('hex')
  }
  return result
}
