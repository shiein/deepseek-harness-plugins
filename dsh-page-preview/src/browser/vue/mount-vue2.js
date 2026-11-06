/*
 * Vue 2.6 / 2.7 挂载辅助（方案 §6.3 第 5 步、§6.9）。由项目构建器编译，必须是普通 JS（ES2018，ESM）。
 * 'vue' 从项目依赖解析，不使用插件自带的 Vue。
 * 目标导出校验、setup.createContext 的 rootOptions、mounted 信号与 body 残留节点清理
 * 均由 lifecycle.js 编排（Vue 2 与 Vue 3 行为一致）；本文件只负责项目 Vue 2 的构造与 $destroy。
 */
import Vue from 'vue'
export { Vue }

export function nextTick() { return Vue.nextTick() }

export function mountVue2(el, Target, options) {
  var props = (options && options.props) || {}
  var rootOptions = (options && options.rootOptions) || {}
  var wrap = options && options.wrap
  var vm = new Vue(
    Object.assign({}, rootOptions, {
      render: function (h) {
        var child = h(Target, { props: props })
        return wrap ? h(wrap, [child]) : child
      },
    }),
  ).$mount(el)
  return {
    unmount: function () {
      vm.$destroy()
      if (vm.$el && vm.$el.parentNode) vm.$el.parentNode.removeChild(vm.$el)
    },
  }
}
