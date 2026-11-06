/** 应用配置与只读画像的共同入口（方案 §5.1、§8）；Host/Runner 同源推断，不合并配置，不批准执行。 */
import { relative, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import { detectApps, inspectApp } from '../profile.ts'
import type { AppProfile } from '../profile.ts'
import { fingerprintJson } from '../fingerprint.ts'
import { ConfigLoadError, loadEffectiveConfigs } from './loader.ts'
import type { EffectiveProjectConfig } from './loader.ts'
import { isWithinRoot, resolveProjectPath } from './paths.ts'

export interface WorkspaceProject {
  config: EffectiveProjectConfig
  profile: AppProfile
}

export async function loadWorkspaceProjects(workspaceRoot: string, explicit?: string, options: { dataDir?: string } = {}): Promise<WorkspaceProject[]> {
  const workspace = await realpath(workspaceRoot)
  const configured = await loadEffectiveConfigs(workspace, explicit, options)
  const detected = explicit === undefined ? await detectApps(workspace) : []
  const roots = await Promise.all(configured.map(value => resolveProjectPath(workspace, value.project.root)))
  const detectedRoots = await Promise.all(detected.map(value => resolveProjectPath(workspace, value.root)))
  const allRoots = [...new Set([...roots, ...detectedRoots])]
  const projects: WorkspaceProject[] = []
  for (const [index, config] of configured.entries()) {
    const root = roots[index]!
    const profile = await inspectApp(workspace, root, allRoots.filter(child => child !== root && isWithinRoot(root, child)))
    projects.push({ config, profile })
  }
  for (const [index, profile] of detected.entries()) {
    const root = detectedRoots[index]!
    if (roots.includes(root)) continue
    // 配置应用已经拥有其中的普通 HTML 子目录；包/构建配置才构成另一应用边界。
    if (!profile.hasPackageJson && !profile.buildTools.some(value => value.value.name !== 'none') && roots.some(parent => isWithinRoot(parent, root))) continue
    const relativeRoot = relative(workspace, root).split(sep).join('/') || '.'
    const id = 'app-' + fingerprintJson(relativeRoot).slice(0, 24)
    if (configured.some(value => value.project.id === id)) throw new ConfigLoadError(workspace, [{ path: '/projects', message: 'A configured project ID conflicts with a detected application; assign an explicit ID/root mapping' }])
    projects.push({ config: { source: { kind: 'detected' }, project: { id, root: relativeRoot, runtime: {} }, diagnostics: [] }, profile })
  }
  return projects
}
