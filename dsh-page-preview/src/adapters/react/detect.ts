/**
 * React 应用识别（方案 §6.9；R5-7）。只读安装元数据、HTML 与配置 AST，不执行项目代码。
 * 清单范围只作候选；版本未知、多入口、动态配置保留歧义，不冒充支持。
 */
import { realpath } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import semver from 'semver'
import {
  installedPackageVersion, projectDependencyNames, readProjectManifest, readProjectText,
} from '../../shared/profile.ts'
import { isWithinRoot, resolveProjectPath } from '../../shared/config/paths.ts'
import { parseHtmlSource } from '../../shared/html.ts'
import { readReactBuildConfig } from './readonly-config.ts'
import { findUiKitProfile, isolationExcludedPackages, uiKitProfiles } from './ui-kits/registry.ts'

export type ReactMajor = '18' | '19' | 'unknown'
export type ReactBuildHost =
  | { kind: 'vite'; viteVersion?: string; reactPlugin: '@vitejs/plugin-react' | '@vitejs/plugin-react-swc' | 'unknown' }
  | { kind: 'webpack' }
  | { kind: 'unknown' }

export interface ReactAppInfo {
  react: { major: ReactMajor; installedVersion?: string; domVersion?: string }
  buildHost: ReactBuildHost
  entry?: string
  entryCandidates: string[]
  /** 检出 react-router / react-router-dom 的安装事实（路由识别另由 route-map 只读判定）。 */
  router?: { package: 'react-router-dom' | 'react-router'; major: number }
  typescript: boolean
  isolationExcluded: string[]
  uiKits: Array<{ packageName: string; version?: string; profileId?: string }>
  evidence: string[]
  unresolved: string[]
}
export interface ReactDetectionOptions {
  workspaceRoot?: string
  entry?: string
}

export async function detectReactApp(
  appRoot: string, options: ReactDetectionOptions = {},
): Promise<ReactAppInfo | undefined> {
  const root = await realpath(appRoot)
  const workspace = options.workspaceRoot ? await realpath(options.workspaceRoot) : root
  if (!isWithinRoot(workspace, root)) throw new Error('Application must be inside the declared workspace')
  const manifest = join(root, 'package.json')
  const dependencies = new Set(projectDependencyNames(await readProjectManifest(manifest, root), manifest))
  const version = (name: string) => installedPackageVersion(root, workspace, name)
  const react = await version('react')
  const reactDom = await version('react-dom')
  if (!dependencies.has('react') && !react && !dependencies.has('react-dom') && !reactDom) return undefined
  const installedMajor = react ? semver.major(react) : undefined
  const major: ReactMajor = installedMajor === 18 ? '18' : installedMajor === 19 ? '19' : 'unknown'
  const result: ReactAppInfo = {
    react: { major, ...(react ? { installedVersion: react } : {}), ...(reactDom ? { domVersion: reactDom } : {}) },
    buildHost: { kind: 'unknown' },
    entryCandidates: [], uiKits: [], typescript: dependencies.has('typescript'),
    isolationExcluded: isolationExcludedPackages.filter(name => dependencies.has(name)),
    evidence: [react
      ? 'Installed react/package.json confirms version ' + react
      : 'Manifest declares React; installed version is unknown'],
    unresolved: [],
  }
  if (major === 'unknown') result.unresolved.push('Installed React version is missing or outside the known 18/19 lines')
  if (!reactDom)
    result.unresolved.push('react-dom is not installed or its version is unknown; mounting cannot be verified')
  if (reactDom && react && semver.major(reactDom) !== installedMajor)
    result.unresolved.push('react and react-dom majors differ; the mounted runtime would be mixed')
  if (result.isolationExcluded.length)
    result.unresolved.push('Framework requires project strategy; isolation is excluded')
  const config = await readReactBuildConfig(root)
  result.unresolved.push(...config.unresolved)
  const hostCandidates = dependencies.has('vite') || config.files.length > 0 ? ['vite' as const] : []
  if (hostCandidates.length === 1) {
    const viteVersion = await version('vite')
    const plugins = ['@vitejs/plugin-react' as const, '@vitejs/plugin-react-swc' as const]
    const installed: Array<Extract<ReactBuildHost, { kind: 'vite' }>['reactPlugin']> = []
    for (const name of plugins) if (await version(name)) installed.push(name)
    result.buildHost = {
      kind: 'vite', ...(viteVersion ? { viteVersion } : {}),
      reactPlugin: installed.length === 1 ? installed[0]! : 'unknown',
    }
    if (installed.length !== 1)
      result.unresolved.push('Installed React build plugin is missing or ambiguous; '
        + 'configuration execution is not part of detection')
  } else if (dependencies.has('webpack') || dependencies.has('react-scripts') || dependencies.has('cra-template')) {
    // CRA/webpack 腿本轮不做（方案 R5-7 只复制 Vite 分层）；如实标 webpack 候选，不冒充可执行。
    result.buildHost = { kind: 'webpack' }
    result.unresolved.push('Webpack/CRA host is not part of the React Vite adapter; the project strategy applies')
  }
  let entryBlocked = false
  const entryProblem = (message: string) => { entryBlocked = true; result.unresolved.push(message) }
  const addEntry = async (file: string) => {
    const absolute = resolve(root, file)
    if (!isWithinRoot(root, absolute)) {
      entryProblem('Entry is outside the application; explicit dependency-root binding is required')
      return
    }
    const canonical = await resolveProjectPath(root, relative(root, absolute) || '.')
    const source = await readProjectText(canonical, root)
    if (source === undefined) { entryProblem('Declared entry does not exist'); return }
    if (extname(canonical).toLowerCase() === '.html') {
      const html = parseHtmlSource(source)
      if (html.inlineScripts.some(script => script.module))
        entryProblem('Inline HTML module scripts require an explicit runtime.entry')
      const rel = relative(config.root ?? root, canonical).split('/').map(encodeURIComponent).join('/')
      const base = new URL(rel, 'http://preview.invalid/')
      let documentBase: URL
      try {
        documentBase = html.base === undefined ? base : new URL(html.base, base)
      } catch { entryProblem('Invalid HTML base requires explicit runtime.entry'); return }
      for (const script of html.references.filter(value => value.kind === 'script' && value.module && !value.preload)) {
        let url: URL
        try {
          url = new URL(script.value, documentBase)
        } catch { entryProblem('Invalid HTML script source requires explicit runtime.entry'); continue }
        if (url.origin !== base.origin || url.search || url.hash) {
          entryProblem('External or parameterized HTML entry requires explicit runtime.entry')
          continue
        }
        let path: string
        try { path = decodeURIComponent(url.pathname) } catch { entryProblem('Invalid HTML script encoding'); continue }
        if (!/\.[cm]?[jt]sx?$/i.test(path)) { entryProblem('HTML module entry is not a supported script'); continue }
        await addEntry(resolve(config.root ?? root, '.' + path))
      }
    } else if (/\.[cm]?[jt]sx?$/i.test(canonical)) result.entryCandidates.push(canonical)
    else entryProblem('Entry is not a supported script or HTML document')
  }
  if (options.entry) await addEntry(options.entry)
  else if (!config.entryUnknown) {
    if (config.entries.length) for (const file of config.entries) await addEntry(resolve(config.root ?? root, file))
    else await addEntry(join(config.root ?? root, 'index.html'))
  }
  result.entryCandidates = [...new Set(result.entryCandidates)]
  if (result.entryCandidates.length === 1 && !entryBlocked) result.entry = result.entryCandidates[0]!
  else if (result.entryCandidates.length !== 1)
    result.unresolved.push('Entry is missing or ambiguous; configure runtime.entry')
  if (result.entry && /\.[cm]?tsx?$/.test(result.entry)) result.typescript = true
  for (const name of ['react-router-dom', 'react-router'] as const) {
    const installed = await version(name)
    if (installed && semver.major(installed) >= 6) {
      result.router = { package: name, major: semver.major(installed) }
      break
    }
  }
  const uiKitPackages = new Set(uiKitProfiles.flatMap(profile => profile.packages.map(pkg => pkg.name)))
  for (const name of uiKitPackages) if (dependencies.has(name)) {
    const installed = await version(name)
    const profile = findUiKitProfile(name, installed)
    result.uiKits.push({
      packageName: name,
      ...(installed ? { version: installed } : {}),
      ...(profile ? { profileId: profile.id } : {}),
    })
  }
  result.evidence.push(...config.files.map(file => 'Read-only build configuration AST: ' + relative(root, file)))
  return result
}
