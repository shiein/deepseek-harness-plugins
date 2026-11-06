/**
 * React UI 组件库 profile（方案 §6.9；R5-7）：数据，不是代码分支。
 * React 库没有 app.use 注册面——接入点是入口里的 Provider 包裹（ThemeProvider、ConfigProvider、
 * QueryClientProvider）与普通组件 import，入口重放保留 Provider 链即可覆盖；
 * profile 只补充通用机制拿不到的知识（默认样式入口、已知全局/命令式 API、已知坑）。
 */
export type UiKitTier = 1 | 2

export interface UiKitPackage {
  name: string
  /** semver 范围。 */
  versions: string
}

export type ConfigCarrier =
  /** 入口中以 JSX Provider 包裹（如 <ConfigProvider theme={...}>、<ThemeProvider theme={...}>）。 */
  | { kind: 'provider-component'; component: string }
  | { kind: 'none' }

export interface UiKitProfile {
  id: string
  displayName: string
  tier: UiKitTier
  packages: UiKitPackage[]
  /** 全量样式入口提示；按需/无运行时样式（CSS-in-JS）库为 none。项目入口的实际 import 优先。 */
  defaultStyles?: Array<{ forVersions: string; path: string; note?: string }>
  config: ConfigCarrier[]
  /** 已知命令式/全局 API（antd message/notification、MUI Snackbar 等），用于诊断与弹层清理提示。 */
  globalApis: string[]
  pitfalls: string[]
  /**
   * 是否已有样本验收。false 时能力表只能写 conditional/unknown，不得写 supported。
   * 只有在 tests/fixtures 中登记对应样本并通过后才能改为 true。
   */
  verified: boolean
}
