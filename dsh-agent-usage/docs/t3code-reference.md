# T3 Code (t3code) Usage implementation — reference for our plugin

Research notes for the DSH Agent Usage plugin's provider contract. Everything below was derived from
the public T3 Code repository and from inspecting this Mac's real agent data (2026-11-04).

- Repository: <https://github.com/pingdotgg/t3code> (branch `main`, downloaded as a tarball on
  2026-11-04; all blob links below point at `main`).
- User-facing documentation:
  <https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md> ·
  <https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/user/usage.md>
- Repo README: <https://github.com/pingdotgg/t3code/blob/main/README.md>
- Per-provider docs: <https://github.com/pingdotgg/t3code/tree/main/docs/user> (e.g.
  `providers-claude.md`, `providers-codex.md`, `providers-opencode.md`, `providers-pi.md`,
  `providers-muse.md`, `providers-antigravity.md`, `cursor.md`).

T3 Code's own summary of the feature (quoted from `docs/user/usage.md`):

> **Usage** combines Codex, Claude Code, Grok Build, OpenCode, Antigravity, Pi, Muse Code, and Cursor
> history from your connected environments. It shows token use, cache savings, model breakdowns, and
> estimated API-equivalent cost, split by token type and by speed. These estimates are not your
> subscription bill. **Premium** is what Fast and Ultrafast requests cost above standard rates.

Three things in that sentence drive the whole design and are worth copying:

1. **Aggregate, don't bill.** Every cost is an *estimate at public API rates*, computed centrally.
2. **Speed tiers matter.** A request billed at a `fast`/`priority` rate costs more than the same
   tokens at standard rate; T3 Code tracks the premium separately.
3. **Nothing is invented.** Tokens come from recorded counters; models without known rates stay
   visibly "unpriced" rather than guessed.

---

## 1. Architecture overview

Usage lives in `apps/server/src/usage/`:

| File | Responsibility |
| --- | --- |
| `UsageService.ts` | Orchestrates scans, fetches/persists the rate table, merges duplicate sessions |
| `usageAggregation.ts` | Buckets records by local day/model, computes cost, cache savings, speed premium |
| `usagePricing.ts` | LiteLLM rate-table parsing, model-id resolution, per-record pricing |
| `usageTranscriptReader.ts` | Incremental JSONL reader with resume guards and tail handling |
| `usageScanCache.ts` | On-disk per-file fingerprint cache (size + mtime) with schema version |
| `CodexUsageHistory.ts` | Resolves Codex service tiers from a local history DB |

Two kinds of provider readers are declared in
<https://github.com/pingdotgg/t3code/blob/main/packages/provider-core/src/server/usage.ts>:

- `kind: "transcripts"` — append-only JSONL directories. The server owns file discovery, the
  incremental read cache and cross-file dedupe. The provider only supplies `directories()`,
  `selectFields`, `usageMarkers`, and `parseLine`/`parseProjected`.
- `kind: "scan"` — the provider walks SQLite/DB trees itself (OpenCode, Antigravity, Cursor) and
  returns `{ dir, files, status }`.

Registered usage providers, in *merge order*
(<https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/builtInDrivers.ts>):

```ts
export const BUILT_IN_USAGE_DRIVERS = [
  ClaudeDriver, CodexDriver, GrokDriver, PiDriver,
  OpenCodeDriver, MuseDriver, AntigravityDriver, CursorDriver,
];
```

`KiroDriver`, `FxDriver` and the ACP registry are chat providers only — they register **no** usage
reader. That is a useful precedent for our "detected but unavailable" state.

### The one-record shape everything converges on

`packages/provider-core/src/server/usage.ts` defines:

```ts
export interface UsageRecord {
  readonly provider: UsageProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  readonly rateModel?: string;      // id used only for pricing lookup
  readonly sessionId: string;
  readonly totals: UsageTokenTotals; // uncachedInputTokens, cachedInputTokens,
                                     // cacheCreationTokens, outputTokens, reasoningTokens
  readonly reportedCostUsd: number | null;
  readonly speed: "standard" | "fast" | "ultrafast";
  readonly unresolvedServiceTierTurnId?: string;
  readonly dedupeKey: string | null;
}
```

And an explicit note that we should mirror in our contract:

```ts
export function totalTokens(totals: UsageTokenTotals): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return totals.uncachedInputTokens + totals.cachedInputTokens +
         totals.cacheCreationTokens + totals.outputTokens;
}
```

Our `Cell` already separates `input` / `cacheRead` / `cacheWrite` / `output`, but we should keep the
same invariant: **reasoning is a subset of output**, never an additional bucket (our contract says
this too, but we have no `reasoning` guarantee anywhere and the UI should not sum it).

---

## 2. Pricing: how T3 Code estimates API-equivalent cost

### 2.1 Where rates come from

Rates are **not** hard-coded. `UsageService.ts` fetches LiteLLM's community price table and caches it
on disk for 24 h:

<https://github.com/pingdotgg/t3code/blob/main/apps/server/src/usage/UsageService.ts#L60-L73>

```ts
const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const LITELLM_RATES_API_URL =
  "https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json?ref=main";
const RATES_TTL_MS = 24 * 60 * 60 * 1000;
const RATES_REFRESH_FLOOR_MS = 60 * 1000;
const CACHE_RETENTION_DAYS = 92;
```

- raw.githubusercontent first, GitHub API (`application/vnd.github.raw+json`) as fallback;
- a 60 s floor prevents hammering GitHub when the user presses Refresh repeatedly;
- the fetched document + `fetchedAtMs` is written to a cache JSON, so offline starts still price;
- failed fetches keep the last table and mark pricing `cached`;
- the pricing status (`fresh` / `cached`) is surfaced to the UI.

**Our plugin cannot fetch at scan time** (single-threaded host plugin, offline-friendly, no network
in most DSH profiles), so we embed a static table in `host/pricing.js`. The important thing to copy is
the *table shape* and the resolution rules, not the fetch.

### 2.2 Parsing the LiteLLM table

`parseRateTable` (<https://github.com/pingdotgg/t3code/blob/main/apps/server/src/usage/usagePricing.ts#L60-L140>):

- drops entries missing `input_cost_per_token` or `output_cost_per_token` ("to avoid understating
  cost");
- reads `cache_read_input_token_cost` / `cache_creation_input_token_cost`; **missing cache rates fall
  back to the input rate** (Anthropic discounts reads and charges ~1.25x for writes, which matters);
- keys are lowercased and stored *with* their vendor prefix (`anthropic/...`, `openai/...`);
- then creates **bare aliases** for every key (`gpt-5.5` from `openai/gpt-5.5`), preferring
  first-party providers:

```ts
const FIRST_PARTY_PROVIDERS = new Set([
  "anthropic", "deepseek", "gemini", "meta", "mistral", "openai", "xai",
]);
```

- if two resellers describe the same bare model with different rates, the alias is dropped rather than
  guessed;
- resellers that omit speed tiers merge with the tiered entry instead of conflicting.

### 2.3 Model id resolution

`lookupRate` / `resolveRate`
(<https://github.com/pingdotgg/t3code/blob/main/apps/server/src/usage/usagePricing.ts#L185-L215>):

```ts
function resolveRate(table: RateTable, model: string): ModelRate | null {
  const key = stripVariantSuffix(normalizeRateKey(model)); // lower-case, drop `[...]`
  const bareName = bareModelName(key);                     // text after last "/"
  if (bareName.length === 0 || UNPRICEABLE_MODELS.has(bareName)) return null;
  return table.get(key) ?? null;
}
```

Note the differences from our current `normalizeModelId`:

- it does **not** strip date suffixes at lookup time; the alias map built from the table covers
  dated ids (`claude-opus-4-5-20251101` exists as its own LiteLLM key);
- it strips Claude's `[1m]`-style context-variant brackets, pricing the variant at the base tier;
- a set of **generation-ambiguous bare names stays unpriced**:

```ts
const UNPRICEABLE_MODELS = new Set([
  "<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable",
]);
```

`<synthetic>` is Claude Code's local placeholder for messages that never reached the API — we already
exclude it, but we should also treat bare `opus`/`sonnet`/`haiku`/`fable` as unpriced instead of
prefix/parent matching a family (our table only has full ids, so this is already effectively true, but
make it explicit so `normalizeModelId` never returns a bare family key).

### 2.4 Per-record pricing and provider-reported cost

<https://github.com/pingdotgg/t3code/blob/main/apps/server/src/usage/usagePricing.ts#L240-L285>

```ts
export function priceUsage(table, record, overrides?): PricedUsage {
  const override = overrides?.get(record.model.trim());
  const reported = override === undefined && reportedCostUsd !== null &&
                   Number.isFinite(reportedCostUsd) ? reportedCostUsd : null;
  const rate = override ?? lookupRate(table, record.rateModel ?? model);
  if (rate === null) {
    return reported === null ? unsplit(0, "unpriced") : unsplit(reported, "providerReported");
  }
  const listCost = costByCategory(totals, ratesAt(rate, record.speed));
  ...
  const scale = reported === null ? 1 : reported / listCostUsd;
  return {
    costUsd: reported ?? listCostUsd,
    costSource: reported === null ? "modelPriced" : "providerReported",
    categoryCostUsd: { input: listCost.input * scale, ... }, // scaled to match reported total
    speedPremiumUsd: premiumUsd * scale,
  };
}
```

Key semantics our `estimateCellCost` should match:

1. **Provider-reported cost wins** when the source records one (OpenCode `cost`, Pi
   `usage.cost.total`, Grok `costUsdTicks`, Claude `costUSD`).
2. When a provider reports a total, T3 Code still computes a list-price split (input/cache/output)
   and **scales the categories** so they sum to the reported total — that is how it keeps a
   per-token-type cost breakdown without inventing numbers.
3. A model with no rate contributes **tokens but no cost**, and is counted as `unpriced`.
4. Prices can be overridden per environment, keyed by the raw model id.

Our starter `estimateCellCost` added the estimate *on top of* `costUsd`; that double-counted
provider-reported cost. The doc comment in the starter already said "provider-reported cost wins", so
`PRICING_VERSION = 2` fixes it to a true pass-through.

### 2.5 Fast / premium tiers

- LiteLLM carries tier variants as suffix fields: `*_priority` (OpenAI "fast") and `*_ultrafast`.
  `parseRateTable` reads them into `ModelRate.fast` / `ModelRate.ultrafast`; when a reseller entry has
  `provider_specific_entry.fast = 2` but no explicit priority fields, it scales standard rates by that
  multiple.
- OpenAI/Azure priority rates are exactly **2x** standard list rates; `gpt-6-astra` ultrafast is
  ~6.6x (measured from the LiteLLM snapshot).
- The **premium** number shown on the Usage page is
  `listCost(speed) - listCost(standard)` (scaled if a reported total exists), exposed as
  `speedPremiumUsd`; cache savings is `cacheReadTokens * (inputRate - cacheReadRate)`.

Our table now carries `fast` sub-rates for the Codex `priority` families and `estimateCost` applies
them when a cell has `tier: 'fast'` (or the model id itself ends in `-fast` / `-priority`). We do not
model `ultrafast` yet.

### 2.6 "Model prices" overrides (UI feature worth flagging)

`docs/user/usage.md` documents an in-app table where a user edits per-model USD/1M input/output (and
optional cache rates) per environment, with:

- exact model-id matching (raw id, not normalized);
- `Map to` aliasing so a preview model can roll up under its released id;
- `Mixed` cells when environments disagree on a price.

Our plugin has no override surface yet — see "gaps".

---

## 3. Aggregation rules

`usageAggregation.ts` (<https://github.com/pingdotgg/t3code/blob/main/apps/server/src/usage/usageAggregation.ts>):

- **Local-day bucketing** uses `Intl.DateTimeFormat("en-CA", { timeZone })` with a quarter-hour slot
  cache, and falls back slot-by-slot when a fixed offset would split a slot; invalid time zones fall
  back to UTC. Store local `YYYY-MM-DD`, exactly like our `utils.localDay`.
- Buckets key on `(day, provider, model)` and accumulate `UsageTokenTotals`, cost, cache savings,
  speed premium, record counts, distinct `sessionId`s, and duplicate counters.
- The window is day-granular (`sinceDay`, `untilDay`) or hour-granular with a max **24 h** hourly
  window (`MAX_HOURLY_WINDOW_MS`); `sinceDay > untilDay` is an explicit `invalidWindow` error.
- Retention: scan cache keeps ~**92 days**; transcript discovery uses a 36 h mtime slack so files
  written just before local midnight on the window's first day are still found.
- Dedupe: aggregation keeps the **first** copy of a record (merge order matters — Claude before
  Codex before … before Cursor), plus cross-file dedupe only for providers marked
  `sharedSessionsAcrossFiles` (Codex, because a moved rollout can exist in two places).
- Model filters live in `settings.json` as `usageModelFilter.include/exclude` with optional
  `provider`, applied **before** `Map to`, and invalid filters are ignored.

### Transcript reading and the scan cache

This is the most reusable part for us, because our contract's cache protocol is a simplified version
of it.

`usageScanCache.ts`
(<https://github.com/pingdotgg/t3code/blob/main/apps/server/src/usage/usageScanCache.ts#L12-L45>):

```ts
const USAGE_SCAN_CACHE_VERSION = 11 as const;          // bump invalidates the whole cache
const SCAN_CACHE_FILE_NAME = "usage-scan-cache-v11.json";
interface CachedFile {
  size: number; mtimeMs: number; provider; records; tailRecords; position; malformedRecords;
}
```

- Cache key = absolute path. Fingerprint = **size + mtimeMs** (same as our `ctx.cache`).
- It stores a `position` (resume offset + 64-byte FNV-1a guard hash over the bytes before the offset,
  `GUARD_LENGTH = 64`) so a grown file is read **incrementally**, not re-parsed; if the guard hash
  does not match (file rewritten) it re-parses from zero.
- Unterminated tail lines are kept as `tailRecords` and re-read on the next scan; a partial line is
  never priced as if complete.
- A newer on-disk cache version wins; an older server sharing a directory writes a separate file name
  (`usage-scan-cache-v11.json` vs legacy names) so it can't clobber newer data.
- `correctedBatch` de-duplicates records that the same file already reported (repeated usage blocks).
- Provider-facing incremental state (`state`: model, speed, cumulative counters, session id) is
  serialized with the file entry, so a Codex/Claude resume starts with the same carried-forward model
  and counters.

Our `ctx.cache` stores only `Cell[]` keyed by fingerprint, with no resume position and no cross-scan
carry-forward state. That is simpler and fine for a first version, but it means **the whole file is
re-parsed whenever it grows**, and it cannot implement Codex's "cumulative counters → per-request
delta" logic across resumes. See gaps.

### Refresh behavior

- **No timer, no scan on load.** The Usage page issues a summary request; the server scans the
  requested window and answers as sources respond (the UI dims figures still updating).
- A stale-while-refresh pattern exists for long scans (`ProviderUsageScan.refreshing: true`), plus
  per-source `status: "ok" | "partial"` and an optional `message` ("Some OpenCode history could not
  be read."). We have `warnings` but no per-source `status`.
- The web client also refreshes Rates (pricing) through a dedicated `refreshRates` path with the 60 s
  floor; Refresh on the Usage page rescans history **and** refreshes model pricing.
- "Grok turns without a saved completed-turn record are missing from the totals" and "Codex/Claude
  text generation is not counted because those runs save no session history" are documented,
  user-visible caveats — a good pattern for our warnings.

---

## 4. Per-provider details

### 4.1 Claude Code (`claude`)

Source: <https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Drivers/claudeUsage.ts>

- **Location**: `<claude home>/projects/**/*.jsonl` where the home is, in priority order:
  1. configured home path (`ClaudeSettings.homePath`),
  2. `CLAUDE_CONFIG_DIR`,
  3. `~/.claude`.
  So the macOS default is `~/.claude/projects/<escaped-cwd>/<session-id>.jsonl`; Windows is
  `%USERPROFILE%\.claude\projects\...`; `CLAUDE_CONFIG_DIR` covers custom homes.
- **Format**: JSONL, one object per assistant *content block* (text/thinking/tool_use), plus
  `user`, `system`, `file-history-snapshot`, `mode`, etc. Only `type: "assistant"` lines with
  `message.usage` matter.
- **Fields read**: `timestamp`, `message.id`, `requestId`, `sessionId`, `costUSD`, and
  `message.usage.{input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens}`.
  `message.model` is the model id; `<synthetic>` is skipped.
- **Critical dedupe rule** (verbatim comment):

  ```ts
  /**
   * T3 Code writes one record per assistant *content block*, and every one of those records repeats
   * the same complete `usage` object for the parent message. Summing them overcounts by roughly
   * 2.4x on a real workload, so the caller must drop repeats by `dedupeKey` and keep the first.
   */
  ```

  `dedupeKey = "${message.id}:${requestId}"` (either may be missing → unique key only when both null).
- **Advisor calls**: newer Claude Code records `usage.iterations[]` with `type: "advisor_message"`;
  T3 Code emits a **separate record per advisor model** (its own `model`, same totals shape,
  `dedupeKey: ...:advisor:<i>`), because the top-level `usage` never includes those tokens.
- **Reasoning**: Anthropic folds thinking into output, so `reasoningTokens: 0`; the transcript does
  carry `output_tokens_details.thinking_tokens`, but T3 Code does not subtract it (output is billed
  in full anyway).
- **Cost**: `costUSD` is read and passed through when present; it is usually absent (we found only 2
  occurrences across ~86 local Claude transcripts), so the price table does the work.
- **Speed**: `usage.speed === "fast"` → `speed: "fast"`, otherwise `standard`. This is the Claude Code
  fast-mode premium (we price it via `tier`/`fast` sub-rates where known).
- **Transcript format declaration**: `usageMarkers: ['"usage"']`, `selectFields` limits projection to
  exactly the fields above so huge tool results are not parsed twice.

Our Claude provider contract should copy: filter `type === "assistant"`, dedupe by
`message.id:requestId`, read the four usage counters, treat `cache_creation_input_tokens` as
cacheWrite, and never count `iterations` advisors as part of the executor record.

### 4.2 Codex (`codex`)

Source: <https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Drivers/codexUsage.ts>

- **Location**: `<codex home>/sessions` recursively (`rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl` under
  `YYYY/MM/DD/`). Home resolution: configured home → `CODEX_HOME` → `~/.codex`; managed-mode setups
  have separate "shared" vs "shadow" homes and only `sharedHomePath/sessions` is read.
  On this machine there are also `~/.codex/archived_sessions/*.jsonl.zst` (zstd-compressed) and
  `~/.codex/sessions` JSONL; a provider that only globs `sessions/` misses archived rollouts.
- **Format**: rollout JSONL with `session_meta`, `turn_context`, `thread_settings_applied`,
  `event_msg`/`response_item` and `event_msg.payload.type = "token_count"` snapshots. Usage lives in
  `payload.info.{last_token_usage, total_token_usage}` with
  `{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
  reasoning_output_tokens, total_tokens}` (validated against invariants; malformed snapshots are
  counted and skipped).
- **The hard parts T3 Code solves**:
  - `token_count` events carry **no model and no service tier** — both are carried forward from the
    most recent `turn_context` (model) and `thread_settings_applied` (service tier).
  - `total_token_usage` lets it validate that the sum of per-request deltas since the previous
    snapshot equals the cumulative increase; interrupted turns are only billed when the deltas
    explain the whole gap.
  - Forks copy parent history; `session_meta.forked_from_id` / `source.subagent.thread_spawn`
    triggers suppression of the copied burst (gaps < **1000 ms**), and the same rollout may exist in
    two directories → `sharedSessionsAcrossFiles: true`.
- **Aggregation**: `uncachedInput = input_tokens - cached_input_tokens - cache_write_input_tokens`
  (Codex's `input_tokens` is inclusive), `cacheRead = cached_input_tokens`,
  `cacheWrite = cache_write_input_tokens`, `output = output_tokens`,
  `reasoning = min(output, reasoning_output_tokens)`.
- **Cost**: no provider-reported cost in rollouts; T3 Code prices with the table. Service tiers:
  `priority` / `fast` → `fast`, `ultrafast` → `ultrafast`, default/standard → `standard`; a
  `codex_usage_history` DB can back-fill a turn's real tier when the settings event was missing.
- **Model ids observed locally**: `gpt-6.1-sol` (config default), `gpt-6-astra`, `gpt-6.1-terra`,
  `codex-auto-review`.

### 4.3 Grok Build / Grok CLI (`grok`)

Source: <https://github.com/pingdotgg/t3code/blob/main/packages/provider-grok/src/server/usage.ts>

- **Location**: `<GROK_HOME>/sessions/**/updates.jsonl` (default `~/.grok`). Only
  `updates.jsonl` is read — T3 Code explicitly skips the large `chat_history` / events logs.
- **Format**: JSONL of ACP session updates. Only `params.update.sessionUpdate === "turn_completed"`
  lines with `params.update.usage` are used.
- **Fields**: usage has `inputTokens` (**inclusive of cached**, like Codex), `outputTokens`,
  `cachedReadTokens`, `cacheCreationTokens`, `reasoningTokens`, and `costUsdTicks`.
  `costUsdTicks` uses **10,000,000,000 ticks per USD** (`GROK_COST_USD_TICKS_PER_DOLLAR`).
- **Per-model split**: a single turn can report `usage.modelUsage { [model]: {...} }`. T3 Code emits
  one record per model; if a model has no `costUsdTicks`, it splits the remaining top-level cost
  proportionally to that model's total tokens.
- **Timestamp**: `params._meta.agentTimestampMs` first, then top-level `timestamp` (seconds vs ms
  auto-detected); dedupe by `sessionId:prompt_id:model`.
- **Cost**: provider-reported when `costUsdTicks > 0`; otherwise the price table.
- **Model ids observed locally**: `grok-4.6-build`, `grok-4.7-build`, `grok-4.6`, `grok-4.7`, and a
  bare `grok` fallback (T3 Code's fallback model when `modelUsage` is empty — deliberately unpriced).

### 4.4 Pi (`pi`)

Source: <https://github.com/pingdotgg/t3code/blob/main/packages/provider-pi/src/server/usage.ts>

- **Location** (`resolvePiSessionsDir`,
  <https://github.com/pingdotgg/t3code/blob/main/packages/provider-pi/src/server/usage.ts#L139-L151>):

  ```ts
  const sessionDir = environment.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (sessionDir) return path.resolve(expandHomePath(sessionDir, home));
  const agentDir = environment.PI_CODING_AGENT_DIR?.trim();
  return path.resolve(agentDir ? … : path.join(home, ".pi", "agent"), "sessions");
  ```

  Default `~/.pi/agent/sessions/<escaped-cwd>/*.jsonl`; `PI_CODING_AGENT_SESSION_DIR` overrides the
  whole session directory (needed when Pi is run with `--session-dir` or its `sessionDir` setting).
- **Format**: JSONL entries. `type: "session"` establishes `id` (the sessionId for later records);
  usage-bearing entries are:
  - `type: "message"`, `message.role: "assistant"` (usage + `provider`/`model`/optional
    `responseModel`),
  - `type: "message"`, `message.role: "toolResult"` (usage, no model),
  - `type: "usage"`,
  - `type: "compaction"` / `type: "branch_summary"`.
- **Fields**: `usage.{input, output, cacheRead, cacheWrite, reasoning, cost.total}`.
  Pi's `input`/`cacheRead` counters are **already disjoint** (comment in source), unlike Codex/Grok.
  `reasoning` is a subset of output → `reasoningTokens = min(output, reasoning)`.
- **Model attribution**: the raw model is `"<provider>/<model>"`; `rateModel` is `responseModel ??
  model`. Auxiliary tool/summary records have no model and are reported as the synthetic model
  **`"Tools/summaries"`** — the Usage UI shows them as a separate row. Our contract has no concept
  for this; map it to `unknown` or add a synthetic model bucket.
- **Cost**: `usage.cost.total` is passed through **only when > 0** — Pi writes 0 when rates are
  omitted, and T3 Code treats 0 as "unknown" so the price table estimates instead.
- **Dedupe**: `JSON.stringify(["pi", entry.id, entry.timestamp, model])` because forked sessions
  preserve ids/timestamps.
- **Refresh**: Pi includes recorded tool/summary costs under `Tools/summaries`.

### 4.5 OpenCode (`opencode`)

Source: <https://github.com/pingdotgg/t3code/blob/main/packages/provider-opencode/src/server/usage.ts>

- **Location**: every `opencode*.db` SQLite file in the data root(s), then legacy
  `storage/message/**/*.json`.
  Root resolution (`resolveOpenCodeDataDirs`):

  ```ts
  const roots = environment["OPENCODE_DATA_DIR"]?.split(",").map(trim).filter(Boolean);
  const dataHome = environment["XDG_DATA_HOME"]?.trim();
  const defaults = [ path.join(dataHome && isAbsolute ? dataHome : ~/.local/share, "opencode") ];
  ```

  So `OPENCODE_DATA_DIR` is a **comma-separated list**; otherwise `XDG_DATA_HOME/opencode` or
  `~/.local/share/opencode`. Each root is `realPath`-canonicalised so symlinked duplicates count once.
- **DB format**: SQLite. Message rows live in `message.data` (or `session_message.data` for newer
  builds) as JSON strings; it pages by `rowid` (64 rows at a time) because `StatementSync.all()`
  materialises everything, and excludes mid-scan appends by capturing `MIN/MAX(rowid)` first.
  `PRAGMA busy_timeout = 100` avoids stalling on the live app's WAL lock.
- **Fields read** (`parseOpenCodeMessage`):

  ```ts
  const usage = object(message.tokens);
  const cache = object(usage.cache);
  const model = text(message.model.id) || text(message.model.modelID) || text(message.modelID);
  const timestampMs = object(message.time).created ?? fallback;
  const reasoningTokens = tokens(usage.reasoning);
  const totals = {
    uncachedInputTokens: tokens(usage.input),
    cachedInputTokens: tokens(cache.read),
    cacheCreationTokens: tokens(cache.write),
    outputTokens: tokens(usage.output) + reasoningTokens,
    reasoningTokens,
  };
  ```

  Note OpenCode's `output` excludes reasoning, so reasoning is **added into output** here (the
  opposite of Pi/Muse). `message.cost` is provider-reported cost; `cost > 0` is required (0 means
  "unknown/free", including paid subscriptions).
- **Legacy JSON**: `storage/message/<message-id>.json` per message, same parser; file mtime before the
  window start is skipped.
- **Local model ids observed**: most OpenCode traffic is on `opencode/*-free` Zen models
  (`minimax-m2.5-free`, `glm-4.7-free`, `deepseek-v4-flash-free`) plus `openai/gpt-5.2`,
  `openai/gpt-5.5`, `google/gemini-3-flash-preview`, `iflowcn/qwen3-coder-plus`, `opencode/grok-code`,
  `opencode/big-pickle`. Free models report `cost: 0`; T3 Code therefore shows them as unpriced
  rather than free — a deliberate, visible limitation.

### 4.6 Antigravity (`antigravity`)

Sources: <https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Drivers/AntigravityUsage.ts>
and `.../antigravityUsageReader.ts`.

- **Location**: conversation SQLite databases under, in order:
  - `ANTIGRAVITY_DATA_DIR` (comma-separated) if set,
  - `~/.gemini/antigravity`, `~/.gemini/antigravity-cli`, `~/.gemini/antigravity-ide`,
    `~/.gemini/antigravity-backup`,
  - `~/.config/antigravity`,
  - plus `<T3 state dir>/profiles/<instance>/antigravity-acp` for T3-managed profiles.
  If the root has a `conversations/` subdirectory, that is used; each `*.db` is a conversation.
- **DB format**: SQLite with tables `gen_metadata` and/or `steps` (plus optional
  `trajectory_metadata_blob`). The `data`/`metadata` columns hold **protobuf-ish field blobs**, not
  JSON: T3 Code hand-decodes fields by index (`fields(bytes)`, `numberAt`, `textAt`,
  `nested(...)`) to extract model id, timestamp, and usage numbers.
- **Field mapping** (from decoded usage fields):
  `uncachedInput = field 2`, `output = max(field 3, field 9 + field 10)`, `cacheRead = field 5`,
  `cacheWrite = field 4`, `reasoning = min(output, field 9)`; dedupe keys are built from string ids
  in fields 7/11/12; model comes from a numeric `MODEL_IDS` map with an
  `antigravity-model-<n>`/`antigravity-unknown` fallback.
- **Cleanup**: rows are paged (1 generation row at a time — they can be megabytes) and the decode
  cache is keyed by file fingerprint.
- This is the most brittle reader in T3 Code; it breaks whenever Google changes the protobuf layout.
  Our provider should treat it as best-effort and report `partial`, never throw.

### 4.7 Muse Code (`muse`)

Source: <https://github.com/pingdotgg/t3code/blob/main/packages/provider-muse/src/server/usage.ts>

- **Location**: `<muse home>/sessions/**/session.jsonl`, where the home is whatever the configured
  Muse CLI reports (resolved by running the binary / reading its settings; `XDG_DATA_HOME` and other
  Muse environment settings apply). On Linux/macOS this is typically under `~/.local/share/muse`
  unless XDG_DATA_HOME is set.
- **Format**: JSONL "event envelopes" with
  `{schema_version: 1, record_type: "event", payload_type: "runtime.session", payload_schema_version:
  1|3, id, recorded_at, stream: {kind: "session", id}, payload: {event: {kind:
  "model_completed"|"automated_review_completed", model, usage}}}`.
- **Fields**: `usage.{input_tokens, output_tokens, cached_tokens|cached_input_tokens|
  cache_read_tokens, cache_write_tokens, reasoning_tokens}`. Muse's cache counters are **subsets of
  input** (`uncachedInput = input - cacheRead - cacheWrite`, clamped) and reasoning is a subset of
  output. `recorded_at` is **microseconds** (`Math.trunc(recorded_at / 1000)` → ms).
- **Cost**: no provider-reported cost; priced from the table.
- **Dedupe**: `payload.source_run_record_id ?? id` — runtime envelopes can be copied into another
  session.

### 4.8 Cursor (`cursor`) — the outlier

Source: <https://github.com/pingdotgg/t3code/blob/main/packages/provider-cursor/src/server/accountUsage.ts>

- Cursor stores **no reliable per-request token usage locally**. T3 Code therefore reads
  **account usage from Cursor's API**:
  `https://cursor.com/api/dashboard/get-filtered-usage-events` with a page size of 1000 and
  `{page, pageSize, startDate, endDate}`.
- Credentials: `CURSOR_API_KEY`, the account signed into T3, or the Cursor CLI login — on macOS the
  CLI login lives in the **Keychain**, which requires explicit user opt-in ("Enable Cursor usage").
- Cursor model ids need cleanup before pricing: `cursorRateModel` strips `cursor-`, a trailing
  reasoning-effort segment (`-high`, `-xhigh`, …) and `-fast`, and prefixes `xai/` for Grok models.
- If no credential exists, T3 Code shows a **notice** instead of partial local totals — it refuses to
  silently under-report.

For our plugin: no Cursor API calls. Detect the local install, return `exists: true` with a note that
token usage is account-side only, and emit one warning.

---

## 5. Summary of file locations / formats / env overrides

| Provider | Default location | Override | Format |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | `CLAUDE_CONFIG_DIR`, configured home | JSONL, `message.usage` |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` (+ `archived_sessions`) | `CODEX_HOME`, configured home | rollout JSONL, `token_count` deltas |
| Grok Build | `~/.grok/sessions/**/updates.jsonl` | `GROK_HOME` | ACP JSONL, `turn_completed.usage` |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` | JSONL entries, `usage.cost.total` |
| OpenCode | `~/.local/share/opencode/opencode*.db` + `storage/message` | `OPENCODE_DATA_DIR` (comma list), `XDG_DATA_HOME` | SQLite JSON rows / JSON files |
| Antigravity | `~/.gemini/antigravity*/conversations/*.db` | `ANTIGRAVITY_DATA_DIR` (comma list) | SQLite protobuf blobs |
| Muse Code | `<muse home>/sessions/**/session.jsonl` | Muse `XDG_DATA_HOME` / settings | JSONL runtime envelopes |
| Cursor | — | `CURSOR_API_KEY` / Keychain / T3 sign-in | **Remote API only** |

Cross-cutting environment behavior from `docs/user/usage.md`:

- Custom homes follow the account's home setting or `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`.
- Pi reads `~/.pi/agent/sessions` or `PI_CODING_AGENT_DIR`; `PI_CODING_AGENT_SESSION_DIR` points at a
  different session directory (must match `--session-dir` / Pi's `sessionDir` setting).
- OpenCode adds `OPENCODE_DATA_DIR`; Antigravity adds `ANTIGRAVITY_DATA_DIR`; both accept
  **comma-separated** paths.
- Accounts that share a history directory are counted once; a `usage-host-id` file (or
  `T3CODE_HOST_ID`) keeps usage identity across recreated containers.
- Absolute paths or `~/` are required in account environment settings; relative paths can't be
  discovered reliably.

---

## 6. What our plugin should copy

1. **Provider-reported cost is authoritative.** `costUsd` must pass through untouched; estimate only
   when absent. (Our `PRICING_VERSION = 2` change.)
2. **Keep the list-price split.** Even with a reported total, compute input/cache/output list prices
   and scale them to the reported total — that is how the UI can show per-token-type cost without
   lying. Our snapshot should eventually expose `categoryCostUsd`.
3. **Treat cache counters carefully, per provider**:
   - Claude: `input_tokens` is *uncached*; `cache_read_input_tokens`, `cache_creation_input_tokens`
     are separate.
   - Codex: `input_tokens` is *inclusive* of cached + cache-write → subtract.
   - Grok: `inputTokens` is *inclusive* of cached → subtract.
   - Pi: `input`/`cacheRead` are *disjoint* → do not subtract.
   - Muse: cached/cache-write are subsets of `input_tokens` → subtract.
   - OpenCode: `input`/`cache.read`/`cache.write` disjoint; `reasoning` must be **added to output**.
4. **Never price a provider-reported 0 as a real cost.** OpenCode/Pi write 0 for "unknown rate";
   treat `<= 0` as absent and estimate (or mark unpriced for genuinely free `-free` models).
5. **Generation-ambiguous ids stay unpriced**: `<synthetic>`, bare `opus`/`sonnet`/`haiku`/`fable`,
   bare `grok`, `devin`, `big-pickle`.
6. **Dedupe by a stable per-message key**, not by "one line = one request". Claude repeats the same
   `usage` on every content-block line (~2.4x overcount); Grok repeats per model entry; Muse copies
   runtime envelopes. Our providers should keep a per-file `Set` of keys and keep the first.
7. **Speed tier is a first-class field.** `tier: 'fast'` (and eventually `'ultrafast'`) should change
   the price lookup, and premium should be reportable separately rather than folded into cost.
8. **Per-source status, not just warnings.** `ok` / `partial` / `missing` + a message is more useful
   than a flat warning list; our `Source.exists` + `warnings` is close but cannot say "read some files
   successfully, some failed".
9. **Explicit documented caveats**: text-generation runs, unfinished Grok turns, archived Codex
   rollouts, free Zen models. Users trust an "incomplete" note more than a silently low total.
10. **Env overrides in the contract, not the provider**: `OPENCODE_DATA_DIR`,
    `ANTIGRAVITY_DATA_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
    `GROK_HOME`, `XDG_DATA_HOME` — comma-separated where T3 Code supports it.
11. **Archived/compressed transcripts are in scope**: `~/.codex/archived_sessions/*.jsonl.zst` and
    DSH's multi-frame `.zstd` sessions both exist on real machines.

## 7. Gaps in our current contract

1. **No speed-tier pricing in the documented contract.** `Cell.tier` exists but `estimateCellCost`
   never used it; we now support `fast` sub-rates, but the contract should state that tier affects
   cost and that `ultrafast` is unpriced today.
2. **No `rateModel` / alias hint.** Pi (and Cursor) need a model id for display and a *different* id
   for pricing (`Tools/summaries`, `responseModel`, stripped tier suffixes). Our `Cell.model` is used
   for both; a `rateModel` field would avoid polluting the model breakdown.
3. **No synthetic buckets.** "Tools/summaries", `antigravity-unknown`, bare `grok` fallback and
   `<synthetic>` placeholder rows are semantically distinct from "an unpriced model"; the contract
   only has `model: 'unknown'`.
4. **Cache protocol cannot resume.** Our fingerprint stores `Cell[]` only; there is no resume offset,
   no guard hash, no per-provider carry-forward state. Codex needs carried-forward `model`/tier and
   cumulative counters; without resume, a growing rollout is fully re-parsed every Refresh. At
   minimum, allow `ctx.cache.get/set` to carry a small opaque `state` alongside cells.
5. **No cross-file / cross-directory dedupe.** `sharedSessionsAcrossFiles` (Codex) and
   "same account on two environments counts once" are unaddressed; our providers will double count
   copied rollouts (`archived_sessions` + `sessions`).
6. **Dedupe key guidance missing.** The contract says "keep one cell per (model, day)" but says
   nothing about repeated usage objects on multiple lines (Claude's 2.4x problem). This should be an
   explicit provider rule.
7. **No cost breakdown / cache savings / premium.** The UI can only show a single cost number; T3
   Code shows cost by token type, cache savings, and speed premium. Extend `Cell`/snapshot with
   optional `costUsd` split or let pricing.js expose `estimateCostBreakdown(cell)`.
8. **Provider-reported 0 ambiguity.** The contract says "`costUsd`: ONLY when the source itself
   reports a cost" but doesn't say that `0` usually means *unknown* in OpenCode/Pi. Add: treat `<= 0`
   as absent.
9. **Env-var overrides are not in the contract.** There is no mention of `OPENCODE_DATA_DIR`,
   `ANTIGRAVITY_DATA_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
   `GROK_HOME`, or comma-separated multi-path values. Providers currently hard-code `~` paths.
10. **No price overrides.** T3 Code lets users edit per-model prices and map preview → released ids;
    our static table can't be corrected by the user. A config-level override map
    (`ctx.env.config.pricingOverrides`) merged in `priceFor` would be a cheap future addition.
11. **No hourly resolution / 92-day retention story.** Our contract is day-only and cache retention
    is unspecified; T3 Code explicitly bounds hourly windows (24 h) and scan-cache retention (92 d).
