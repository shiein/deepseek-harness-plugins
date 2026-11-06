/*
 * 项目 setup 契约（方案 §6.9、§8）。setup 文件由项目提供（或由入口注册重放生成草稿后经用户确认保存），
 * 被目标项目的构建器编译，因此必须是项目能编译的 JS（或项目已支持的 TS）。
 *
 * 具体 hook 在首批 Vue 样本验证后冻结（方案 §8）。当前草案：
 *
 *   export default {
 *     // 在业务模块导入前调用：注册 UI 库、全局组件/指令、全局样式（可 await import）
 *     async install({ Vue, app, scenario }) { return { rootOptions: {} } },
 *
 *     // 返回根实例选项或包裹组件：router、store、i18n、vuetify、Provider 包裹等
 *     async createContext({ Vue, app, scenario, target, installation }) { return { rootOptions: {}, wrap: null } },
 *
 *     // 场景映射：把 scenario.identity / permissions / state 写入项目原有的 Store/权限机制
 *     async applyScenario({ scenario, context }) {},
 *
 *     // 卸载与重置：清理 Store、查询缓存、挂到 body 的弹层
 *     async dispose({ context }) {},
 *   }
 *
 * Vue 2：参数中提供 Vue 构造函数，app 为 undefined；Vue 3：提供 app 实例，Vue 为 undefined。
 * install 的返回值作为本次挂载的 installation 传给 createContext；可不返回值。
 * 草稿用它传递第三方根选项实例，避免多次挂载共享模块级可变状态。
 * 本文件只作契约说明，不被打包。
 */
export {}
