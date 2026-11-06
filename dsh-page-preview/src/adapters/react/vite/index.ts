/**
 * react-vite 隔离适配器（方案 §6.3、§6.5、§6.9；R5-7）。
 *
 * 运行位置：Runner 子进程；从 appRoot 解析项目自己安装的 vite、react/react-dom 与 React 编译插件
 * （@vitejs/plugin-react 或 @vitejs/plugin-react-swc），项目未安装时报告 dependency_missing，
 * 不回退到插件自带副本。
 *
 * 启动顺序遵守 §6.3：
 *   1. 计划解析；准备模块替身与网络边界
 *   2. createServer：加载项目 vite.config（默认加载，保留别名与样式预处理）；
 *      env 目录与加载选项按预览环境策略设置；受控响应层作为最前置中间件；固定 strictPort
 *   3. 虚拟预览入口（纯 JS，见 src/browser/react/）先运行 bootstrap 与 Mock 桥接
 *   4. 动态 import setup（入口重放草稿或手写），完成 Provider 链/路由上下文绑定
 *   5. 动态 import 目标模块，createRoot().render 挂载（叶组件替换业务根）
 *   6. 等待目标就绪断言 → ready / degraded
 *
 * 已验证的精确工具链组合记录在 vite/profile.ts 与 tests/fixtures/README.md 兼容矩阵；
 * 未验证的版本/平台组合照常执行并附带 unverified_toolchain 诊断，能力为 unknown（§0.3 第 1 条）。
 */

import type { Adapter } from '../../types.ts'
import { discoverReact, planReact, probeReact } from '../preflight.ts'
import { impactReact } from '../impact/index.ts'
import { startReactVite } from './runtime.ts'

export const reactViteAdapter: Adapter = {
  id: 'react-vite',
  version: '0.0.0',
  strategies: ['isolated'],
  features: { scenarios: true, targetAssertions: true, isolatedTarget: true },
  probe: probeReact,
  discover: discoverReact,
  plan: (ctx, target, scenario, options) => planReact(ctx, target, 'vite', scenario, options),
  start: startReactVite,
  impact: impactReact,
}
