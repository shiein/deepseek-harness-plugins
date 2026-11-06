/**
 * Tier 2：先只做冒烟样本（方案 §6.9）。
 * 每个库至少一个冒烟样本通过后才可能把 verified 改为 true 并在能力表声明支持；
 * 按方案 R5-8，冒烟结果只记"冒烟通过"、不升 verified——verified 需矩阵级（Tier 1 规格）证据。
 * 冒烟证据仅限各条目注释标注的实测组合；未覆盖的包腿/版本照常执行并报 unverified。
 */

import type { UiKitProfile } from './types.ts'

export const tier2Profiles: readonly UiKitProfile[] = [
  {
    id: 'vant',
    displayName: 'Vant',
    tier: 2,
    packages: [
      { name: 'vant', versions: '^2.0.0', vue: '2' },
      { name: 'vant', versions: '^3.0.0 || ^4.0.0', vue: '3' },
    ],
    onDemand: [{ kind: 'unplugin-vue-components', resolver: 'VantResolver' }, { kind: 'babel-plugin-import' }],
    config: [{ kind: 'provider-component', component: 'van-config-provider' }],
    globalApis: ['showToast', 'showDialog', '$toast', '$dialog'],
    pitfalls: ['移动端 rem/vw 适配依赖项目 postcss 配置', '建议以移动端 viewport 预览'],
    // R5-8 冒烟通过（非 verified，方案 R5-8）：vant 4.10.2 + Vue 3.4.27/Vite（headless Chrome）；
    //   冒烟不升 verified（需矩阵级证据）；其余声明腿未验，按 unverified 照常执行（§0.3 第 1 条）
    verified: false,
  },
  {
    id: 'naive-ui',
    displayName: 'Naive UI',
    tier: 2,
    packages: [{ name: 'naive-ui', versions: '^2.0.0', vue: '3' }],
    onDemand: [{ kind: 'unplugin-vue-components', resolver: 'NaiveUiResolver' }],
    config: [{ kind: 'provider-component', component: 'n-config-provider' }],
    globalApis: ['useMessage', 'useDialog', 'useNotification', 'useLoadingBar'],
    pitfalls: ['useMessage 等需要 n-message-provider 等祖先组件；只挂载页面组件时必须由 setup 包裹 Provider'],
    // R5-8 冒烟通过（非 verified，方案 R5-8）：naive-ui 2.45.3 + Vue 3.4.27/Vite（headless Chrome）；
    //   冒烟不升 verified（需矩阵级证据）；其余声明腿未验，按 unverified 照常执行（§0.3 第 1 条）
    verified: false,
  },
  {
    id: 'arco-design-vue',
    displayName: 'Arco Design Vue',
    tier: 2,
    packages: [{ name: '@arco-design/web-vue', versions: '^2.0.0', vue: '3' }],
    defaultStyles: [{ forVersions: '^2.0.0', path: '@arco-design/web-vue/dist/arco.css' }],
    onDemand: [{ kind: 'unplugin-vue-components', resolver: 'ArcoResolver' }],
    config: [{ kind: 'provider-component', component: 'a-config-provider' }],
    globalApis: ['Message', 'Modal', 'Notification'],
    pitfalls: [],
    // R5-8 冒烟通过（非 verified，方案 R5-8）：@arco-design/web-vue 2.59.0 + Vue 3.4.27/Vite（headless Chrome）；
    //   冒烟不升 verified（需矩阵级证据）；其余声明腿未验，按 unverified 照常执行（§0.3 第 1 条）
    verified: false,
  },
  {
    id: 'tdesign-vue',
    displayName: 'TDesign Vue / Vue Next',
    tier: 2,
    packages: [
      { name: 'tdesign-vue', versions: '^1.0.0', vue: '2' },
      { name: 'tdesign-vue-next', versions: '^1.0.0', vue: '3' },
    ],
    onDemand: [{ kind: 'unplugin-vue-components', resolver: 'TDesignResolver' }],
    config: [{ kind: 'provider-component', component: 't-config-provider' }],
    globalApis: ['MessagePlugin', 'DialogPlugin', 'NotifyPlugin'],
    pitfalls: [],
    // R5-8 冒烟通过（非 verified，方案 R5-8）：tdesign-vue-next 1.20.10 + Vue 3.4.27/Vite（headless Chrome）；
    //   冒烟不升 verified（需矩阵级证据）；其余声明腿未验，按 unverified 照常执行（§0.3 第 1 条）
    verified: false,
  },
  {
    id: 'view-ui',
    displayName: 'View UI (iView)',
    tier: 2,
    packages: [
      { name: 'view-design', versions: '^4.0.0', vue: '2' },
      { name: 'iview', versions: '^3.0.0', vue: '2' },
    ],
    onDemand: [{ kind: 'babel-plugin-import' }],
    config: [{ kind: 'plugin-options', example: 'Vue.use(ViewUI, { size, transfer })' }],
    globalApis: ['$Message', '$Modal', '$Notice', '$Spin', '$Loading'],
    pitfalls: ['主题通常为 less 变量覆盖'],
    // R5-8 冒烟通过（非 verified，方案 R5-8）：view-design 4.7.0 + Vue 2.6.14/vue-cli 5（headless Chrome）；
    //   冒烟不升 verified（需矩阵级证据）；其余声明腿未验，按 unverified 照常执行（§0.3 第 1 条）
    verified: false,
  },
  {
    id: 'vuetify',
    displayName: 'Vuetify',
    tier: 2,
    packages: [
      { name: 'vuetify', versions: '^2.0.0', vue: '2' },
      { name: 'vuetify', versions: '^3.0.0', vue: '3' },
    ],
    onDemand: [{ kind: 'none' }],
    config: [{ kind: 'root-option', key: 'vuetify' }, { kind: 'plugin-options', example: 'app.use(createVuetify({...}))' }],
    globalApis: ['$vuetify'],
    pitfalls: [
      'Vuetify 2 需要把 vuetify 实例作为根选项 new Vue({ vuetify })，只重放 Vue.use 不够',
      '组件需包裹在 v-app 内才能得到正确布局与主题',
    ],
    // R5-8 冒烟通过（非 verified，方案 R5-8）：vuetify 3.7.19 + Vue 3.4.27/Vite（headless Chrome）；
    //   冒烟不升 verified（需矩阵级证据）；其余声明腿未验，按 unverified 照常执行（§0.3 第 1 条）
    verified: false,
  },
  {
    id: 'primevue',
    displayName: 'PrimeVue',
    tier: 2,
    packages: [{ name: 'primevue', versions: '^3.0.0 || ^4.0.0', vue: '3' }],
    onDemand: [{ kind: 'unplugin-vue-components', resolver: 'PrimeVueResolver' }],
    config: [{ kind: 'plugin-options', example: 'app.use(PrimeVue, { theme })' }],
    globalApis: ['useToast', 'useConfirm'],
    pitfalls: ['4.x 主题通过 preset 配置；3.x 需要主题 CSS', 'Toast/ConfirmDialog 需挂载对应宿主组件'],
    // R5-8 冒烟通过（非 verified，方案 R5-8）：primevue 4.2.5 + Vue 3.4.27/Vite（headless Chrome）；
    //   冒烟不升 verified（需矩阵级证据）；其余声明腿未验，按 unverified 照常执行（§0.3 第 1 条）
    verified: false,
  },
]
