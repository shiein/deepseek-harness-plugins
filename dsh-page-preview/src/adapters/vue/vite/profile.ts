/** vue-vite 的已验证组合与能力证据数据（方案 §0.3 第 1 条、§6.2、§6.9、§15.3）。
 * 本模块只记录"哪个组合有样本证据"，不构成执行门禁：验证过的版本保存在 profile 数据与
 * tests/fixtures/README.md 兼容矩阵中；未验证的版本/平台照常执行，由执行路径附带
 * unverified_toolchain 诊断，能力保持 unknown。
 */
import type { CapabilitySet, TargetSelector } from '../../../shared/contracts.ts'

/** 唯一通过完整样本验收的精确组合（兼容矩阵见 tests/fixtures/README.md）。 */
export const verifiedViteToolchain = { vue: '3.4.27', vite: '5.2.12', vuePlugin: '@vitejs/plugin-vue', vuePluginVersion: '5.1.4' } as const

/** 计划记录的工具链是否与样本证据组合完全一致；不决定能否执行。 */
export function hasVerifiedViteToolchain(toolchain: Record<string, string>): boolean {
  return Object.entries(verifiedViteToolchain).every(([key, value]) => toolchain[key] === value)
}

/** 列出与已验证样本不一致的执行轴（版本差异与运行平台）；空数组表示本机组合有完整样本证据。 */
export function unverifiedViteFacts(toolchain: Record<string, string>): string[] {
  const facts: string[] = []
  if (process.platform !== 'darwin') facts.push('platform ' + process.platform + ' (verified sample: darwin)')
  for (const [key, value] of Object.entries(verifiedViteToolchain)) {
    const actual = toolchain[key]
    if (actual !== value) facts.push(actual === undefined ? key + ' not recorded in the plan' : key + ' ' + actual + ' (verified sample: ' + value + ')')
  }
  // JSX/TSX 目标经项目自己的 @vitejs/plugin-vue-jsx 编译：没有已验证样本。
  if (toolchain.vueJsx !== undefined) {
    facts.push('JSX target via @vitejs/plugin-vue-jsx ' + toolchain.vueJsx + ' (no verified sample)')
  }
  return facts
}

/** Probe 仅是候选；完整只读计划通过后才应用该组合的实际证据，其余组合保持 unknown。 */
export function applyViteEvidence(capabilities: CapabilitySet, toolchain: Record<string, string>, selector: TargetSelector): CapabilitySet {
  if (process.platform !== 'darwin' || !hasVerifiedViteToolchain(toolchain) || selector.kind !== 'file' || !/\.vue$/i.test(selector.path)) return capabilities
  const mounted = { status: 'supported', source: 'adapter', coverage: ['macOS; Vue 3.4.27/Vite 5.2.12/plugin-vue 5.1.4; original default/named-export JS/TS SFC with explicit initialization; no router/shell substitution'] } as const
  return { ...capabilities, scopes: { ...capabilities.scopes, component: { ...mounted, coverage: [...mounted.coverage] }, page: { ...mounted, coverage: [...mounted.coverage] } }, isolatedRender: { ...mounted, coverage: [...mounted.coverage] },
    scenarioApply: { status: 'supported', source: 'adapter', coverage: ['Initial configured props, reviewed browser setup data, declared same-origin HTTP fixtures and approved per-preview Node handlers; no browser identity/storage reset'] },
    // toolchain-scenario E2E（macOS + Linux Docker）：refresh 就地重读场景数据并供出，切场景生效。
    scenarioReset: { status: 'supported', source: 'adapter', coverage: [
      'Declared scenario HTTP fixtures/body re-read and re-bound in place; '
        + 'no browser identity/storage reset; verified at HTTP level only',
    ] },
    // R5-3（2026-11-03）：真实 headless Chrome 实测 SFC 修改经 HMR 就地应用——页面变量
    // 存活（非整页重载）、新标记出现、bootstrap module-updated 推动 freshness 回 current。
    // 载体 IAB 未验，不外推；详见 docs/evidence/2026-11-03-vite-browser-refresh.md。
    refresh: { status: 'supported', source: 'adapter', mode: 'hmr',
      coverage: ['In-place HMR proven in headless Chrome on the verified macOS toolchain '
        + '(window state survives, new markup appears, bootstrap module-updated drives '
        + 'freshness back to current); DSH carrier unverified'] },
    readinessAssertion: { status: 'supported', source: 'response-layer', coverage: ['Explicit Vue mount signal and one observation of configured visible selectors/body innerText; target deadline failure is not success'] },
  }
}
