import type { UiKitProfile } from './types.ts'

/** Ant Design 5（Tier 1）：CSS-in-JS 运行时主题，无全局样式入口；命令式 API 走 App 组件或静态函数。 */
export const antd: UiKitProfile = {
  id: 'antd',
  displayName: 'Ant Design',
  tier: 1,
  packages: [{ name: 'antd', versions: '^5.0.0' }],
  defaultStyles: [{ forVersions: '^5.0.0', path: 'antd/dist/reset.css', note: 'v5 无必全量 CSS；reset.css 仅为可选样式重置' }],
  config: [{ kind: 'provider-component', component: 'ConfigProvider' }],
  globalApis: ['message', 'notification', 'Modal.confirm', 'App'],
  pitfalls: [
    'message/notification 静态函数脱离 ConfigProvider 上下文；项目应使用 App 组件提供的 hooks，静态调用在预览中仍可渲染但不吃主题',
    'ConfigProvider 主题/locale 经入口 Provider 链重放；只挂载页面组件时由 setup.createContext 的 wrap 提供',
  ],
  verified: false,
}
