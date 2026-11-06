import type { UiKitProfile } from './types.ts'

/**
 * Tier 1，覆盖三个大版本：1.x（Vue 2）、3.x 与 4.x（Vue 3）。
 * 样本：vue27-cli（2.7.16 + antdv 1.7.8 babel-plugin-import，产物无全量入口）与
 * vue3-self-contained（4.2.5 + AntDesignVueResolver importStyle:false——4.x CSS-in-JS
 * 无样式文件，按需/message 全局 API/切场景重置，headless Chrome 实测）。
 */
export const antDesignVue: UiKitProfile = {
  id: 'ant-design-vue',
  displayName: 'Ant Design Vue',
  tier: 1,
  packages: [
    { name: 'ant-design-vue', versions: '^1.0.0', vue: '2' },
    { name: 'ant-design-vue', versions: '^2.0.0 || ^3.0.0', vue: '3' },
    { name: 'ant-design-vue', versions: '^4.0.0', vue: '3' },
  ],
  defaultStyles: [
    { forVersions: '^1.0.0 || ^2.0.0 || ^3.0.0', path: 'ant-design-vue/dist/antd.css', note: 'less 主题定制时由项目 less 配置处理' },
    { forVersions: '^4.0.0', path: 'ant-design-vue/dist/reset.css', note: '4.x 为 CSS-in-JS，reset.css 可选' },
  ],
  onDemand: [{ kind: 'babel-plugin-import' }, { kind: 'unplugin-vue-components', resolver: 'AntDesignVueResolver' }],
  config: [{ kind: 'provider-component', component: 'a-config-provider' }],
  globalApis: ['$message', '$notification', '$info', '$success', '$error', '$warning', '$confirm', 'message', 'notification', 'Modal'],
  pitfalls: [
    '1.x/3.x 的 less 主题依赖项目 css.loaderOptions / preprocessorOptions 中的 javascriptEnabled 与 modifyVars',
    '4.x 主题通过 ConfigProvider 的 theme 属性传入，不依赖全局 CSS',
    '1.x 的 moment 语言包需与 locale 同步',
  ],
  verified: true,
}
