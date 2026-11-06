/*
 * React 挂载辅助（方案 §6.3；R5-7）。使用项目自己的 react/react-dom；
 * 先由 setup.createContext 提供 wrap（Provider 链），最后渲染真实目标。
 * 纯 JS/ES2018 ESM，无 import 副作用。
 */
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'

export { React, ReactDOM, createElement }

export function nextTick() { return Promise.resolve() }

export function createPreviewApp() {
  var attempted = false
  var disposed = false
  var root
  function unmount() {
    if (attempted && !disposed) { disposed = true; root.unmount() }
  }
  return {
    mount: function (el, Component, options) {
      if (attempted) throw new Error('[dsh-page-preview] React root was already mounted')
      attempted = true
      var child = createElement(Component, options.props)
      // wrap 可为组件（createElement(wrap, null, child)）或元素函数（wrap(child)）；
      // 其余形态在生命周期处已拒绝，这里不再兜底。
      var element = typeof options.wrap === 'function'
        ? options.wrap(child)
        : options.wrap ? createElement(options.wrap, null, child) : child
      root = createRoot(el)
      root.render(element)
      return { unmount: unmount }
    },
    unmount: unmount,
  }
}
