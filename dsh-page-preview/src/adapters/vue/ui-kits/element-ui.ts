import type { UiKitProfile } from './types.ts'

/** Tier 1。R5-2 已用 vue26-cli 工具链跑齐矩阵（babel-plugin-component 按需引入、$message
 * 全局 API、切场景整页重置，headless Chrome 实测，tests/unit/vue-uikit-matrix.test.ts）；
 * verified 按决策 S 保持 false——矩阵证据来自自有样本，无真实业务项目验收记录。 */
export const elementUi: UiKitProfile = {
  id: 'element-ui',
  displayName: 'Element UI',
  tier: 1,
  packages: [{ name: 'element-ui', versions: '^2.0.0', vue: '2' }],
  defaultStyles: [
    {
      forVersions: '^2.0.0',
      path: 'element-ui/lib/theme-chalk/index.css',
      note: '项目常用自定义 SCSS 主题替代；以入口实际 import 为准',
    },
  ],
  onDemand: [{ kind: 'babel-plugin-component' }, { kind: 'unplugin-vue-components', resolver: 'ElementUiResolver' }],
  config: [{ kind: 'plugin-options', example: 'Vue.use(ElementUI, { locale, size, zIndex })' }],
  globalApis: ['$message', '$msgbox', '$alert', '$confirm', '$prompt', '$notify', '$loading'],
  pitfalls: [
    '按需引入依赖项目 babel 配置中的 babel-plugin-component，必须加载项目自己的 babel 配置',
    '语言包通过 Vue.use 选项或 locale.use 设置，常与 vue-i18n 联动',
    '$message 等弹层挂在 body，切换场景时需清理残留节点',
  ],
  verified: false,
}
