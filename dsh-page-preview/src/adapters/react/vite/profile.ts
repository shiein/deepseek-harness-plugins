/** react-vite 的已验证组合与能力证据数据（方案 §0.3 第 1 条、§6.2、§6.9、§15.3；R5-7）。
 * 本模块只记录"哪个组合有样本证据"，不构成执行门禁：未验证的版本/平台照常执行，
 * 由执行路径附带 unverified_toolchain 诊断，能力保持 unknown。
 */
import type { CapabilitySet, TargetSelector } from '../../../shared/contracts.ts'

/** 唯一通过完整样本验收的精确组合（兼容矩阵见 tests/fixtures/README.md；react18-vite 工具链）。 */
export const verifiedViteToolchain = {
  react: '18.3.1', reactDom: '18.3.1', vite: '5.2.12',
  reactPlugin: '@vitejs/plugin-react', reactPluginVersion: '4.7.0',
} as const

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
    if (actual === value) continue
    facts.push(actual === undefined
      ? key + ' not recorded in the plan' : key + ' ' + actual + ' (verified sample: ' + value + ')')
  }
  return facts
}

/** Probe 仅是候选；完整只读计划通过后才应用该组合的实际证据，其余组合保持 unknown。 */
export function applyViteEvidence(capabilities: CapabilitySet, toolchain: Record<string, string>,
  selector: TargetSelector): CapabilitySet {
  const fileSelector = selector.kind === 'file' && /\.[jt]sx?$/i.test(selector.path)
  if (process.platform !== 'darwin' || !hasVerifiedViteToolchain(toolchain) || !fileSelector) return capabilities
  const mounted = { status: 'supported', source: 'adapter',
    coverage: ['macOS; React 18.3.1/Vite 5.2.12/plugin-react 4.7.0; original default/named-export '
      + 'JSX/TSX component with entry provider-chain replay; router context via MemoryRouter'] } as const
  return { ...capabilities,
    scopes: { ...capabilities.scopes, component: { ...mounted, coverage: [...mounted.coverage] },
      page: { ...mounted, coverage: [...mounted.coverage] } },
    isolatedRender: { ...mounted, coverage: [...mounted.coverage] },
    refresh: { status: 'supported', source: 'adapter', mode: 'hmr',
      coverage: ['In-place HMR proven in headless Chrome on the verified macOS toolchain '
        + '(window state survives, new markup appears, bootstrap module-updated drives '
        + 'freshness back to current); DSH carrier unverified'] },
    readinessAssertion: { status: 'supported', source: 'response-layer',
      coverage: ['Explicit React mount signal and one observation of configured visible '
        + 'selectors/body innerText; target deadline failure is not success'] },
  }
}
