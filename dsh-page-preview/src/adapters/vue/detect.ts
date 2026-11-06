/**
 * Vue 应用识别（方案 §6.9）。只读安装元数据、HTML 与配置 AST，不执行项目代码。
 * 清单范围只作候选；版本未知、多宿主/多入口、动态配置保留歧义，不冒充支持。
 */
import { realpath } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import semver from 'semver'
import { installedPackageVersion, projectDependencyNames, readProjectManifest, readProjectText } from '../../shared/profile.ts'
import { isWithinRoot, resolveProjectPath } from '../../shared/config/paths.ts'
import { parseHtmlSource } from '../../shared/html.ts'
import { readVueBuildConfig } from './readonly-config.ts'
import { findUiKitProfile, isolationExcludedPackages, uiKitProfiles } from './ui-kits/registry.ts'

export type VueMajor = '2.6' | '2.7' | '3'
export type VueBuildHost =
  | { kind: 'vite'; viteVersion?: string; vuePlugin: '@vitejs/plugin-vue' | '@vitejs/plugin-vue2' | 'vite-plugin-vue2' | 'unknown' }
  | { kind: 'vue-cli'; cliServiceVersion?: string; webpackMajor?: 4 | 5 }
  | { kind: 'webpack' }
  | { kind: 'unknown' }

export interface VueAppInfo {
  vue: { major: VueMajor | 'unknown'; installedVersion?: string }
  buildHost: VueBuildHost
  entry?: string
  entryCandidates: string[]
  router?: { package: 'vue-router'; major: 3 | 4 }
  stores: Array<{ package: 'vuex' | 'pinia'; major: number }>
  uiKits: Array<{ packageName: string; version?: string; profileId?: string }>
  typescript: boolean
  isolationExcluded: string[]
  evidence: string[]
  unresolved: string[]
}
export interface VueDetectionOptions {
  workspaceRoot?: string
  entry?: string
  buildHost?: 'vite' | 'vue-cli'
}

export async function detectVueApp(appRoot: string, options: VueDetectionOptions = {}): Promise<VueAppInfo | undefined> {
  const root = await realpath(appRoot)
  const workspace = options.workspaceRoot ? await realpath(options.workspaceRoot) : root
  if (!isWithinRoot(workspace, root)) throw new Error('Application must be inside the declared workspace')
  const dependencies = new Set(projectDependencyNames(await readProjectManifest(join(root, 'package.json'), root), join(root, 'package.json')))
  const version = (name: string) => installedPackageVersion(root, workspace, name)
  const vue = await version('vue')
  if (!dependencies.has('vue') && !vue) return undefined
  const installedMajor = vue ? semver.major(vue) : undefined
  const major: VueAppInfo['vue']['major'] = installedMajor === 3 ? '3' : installedMajor === 2 && semver.minor(vue!) === 7 ? '2.7' : installedMajor === 2 && semver.minor(vue!) === 6 ? '2.6' : 'unknown'
  const result: VueAppInfo = {
    vue: { major, ...(vue ? { installedVersion: vue } : {}) }, buildHost: { kind: 'unknown' },
    entryCandidates: [], stores: [], uiKits: [], typescript: dependencies.has('typescript'),
    isolationExcluded: isolationExcludedPackages.filter(name => dependencies.has(name)),
    evidence: [vue ? 'Installed vue/package.json confirms version ' + vue : 'Manifest declares Vue; installed version is unknown'], unresolved: [],
  }
  if (major === 'unknown') result.unresolved.push('Installed Vue version is missing or outside Vue 2.6/2.7/3')
  if (result.isolationExcluded.length) result.unresolved.push('Framework requires project strategy; isolation is excluded')
  const allConfig = await readVueBuildConfig(root)
  const hosts = [
    ...(dependencies.has('vite') || allConfig.files.some(file => /\/vite\.config\./.test(file)) ? ['vite' as const] : []),
    ...(dependencies.has('@vue/cli-service') || allConfig.files.some(file => /\/vue\.config\./.test(file)) ? ['vue-cli' as const] : []),
  ]
  const host = options.buildHost ?? (hosts.length === 1 ? hosts[0] : undefined)
  if (hosts.length > 1 && !options.buildHost) result.unresolved.push('Several build hosts are candidates; select one explicitly')
  const config = host ? await readVueBuildConfig(root, host) : allConfig
  result.unresolved.push(...config.unresolved)
  if (host === 'vite') {
    const viteVersion = await version('vite')
    const plugins = major === '3' ? ['@vitejs/plugin-vue' as const] : major === '2.7' ? ['@vitejs/plugin-vue2' as const, 'vite-plugin-vue2' as const] : major === '2.6' ? ['vite-plugin-vue2' as const] : []
    const installed: Array<Extract<VueBuildHost, { kind: 'vite' }>['vuePlugin']> = []
    for (const name of plugins) if (await version(name)) installed.push(name)
    result.buildHost = { kind: 'vite', ...(viteVersion ? { viteVersion } : {}), vuePlugin: installed.length === 1 ? installed[0]! : 'unknown' }
    if (installed.length !== 1) result.unresolved.push('Installed Vue build plugin is missing or ambiguous; configuration execution is not part of detection')
  } else if (host === 'vue-cli') {
    const cliServiceVersion = await version('@vue/cli-service')
    const webpack = await version('webpack')
    const webpackMajor = webpack ? semver.major(webpack) : undefined
    result.buildHost = { kind: 'vue-cli', ...(cliServiceVersion ? { cliServiceVersion } : {}), ...(webpackMajor === 4 || webpackMajor === 5 ? { webpackMajor } : {}) }
  } else if (hosts.length === 0 && dependencies.has('webpack')) result.buildHost = { kind: 'webpack' }
  let entryBlocked = false
  const entryProblem = (message: string) => { entryBlocked = true; result.unresolved.push(message) }
  const addEntry = async (file: string) => {
    const absolute = resolve(root, file)
    if (!isWithinRoot(root, absolute)) { entryProblem('Entry is outside the application; explicit dependency-root binding is required'); return }
    const canonical = await resolveProjectPath(root, relative(root, absolute) || '.')
    const source = await readProjectText(canonical, root)
    if (source === undefined) { entryProblem('Declared entry does not exist'); return }
    if (extname(canonical).toLowerCase() === '.html') {
      const html = parseHtmlSource(source)
      // 内联经典脚本（polyfill 等）不影响入口判定，由预览文档原样带上（documentShell）；内联模块脚本可能本身就是入口。
      if (html.inlineScripts.some(script => script.module)) {
        entryProblem('Inline HTML module scripts require an explicit runtime.entry')
      }
      const base = new URL(relative(config.root ?? root, canonical).split('/').map(encodeURIComponent).join('/'), 'http://preview.invalid/')
      let documentBase: URL
      try { documentBase = html.base === undefined ? base : new URL(html.base, base) } catch { entryProblem('Invalid HTML base requires explicit runtime.entry'); return }
      for (const script of html.references.filter(value => value.kind === 'script' && value.module && !value.preload)) {
        let url: URL
        try { url = new URL(script.value, documentBase) } catch { entryProblem('Invalid HTML script source requires explicit runtime.entry'); continue }
        if (url.origin !== base.origin || url.search || url.hash) { entryProblem('External or parameterized HTML entry requires explicit runtime.entry'); continue }
        let path: string
        try { path = decodeURIComponent(url.pathname) } catch { entryProblem('Invalid HTML script encoding'); continue }
        if (!/\.[cm]?[jt]sx?$/i.test(path)) { entryProblem('HTML module entry is not a supported script'); continue }
        await addEntry(resolve(config.root ?? root, '.' + path))
      }
    } else if (/\.[cm]?[jt]sx?$/i.test(canonical)) result.entryCandidates.push(canonical)
    else entryProblem('Entry is not a supported script or HTML document')
  }
  if (options.entry) await addEntry(options.entry)
  else if (host && !config.entryUnknown) {
    if (config.entries.length) for (const file of config.entries) await addEntry(resolve(config.root ?? root, file))
    else if (host === 'vite') await addEntry(join(config.root ?? root, 'index.html'))
    else for (const file of ['src/main.js', 'src/main.ts']) if (await readProjectText(join(root, file), root) !== undefined) await addEntry(file)
  }
  result.entryCandidates = [...new Set(result.entryCandidates)]
  if (result.entryCandidates.length === 1 && !entryBlocked) result.entry = result.entryCandidates[0]!
  else if (result.entryCandidates.length !== 1) result.unresolved.push('Entry is missing or ambiguous; configure runtime.entry')
  if (result.entry && /\.[cm]?tsx?$/.test(result.entry)) result.typescript = true
  const router = await version('vue-router')
  if (router && [3, 4].includes(semver.major(router))) result.router = { package: 'vue-router', major: semver.major(router) === 3 ? 3 : 4 }
  for (const name of ['vuex', 'pinia'] as const) if (dependencies.has(name)) {
    const installed = await version(name)
    if (installed) result.stores.push({ package: name, major: semver.major(installed) })
    else result.unresolved.push('Declared store has no installed version: ' + name)
  }
  for (const name of new Set(uiKitProfiles.flatMap(profile => profile.packages.map(pkg => pkg.name)))) if (dependencies.has(name)) {
    const installed = await version(name)
    const profile = findUiKitProfile(name, installed, major === '3' ? '3' : major === 'unknown' ? undefined : '2')
    result.uiKits.push({ packageName: name, ...(installed ? { version: installed } : {}), ...(profile ? { profileId: profile.id } : {}) })
  }
  result.evidence.push(...config.files.map(file => 'Read-only build configuration AST: ' + relative(root, file)))
  return result
}
