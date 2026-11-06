import type { UiKitProfile } from './types.ts'

/** Tier 1。样本：vue3-self-contained 工具链（Vue 3.4.27/Vite 5.2.12 + element-plus 2.14.2）
 * ——resolver 按需引入、ElMessage 全局 API、切场景整页重置，headless Chrome 实测
 * （tests/unit/vue-uikit-matrix.test.ts）。 */
export const elementPlus: UiKitProfile = {
  id: 'element-plus',
  displayName: 'Element Plus',
  tier: 1,
  packages: [{ name: 'element-plus', versions: '^2.0.0', vue: '3' }],
  defaultStyles: [{ forVersions: '^2.0.0', path: 'element-plus/dist/index.css' }],
  onDemand: [{ kind: 'unplugin-vue-components', resolver: 'ElementPlusResolver' }],
  config: [
    { kind: 'plugin-options', example: 'app.use(ElementPlus, { locale, size, zIndex })' },
    { kind: 'provider-component', component: 'ElConfigProvider' },
  ],
  globalApis: ['ElMessage', 'ElMessageBox', 'ElNotification', 'ElLoading'],
  pitfalls: [
    'ElMessage 等函数式 API 常通过 unplugin-auto-import 引入，需加载项目 Vite 配置',
    '暗色主题依赖 html.dark 类与 element-plus/theme-chalk/dark/css-vars.css',
  ],
  verified: true,
}
