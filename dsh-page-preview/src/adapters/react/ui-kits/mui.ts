import type { UiKitProfile } from './types.ts'

/** MUI（Material UI）6/7（Tier 1）：Emotion CSS-in-JS，无全局样式入口；主题经 ThemeProvider。 */
export const mui: UiKitProfile = {
  id: 'mui',
  displayName: 'Material UI',
  tier: 1,
  packages: [{ name: '@mui/material', versions: '^6.0.0 || ^7.0.0' }],
  config: [
    { kind: 'provider-component', component: 'ThemeProvider' },
    { kind: 'provider-component', component: 'StyledEngineProvider' },
  ],
  globalApis: ['Snackbar', 'Dialog', 'useMediaQuery'],
  pitfalls: [
    'theme 必须经入口 ThemeProvider 重放；缺失时组件仍能渲染但丢失项目主题',
    'CssBaseline 是可选根组件，入口有则随 Provider 链保留',
    '@emotion/* 与 styled-components 主题机制不同；profile 只覆盖 @mui/material 官方 Emotion 路径',
  ],
  verified: false,
}
