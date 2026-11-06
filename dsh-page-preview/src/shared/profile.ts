/** 应用画像与工作区识别（方案 §5.1、§8、§11）；仅 JSON/YAML/文件元数据，绝不加载构建配置或运行脚本。 */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, matchesGlob, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import semver from 'semver'
import { isWithinRoot, resolveProjectPath } from './config/paths.ts'
import { scanProjectFiles } from './project-files.ts'

export type Confidence = 'confirmed' | 'candidate' | 'unknown'
export interface Detected<T> {
  value: T
  confidence: Confidence
  evidence: string[]
}
export interface AppProfile {
  root: string
  hasPackageJson: boolean
  languages: Array<Detected<'js' | 'ts' | 'jsx' | 'tsx' | 'vue-sfc' | 'svelte' | 'html' | 'server-template' | 'css-preprocessor'>>
  frameworks: Array<Detected<{ name: string, version?: string }>>
  buildTools: Array<Detected<{ name: 'vite' | 'vue-cli' | 'webpack' | 'rspack' | 'angular-cli' | 'none' | string, version?: string }>>
  runtime: { node?: string, declaredNode?: string, packageManager?: string }
  existingPreview: Array<Detected<{ kind: 'script' | 'storybook' | 'test-mount' | 'msw' | 'fixtures', ref: string }>>
  unresolved?: string[]
}
export class ProjectReadError extends Error {
  readonly file: string
  constructor(file: string, cause?: unknown) {
    super('Invalid or inaccessible project metadata', { cause })
    this.name = 'ProjectReadError'
    this.file = file
  }
}
type ObjectData = Record<string, unknown>
function object(value: unknown): ObjectData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected metadata object')
  return value as ObjectData
}
async function textFile(file: string, root?: string): Promise<string | undefined> {
  let canonical: string
  try { canonical = await realpath(file) }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new ProjectReadError(file, error)
    try { await lstat(file) }
    catch (missing) {
      if (missing instanceof Error && 'code' in missing && missing.code === 'ENOENT') return undefined
      throw new ProjectReadError(file, missing)
    }
    throw new ProjectReadError(file, error)
  }
  if (/^\.env(?:\.|$)/.test(basename(canonical)) || root && !isWithinRoot(root, canonical)) throw new ProjectReadError(file)
  try { return await readFile(canonical, 'utf8') } catch (error) { throw new ProjectReadError(file, error) }
}
async function manifest(file: string, root?: string): Promise<ObjectData | undefined> {
  const source = await textFile(file, root)
  if (source === undefined) return undefined
  try { return object(JSON.parse(source)) } catch (error) { throw new ProjectReadError(file, error) }
}
const frameworkPackages = ['vue', 'react', 'svelte', '@angular/core', 'solid-js', 'nuxt', 'quasar', 'next']
const buildPackages: Record<string, string> = { vite: 'vite', '@vue/cli-service': 'vue-cli', webpack: 'webpack', '@rspack/core': 'rspack', '@angular/cli': 'angular-cli' }
const configTool = (file: string) => /^(vite|webpack|rspack)\.config\.[cm]?[jt]s$/.exec(file)?.[1] ?? (/^vue\.config\.[cm]?js$/.test(file) ? 'vue-cli' : file === 'angular.json' ? 'angular-cli' : undefined)

async function installedVersion(root: string, workspace: string, name: string): Promise<string | undefined> {
  return (await resolveInstalledPackage(root, workspace, name))?.version
}

export interface InstalledPackage { directory: string; version?: string }

/** 实际包位置与版本共用同一次查找。只解析声明工作区内的 node_modules 层级，允许真实包存放于 pnpm 链接目标。 */
export async function resolveInstalledPackage(root: string, workspace: string, name: string): Promise<InstalledPackage | undefined> {
  if (!isAbsolute(root) || !isAbsolute(workspace) || !/^(?:@[a-z0-9_][a-z0-9_.-]*\/)?[a-z0-9_][a-z0-9_.-]*$/i.test(name)) throw new Error('Installed package lookup requires absolute roots and a package name')
  root = await realpath(root)
  workspace = await realpath(workspace)
  if (!isWithinRoot(workspace, root)) throw new Error('Package lookup application is outside the declared workspace')
  let directory = root
  while (isWithinRoot(workspace, directory)) {
    const file = join(directory, 'node_modules', name, 'package.json')
    const pkg = await manifest(file)
    if (pkg) {
      if (pkg.name !== name) throw new ProjectReadError(file)
      const version = typeof pkg.version === 'string' ? semver.valid(pkg.version) : undefined
      return { directory: dirname(await realpath(file)), ...(version ? { version } : {}) }
    }
    if (directory === workspace) break
    directory = dirname(directory)
  }
  return undefined
}

/** 显式配置根即使不在自动扫描结果中，也以相同规则检查；不读取 .env。 */
export async function inspectApp(workspaceRoot: string, appRoot: string, excludeRoots: readonly string[] = []): Promise<AppProfile> {
  const workspace = await realpath(workspaceRoot)
  const root = await resolveProjectPath(workspace, relative(workspace, appRoot) || '.')
  const pkg = await manifest(join(root, 'package.json'), workspace)
  const scan = await scanProjectFiles(root, 5000, excludeRoots)
  const profile: AppProfile = { root: relative(workspace, root) || '.', hasPackageJson: pkg !== undefined, languages: [], frameworks: [], buildTools: [], runtime: {}, existingPreview: [], unresolved: scan.limited ? ['Source metadata scan reached its 5000-entry budget'] : [] }
  const languages = new Map<AppProfile['languages'][number]['value'], string[]>()
  for (const file of scan.files) {
    const name = file.toLowerCase()
    const language = /\.vue$/.test(name) ? 'vue-sfc' : /\.svelte$/.test(name) ? 'svelte' : /\.tsx$/.test(name) ? 'tsx' : /\.jsx$/.test(name) ? 'jsx' : /\.[cm]?ts$/.test(name) ? 'ts' : /\.[cm]?js$/.test(name) ? 'js' : /\.html?$/.test(name) ? 'html' : /\.(php|jsp|ejs|hbs|twig|erb)$/.test(name) ? 'server-template' : /\.(scss|sass|less|styl)$/.test(name) ? 'css-preprocessor' : undefined
    if (language) {
      const evidence = languages.get(language) ?? []
      if (evidence.length < 3) evidence.push(relative(root, file))
      languages.set(language, evidence)
    }
  }
  for (const [value, evidence] of languages) profile.languages.push({ value, confidence: 'candidate', evidence: evidence.map(file => 'Source extension only: ' + file) })
  const dependencies = dependencyMetadata(pkg, join(root, 'package.json'))
  for (const name of frameworkPackages) if (Object.hasOwn(dependencies, name)) {
    const version = await installedVersion(root, workspace, name)
    profile.frameworks.push({ value: { name, ...(version ? { version } : {}) }, confidence: 'candidate', evidence: ['Manifest dependency declares a candidate framework', ...(version ? ['Installed package.json confirms the version only'] : ['Installed version is unknown'])] })
  }
  const tools = new Map<string, Detected<{ name: string, version?: string }>>()
  for (const [name, kind] of Object.entries(buildPackages)) if (Object.hasOwn(dependencies, name)) {
    const version = await installedVersion(root, workspace, name)
    tools.set(kind, { value: { name: kind, ...(version ? { version } : {}) }, confidence: 'candidate', evidence: ['Manifest dependency; no project command/configuration was executed'] })
  }
  for (const file of scan.files) if (dirname(file) === root) {
    const tool = configTool(basename(file))
    if (tool) {
      const detected = tools.get(tool) ?? { value: { name: tool }, confidence: 'candidate' as const, evidence: [] }
      detected.evidence.push('Configuration file exists: ' + basename(file))
      tools.set(tool, detected)
    }
  }
  profile.buildTools = [...tools.values()]
  if (!tools.size && languages.has('html')) profile.buildTools.push({ value: { name: 'none' }, confidence: 'candidate', evidence: ['HTML exists and no known build host was detected; not proof that all scripts are browser-ready'] })
  if (pkg?.engines !== undefined) {
    const node = metadataObject(pkg.engines, join(root, 'package.json')).node
    if (typeof node === 'string' && semver.validRange(node)) profile.runtime.declaredNode = node
  }
  if (typeof pkg?.packageManager === 'string') {
    const manager = /^(npm|pnpm|yarn|bun)@([^+]+)(?:\+sha\d+\.[\da-f]+)?$/.exec(pkg.packageManager)
    if (manager && semver.valid(manager[2])) profile.runtime.packageManager = pkg.packageManager
  }
  if (pkg?.scripts !== undefined) for (const [name, value] of Object.entries(metadataObject(pkg.scripts, join(root, 'package.json')))) if (typeof value === 'string' && /preview|storybook|test.*mount/i.test(name)) profile.existingPreview.push({ value: { kind: /storybook/i.test(name) ? 'storybook' : /mount/i.test(name) ? 'test-mount' : 'script', ref: 'package.json#scripts.' + name }, confidence: 'candidate', evidence: ['Explicit script name only; body was not executed or approved'] })
  if (Object.hasOwn(dependencies, 'msw')) profile.existingPreview.push({ value: { kind: 'msw', ref: 'package.json#dependencies.msw' }, confidence: 'candidate', evidence: ['Dependency presence does not establish interception coverage'] })
  return profile
}

export async function detectApps(workspaceRoot: string): Promise<AppProfile[]> {
  const workspace = await realpath(workspaceRoot)
  const pkg = await manifest(join(workspace, 'package.json'), workspace)
  const yamlSource = await textFile(join(workspace, 'pnpm-workspace.yaml'), workspace)
  let patterns: string[] = []
  try {
    const nodeWorkspaces = pkg?.workspaces
    const entries = Array.isArray(nodeWorkspaces) ? nodeWorkspaces : nodeWorkspaces === undefined ? [] : object(nodeWorkspaces).packages
    const pnpm = yamlSource === undefined ? [] : object(parseYaml(yamlSource)).packages ?? []
    if (!Array.isArray(entries) || !Array.isArray(pnpm)) throw new Error('Workspace packages must be arrays')
    for (const pattern of [...entries, ...pnpm]) {
      if (typeof pattern !== 'string') throw new Error('Workspace pattern must be a string')
      const negative = pattern.startsWith('!')
      const path = (negative ? pattern.slice(1) : pattern).replace(/^\.\//, '')
      if (!path || /^[\\/]|^[A-Za-z]:/.test(path) || path.includes('\\') || /(^|\/)\.\.(\/|$)/.test(path)) throw new Error('Workspace pattern must stay within the workspace')
      patterns.push((negative ? '!' : '') + path)
    }
  } catch (error) { throw new ProjectReadError(yamlSource === undefined ? join(workspace, 'package.json') : join(workspace, 'pnpm-workspace.yaml'), error) }
  const scan = await scanProjectFiles(workspace)
  const roots = new Set(scan.files.filter(file => basename(file) === 'package.json' || configTool(basename(file))).map(dirname))
  if (pkg) roots.add(workspace)
  const htmlRoots = [...new Set(scan.files.filter(file => /\.html?$/i.test(file)).map(dirname))].sort((a, b) => a.length - b.length || (a < b ? -1 : 1))
  for (const root of htmlRoots) if (![...roots].some(parent => isWithinRoot(parent, root))) roots.add(root)
  const positive = patterns.filter(value => !value.startsWith('!'))
  const negative = patterns.filter(value => value.startsWith('!')).map(value => value.slice(1))
  const rootDependencies = { ...metadataObject(pkg?.dependencies ?? {}, join(workspace, 'package.json')), ...metadataObject(pkg?.devDependencies ?? {}, join(workspace, 'package.json')) }
  const rootHasTool = [...frameworkPackages, ...Object.keys(buildPackages)].some(name => Object.hasOwn(rootDependencies, name))
  const selected = [...roots].filter(root => {
    const rel = relative(workspace, root).split(sep).join('/') || '.'
    if (negative.some(pattern => matchesGlob(rel, pattern))) return false
    if (!positive.length) return true
    if (positive.some(pattern => matchesGlob(rel, pattern))) return true
    return root === workspace && (rootHasTool || scan.files.some(file => dirname(file) === root && (configTool(basename(file)) || /^index\.html?$/i.test(basename(file)))))
  }).sort()
  const profiles: AppProfile[] = []
  for (const root of selected) {
    const profile = await inspectApp(workspace, root, selected.filter(child => child !== root && isWithinRoot(root, child)))
    if (scan.limited) profile.unresolved?.push('Workspace root discovery was incomplete')
    profiles.push(profile)
  }
  return profiles
}

function metadataObject(value: unknown, file: string): ObjectData {
  try { return object(value) } catch (error) { throw new ProjectReadError(file, error) }
}

function dependencyMetadata(pkg: ObjectData | undefined, file: string): ObjectData {
  const dependencies: ObjectData = {}
  if (pkg) for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) if (pkg[key] !== undefined) Object.assign(dependencies, metadataObject(pkg[key], file))
  return dependencies
}

export function projectDependencyNames(pkg: ObjectData | undefined, file: string): string[] {
  return Object.keys(dependencyMetadata(pkg, file))
}

/** 其他只读探测器复用相同的缺失/断链/范围/环境文件规则，不再实现另一套读取。 */
export { textFile as readProjectText, manifest as readProjectManifest, installedVersion as installedPackageVersion }
