/**
 * vue-vite 隔离适配器（方案 §6.3、§6.5、§6.9）。
 *
 * 运行位置：Runner 子进程（或其子进程）；从 appRoot 解析项目自己安装的 vite 与 Vue 插件，
 * 项目未安装时报告 dependency_missing，不回退到插件自带副本。
 *
 * 启动顺序必须遵守 §6.3：
 *   1. 计划解析；准备模块替身与网络边界
 *   2. createServer：是否加载项目 vite.config 由本适配器明确选择（默认加载，以保留别名、按需引入 resolver、样式预处理）；
 *      env 目录与加载选项按预览环境策略设置；受控响应层作为最前置中间件；固定 strictPort
 *   3. 虚拟预览入口（纯 JS，见 src/browser/vue/）先运行 bootstrap 与 Mock 桥接
 *   4. 动态 import setup（入口重放草稿或手写），完成 UI 库/路由/Store/权限绑定
 *   5. 动态 import 目标模块，按 Vue 主版本挂载
 *   6. 等待目标就绪断言 → ready / degraded
 *
 * 已验证的精确工具链组合记录在 vite/profile.ts 与 tests/fixtures/README.md 兼容矩阵；
 * 未验证的版本/平台组合照常执行并附带 unverified_toolchain 诊断，能力为 unknown（§0.3 第 1 条）。
 */

import type { Adapter } from '../../types.ts'
import { discoverVue, planVue, probeVue } from '../preflight.ts'
import { impactVue } from '../impact/index.ts'
import { startVueVite } from './runtime.ts'

export const vueViteAdapter: Adapter = {
  id: 'vue-vite',
  version: '0.0.0',
  strategies: ['isolated'],
  // 与旧 ID 分支一致：vue-* 全部接受。
  features: { scenarios: true, targetAssertions: true, isolatedTarget: true },
  probe: (ctx, target) => probeVue(ctx, 'vite', target),
  discover: discoverVue,
  plan: (ctx, target, scenario, options) => planVue(ctx, target, 'vite', scenario, options),
  start: startVueVite,
  impact: impactVue,
}
