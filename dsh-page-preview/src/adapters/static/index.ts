/**
 * static 适配器（方案 §6.1、§6.6、§6.7）。
 * - 自有 HTTP 服务，只暴露 publicRoot 范围；保持资源和多页路径
 * - 只有显式 spaFallback 才回退 index.html；不存在的资源返回 404，不掩盖路径错误
 * - 通过受控响应层：CSP、bootstrap 注入、归属探针、Host 头校验（§6.8）
 * - 已有产物默认 freshness=unverified；直接服务源 HTML/JS/CSS 时记录实际文件与重载证据
 * - 原始服务端模板和未编译组件不是静态页面
 */

import type { Adapter } from '../types.ts'
import { startStatic } from './runtime.ts'
import { discoverStatic, planStatic, probeStatic } from './preflight.ts'
import { impactStatic } from './impact.ts'

export const staticAdapter: Adapter = {
  id: 'static',
  version: '0.0.0',
  strategies: ['static'],
  // 与旧 ID 分支一致：接受场景与目标断言；不接受 isolated-target/entry/styles。
  features: { scenarios: true, targetAssertions: true, isolatedTarget: false },
  probe: probeStatic,
  discover: discoverStatic,
  plan: planStatic,
  async start(ctx) {
    return startStatic(ctx)
  },
  impact: impactStatic,
}
