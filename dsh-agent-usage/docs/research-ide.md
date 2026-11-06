# IDE / VS Code-fork agent usage providers — research & verification

Scope: task-2 providers in `host/providers/`:

| provider id | module | status on this machine (macOS, 2026-11-04) |
| --- | --- | --- |
| `cursor` | `cursor.js` | **not installed** → source MISS (parser unverified on real Cursor data) |
| `trae` | `trae.js` | Trae CN installed; agent DB encrypted → detected-but-unavailable (0 cells + warning) |
| `qoder` | `qoder.js` | **not installed** → source MISS (parser unverified on real Qoder data) |
| `workbuddy` | `workbuddy.js` | **not installed** → source MISS (parser unverified on real WorkBuddy data) |
| `devin` | `devin.js` | Devin Desktop installed; no local token usage → detected-but-unavailable |
| `antigravity` | `antigravity.js` | **verified on real data** — 136 DBs, 26,811 generations, 97 (model,day) cells |
| `windsurf` | `windsurf.js` | Windsurf installed; Cascade files encrypted → detected-but-unavailable |
| `zed` | `zed.js` | **verified on real data** — 1 thread, 6,708 tokens |
| `codebuddy` | `codebuddy.js` | CodeBuddy CN IDE installed; no local token counters → detected-but-unavailable |
| `cline-family` | `cline-family.js` | no Cline/Roo/Kilo storage found → source MISS (parsers verified against fixtures) |

All ten providers were run with the bundled Node 24 runtime:

```bash
E="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 "$E" dsh-agent-usage/host/providers/self-test.mjs <id>
```

Parsers for apps that are not installed were additionally verified against synthetic fixtures
(`/tmp/make-ide-fixtures.mjs` + `/tmp/run-ide-fixtures.mjs`): cursor 460 tokens, qoder 5,300,
workbuddy 12,700, codebuddy 3,400, cline-family 1,850, trae (plaintext path) 8,600 — all exact.

Shared implementation rules used by every module:

- Read-only SQLite (`ctx.utils.openSqliteDatabase(path, { readOnly: true })`, `finally db.close()`),
  `PRAGMA table_info` / `sqlite_master` discovery before querying, per-DB try/catch.
- Cache fingerprint = `size:mtimeMs` of the file **and its `-wal` / `-shm` sidecars** for SQLite;
  JSONL/JSON files use their own `size:mtimeMs`. Parsed `Cell[]` are stored with `ctx.cache`
  keyed by path. Verified for Antigravity: first scan 2.9–3.4 s (136 DBs), cached rescan ~0.28 s,
  identical totals.
- One cell per `(model, local day)` merged inside each provider (`mergeProviderCells`).
- No token estimates: only counters that exist in the local store are reported. `reasoning`
  is left unset where the source folds thinking into `output` (Antigravity, WorkBuddy,
  CodeBuddy, Cline family) so it is not double counted.

Note: `CONTRACT.md` documents `utils.join/path.resolve`, but `host/scan-utils.js` exports
`utils.joinPath` / `utils.joinPathNode` / `utils.resolvePath`; providers use the functions that
actually exist (`utils.joinPath`).

---

## Antigravity (verified)

**Data (all platforms):** Antigravity roots under `$GEMINI_HOME` (default `~/.gemini`):
`antigravity`, `antigravity-cli`, `antigravity-ide`, `antigravity-backup`, `antigravity-acp`,
plus `~/.config/antigravity`. `ANTIGRAVITY_DATA_DIR` (comma-separated; a data root or a
`conversations` directory) overrides/adds roots, matching t3code's driver
(see `docs/t3code-reference.md` §4.6). Conversation DBs:
`<root>/conversations/<conversation-uuid>.db` (SQLite, WAL).
On this machine only `~/.gemini/antigravity/conversations` exists (136 `.db` files, 821 MB);
the other four roots report MISS.

**Storage format:** `gen_metadata` has `(idx INTEGER, data BLOB)` where `data` is a private
Protobuf (`GenMetadata`) — no JSON anywhere:

| path | meaning |
| --- | --- |
| `gen_metadata.data` field 1 | `ChatModel` |
| `ChatModel` field 4 | `ModelUsageStats` (`exa.codeium_common_pb.ModelUsageStats`) |
| stats field 2 | `input_tokens` (uncached) |
| stats field 3 | `output_tokens` (= field 9 + field 10) |
| stats field 4 | `cache_write_tokens` |
| stats field 5 | `cache_read_tokens` |
| stats field 9 | `thinking_output_tokens` (inside field 3) |
| stats field 10 | `response_output_tokens` |
| stats field 11 | response id (dedup key) |
| `ChatModel` field 19 | canonical model config id (e.g. `gemini-3.8-flash-exp-a`) |
| `ChatModel` field 21 | display name fallback (e.g. `Gemini 3.1 Pro (Low)`) |
| top-level field 2 | packed step indices produced by this generation |
| top-level field 4 | generation uuid |
| `steps.metadata` field 1 | `Timestamp {seconds, nanos}` for that step |

Each `gen_metadata` row is **one model call**, so usage is summed over all rows (not just the
latest). Deduped per response id; one conversation UUID is read once even if mirrored under
several roots. Day = first step timestamp of the generation; when a generation has no step row
the DB file mtime is used (16 of 26,811 rows on this machine).

**Model identity normalization (added after dashboard review, `cacheVersion: 2`).** Some builds
write only a display name (field 21) instead of the canonical config id (field 19):

- A record's canonical id always wins. For display-only records the parser first matches the
  display name against the canonical ids observed **in the same conversation database**
  (punctuation-insensitive identity key: `Claude Opus 4.6 (Thinking)` ↔
  `claude-opus-4-6-thinking`, `Gemini 3.1 Pro (Low)` ↔ `gemini-3.1-pro-low`), then retries with
  the effort suffix (`High`/`Low`/`Thinking`/…) removed, then falls back to a deterministic
  slug (`Gemini 3.1 Pro (Low)` → `gemini-3.1-pro-low`).
- On real data this folds the 2 display-only `Gemini 3.1 Pro (Low)` records (35,509 tokens)
  into the canonical `gemini-3.1-pro-low` bucket. No display-name or `unknown` models remain.
- **Zero-token generations are pruned:** 109 of 26,811 rows record a model call with no token
  counters (including 102 rows with neither canonical nor display name). They are skipped
  instead of emitting messages-only cells, which removes the empty `unknown` buckets from the
  dashboard while leaving the token total unchanged (3,662,602,045).

**Evidence / observed output:**

```
=== antigravity (Antigravity) — 3063ms
  source OK   /Users/aesc/.gemini/antigravity/conversations
         files=136 bytes=821399552 note=SQLite conversation DBs; Protobuf gen_metadata token usage
  cells=73 tokens=3,662,602,045 estCost=$526.0353
  unpriced models: gemini-3.1-pro-low
  model gemini-3.8-flash: 1,501,739,646 tok
  model gemini-3.7-flash: 1,301,864,014 tok
  model gemini-3.8-flash-n: 647,931,582 tok
  model gemini-3.8-flash-exp-a: 182,933,618 tok
  model claude-opus-4-6-thinking: 18,887,885 tok
  model gemini-3.1-pro-low: 5,663,432 tok   (5,627,923 canonical + 35,509 folded display-only)
```

Totals: input 283,864,543 / output 13,087,160 / cache-read 3,365,650,342 / cache-write 0.

**Limitations:** T3-managed profile roots (`<T3 state dir>/profiles/<instance>/antigravity-acp`)
are not read. The `.proto` files are unpublished; the field mapping is inferred from
descriptors embedded in Antigravity binaries and cross-checked against two independent readers
([antiburn](https://github.com/antiburn/antiburn/blob/146d8c4ab889c6e7fe9ee6e8ee8dbf6c90644667/docs/antigravity-sessions.md),
[codeburn](https://github.com/getagentseal/codeburn/blob/f846b6309741fd2813d7ac651ede5861bd3f2ae3/docs/providers/antigravity.md),
[codeux](https://raw.githubusercontent.com/codeux-ai/codeux/e15e1e8d59e615acd54cddc009a35a89015ce38e/docs/architecture/usage-telemetry-and-stats.md)).
A future app build can renumber the private fields; malformed rows are skipped, never guessed.
Display-only names are normalized to their canonical id where one is observable in the same
database; a name with no observable canonical counterpart becomes a deterministic slug
(`gemini-3.1-pro-low`) rather than a display string. `gemini-3.1-pro-low` itself has no row in
`host/pricing.js`, so it stays visibly unpriced (152 generations were not guessed into a priced
family). Legacy encrypted `.pb` conversations (pre-SQLite builds) are not read.

---

## Zed (verified)

**Data:** `~/Library/Application Support/Zed/threads/threads.db` (macOS),
`%LOCALAPPDATA%\Zed\threads\threads.db` (Windows), `$XDG_DATA_HOME/zed/threads/threads.db`
(Linux). Schema: `threads(id, summary, updated_at, data_type, data, parent_id, folder_paths,
created_at)`; `data_type` is `json` or `zstd`.

Thread JSON carries `model: {provider, model}`, `request_token_usage` (map or array of
`{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`) and
`cumulative_token_usage` (fallback when the request map is empty), plus `imported`.
Threads with `imported: true` are skipped (their usage belongs to another agent's provider).
Zed stores no per-request timestamps, so every request in a thread is attributed to the
thread's `updated_at` day (documented limitation).

**Evidence:** 1 thread on this machine, `gpt-5.5`, 6,708 tokens (`input 2,089 / output 11 /
cache-read 4,608`), day `2026-05-18`.

---

## Cursor (unverified locally — not installed)

**Data:** `~/Library/Application Support/Cursor/User/{globalStorage,workspaceStorage}/state.vscdb`
(macOS), `%APPDATA%\Cursor\User\...` (Windows), `~/.config/Cursor/User/...` (Linux). The Cursor
CLI config lives at `~/.cursor` (`hooks.json` on this machine; no usage there).

**Format:** current Cursor writes cross-workspace chats to the **`cursorDiskKV`** table of
`globalStorage/state.vscdb`; workspace chats stay in their own `workspaceStorage/*/state.vscdb`:

- `composerData:<composerId>` — `{modelConfig:{modelName}, createdAt, lastUpdatedAt, ...}`
- `bubbleId:<composerId>:<bubbleId>` — `{tokenCount:{inputTokens, outputTokens}, createdAt,
  modelInfo:{modelName}, ...}`

Older builds kept an aichat/composer JSON blob under `ItemTable`; the provider walks those JSON
strings for explicit `tokenCount` objects and uses them only when `cursorDiskKV` produced
nothing.

**Token semantics:** `tokenCount` is already split input/output (uncached input); cache fields
are not recorded by Cursor, so `cacheRead`/`cacheWrite` stay 0. Bubbles without a timestamp are
skipped (composer `lastUpdatedAt` is the fallback).

`docs/t3code-reference.md` §4.8 suggests detecting Cursor and warning only (it reads the
account API); this provider instead layers a best-effort local `tokenCount` reader on top, so
real local counts are used when they happen to exist while everything else is reported as
remote-only.

**Evidence:** Cursor is not installed on this machine (`Application Support/Cursor` absent,
`~/.cursor/hooks.json` present). Schema taken from a real-data-verified independent adapter
([skiagram cursor adapter](https://docs.rs/skiagram-core/0.1.2/src/skiagram_core/adapters/cursor.rs.html)).
That adapter also reports the important limitation implemented here: on real installs the
per-message `tokenCount` is **~99 % zeroed** (3 of 275 bubbles non-zero), and Cursor's
authoritative usage is the online dashboard API authenticated by the CLI login. The provider
therefore only reports non-zero local counts and, when none exist, emits one warning that
Cursor usage is remote-only.

---

## Trae / Trae CN (detected, not locally readable)

**Data:** `~/Library/Application Support/{Trae,Trae CN,TRAE SOLO}/ModularData/ai-agent/database.db`
(macOS), `%APPDATA%\{Trae,Trae CN,TRAE SOLO}\ModularData\ai-agent\database.db` (Windows),
`~/.config/{...}` (Linux); older builds used `ModularData/ai-chat/database.db`. IDE config also
exists at `~/.trae` / `~/.trae-cn`, and VS Code state at
`<root>/User/globalStorage/state.vscdb`.

**Verified on this machine (Trae CN 2.3.82600):**

- `ModularData/ai-agent/database.db` is **SQLCipher-encrypted**: the first bytes are opaque
  (`44 2c cd 47 …`), `sqlite3` and `node:sqlite` both report "file is not a database". Third
  party readers decrypt it with Trae's shared application key
  ([tokentracker trae docs](https://raw.githubusercontent.com/xiufengsun/tokentracker/d3946d4a70efa7d388a34409649adde8f2bca020/docs/trae.md)).
  This bundle deliberately embeds no vendor key and never writes a decrypted copy of user data.
- Plaintext `state.vscdb` holds only IDE state: `AI.agent.model.model_list_map` (model catalog),
  draft-session keys (`<id>:draft:session:...`), `previousAgentDataLeaveIDEMode_*`,
  `*:AI.agent.model.session_selected_model`, theme data. A value scan for token strings finds no
  usage counters.
- Workspace storage has `icube-ai-agent-storage-input-history` (prompt text only).

The provider reports the DB as detected-but-unavailable (0 cells + one warning). If a user points
the app at a **plaintext/decrypted** database at the same path, the provider parses the documented
`chat_turn(id, session_id, turn_id, context, created_at, updated_at)` schema
(`context.token_usage` OpenAI-style counters, `context.persist_user_message_context.model_info`)
— this branch is implemented but unverified on this machine (verified only against a fixture:
8,600 tokens for a 8,000/600/2,000 row).

---

## Qoder / Qoder CN (unverified locally — not installed)

**Data:** `<app root>/SharedClientCache/cache/db/local.db` where app root is
`~/Library/Application Support/Qoder` (macOS), `%APPDATA%\Qoder` (Windows), `~/.config/Qoder`
(Linux); `Qoder CN` is scanned as a second app dir.

**Verified schema** (shared with Token Tracker's Qoder reader,
[reference](https://cdn.jsdelivr.net/npm/tokentracker-cli@0.89.0/README.zh-CN.md)):

```sql
SELECT cm.id, cm.session_id, cm.request_id, cm.token_info, cm.model_info, cm.gmt_create,
       cr.extra AS record_extra, cs.preferred_model_info
  FROM chat_message cm
  LEFT JOIN chat_record cr ON cr.request_id = cm.request_id
  LEFT JOIN chat_session cs ON cs.session_id = cm.session_id
 WHERE cm.role = 'assistant' AND cm.token_info IS NOT NULL
```

`token_info = {prompt_tokens, cached_tokens, completion_tokens}`; `prompt_tokens` includes
`cached_tokens`, so `input = prompt - cached`, `cacheRead = cached`, `output = completion`.
Model: `model_info.model_key` → `chat_record.extra.modelConfig.key` →
`chat_session.preferred_model_info.model_key` → `qoder-agent`. One row per request (deduped by
message and request id); `gmt_create` is epoch seconds or ms. Missing/unsupported schema emits
one warning instead of guesses.

---

## WorkBuddy (unverified locally — not installed)

**Data:** `~/.workbuddy/projects/<cwd-slug>/<sessionId>.jsonl` plus nested
`<sessionId>/subagents/agent-*.jsonl` (macOS/Windows/Linux; `WORKBUDDY_HOME` / provider config
override supported). Optional fallback: `~/.workbuddy/traces/<id>/trace_*.json`. The binary
`~/.workbuddy/workbuddy.db` is deliberately ignored (it holds context-window state and credits,
not billable token columns).

**Format:** flat JSONL records; every LLM round-trip (`message` assistant or `function_call`)
carries `providerData.rawUsage`:

```json
{ "prompt_tokens": 22223, "completion_tokens": 250,
  "prompt_tokens_details": { "cached_tokens": 512, "reasoning_tokens": 40 },
  "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
  "prompt_cache_hit_tokens": 0 }
```

Math: `cacheRead = max(cache_read_input_tokens, prompt_tokens_details.cached_tokens,
prompt_cache_hit_tokens)`, `cacheWrite = cache_creation_input_tokens`,
`input = prompt - cacheRead - cacheWrite`, `output = completion` (reasoning is inside output and
not re-added). camelCase `inputTokens`/`outputTokens` variants are accepted. Timestamp =
`record.timestamp` (epoch ms); dedup by `providerData.messageId`; model =
`providerData.model` / `requestModelId` / record model / `settings.model` / `auto`.
Trace fallback uses `trace.modelInfo.totalInputTokens/totalOutputTokens/totalCachedTokens`.

References: [better-harness WorkBuddy spec](https://raw.githubusercontent.com/QoderAI/better-harness/refs/heads/main/docs/specs/2026-07-30-workbuddy-host-adapter.md),
[tokentracker WorkBuddy reader](https://cdn.jsdelivr.net/npm/tokentracker-cli@1.5.5/src/lib/rollout.js).

---

## Devin Desktop / Devin CLI (detected, not locally readable)

**Data:** `~/Library/Application Support/Devin` (macOS), `%APPDATA%\Devin` (Windows) — a
Windsurf-derived Electron app — plus `~/.devin` (VS Code-style argv/extensions) and the shared
Codeium home `~/.codeium/windsurf` (Cascade sessions).

**Verified on this machine (2026-11-04):**

- `User/acp-messages/<session>.db` (SQLite `meta` + `messages(position, kind, payload)`) stores
  ACP session updates: `user_message`, `agent_message`, `agent_thought`, `tool_call`, `plan`,
  `subagent`. 200 session DBs were scanned: no payload contains token/usage counters (the only
  `usage` hits are tool-output text).
- `User/globalStorage/state.vscdb` holds Windsurf-fork state (`windsurfAuthStatus`,
  `windsurfSpace.*`, `windsurf.acp.sessioninfo.*`). A recursive key walk of `windsurfAuthStatus`
  finds no token/quota counters, only auth/plan metadata.
- `~/.codeium/windsurf/cascade/*.pb` are encrypted (no printable model/usage strings).

Devin reports usage to the Cognition service. Provider result: 0 cells + one warning + source
notes; no numbers fabricated.

---

## Windsurf (detected, not locally readable)

**Data:** `~/Library/Application Support/Windsurf` (macOS), `%APPDATA%\Windsurf` (Windows),
`~/.windsurf` (IDE config) and `~/.codeium/windsurf` (Cascade agent home: `cascade/`, `brain/`,
`memories/`, `context_state/`, `code_tracker/`).

**Verified:** `state.vscdb` has no token counters (values are `windsurfConfigurations`,
`windsurfAuthStatus`, plan info, space/ACP registries, model pickers). Cascade sessions are
`cascade/<uuid>.pb` encrypted protobuf files (`file(1)` misreads the header as an OpenPGP key,
no printable usage/model strings). `brain/`, `memories/`, `context_state/` hold memory material
only. Windsurf usage is account-served → 0 cells + one warning.

---

## CodeBuddy / CodeBuddy CN (IDE detected, CLI readable when present)

**Data:**

- CodeBuddy CLI: `~/.codebuddy/projects/<encoded-cwd>/<sessionId>.jsonl` (macOS/Windows/Linux)
  and `~/.codebuddy/settings.json` (`{"model": ...}`).
- IDE: `~/Library/Application Support/{CodeBuddy,CodeBuddy CN}` (macOS),
  `%APPDATA%\{CodeBuddy,CodeBuddy CN}` (Windows); extension storage under
  `User/globalStorage/tencent-cloud.coding-copilot` (file-change snapshots only).

**Verified on this machine:** CodeBuddy CN is installed; `state.vscdb` keys are UI/model-cache
data (`Tencent-Cloud.coding-copilot` product/model caches, auth cache, theme, workbench views).
No token counters exist locally for the IDE — its usage is reported to Tencent. `~/.codebuddy`
contains plugins/skills but no `projects/` transcripts.

**CLI format** (verified against a fixture; reference reader: tokentracker CodeBuddy parser):
only `type=="message" && role=="assistant"` records carry
`providerData.rawUsage = {prompt_tokens, completion_tokens, prompt_tokens_details:{cached_tokens,
reasoning_tokens}, cache_read_input_tokens, cache_creation_input_tokens}`; `input = prompt -
cached - cache_create`, `output = completion`, dedup by message id, model from
`providerData.model`/`requestModelId`/record model/`settings.model`/`codebuddy-unknown`.
Legacy IDE extension-log scraping is intentionally not implemented (log format, not a data store).

---

## Cline / Roo Code / Kilo Code (cline-family; unverified locally — not installed)

**Data roots** (all VS Code forks found in `env.appData`): `Code`, `Code - Insiders`, `Cursor`,
`Cursor Nightly`, `CodeBuddy`, `CodeBuddy CN`, `Windsurf`, `VSCodium`, `Trae`, `Trae CN`, `Devin`,
`Qoder` × `User/globalStorage/<extension>/tasks`:

- `saoudrizwan.claude-dev` — Cline
- `rooveterinaryinc.roo-cline` — Roo Code
- `kilocode.kilo-code` — Kilo Code

Each `<taskId>/ui_messages.json` is a JSON array; usage records are `say == "api_req_started"`
(or `api_req_deleted`, a removed turn whose tokens were already spent), whose `text` is a
JSON string:

```json
{ "apiProtocol": "anthropic", "tokensIn": 1200, "tokensOut": 250,
  "cacheReads": 300, "cacheWrites": 100, "cost": 0.0123 }
```

`tokensIn` already excludes cache; `cacheReads`/`cacheWrites` are separate; `cost` (when
present) is passed through as `costUsd`. Timestamp = `msg.ts`. Model attribution, in order:
explicit payload model id → last `<model>` tag inside
`api_conversation_history.json` `<environment_details>` blocks (Roo/Cline) → `task_metadata.json`
model fields → `unknown`. Dedup by `(taskId, ts)`; zero-token placeholders are not cached as
seen (Cline writes them at request start and back-fills in place).

Also supported: Cline's newer standalone CLI/desktop sessions at
`~/.cline/data/sessions/<sessionId>/<sessionId>.messages.json` (`messages[].metrics` with
`inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/reasoningTokenCount/cost`;
`inputTokens` is inclusive of both cache buckets).

**Evidence:** no cline-family globalStorage or `~/.cline` exists on this machine → three MISS
sources (Code globalStorage, extension storage, CLI sessions). Parsers verified against fixtures:
extension task 1,850 tokens (`input 1,200 / output 250 / cache 300+100`, model resolved from the
history tag, cost 0.0123), CLI metrics path covered by the code path.

---

## Cross-cutting notes / open risks

1. **Cursor is the weakest provider.** Local `tokenCount` is mostly zeroed in the wild; only
   non-zero values are reported. Authoritative Cursor usage needs its dashboard API and CLI
   login, which is out of scope for a local-file scanner (and t3code itself shows a notice
   instead of local totals). Source note + warning make this visible in the UI.
2. **Trae / Windsurf / Devin are encrypted or account-only.** They always produce 0 cells with a
   warning; a future framework-level decision to support SQLCipher (with a user-supplied key)
   would be needed to read Trae. Never fabricated numbers.
3. **Antigravity's Protobuf mapping is inferred**, not official. The decoder is defensive
   (skips malformed rows), and totals were cross-checked against two independent readers
   (codeux sum-every-row behaviour, codeburn field table, antiburn ModelUsageStats table).
4. **Day attribution fallbacks:** Antigravity uses the generation's first step timestamp, and
   the DB mtime for the rare generation without steps (16/26,811). Cursor/Zed attribute all
   requests of a conversation/thread to the store's update timestamp. WorkBuddy/CodeBuddy/
   Cline use per-record/per-message timestamps.
5. **Antigravity unpriced aliases:** display names are now folded into canonical ids inside
   `antigravity.js` (no duplicate display-name rows). The only remaining unpriced Antigravity
   model is the canonical `gemini-3.1-pro-low` (effort variant), which has no price row; that
   mapping belongs to `host/pricing.js`, not the provider.
6. **Framework contract mismatch:** `CONTRACT.md` lists `utils.join` / `utils.resolve`, which
   `host/scan-utils.js` does not export (it has `joinPath`, `joinPathNode`, `resolvePath`).
   Providers use the real functions; a contract/implementation alignment would avoid this trap
   for future providers.

## Update 2026-11-04 — Devin CLI is locally readable after all

The original Devin conclusion covered only the **desktop** app (Windsurf fork). Checking the
XDG data directory found a second, much better source used by the Devin **CLI**:

```
~/.local/share/devin/cli/sessions.db          (+ sessions.db-wal, 3.5 GB + 1.1 GB here)
Windows: %LOCALAPPDATA%\devin\cli\sessions.db  (or %USERPROFILE%\.local\share\devin\...)
```

`message_nodes.chat_message` holds ACP messages as JSON; assistant responses carry
`metadata.metrics`:

```json
{
  "num_tokens": 101,
  "request_id": "47429a8a-…",
  "generation_model": "claude-sonnet-4-6",
  "started_generation_at": "2026-06-09T07:32:29.676699Z",
  "metrics": {
    "input_tokens": 3, "output_tokens": 101,
    "cache_read_tokens": null, "cache_creation_tokens": 17074,
    "context_input_tokens": …, "ttft_ms": …
  }
}
```

Notes:

- One response is stored on **more than one row** (a later row adds `extensions`), so rows must be
  de-duplicated by `message_id`/`request_id` — without it the totals inflate ~2.4x here.
- `input_tokens` is uncached input (Anthropic semantics); cache read and cache creation are
  separate counters.
- The aggregation runs inside SQLite (`json_extract` + `strftime(..., 'localtime')`), so the
  multi-GB JSON never reaches Node. On this machine: 215 (model, day) buckets, 49,821 responses,
  5.52 B tokens, 2026-06-09 → 2026-11-04.
- Cost: Devin CLI reports SWE / Fable variant ids (`swe-2-max`, `swe-1-7-medium`,
  `claude-5-fable-high`, `claude-opus-5-5-medium`, …). `host/pricing.js` maps the effort suffixes
  onto the family rate; `compactor`, `summarizer`, `MODEL_PRIVATE_11` stay unpriced (internal
  operations with no public rate).
- Cold aggregation takes ~18 s for the 3.5 GB database; the provider caches by
  `sessions.db` + `-wal` fingerprint, so later scans are ~0.1 s until the CLI writes again.
- The desktop app remains detected-but-unavailable: its ACP stores carry no token counters and its
  Cascade `.pb` files are encrypted.
