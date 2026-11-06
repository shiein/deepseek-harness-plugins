/**
 * UI 组件库 profile（方案 §6.9）：数据，不是代码分支。
 * 只补充通用机制（按需引入原样保留、入口注册重放、手写 setup）拿不到的知识。
 * profile 不修改项目代码、不安装依赖；默认样式入口只作提示，不覆盖项目入口里的实际 import。
 */

export type UiKitTier = 1 | 2

export interface UiKitPackage {
  name: string
  /** semver 范围。 */
  versions: string
  vue: '2' | '3'
}

export type OnDemandMechanism =
  | { kind: 'unplugin-vue-components'; resolver: string }
  | { kind: 'babel-plugin-component' }
  | { kind: 'babel-plugin-import' }
  | { kind: 'none' }

export type ConfigCarrier =
  | { kind: 'plugin-options'; example: string }
  | { kind: 'provider-component'; component: string }
  | { kind: 'root-option'; key: string }
  | { kind: 'none' }

export interface UiKitProfile {
  id: string
  displayName: string
  tier: UiKitTier
  packages: UiKitPackage[]
  /** 全量注册时的默认样式入口；按需引入时通常由 resolver / babel 插件注入。 */
  defaultStyles?: Array<{ forVersions: string; path: string; note?: string }>
  onDemand: OnDemandMechanism[]
  config: ConfigCarrier[]
  /** 已知全局 API，用于诊断（例如场景切换时清理残留弹层）。 */
  globalApis: string[]
  pitfalls: string[]
  /**
   * 是否已有样本验收。false 时能力表只能写 conditional/unknown，不得写 supported。
   * 只有在 tests/fixtures 中登记对应样本并通过后才能改为 true。
   */
  verified: boolean
}
