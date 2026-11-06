/**
 * Vue CLI 组合的未验证事实（方案 §0.3 第 1 条、§6.9）。vue-cli 目前没有任何 verified 样本，
 * 所有组合照常执行并报告 unverified_toolchain，能力保持 unknown。
 */
export function unverifiedCliFacts(toolchain: Record<string, string>): string[] {
  const facts = ['vue-cli build host has no verified sample evidence yet']
  if (!toolchain['vue-cli']) facts.push('installed @vue/cli-service version is unresolved')
  if (!toolchain.vue) facts.push('installed vue version is unresolved')
  return facts
}
