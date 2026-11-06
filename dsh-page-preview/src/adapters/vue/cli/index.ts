/**
 * vue-cli 隔离适配器（Vue CLI / webpack，方案 §6.9）。面向 Vue 2 + Element UI / Ant Design Vue 1.x 项目。
 *
 * 实现（尚无 verified 样本，所有组合按 unverified_toolchain 执行）：
 *  - 在 Runner 子进程中运行项目自己的 @vue/cli-service（从 appRoot 解析），不使用插件自带副本
 *  - 生成临时配置文件（插件临时目录、登记账本）：require 项目原 vue.config.js，
 *    覆盖 pages 为预览页（入口/模板在临时目录），devServer 绑定 loopback；
 *    会改写网络的项目 devServer 键（proxy/setupMiddlewares/before 等）显式拒绝而非链接执行
 *  - 通过环境变量 VUE_CLI_SERVICE_CONFIG_PATH 指向临时配置，不修改项目文件
 *  - 受控响应层：webpack-dev-server v4 经 devServer.setupMiddlewares 前插（v3 未实现）
 *  - 端口：portfinder 取实际端口后以账本归属核对；HMR 关闭（hot/liveReload/webSocketServer:false），
 *    业务 Upgrade 在 dev-server socket 层销毁并上报 blocked_request
 *  - 编译结果：webpack done/failed 钩子转 compile-error/compiled；freshness 不伪造 current
 *
 * 不支持：非 vue-cli 的手写 webpack 配置（走 project 策略）、webpack-dev-server v3 组合、异步 vue.config.js 导出。
 */

import type { Adapter } from '../../types.ts'
import { discoverVue, planVue, probeVue } from '../preflight.ts'
import { impactVue } from '../impact/index.ts'
import { startVueCli } from './runtime.ts'

/** 已实测的 @vue/cli-service 主版本范围：4.5.19（wds v3，vue26-cli4）与 5.0.9
 * （wds v4，vue26-cli/vue27-cli）全链路通过；未验证版本照常执行并带 unverified_toolchain。 */
export const SUPPORTED_CLI_SERVICE = '>=4 <6'

export const vueCliAdapter: Adapter = {
  id: 'vue-cli',
  version: '0.0.0',
  strategies: ['isolated'],
  // 与旧 ID 分支一致：vue-* 全部接受。
  features: { scenarios: true, targetAssertions: true, isolatedTarget: true },
  probe: (ctx, target) => probeVue(ctx, 'vue-cli', target),
  discover: discoverVue,
  plan: (ctx, target, scenario, options) => planVue(ctx, target, 'vue-cli', scenario, options),
  start: ctx => startVueCli(ctx),
  impact: impactVue,
}
