/**
 * Model price table: USD per 1,000,000 tokens.
 *
 * The dashboard shows an *estimated API-equivalent cost*, never a subscription bill. Providers do
 * not estimate cost themselves: the scanner calls `estimateCellCost` for every merged cell.
 *
 * Owners: pricing task. Keep the exported API stable:
 *   PRICING_VERSION, PRICES, normalizeModelId, priceFor, estimateCost, estimateCellCost, hasPrice
 * `pricing_version` in the snapshot lets the UI/tests detect table changes.
 *
 * Rate sources (fetched 2026-11-04, USD / 1M tokens):
 *   - LiteLLM `model_prices_and_context_window.json` (the same table T3 Code prices from):
 *     https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
 *     raw: https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
 *   - T3 Code's pricing/aggregation logic (speed tiers, unpriced-model rules, cache fallbacks):
 *     https://github.com/pingdotgg/t3code/blob/main/apps/server/src/usage/usagePricing.ts
 *     https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md
 *   - Legacy (`claude-3-*`, `gpt-4*`, `o1`) rates are the long-standing published list prices
 *     LiteLLM no longer carries as bare keys.
 *
 * Conventions:
 *   - `input` is the UNCACHED input rate; providers must subtract cached tokens before pricing
 *     (see CONTRACT.md). `cacheRead` is the discounted cache-hit rate. `cacheWrite` is the
 *     cache-creation rate; for providers that do not bill cache writes separately it equals
 *     `input` (t3code's fallback rule: missing cache rates use the input rate).
 *   - A few entries carry an optional `fast` sub-table (Codex `priority` / Grok fast / Claude Code
 *     `speed: "fast"`). `estimateCost` uses it when the caller sets `usage.tier === 'fast'` or the
 *     model id itself ends in `-fast` / `-priority`. OpenAI priority tiers are exactly 2x list.
 *   - Models without public rates stay OUT of the table (never estimate a made-up number); the UI
 *     marks them unpriced. Two deliberate exceptions are documented inline (`codex-auto-review`,
 *     `swe-2-high`) because their local volume is high and they are clearly part of a priced family.
 */

export const PRICING_VERSION = 4;

/** @typedef {{input: number, output: number, cacheRead: number, cacheWrite: number}} ModelPrice */

/**
 * Canonical model id -> price. Rates are USD per 1M tokens.
 * `cacheRead` defaults to the input rate; `cacheWrite` defaults to the input rate as well when
 * omitted (Anthropic-style tables spell out the 1.25x creation premium explicitly).
 * @type {Record<string, ModelPrice & {fast?: ModelPrice}>}
 */
export const PRICES = {
  // ── Anthropic Claude (Claude Code) ────────────────────────────────────────────────────────────
  // Current 2026 families. Opus 5.5 / Sonnet 5.5 are cheaper than Opus 5 / Sonnet 5.
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // Premium/limited Claude tiers seen in the 2026 price table.
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  // Legacy Claude 3.x list prices (still present in long-lived transcripts).
  'claude-3-7-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },

  // ── OpenAI / Codex ───────────────────────────────────────────────────────────────────────────
  // `fast` = the `priority` service tier (2x standard list rate). Cache writes are billed at the
  // input rate on OpenAI models that do not break them out separately.
  'gpt-6-astra': {
    input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5,
    fast: { input: 20, output: 100, cacheRead: 2, cacheWrite: 25 },
  },
  'gpt-6-sol': {
    input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5,
    fast: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  },
  'gpt-6.1-sol': {
    input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
    fast: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  },
  'gpt-6.1-terra': {
    input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25,
    fast: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  },
  'gpt-6-luna': {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
    fast: { input: 0.2, output: 1, cacheRead: 0.02, cacheWrite: 0.25 },
  },
  'gpt-5.6-sol': {
    input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5,
    fast: { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 },
  },
  'gpt-5.6': {
    input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5,
    fast: { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 },
  },
  'gpt-5.6-terra': {
    input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5,
    fast: { input: 4, output: 24, cacheRead: 0.4, cacheWrite: 5 },
  },
  'gpt-5.6-luna': {
    input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25,
    fast: { input: 0.4, output: 2.4, cacheRead: 0.04, cacheWrite: 0.5 },
  },
  'gpt-5.5': {
    input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5,
    fast: { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 12.5 },
  },
  'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.2 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 },
  'gpt-5.2-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 },
  'gpt-5.2': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 },
  'gpt-5.1-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5.1-codex-max': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5.1-codex-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  'gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.05 },
  'gpt-4.1': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
  o3: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  'o3-mini': { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 },
  'o3-pro': { input: 20, output: 80, cacheRead: 20, cacheWrite: 20 },
  'o4-mini': { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 },
  o1: { input: 15, output: 60, cacheRead: 7.5, cacheWrite: 15 },
  // OpenAI's hidden per-turn approval reviewer. It has no public rate; 3.7k local turns would
  // otherwise be permanently unpriced. Proxied at the current Terra workhorse tier (cheap, fast).
  'codex-auto-review': {
    input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25,
    fast: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  },

  // ── DeepSeek ────────────────────────────────────────────────────────────────────────────────
  // deepseek-flash / v4-flash: cache writes are free; cache reads are ~2% of input.
  'deepseek-flash': { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  'deepseek-v4-flash': { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  'deepseek-v4-flash-vision-exp': { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  'deepseek-v4-pro': { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
  'deepseek-chat': { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 },
  'deepseek-reasoner': { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 },
  'deepseek-v3.2': { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 },
  'deepseek-v3': { input: 0.27, output: 1.1, cacheRead: 0.027, cacheWrite: 0.27 },

  // ── xAI Grok (Grok Build / Grok CLI / Cursor) ───────────────────────────────────────────────
  'grok-4.7': { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },
  'grok-4.6': { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },
  'grok-4.5': { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 2 },
  'grok-4.3': { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 1.25 },
  'grok-4.20': { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 1.25 },
  'grok-4-1-fast-reasoning': { input: 0.2, output: 0.5, cacheRead: 0.05, cacheWrite: 0.2 },
  'grok-4-1-fast-non-reasoning': { input: 0.2, output: 0.5, cacheRead: 0.05, cacheWrite: 0.2 },
  'grok-code-fast-1': { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 1 },
  'grok-code-fast': { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 1 },
  'grok-4': { input: 3, output: 15, cacheRead: 0.75, cacheWrite: 3 },
  // Grok Build: the `-build` models bill at the underlying 4.6/4.7 text rates.
  'grok-build': { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 2 },
  'grok-4.6-build': { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },
  'grok-4.7-build': { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },

  // ── Google Gemini (Gemini CLI, Antigravity, OpenCode) ───────────────────────────────────────
  'gemini-3-flash-preview': { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.5 },
  'gemini-3-pro-preview': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 },
  'gemini-3.1-pro-preview': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0.25 },
  'gemini-3.5-flash': { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.5 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
  'gemini-3.7-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
  // `gemini-flash-latest` is Google's rolling alias; priced at the current Flash tier.
  'gemini-flash-latest': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },

  // ── Alibaba Qwen ────────────────────────────────────────────────────────────────────────────
  // `qwen3-coder-plus` / `qwen3-coder-flash` have no rates in the current LiteLLM snapshot
  // (dashscope entries carry null costs), so they stay unpriced instead of guessed.
  'qwen-max': { input: 1.6, output: 6.4, cacheRead: 1.6, cacheWrite: 1.6 },
  'qwen-plus': { input: 0.4, output: 1.2, cacheRead: 0.4, cacheWrite: 0.4 },

  // ── Moonshot Kimi ───────────────────────────────────────────────────────────────────────────
  'kimi-k3': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
  'kimi-k3.1-pro': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 },
  'kimi-k2.7-code': { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0.95 },
  'kimi-k2.6': { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0.6 },
  'kimi-k2.5': { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0.6 },
  'kimi-k2-thinking': { input: 0.6, output: 2.5, cacheRead: 0.6, cacheWrite: 0.6 },

  // ── Z.ai GLM ────────────────────────────────────────────────────────────────────────────────
  'glm-5.3': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
  'glm-5.3-flash': { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0.15 },
  'glm-5.2': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
  'glm-5.1': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
  'glm-5': { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 1 },
  'glm-5-code': { input: 1.2, output: 5, cacheRead: 0.3, cacheWrite: 1.2 },
  'glm-4.7': { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0.6 },

  // ── MiniMax ─────────────────────────────────────────────────────────────────────────────────
  'minimax-m3': { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.3 },
  'minimax-m3.1-flash': { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0.15 },
  'minimax-m2.5': { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.3 },
  'minimax-m2.1': { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.3 },

  // ── Cognition (Devin / SWE) ─────────────────────────────────────────────────────────────────
  'swe-1.7': { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0.5 },
  'swe-1.6': { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0.5 },
  'swe-1.7-lightning': { input: 2.5, output: 12.5, cacheRead: 1, cacheWrite: 2.5 },
  // SWE-2 has no published rate yet; Devin's pooled SWE-2 usage is proxied at the SWE-1.7 tier.
  'swe-2-high': { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0.5 },
};

/**
 * Bare family names that are generation-ambiguous and must stay unpriced (mirrors t3code's
 * `UNPRICEABLE_MODELS`). `<synthetic>` is Claude Code's local placeholder that never hit the API.
 */
const UNPRICEABLE_MODELS = new Set([
  '',
  '<synthetic>',
  'synthetic',
  'unknown',
  'auto',
  'default',
  'none',
  'opus',
  'sonnet',
  'haiku',
  'fable',
]);

/** Aliases and vendor-prefixed ids that map onto a canonical id. */
const ALIASES = {
  // Tool-level / family aliases.
  'claude-code': 'claude-sonnet-5-5',
  'claude-code-sonnet': 'claude-sonnet-5-5',
  'claude-code-opus': 'claude-opus-5-5',
  'claude-code-haiku': 'claude-haiku-5-5',
  // Dated / snapshot ids that appear in transcripts.
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5',
  'claude-opus-4-5-20251101': 'claude-opus-4-5',
  'claude-opus-4-1-20250805': 'claude-opus-4-1',
  'claude-opus-4-20250514': 'claude-opus-4',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
  'claude-sonnet-5-5-202610xx': 'claude-sonnet-5-5',
  // Dash-separated spellings used by some agents (e.g. `glm-5-2`, `swe-1-7`).
  'glm-5-2': 'glm-5.2',
  'glm-5-3': 'glm-5.3',
  'glm-5-2-1m': 'glm-5.2',
  'glm-5-3-flash': 'glm-5.3-flash',
  'swe-1-7': 'swe-1.7',
  'swe-1-6': 'swe-1.6',
  'swe-1-7-lightning': 'swe-1.7-lightning',
  'swe-2': 'swe-2-high',
  // Devin CLI reports SWE variants with an effort suffix; the token rate is the family rate.
  'swe-2-max': 'swe-2-high',
  'swe-2-medium': 'swe-2-high',
  'swe-2-low': 'swe-2-high',
  'swe-1-7-medium': 'swe-1.7',
  'swe-1-7-high': 'swe-1.7',
  'swe-1-6-medium': 'swe-1.6',
  'swe-1-6-high': 'swe-1.6',
  // Devin CLI spells the Fable family with the generation number in the middle.
  'claude-5-fable-low': 'claude-fable-5',
  'claude-5-fable-medium': 'claude-fable-5',
  'claude-5-fable-high': 'claude-fable-5',
  'claude-5-fable-xhigh': 'claude-fable-5',
  'claude-5-fable-max': 'claude-fable-5',
  'claude-5-1-fable-low': 'claude-fable-5-1',
  'claude-5-1-fable-medium': 'claude-fable-5-1',
  'claude-5-1-fable-high': 'claude-fable-5-1',
  'claude-5-1-fable-xhigh': 'claude-fable-5-1',
  'kimi-k2-5': 'kimi-k2.5',
  'kimi-k2-6': 'kimi-k2.6',
  'kimi-k3-1-pro': 'kimi-k3.1-pro',
  'minimax-m3-1-flash': 'minimax-m3.1-flash',
  'minimax-m2-5': 'minimax-m2.5',
  'gemini-3-1-pro': 'gemini-3.1-pro-preview',
  // Antigravity reports effort variants of an otherwise priced family.
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-3.1-pro-low': 'gemini-3.1-pro-preview',
  'gemini-3.1-pro-high': 'gemini-3.1-pro-preview',
  'gemini-3.1-pro-medium': 'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-low': 'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-high': 'gemini-3.1-pro-preview',
  'gemini-3-1-flash-lite': 'gemini-3.1-flash-lite',
  // Provider-prefixed model ids whose family is not inferred by the generic normalizer.
  'grok:grok-4.7': 'grok-4.7',
  'grok:grok-4.6': 'grok-4.6',
  'xai/grok-4.7': 'grok-4.7',
  'xai/grok-4.6': 'grok-4.6',
  'xai/grok-code-fast-1': 'grok-code-fast-1',
  'xai/grok-build-latest': 'grok-build',
  'antigravity-gemini-3-flash': 'gemini-3-flash-preview',
  'google-antigravity/gemini-3-flash': 'gemini-3-flash-preview',
  'opencode/grok-code': 'grok-code-fast',
  'big-pickle': '',
  // Cursor exposes its own model aliases; map the ones that alias a priced family.
  'cursor-grok-4.6': 'grok-4.6',
  'cursor-grok-4.7': 'grok-4.7',
};

/**
 * Normalize a raw model id from a session file to a price-table key.
 * Lowercases, drops provider prefixes (`anthropic/…`, `devin:swe-2-high`), snapshot dates
 * (`-20250929`, `-2025-09-29`, `@20250929`), Bedrock version suffixes (`-v1:0`) and context
 * markers (`[1m]`), then resolves aliases.
 * @param {string} model
 * @returns {string}
 */
export function normalizeModelId(model) {
  let id = String(model || '').trim().toLowerCase();
  if (id === '') return '';
  // Strip a trailing (provider) marker and bracketed context/variant markers, e.g. `[1m]`.
  id = id.replace(/\s*\([^)]*\)$/, '');
  id = id.replace(/\[[^\]]*\]$/, '');
  const bare = (value) => value.replace(/^country\.[^/]+\//, '');

  // OpenCode Zen's `-free` promo aliases (e.g. `minimax-m2.5-free`) are genuinely $0 models; keep
  // them unpriced instead of prefix-matching the paid family rate and inventing a cost.
  if (id.endsWith('-free')) return '';

  // Take the model segment of `provider/model:tag` or `provider:model` ids.
  const lastSlash = id.lastIndexOf('/');
  if (lastSlash >= 0) id = bare(id.slice(lastSlash + 1));
  const lastColon = id.lastIndexOf(':');
  if (lastColon >= 0 && !/^\d/.test(id.slice(lastColon + 1))) id = id.slice(lastColon + 1);

  // Strip Bedrock-style `-v1:0` / `-v1` and Vertex-style `@version` suffixes before aliasing.
  id = id.replace(/-v\d+(?::\d+)?$/, '');
  id = id.replace(/@\d{8}$/, '');

  if (UNPRICEABLE_MODELS.has(id)) return '';
  if (ALIASES[id]) return ALIASES[id];

  // Strip a trailing YYYYMMDD / YYYY-MM-DD snapshot suffix.
  const dated = id.replace(/[-@:]?(\d{4}-?\d{2}-?\d{2})$/, '');
  if (dated !== id) {
    if (UNPRICEABLE_MODELS.has(dated)) return '';
    if (ALIASES[dated]) return ALIASES[dated];
    if (PRICES[dated]) return dated;
    id = dated;
  }

  // Some tools append the provider as a suffix (`model@openai`, `model (anthropic)` handled above).
  const atProvider = id.replace(/@[a-z0-9_-]+$/, '');
  if (atProvider !== id) {
    if (ALIASES[atProvider]) return ALIASES[atProvider];
    if (PRICES[atProvider]) return atProvider;
    id = atProvider;
  }

  return id;
}

/**
 * @param {string} model
 * @returns {ModelPrice|null}
 */
export function priceFor(model) {
  const normalized = normalizeModelId(model);
  if (normalized === '') return null;
  const direct = PRICES[normalized];
  if (direct) return direct;
  // Longest-prefix match handles effort/preview/fast suffixes the alias table missed. The rest must
  // be a named suffix (`-high`): `gpt-5.7` or `claude-opus-4-9` is another version, so it stays unpriced.
  let best = null;
  let bestLength = 0;
  for (const key of Object.keys(PRICES)) {
    if (normalized.startsWith(key) && key.length > bestLength && /^-[a-z]/.test(normalized.slice(key.length))) {
      best = PRICES[key];
      bestLength = key.length;
    }
  }
  return best;
}

/**
 * A model id may itself encode a speed tier (`gpt-5.5-fast`, `claude-opus-5-5-priority`).
 * @param {string} model
 * @returns {'fast'|'ultrafast'|null}
 */
function explicitSpeedTier(model) {
  const id = String(model || '').trim().toLowerCase();
  if (id.endsWith('-ultrafast')) return 'ultrafast';
  if (id.endsWith('-fast') || id.endsWith('-priority')) return 'fast';
  return null;
}

/**
 * @param {string} model
 * @param {{input?: number, output?: number, cacheRead?: number, cacheWrite?: number, tier?: string}} usage
 * @returns {number|null} USD, or null when the model has no known price
 */
export function estimateCost(model, usage) {
  const price = priceFor(model);
  if (!price) return null;
  const tier = usage.tier === 'ultrafast' || usage.tier === 'fast'
    ? usage.tier
    : explicitSpeedTier(model);
  // Only the fast tier has a published multiplier today; ultrafast falls back to list rate.
  const rates = tier === 'fast' && price.fast ? price.fast : price;
  const input = usage.input || 0;
  const output = usage.output || 0;
  const cacheRead = usage.cacheRead || 0;
  const cacheWrite = usage.cacheWrite || 0;
  return (
    (input * rates.input +
      output * rates.output +
      cacheRead * (rates.cacheRead ?? rates.input) +
      cacheWrite * (rates.cacheWrite ?? rates.input)) /
    1_000_000
  );
}

/**
 * Cost for one merged cell: provider-reported cost passes through unchanged; only cells without a
 * reported cost are estimated from the price table.
 * @param {{model: string, input?: number, output?: number, cacheRead?: number, cacheWrite?: number,
 *          costUsd?: number|null, tier?: string}} cell
 * @returns {number|null}
 */
export function estimateCellCost(cell) {
  if (typeof cell.costUsd === 'number' && Number.isFinite(cell.costUsd)) {
    return cell.costUsd;
  }
  return estimateCost(cell.model, cell);
}

/**
 * Whether the price table knows this model (the UI marks unpriced models).
 * @param {string} model
 * @returns {boolean}
 */
export function hasPrice(model) {
  return priceFor(model) !== null;
}
