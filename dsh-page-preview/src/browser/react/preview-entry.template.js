/*
 * React 隔离入口模板（方案 §6.3；R5-7）。适配器填充 JSON/模块占位；仅编排，不直接静态导入业务代码。
 * 网络准备必须先于框架、setup 和目标模块加载；没有 Mock 就绪信号时不能执行要求 Mock 的计划。
 */
import { startReactPreview } from '__LIFECYCLE_MODULE__'

__VITE_HOT_HOOK__

async function main() {
  var bridge = window.__DSH_PREVIEW__
  if (!bridge) throw new Error('[dsh-page-preview] bootstrap bridge is missing')
  var controller = await startReactPreview({
    el: document.getElementById(__MOUNT_ID__),
    scenario: __SCENARIO_JSON__,
    navigation: __NAVIGATION_JSON__,
    target: __TARGET_JSON__,
    props: __PROPS_JSON__,
    exportName: __EXPORT_NAME__,
    beforeImport: async function () {
      if (__REQUIRE_MOCK__ && !bridge.mockReady) throw new Error('[dsh-page-preview] Mock readiness is missing')
      await bridge.mockReady
      __STYLE_IMPORTS__
    },
    loadRuntime: function () { return __RUNTIME_IMPORT__ },
    loadSetup: __SETUP_LOADER__,
    loadTarget: function () { return __TARGET_IMPORT__ },
    onMounted: function (detail) { bridge.mounted(JSON.stringify(detail)) },
  })
  window.addEventListener('pagehide', function () {
    controller.stop().catch(function (error) { throw error })
  }, { once: true })
}
main().catch(function (error) { throw error })
