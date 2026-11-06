/**
 * React UI 组件库 profile 注册表（方案 §6.9；R5-7）。
 * 未匹配到 profile 的库走 Tier 3 通用路径，不是错误。
 */
import { antd } from './antd.ts'
import { mui } from './mui.ts'
import type { UiKitProfile } from './types.ts'
import semver from 'semver'

export const uiKitProfiles: readonly UiKitProfile[] = [antd, mui]

/** 不走隔离路径的 React 元框架（SSR/自有 dev server）；首版使用 project 策略。 */
export const isolationExcludedPackages: readonly string[] = [
  'next', 'gatsby', '@remix-run/react', '@remix-run/node', 'redwood',
]

/** 仅匹配实际安装版本；匹配不是样本验收，不改变 verified。 */
export function findUiKitProfile(packageName: string, installedVersion: string | undefined): UiKitProfile | undefined {
  if (!installedVersion || !semver.valid(installedVersion)) return undefined
  return uiKitProfiles.find(profile => profile.packages.some(pkg => pkg.name === packageName
    && semver.satisfies(installedVersion, pkg.versions)))
}
