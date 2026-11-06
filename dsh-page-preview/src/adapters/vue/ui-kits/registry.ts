/**
 * UI 组件库 profile 注册表（方案 §6.9）。
 * 未匹配到 profile 的库走 Tier 3 通用路径，不是错误。
 */

import { antDesignVue } from './ant-design-vue.ts'
import { elementPlus } from './element-plus.ts'
import { elementUi } from './element-ui.ts'
import { tier2Profiles } from './tier2.ts'
import type { UiKitProfile } from './types.ts'
import semver from 'semver'

export const uiKitProfiles: readonly UiKitProfile[] = [elementUi, elementPlus, antDesignVue, ...tier2Profiles]

/** 不走隔离路径的框架/库（§6.9 表）：首版使用 project 策略。 */
export const isolationExcludedPackages: readonly string[] = ['quasar', 'nuxt', 'nuxt3', '@nuxt/kit']

/** 仅匹配实际安装版本及 Vue 主版本；匹配不是样本验收，不改变 verified。 */
export function findUiKitProfile(packageName: string, installedVersion: string | undefined, vue: '2' | '3' | undefined): UiKitProfile | undefined {
  if (!installedVersion || !semver.valid(installedVersion) || !vue) return undefined
  return uiKitProfiles.find(profile => profile.packages.some(pkg => pkg.name === packageName && pkg.vue === vue && semver.satisfies(installedVersion, pkg.versions)))
}
