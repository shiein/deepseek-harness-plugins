/*
 * Vue 3 挂载辅助（方案 §6.3、§6.9）。使用项目 Vue；先创建 app 供 setup 安装插件，最后挂载真实目标。
 * rootOptions 作为根组件的 mixin，在首次 mount 前填入；render 始终由目标与可选 Provider 构成。
 * 纯 JS/ES2018 ESM，无 import 副作用；真实验证记录见 docs/vue-browser-lifecycle.md。
 */
import { createApp, h, nextTick } from 'vue'
export { nextTick }

export function createPreviewApp() {
  var Target
  var props
  var wrap
  var rootOptions = {}
  var attempted = false
  var disposed = false
  var app = createApp({
    mixins: [rootOptions],
    render: function () {
      var child = h(Target, props)
      return wrap ? h(wrap, null, { default: function () { return child } }) : child
    },
  })
  function unmount() {
    if (attempted && !disposed) { app.unmount(); disposed = true }
  }
  return {
    app: app,
    mount: function (el, component, options) {
      if (attempted) throw new Error('[dsh-page-preview] Vue app was already mounted')
      Target = component
      props = options.props
      wrap = options.wrap
      Object.assign(rootOptions, options.rootOptions)
      attempted = true
      app.mount(el)
      return { unmount: unmount }
    },
    unmount: unmount,
  }
}
