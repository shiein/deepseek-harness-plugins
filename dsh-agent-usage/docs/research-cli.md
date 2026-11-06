# CLI / JSONL agent usage providers — research notes

Scope: the twelve providers implemented in `host/providers/` for task-1 —
`opencode`, `pi`, `gemini-cli`, `copilot-cli`, `amp`, `goose`, `crush`, `aider`,
`qwen-code`, `grok-build`, `factory-droid`, `continue`.

Method: each provider was written against the real data on this Mac where the agent is
installed (`opencode`, `pi`, `grok-build`, and a partial `copilot-cli` install), and against
the documented formats of the project the tool is derived from / the format other usage
tools parse where the agent is not installed. Every provider was then run through
`host/providers/self-test.mjs` with the DSH-bundled Node. The providers whose tool is absent
were additionally exercised against synthetic fixtures that follow the documented schema, so
the parsing paths are covered even though they cannot be verified on this machine.

Verification legend: ✅ verified on this machine · ◐ detected here, no token data to verify my
parser against · ⚠ not installed here, parser based on documented schema / upstream source and
verified only against fixtures.

Two rules applied throughout:

- Tokens are only ever taken from recorded counters. If a tool stores no local usage, the
  provider returns zero cells, a source with a `note`, and one warning.
- `costUsd` is passed through only when the source itself records a cost/credit figure; the
  central `host/pricing.js` prices everything else. `day` is always `utils.localDay(ts)`.

---

## 1. OpenCode — `opencode.js` ✅

Paths

- macOS/Linux: `$OPENCODE_DATA_DIR` (comma-separated list) or
  `$XDG_DATA_HOME/opencode` → default `~/.local/share/opencode`.
- Windows: `%LOCALAPPDATA%\opencode`, plus `%APPDATA%\opencode` and
  `%USERPROFILE%\.local\share\opencode` as fallbacks (OpenCode is XDG-style on every OS).
- Current store: `opencode.db` (older builds also leave `opencode-next.db`) + `-wal`/`-shm`.
- Legacy store: `storage/message/<sessionID>/<messageID>.json`.

Format

- V1 SQLite `message` table: columns `id, session_id, time_created, time_updated, data`.
  `data` is JSON with `role: "assistant"`, `modelID` (or `model.modelID`/`model.id`),
  `time.created` (epoch ms), `cost` (USD), and
  `tokens: { input, output, reasoning, cache: { read, write } }`.
- V2 SQLite `session_message` table: columns `id, session_id, type, seq, time_created,
  time_updated, data`. `type` holds the role (`assistant`, `user`, `system`, …); `data` has
  no `role` but keeps `model: { id, providerID }`, `content`, `cost` and the same `tokens`.
- Legacy JSON message files use the V1 object shape.

Token semantics

- `tokens.input` is the uncached prompt; `tokens.cache.read` and `.write` are separate.
- `tokens.output` **excludes** reasoning, so reasoning is added into `output`
  (`output + reasoning`) — same rule as T3 Code's OpenCode reader.
- `cost` is OpenCode's reported USD cost; only `cost > 0` is passed through (`0` means
  free/unknown/free-tier subscription, matching the upstream reader).
- A database with both `message` and `session_message` populated is read from
  `session_message` first: on this machine it is the complete unified store (695 rows,
  including all 547 `message` ids plus V2 data through 2026-10-22). Reading both would
  double count; the SQLite row ids are also used to skip migrated legacy JSON files.

Sample evidence (this machine)

```
=== opencode (OpenCode) — 18ms
  source OK   ~/.local/share/opencode/opencode.db    files=502 bytes=23244800
  source OK   ~/.local/share/opencode/opencode-next.db files=5 bytes=2377248
  source OK   ~/.local/share/opencode/storage/message files=455 (all ids already in SQLite)
  cells=20 tokens=23,795,216 estCost=$1.1328
  recent days: 2026-10-22=1,204,259 2026-05-27=263,208 2026-03-07=2,583,040 ...
  model minimax-m2.5-free: 18,941,574 tok
  model gpt-5.2: 1,738,562 tok, $0.9687 (OpenCode-reported cost)
```

Known limitations

- `session_message` rows from other (future) V2 releases may add new `type` values; unknown
  types are skipped unless they carry assistant tokens.
- A migrated database where both tables hold *different* (not overlapping) message ids would
  only be read from `session_message`; not observed.
- The DB is opened read-only; a live OpenCode with an exclusive lock could make a scan fail
  per database (caught, warning) rather than crash the provider.

## 2. Pi — `pi.js` ✅

Paths

- Agent dir: `$PI_CODING_AGENT_DIR` (tilde-expanded) else `~/.pi/agent`; Windows
  `%USERPROFILE%\.pi\agent`.
- Sessions dir: `$PI_CODING_AGENT_SESSION_DIR` (overrides everything, equals `--session-dir`)
  else `<agent-dir>/sessions`.
- Files: `sessions/--<escaped-cwd>--/<ISO-timestamp>_<uuid>.jsonl`.

Format (Pi `docs/session-format.md`, v1.4.0 installed here)

One JSON object per line, `type`-tagged. Usage-bearing entries:

```jsonc
{ "type": "message", "timestamp": "…", "message": { "role": "assistant",
    "model": "deepseek-flash", "timestamp": 1792606203787,
    "usage": { "input": 235, "output": 84, "cacheRead": 24576, "cacheWrite": 0,
               "reasoning": 0, "totalTokens": 24895,
               "cost": { "input": 0.00007, "output": 0.0001, "cacheRead": 0.00015,
                         "total": 0.000319 } } } }
{ "type": "usage", "kind": "cache_warm", "provider": "anthropic", "model": "…",
  "timestamp": "…", "usage": { "input": 0, "output": 0, "cacheRead": 50000, … } }
{ "type": "compaction", "…": "…", "usage": { … } }        // summarization usage
{ "type": "branch_summary", "…": "…", "usage": { … } }   // branch summarization usage
{ "type": "model_change", "provider": "openai", "modelId": "gpt-5.5" }
```

Token semantics

- `input` / `cacheRead` / `cacheWrite` are already disjoint counters.
- `reasoning` is documented as a subset of `output`, so it is **not** added again.
- `usage.cost.total` is Pi's recorded USD cost, passed through only when > 0 (Pi writes 0
  when it has no rates).
- `model_change` tracks the current model for subsequent usage entries; assistant messages
  carry their own `model`, which wins.

Sample evidence (this machine)

```
=== pi (Pi) — 50ms
  source OK   ~/.pi/agent/sessions  files=93 bytes=4876307
  cells=13 tokens=3,644,731 estCost=$0.5663
  recent days: 2026-10-27=199,589 2026-10-22=2,819,140 ...
  model deepseek-flash: 3,078,558 tok, $0.2760
  model deepseek-v4-pro: 222,603 tok, $0.0697
  model glm-5-2: 172,450 tok, $0.0550
```

Model-id validation

- Only `message.model`, `usage`/`model_usage` `record.model` and `model_change`
  `modelId`/`model` are candidates, and the value must be a plausible model id: trimmed,
  2–160 chars, contains a letter, no whitespace/control characters. Unusable values fall
  back to the session's last valid `model_change` model, then to `unknown`.
- This rejects the one-character ids (`"a"`, `"b"`) that Pi's own integration fixtures write
  (they produced a bogus `model: "b"` cell before `cacheVersion` 2), and other stray strings
  (empty values, numbers, null, `"hello world"`). The affected tokens are still counted, just
  under `unknown` — the Pi total (3,644,731 tokens on this machine) is unchanged.

Known limitations

- **Forked sessions:** upstream notes that a forked/cloned Pi session can preserve entry
  ids/timestamps of its parent (duplicate usage across two files). The framework cache is
  per-file, so cross-file dedupe cannot be expressed; the parser dedupes within a file by
  `id + timestamp + model` only. No forked session files exist on this machine; a real fork
  could double count. If this matters, the framework would need a cross-file seen-set.
- Tool/summary usage records have no model; the current model-change state is used instead of
  a synthetic `Tools/summaries` row (keeps the pricing table honest).

## 3. Grok Build — `grok-build.js` ✅

Paths

- `$GROK_HOME` else `~/.grok`; Windows `%USERPROFILE%\.grok`.
- Sessions: `<grok-home>/sessions/<url-encoded-cwd>/<session-id>/` with `updates.jsonl`,
  `usage.json`, `summary.json`, `events.jsonl`, `chat_history.jsonl`, …

Format — two sources, both documented locally in `$GROK_HOME/docs/user-guide/17-sessions.md`

1. `updates.jsonl` (primary) — ACP stream. Completed prompts append:

```jsonc
{"timestamp":1787663619,"method":"_x.ai/session/update","params":{"sessionId":"…",
 "update":{"sessionUpdate":"turn_completed","prompt_id":"…","usage":{
   "inputTokens":4710559,"outputTokens":53386,"totalTokens":4763945,
   "cachedReadTokens":4115712,"cacheCreationTokens":0,"reasoningTokens":46870,
   "modelCalls":47,"costUsdTicks":210785452400,
   "modelUsage":{"grok-4.6-build":{ …same fields… }}}}},
 "_meta":{"agentTimestampMs":1787663619766}}}
```

2. `usage.json` (fallback) — finalized session envelope
   `{sessionId, updatedAt, session:{…totals…, modelUsage}, turns:[{…, endedAt, costUsdTicks}]}`.
   `grok usage <id>` reads this file.

Token semantics

- `costUsdTicks` is **10^10 ticks per USD** (divide by 1e10); confirmed in the bundled Grok
  docs and against T3 Code's `GROK_COST_USD_TICKS_PER_DOLLAR`.
- `inputTokens` is uncached prompt (`totalTokens = input + output`), `cachedReadTokens` is
  separate, `reasoningTokens` is inside `outputTokens`.
- Per turn, `modelUsage` gives the per-model split. A model without `costUsdTicks` gets a
  proportional share of the remaining top-level cost (T3 Code rule).
- `updates.jsonl` is read first because it records every completed turn (including sessions
  whose `usage.json` was never flushed); `usage.json` is only used for session dirs without
  usage-bearing `updates.jsonl`.

Sample evidence (this machine)

- `usage.json`: 95 files; summing `turns` equals `session` totals for 94/95 sessions (one
  in-progress session was short).
- `updates.jsonl`: 162 session dirs; 67 of them have **no** `usage.json` yet, so the
  updates-first design added ~1.55B real tokens that a usage.json-only parser would miss.

```
=== grok-build (Grok Build) — 704ms (first, uncached)
  source OK   ~/.grok/sessions  files=163 bytes=414614959
  cells=40 tokens=3,145,210,204 estCost=$349.4695
  model grok-4.6-build: 1,625,600,874 tok, $156.3399 (provider-reported cost)
  model grok-4.7-build: 1,519,609,330 tok, $193.1296
```

Known limitations

- The first scan reads ~415 MB of `updates.jsonl`; per-session fingerprints make later scans
  cache-only.
- A resumed session appends more `turn_completed` lines and possibly repeats accounting after
  compaction; dedupe is per `sessionId + prompt_id + model`, and duplicated cumulative
  accounting across resumed legs was not observed here.
- A session dir with neither file (e.g. aborted before the first completed turn) contributes
  nothing.

## 4. GitHub Copilot CLI — `copilot-cli.js` ◐

Paths

- `~/.copilot` (Windows `%USERPROFILE%\.copilot`).
- `session-store.db` (SQLite/WAL) — written unconditionally by current Copilot CLI builds.
- `session-state/<sessionId>/events.jsonl` — ACP event stream, plus `workspace.yaml`.

Format

- `assistant_usage_events` table: `session_id, model, input_tokens` (cache-**inclusive**),
  `cache_read_tokens, cache_write_tokens, reasoning_tokens, output_tokens,
  created_at, total_nano_aiu` (billed Copilot AI credits × 1e9).
  One row per API request; authoritative for input/cache.
- `events.jsonl`: the last `session.shutdown` event per model has
  `data.modelMetrics[model].usage = {inputTokens (cache-inclusive), outputTokens,
  cacheReadTokens, cacheWriteTokens}` plus `totalNanoAiu`. Older CLIs also write per-turn
  `assistant.message.data.outputTokens` (used only when no rollup exists).

Token semantics

- `input = max(0, input_tokens − cache_read − cache_write)`.
- `total_nano_aiu / 1e9` = Copilot AI credits; 1 credit = $0.01, so the billed USD figure is
  `total_nano_aiu / 1e11`, passed through as `costUsd`.
- Store rows win for a session; events rollups only fill sessions without store rows.

Sample evidence (this machine)

```
=== copilot-cli (GitHub Copilot CLI) — 2ms
  source OK   ~/.copilot/session-state   files=0
  warnings: Copilot CLI: session state detected but no token usage found
             (no session-store.db assistant_usage_events rows and no events.jsonl usage rollups)
  cells=0 tokens=0
```

Verified only against synthetic fixtures: a store row (1000 cache-inclusive input / 300 read /
100 write / 50 output / 5e9 nano-AIU → 600+300+100+50 tokens, $0.05) and an events rollup
session (500 cache-inclusive input / 100 read / 20 output / 1e9 → 400+100+20 tokens, $0.01).

Known limitations

- Cumulative rollups across resume legs are taken as "last shutdown wins"; the upstream reader
  does interval reconciliation per compaction, which this provider does not attempt.
- Newer per-request tables are matched schema-adaptively; if the CLI renames columns the store
  parses as absent (warning) rather than guessing.

## 5. Amp — `amp.js` ⚠

Paths

- `$AMP_DATA_DIR` (comma-separated list, like Amp itself) else
  `~/.local/share/amp` (`$XDG_DATA_HOME/amp`); Windows also checks `%LOCALAPPDATA%\amp` and
  `%USERPROFILE%\.amp`. Threads: `<data-dir>/threads/**/*.json` (`T-<uuid>.json`).

Format

```jsonc
{ "id": "T-…",
  "messages": [ { "messageId": "…", "usage": { "inputTokens": 10, "outputTokens": 5,
      "cacheCreationInputTokens": 2, "cacheReadInputTokens": 3, "totalTokens": 20 } } ],
  "usageLedger": { "events": [ { "id": "…", "timestamp": "2026-…", "model": "claude-sonnet-4-5",
      "tokens": { "input": 10, "output": 5, "total": 20 }, "toMessageId": "…", "credits": 1.2 } ] } }
```

Token semantics

- Ledger-first: each ledger event is one model call; `tokens.input`/`output`/`total`, and
  cache tokens are joined from `messages[].usage` via `toMessageId`.
- Any positive `total − input − output − caches` remainder is added to `output`.
- No ledger → each assistant message with a `usage` block is one call.
- Amp records `credits`, not USD, so no `costUsd` is reported (kept unpriced/estimated by the
  central price table).

Verification: ⚠ not installed here (`~/.amp` and `~/.local/share/amp` absent). Fixture with a
2-event ledger (10 input + 5 output + 3 read + 2 write, plus a total-only event of 7) parses to
`input=10, output=12, cacheRead=3, cacheWrite=2`. Format mapped from ccusage's Amp adapter,
which was validated against real thread files upstream.

## 6. Goose — `goose.js` ⚠

Paths

- `$GOOSE_PATH_ROOT/data/sessions/sessions.db` when set; else
  `$XDG_DATA_HOME/goose/sessions/sessions.db` (`~/.local/share/goose/sessions/sessions.db`)
  on macOS/Linux, `%APPDATA%\Block\goose\sessions\sessions.db` on Windows.
- Older releases kept `<same dir>/*.jsonl`; those files are detected but carry no token
  counters, so they surface as "detected but unavailable".

Format (Goose `session_manager.rs` schema, `sessions` table)

```
id, name, working_dir, created_at, updated_at,
total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
accumulated_total_tokens, accumulated_input_tokens, accumulated_output_tokens,
accumulated_cache_read_tokens, accumulated_cache_write_tokens, accumulated_cost,
provider_name, model_config_json, parent_session_id, …
```

Token semantics

- `accumulated_input_tokens` / `accumulated_output_tokens` are the session's token totals;
  cache read/write columns and `accumulated_cost` (already USD) are read when present.
- `model_config_json` is JSON; `model_name` is the model id.
- Timestamps are SQLite TIMESTAMP strings; a missing `Z` is treated as UTC.
- No per-message breakdown exists, so one cell per session (`messages: 1`).

Verification: ⚠ not installed here. Fixture SQLite DB with the documented columns parses to
`input=1000, output=200, model=claude-sonnet-4-5` on 2026-02-02.

## 7. Crush — `crush.js` ⚠

Paths

- Registry: `$CRUSH_GLOBAL_DATA/projects.json` else `$XDG_DATA_HOME/crush/projects.json`
  (`~/.local/share/crush/projects.json`); Windows `%LOCALAPPDATA%\crush\projects.json`.
- Per-project DB: `<project.path>/<project.data_dir>/crush.db` (`data_dir` defaults `.crush`).
- Fallback for builds with a single global DB: `<crush-root>/crush.db`.

Format (`sessions` table; verified upstream against Crush v0.66.1 migrations)

```
sessions(id, parent_session_id, title, message_count, prompt_tokens, completion_tokens,
         cost, created_at, updated_at, …)
messages(id, session_id, role, parts, model, created_at, updated_at, …)
```

Token semantics

- `input = prompt_tokens`, `output = completion_tokens`, `cost = cost` (already USD).
- Dominant model from `messages.model` (`GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1`).
- Timestamps are Unix **seconds** (despite upstream schema comments): multiplied by 1000.
- Child sessions (`parent_session_id IS NOT NULL`) are skipped — their cost rolls into the
  parent. Cache tokens are not recorded by Crush.

Verification: ⚠ not installed here. Fixture registry + project `crush.db` parses a parent
session (`input=2000, output=100, cost=$0.5, model=claude-sonnet-4-5`) and correctly skips the
child session.

## 8. Aider — `aider.js` ⚠

Paths

- Structured: `$AIDER_ANALYTICS_LOG` file or any `~/.aider/analytics*.jsonl|log` file.
  (Aider has no default analytics path; it is written by `aider --analytics-log FILE`.)
- Fallback text: `~/.aider.chat.history.md` (per-user history; repo-local
  `.aider.chat.history.md` files are not scanned).

Formats

1. Analytics JSONL — one record per line, usage event is `message_send`
   (Aider `aider/analytics.py`, verified against Aider's official `sample-analytics.jsonl`):

```jsonc
{"event":"message_send","properties":{"main_model":"gemini/gemini-2.5-pro","edit_format":"ask",
  "prompt_tokens":10006,"completion_tokens":81,"total_tokens":10087,
  "cost":0.0133,"total_cost":0.0133},"user_id":"…","time":1755100406}
```

2. Chat-history Markdown — after a `# aider chat started at YYYY-MM-DD HH:MM:SS` header,
   each turn prints a summary line such as
   `> Tokens: 1.2k sent, 34 received. Cost: $0.01 message, $0.02 session.`

Token semantics

- `input = prompt_tokens`, `output = completion_tokens`, `cost = properties.cost` (per
  message; `total_cost` is cumulative and unused). Time is Unix seconds.
- The Markdown fallback (used only when no analytics log exists) parses the conservative
  `Tokens: <sent> sent, <received> received` + `Cost: $<x> message` pattern; `k` suffixes are
  expanded, model is `unknown`, and unparsable lines are skipped silently.
- Aider stores no cache-token breakdown, so cacheRead/cacheWrite stay 0.

Verification: ⚠ not installed here. Fixtures: analytics record → `10006/81`, `$0.0133175`;
Markdown history (two turns) → `1215 input, 34 output, $0.01`, day from the
`aider chat started at` header.

## 9. Qwen Code — `qwen-code.js` ⚠

Paths

- Current: `$QWEN_DATA_DIR` else `~/.qwen/projects/<encoded-cwd>/chats/*.jsonl`;
  Windows `%USERPROFILE%\.qwen\projects`.
- Legacy (Gemini-CLI-fork format): `~/.qwen/tmp/<project>/chats/session-*.json(l)`.

Format

- Current JSONL entries: `{uuid, sessionId, timestamp, type:"assistant", model,
  usageMetadata:{ promptTokenCount, candidatesTokenCount, thoughtsTokenCount,
  totalTokenCount, cachedContentTokenCount }}` (message parts may be nested under
  `message`). Legacy entries use `type:"gemini"` + `tokens:{input, output, cached, thoughts,
  tool, total}`.

Token semantics

- `cachedContentTokenCount`/`cached` is a subset of the prompt count → subtract it.
- Thoughts are billed as output → `output = candidatesTokenCount + thoughtsTokenCount`
  (legacy: `output + thoughts`).
- No cache-write or cost fields.
- Duplicate `uuid`s within one file are deduped (keeps first).

Verification: ⚠ not installed here. Fixture (prompt 800, candidates 40, thoughts 8, cached 300)
→ `input=500, output=48, cacheRead=300`.

## 10. Gemini CLI — `gemini-cli.js` ⚠

Paths

- `$GEMINI_DIR` / `$GEMINI_CLI_HOME` (if set) else `~/.gemini`; Windows
  `%USERPROFILE%\.gemini`.
- Sessions: `~/.gemini/tmp/<project>/chats/session-*.json` (older, single JSON document) and
  `session-*.jsonl` (current).

Format

- JSONL: header line `{sessionId, projectHash, startTime, kind}`, `{"$set": …}` update
  markers, and message lines `{id, timestamp, type:"user"|"gemini", content, thoughts,
  tokens, model, toolCalls}`. Gemini rewrites an assistant message several times; the newest
  line per `id` wins.
- Single JSON: `{sessionId, startTime, messages:[…]}` (or `history`).
- Token object: `tokens: {input, output, cached, thoughts, tool, total}`.

Token semantics

- `cached` is a subset of `input` → `input = input − cached`.
- `thoughts` is billed at the output rate → `output = output + thoughts`.
- `tool` tokens are not attributable to input/output columns and are ignored (upstream readers
  do the same); no cost field exists.
- Files older than the current format are accepted by trying whole-document JSON before JSONL.

Verification: ⚠ not installed here — `~/.gemini/tmp` does not exist (only Antigravity's
`~/.gemini/antigravity` tree, which is a different product handled by the antigravity
provider). Fixtures: JSONL with a rewritten assistant message (1200 input − 500 cached, 60+12
output) and an older single-JSON session both parse to the expected 1,382 tokens.

## 11. Factory Droid — `factory-droid.js` ⚠

Paths

- `$FACTORY_DIR` else `~/.factory`; sessions `~/.factory/sessions/<subdir>/*.jsonl` with a
  sibling `<name>.settings.json`.

Format

- Transcript JSONL: first line `{type:"session_start", cwd, timestamp}`, then
  `{type:"message", message:{role, content:[{type:"text"|"tool_use", …}]}, timestamp}`.
- `<name>.settings.json`: `{model, tokenUsage:{inputTokens, outputTokens,
  cacheCreationTokens, cacheReadTokens, thinkingTokens}}` — the **only** token record, and it
  is session-level.

Token semantics

- Droid does not record per-message usage. Session totals are split evenly across the
  assistant calls found in the transcript (floor per call, remainder on the last call), the
  same approximation the upstream Droid reader uses; each split is bucketed by that call's
  entry timestamp so multi-day sessions attribute correctly.
- `thinkingTokens` are billed like output → folded into `output`.
- Model is `settings.model` verbatim (raw ids such as `custom:GLM-5.1-[Proxy]-0` stay raw so
  the UI can show them as unpriced instead of guessing).
- No tokenUsage in the settings file → zero cells + one warning (detected but unavailable).

Verification: ⚠ not installed here — only `~/.factory/settings.json` exists. Fixture with two
assistant calls and `tokenUsage {100 input, 20 output, 3 thinking, 10 cache read,
5 cache creation}` → `input=100, output=23, cacheRead=10, cacheWrite=5`.

## 12. Continue — `continue.js` ⚠

Paths

- `$CONTINUE_GLOBAL_DIR` else `~/.continue`; Windows `%USERPROFILE%\.continue`.
- `~/.continue/sessions/<sessionId>.json` + `~/.continue/sessions/sessions.json` index.

Format

- Session document (`Session`/`SessionUsage` in Continue's `core/index.d.ts`):
  `{sessionId, title, workspaceDirectory, chatModelTitle, history:[{message:{role,
  content, usage?}}], usage?: {promptTokens, completionTokens, totalCost,
  promptTokensDetails:{cachedTokens, cacheWriteTokens},
  completionTokensDetails:{reasoningTokens}}}`.
- `sessions.json`: array of `{sessionId, title, dateCreated, workspaceDirectory,
  messageCount}`; it is the only timestamp source.

Token semantics

- Session-level cumulative `usage` is preferred; `promptTokens` is cache-inclusive, so
  `input = max(0, promptTokens − cachedTokens − cacheWriteTokens)`.
  `output = completionTokens` (reasoning is a subset of it).
- `totalCost` is Continue's recorded USD cost (passed through when > 0).
- If `session.usage` is absent, per-assistant `message.usage` blocks are summed instead.
- Day comes from `sessions.json` `dateCreated` (fallback: file mtime); the index stat is part
  of the cache fingerprint so a newly indexed session re-dates cached cells.
- Model id is only `chatModelTitle` (a display title) or `unknown` — Continue does not persist
  a raw model id per session here (documented limitation: titles can be unpriced).

Verification: ⚠ not installed here. Fixture session with cumulative usage (1000 prompt, 100
completion, 200 cached, $0.05, reasoning 10) and an index `dateCreated` → `input=800,
output=100, cacheRead=200, day=2026-02-01, cost=$0.05`.

---

## Cross-cutting notes

- **Caching:** every provider uses `ctx.cache` with `size:mtimeMs` fingerprints. SQLite
  fingerprints also include `-wal` size+mtime. Per-file cached values are `Cell[]` produced by
  `addUsage`/`finalizeCells`, so they are plain JSON. `cacheVersion` is 1 for eleven providers
  and 2 for `pi` (bumped by the model-id validation fix, which invalidates cells cached with
  the old bogus model ids).
- **No module-load or timer scans:** all work happens inside `scan(ctx)`; abort checks come
  from `utils.readJsonl`/`listFilesRecursive` via `ctx.signal`.
- **Windows:** every path is built with `path.join` from `ctx.env.home` / `appData` /
  `localAppData` / `xdgData`, and basename tests use `utils.basenameOf` so backslash paths are
  handled. Env overrides are expanded with `utils.expandPath` (`~` and `${ENV}`).
- **Cost:** only OpenCode (`cost`), Pi (`usage.cost.total`), Aider (`cost`), Goose
  (`accumulated_cost`), Crush (`cost`), Continue (`totalCost`), Grok (`costUsdTicks/1e10`),
  and Copilot (AI credits → `total_nano_aiu/1e11`) report provider-side costs; they are passed
  through only when > 0 and `host/pricing.js` owns all estimates.
- **Reasoning:** never added twice. Where a source gives reasoning as a distinct block
  (Gemini/Qwen thoughts, Droid thinking) it is folded into `output` because that is how it is
  billed; where it is already inside `output` (Pi, Grok, OpenCode, Continue) it is ignored.
  No `reasoning` cell field is emitted by these providers (the framework contract allows it,
  but totals stay unambiguous this way).
- **Detected but unavailable:** `aider` (no analytics log) and `copilot-cli` (session state
  without store/events usage) return zero cells, a source note, and exactly one warning; the
  UI shows them under "Detected but unavailable".

## Known limitations / risks

1. Pi forked sessions can duplicate entry ids across files; the per-file cache cannot dedupe
   across files (see §2). No real fork exists here to test.
2. Copilot CLI rollup reconciliation across resumed/compacted legs is simplified to
   "last shutdown rollup wins".
3. Crush and Goose schemas are versioned; the providers introspect table columns and degrade to
   a warning instead of throwing, but a renamed column will read as absent.
4. Gemini CLI / Qwen Code / Amp / Aider / Continue / Droid formats are only fixture-verified on
   this machine; a field rename upstream will silently drop those rows (skipped, not fabricated).
5. Aider Markdown parsing is inherently fragile (Aider can change the human-readable summary
   wording); it is only used when no structured analytics log exists.
6. Continue does not persist a raw model id, so its cells are usually unpriced.

## Reproduce

```bash
E="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
cd /Users/aesc/Documents/workspace/overview
for id in opencode pi gemini-cli copilot-cli amp goose crush aider qwen-code grok-build factory-droid continue; do
  ELECTRON_RUN_AS_NODE=1 "$E" dsh-agent-usage/host/providers/self-test.mjs "$id"
done
```
