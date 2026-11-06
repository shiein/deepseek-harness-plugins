/*
 * React 项目 setup 契约（方案 §6.9、§8；R5-7）。setup 文件由项目提供（或由入口注册重放
 * 生成草稿后经用户确认保存），被目标项目的构建器编译，因此必须是项目能编译的 JS
 * （或项目已支持的 TS）；JSX 只在项目的编译约定下可用，生成草稿一律用 React.createElement。
 *
 * 钩子与 Vue 侧同一契约（R5-7 按 Vue 分层复制）：
 *
 *   export default {
 *     // 在业务模块导入前调用：全局样式、i18n、主题等（可 await import）；收到
 *     //     { React, ReactDOM, scenario }
 *     async install({ React, ReactDOM, scenario }) { return {} },
 *
 *     // 返回包裹信息：context.wrap 为函数 child => element（Provider 链）或组件；
 *     //     router/store/QueryClient 等实例经 context 透传给 navigate/dispose；
 *     //     收到 { React, createElement, scenario, target, installation }
 *     async createContext({ React, createElement, scenario, target, installation }) {
 *       return { wrap: function (child) { return child } }
 *     },
 *
 *     // 场景映射：把 scenario.identity / permissions / state 写入项目原有的 Store/权限机制
 *     async applyScenario({ scenario, context, installation }) {},
 *
 *     // 路由目标/项目内导航：把路由推进到 href（MemoryRouter / createMemoryRouter），
 *     //     返回最终路径（相对路径，含 search/hash）；收不到时不得挂载目标
 *     async navigate({ route, href, context, installation }) { return href },
 *
 *     // 卸载与重置：清理 Store、查询缓存、挂到 body 的弹层
 *     async dispose({ context, installation }) {},
 *   }
 *
 * install 的返回值作为本次挂载的 installation 传给 createContext；可不返回值。
 * 本文件只作契约说明，不被打包。
 */
export {}
