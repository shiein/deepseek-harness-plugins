# Local usage-data coverage matrix — AI coding agents (2026)

Reference for the DSH Agent Usage plugin: where each market-relevant coding agent keeps its history,
whether **token usage is readable locally**, and what breaks. Compiled 2026-11-04 from

- the T3 Code usage implementation and its per-provider readers
  ([t3code-reference.md](./t3code-reference.md), <https://github.com/pingdotgg/t3code>),
- each vendor's public documentation / release notes,
- **actual inspection of this Mac** (`/Users/aesc`).

Legend:

- **readable** — token counters (input/output/cache, usually cost) are recorded in a local file the
  plugin can parse without network calls.
- **partial** — history is local, but token counters are missing, derived, or layout-dependent.
- **no** — usage exists only server-side (account API) or is not recorded at all.
- ✅ verified on this machine · ◐ directory present, parser not proven · — not present here.

A tool can be "readable" but still low priority: the plugin should only claim what the contract's
Coverage Expectations section lists, and every absent/unreadable source must surface as
"Detected but unavailable" rather than zero usage.

## 1. Verified on this machine (2026-11-04)

| Source | Path | Size / files | Models actually recorded |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/*/*.jsonl` | 86 transcripts | `claude-opus-5-5` (30.8k lines), `claude-haiku-5-5`, `claude-sonnet-5-5`, `<synthetic>` (39) |
| Codex | `~/.codex/sessions/**/*.jsonl` | 66 rollouts (+5 `.jsonl.zst` in `~/.codex/archived_sessions`) | `codex-auto-review` (3.7k), `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6.1-terra` |
| DeepSeek Harness | `~/.dsh/sessions/*/*/session.v4.jsonl.zstd` | 223 sessions (multi-frame zstd) | `deepseek-flash` (14.6k), `grok-4.6-build`, `grok-4.7-build`, `gpt-6-astra`, `gpt-5.6-sol`, `deepseek-v4-flash`, `swe-2-high`, `gpt-6.1-sol`, `swe-1-7`, `deepseek-v4-pro`, `devin:swe-2-high` |
| OpenCode | `~/.local/share/opencode/opencode.db` | 464 assistant messages in SQLite | `minimax-m2.5-free` (309), `glm-4.7-free` (53), `openai/gpt-5.2` (43), `google/gemini-3-flash-preview`, `opencode/deepseek-v4-flash-free`, `opencode/big-pickle`, `google/gemini-3-pro-preview`, `opencode/grok-code`, `openai/gpt-5.5`, `iflowcn/qwen3-coder-plus`, `alibaba-cn/qwen-max`, `galaxy/gpt-5.5`, ... |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | 93 sessions | `deepseek-flash`, `gpt-5.5`, `glm-5-2`, `glm-5-2-1m`, `swe-1-7`, `deepseek-v4-pro`, `gpt-6.1-sol`, fixture ids |
| Grok Build | `~/.grok/sessions/**/updates.jsonl` | 162 session logs | Grok 4.6 / 4.7 build traffic |
| Antigravity | `~/.gemini/antigravity/conversations/*.db` | 136 SQLite conversation DBs | Gemini 3 family (protobuf blobs) |
| Zed | `~/Library/Application Support/Zed/threads/threads.db` | SQLite, compressed thread blobs | not decoded here |
| GitHub Copilot CLI | `~/.copilot/session-state/<uuid>/` + `~/.copilot/logs` | session dirs, no token fields found | no token counters |
| VS Code forks | `~/Library/Application Support/{Trae CN,CodeBuddy CN,Devin,Windsurf}/User/globalStorage/state.vscdb` | chat data in SQLite | token counters not exposed by the chat schema |
| Factory Droid | `~/.factory/settings.json` | config only (no session history) | none |
| Warp | `~/.warp/settings.toml` + `~/Library/Application Support/dev.warp.Warp-Stable` | config / app db | no token counters |

Present but empty/irrelevant: `~/.cursor/hooks.json` (no Cursor user data in `~/Library`),
`~/.codebuddy`, `~/.devin` (VS Code-style shell only), `~/.gemini/config` (project metadata, migrated
history lives under Antigravity). Absent entirely: `~/.qoder`, `~/.workbuddy`, `~/.amp`, `~/.goose`,
`~/.crush`, `~/.aider`, `~/.continue`, `~/.qwen`, `~/.kiro`, `~/.muse`, `~/.augment`.

## 2. Coverage matrix

| Tool | Platform coverage | Local usage data (macOS / Windows) | Tokens readable | Notes / risks |
| --- | --- | --- | --- | --- |
| **Claude Code** | mac, win, linux | mac `~/.claude/projects/<escaped-cwd>/<session>.jsonl` · win `%USERPROFILE%\.claude\projects\...` · env `CLAUDE_CONFIG_DIR` | **readable** ✅ | `type:"assistant"` lines carry `message.usage.{input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens}`; one usage object is repeated on **every content block** of a message → dedupe by `message.id`+`requestId` or overcount ~2.4x. `<synthetic>` must be skipped. `costUSD` appears rarely. Newer builds add `usage.iterations[]` advisor calls on other models. |
| **Codex** | mac, win, linux | mac/win `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `~/.codex/archived_sessions/*.jsonl.zst` · env `CODEX_HOME` | **readable** ✅ | `token_count` events are cumulative snapshots **without model or tier** — carry forward from `turn_context` / `thread_settings_applied`; `input_tokens` is inclusive of cached+write, subtract; forks (`forked_from_id`, `thread_spawn`) copy history; a rollout can exist in both `sessions/` and `archived_sessions/` → dedupe across files. |
| **Cursor** | mac, win | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` · win `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | **no** — account API only | Chat/composer state is local but per-request token counters are not; T3 Code reads `https://cursor.com/api/dashboard/get-filtered-usage-events` with `CURSOR_API_KEY` / Keychain login. Our plugin: detect install, note "usage is account-side", warn once. |
| **Windsurf** | mac, win | `~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb` · win `%APPDATA%\Windsurf\User\globalStorage\state.vscdb` | **partial** ◐ | VS Code fork; Cascade chat stored in `state.vscdb` (`ItemTable`/`cursorDiskKV`-style blobs, often base64/zstd), token counters not part of the public schema; enterprise privacy mode may strip content. |
| **Trae (CN)** | mac, win | `~/Library/Application Support/Trae CN/User/globalStorage/state.vscdb` · win `%APPDATA%\Trae CN\User\globalStorage\state.vscdb` | **partial** ◐ | Verified present here. Chat JSON in SQLite; token metrics vary by release/build channel. Same layout as ByteDance VS Code forks, so one provider can serve CN + global. |
| **Trae (global)** | mac, win | `~/Library/Application Support/Trae/User/globalStorage/state.vscdb` · win `%APPDATA%\Trae\User\globalStorage\state.vscdb` | **partial** ◐ | Global build is not installed here; same parser as CN is expected, use separate source labels. |
| **Qoder** | mac, win | `~/Library/Application Support/Qoder/User/globalStorage/state.vscdb` · win `%APPDATA%\Qoder\User\globalStorage\state.vscdb` | **partial** (unverified) — | Alibaba's agent IDE; not installed here. Treat chat storage as VS Code globalStorage; confirm token fields before promising provider. |
| **WorkBuddy** | mac, win | not installed here; candidate `~/Library/Application Support/WorkBuddy*` / `%APPDATA%\WorkBuddy` | **no / unknown** — | Tencent's agent workspace; public docs do not describe a local usage log. Detect and report unavailable rather than scanning blindly. |
| **Devin** | mac, win, linux | CLI: `~/.local/share/devin/cli/sessions.db` · win `%LOCALAPPDATA%\devin\cli\sessions.db`; Desktop: `~/Library/Application Support/Devin/...` (VS Code shell) | **yes (CLI) / no (desktop)** | **Update 2026-11-04:** the Devin **CLI** records per-response metrics in `message_nodes.chat_message` → `metadata.metrics` (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`) with `generation_model` and `started_generation_at`; dedupe by message id (~2.4x duplicate rows otherwise). Verified here: 5.52 B tokens / 49,821 responses / 314 sessions. The desktop app remains a cloud client with no local counters. |
| **OpenCode** | mac, win, linux | `~/.local/share/opencode/opencode*.db` (+ `-wal`), legacy `storage/message/*.json` · env `OPENCODE_DATA_DIR` (comma list), `XDG_DATA_HOME` · win `%USERPROFILE%\.local\share\opencode` (XDG-style) | **readable** ✅ | SQLite `message.data` / `session_message.data` JSON: `tokens.{input, output, reasoning, cache.{read, write}}`, `cost`, `modelID`, `providerID`, `time.created`. `cost: 0` means unknown/free — do not price it as $0. Open whole DB read-only with `PRAGMA busy_timeout`. Free Zen models (`*-free`) intentionally stay unpriced. |
| **DeepSeek Harness** | mac, win | `~/.dsh/sessions/<project-slug>/<session-id>/session.v4.jsonl.zstd` · win `%USERPROFILE%\.dsh\sessions` | **readable** ✅ | Multi-frame zstd; `node:zlib` zstd decompresses all frames (or `zstd -dc`). `{"type":"usage","usage":{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens}}` plus model on the assistant message. Session lock file alongside; ignore partial tails. |
| **Pi** | mac, win, linux | `~/.pi/agent/sessions/**/*.jsonl` · env `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` · win `%USERPROFILE%\.pi\agent\sessions` | **readable** ✅ | Entry types `session`/`message`/`usage`/`compaction`/`branch_summary`; `message.usage` holds disjoint `input`/`cacheRead`/`cacheWrite`/`output`/`reasoning` and `cost.total` (0 = unknown). Model is `provider/model`, pricing may need `responseModel`. Auxiliary records use synthetic model `Tools/summaries`. Yi (01) style short ids need timestamp+model in dedupe keys. |
| **Gemini CLI** | mac, win, linux | `~/.gemini/` — older releases `tmp/<project>/chats/session-*.json`; current install here keeps only `~/.gemini/config/projects/*.json` metadata | **partial** ◐ | Verified here: no chat transcripts left under `~/.gemini` outside Antigravity, so nothing to parse. Older `session-*.json` files carry `tokens.{input, output, cached}` per message. Budget a parser only if transcripts are found. |
| **GitHub Copilot CLI** | mac, win, linux | `~/.copilot/session-state/<uuid>/` (`workspace.yaml`, `checkpoints/`, `files/`), `~/.copilot/logs/` | **no / partial** — | Verified here: no token counters in session state or logs. Copilot usage/premium requests are reported in GitHub account settings, not locally. Copilot CLI OTel telemetry can emit token counts only if the user enables an exporter. |
| **Amp** | mac, win, linux | `~/.amp/` (threads + settings; `%USERPROFILE%\.amp` on win) | **partial** (unverified) | Sourcegraph Amp stores thread JSON locally; whether token counters are persisted depends on version/telemetry settings — not installed here, do not promise a parser until a sample is inspected. |
| **Goose** | mac, win, linux | `~/.local/share/goose/sessions/*.jsonl` · win `%APPDATA%\Block\goose\sessions` | **readable** ◐ | Block's Goose writes one JSONL session per conversation with per-message `usage` (`input_tokens`, `output_tokens`, `total_tokens`, sometimes cache fields). Schema drifts between releases; parse defensively. |
| **Crush** | mac, win, linux | `~/.local/share/crush/crush.db` · win `%LOCALAPPDATA%\crush` | **partial** ◐ | Charm Crush keeps sessions/messages in SQLite; token usage is recorded in newer schema versions, older ones only cost/timing. Inspect `sqlite_master` before assuming columns. |
| **Aider** | mac, win, linux | `~/.aider.chat.history.md`, `~/.aider/analytics.jsonl`(opt-in), `.aider.chat.history.md` per repo | **partial** ◐ | Chat history is Markdown with `Tokens: X sent, Y received. Cost: $Z` summary lines (model-dependent); structured cost only when `--analytics` is on. No cache-read/write breakdown. Regex parsing of Markdown is fragile — tolerate failures. |
| **Cline** | VS Code (mac/win) | mac `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/<id>/{ui_messages.json,api_conversation_history.json}` · win `%APPDATA%\Code\User\globalStorage\...` | **readable** ✅ (when tasks exist) | Each task's `ui_messages.json` / API metrics include `tokensIn`, `tokensOut`, `cacheWrites`, `cacheReads`, and `cost`; also has `modelId`/`modelInfo`. Watch for huge files and streaming partial writes. |
| **Roo Code** | VS Code | `.../globalStorage/rooveterinaryinc.roo-cline/tasks/<id>/` (same format as Cline) | **readable** ✅ | Fork of Cline; identical metrics schema, different extension id. |
| **Kilo Code** | VS Code | `.../globalStorage/kilocode.kilo-code/tasks/<id>/` (Cline-lineage) | **readable** ✅ | Also the "Kilo/Kiro" naming trap: **Kilo Code** (VS Code extension) ≠ **Kiro** (AWS CLI/IDE). Keep two separate providers. |
| **Continue** | VS Code / JetBrains / CLI | `~/.continue/sessions/*.json`, `~/.continue/config.json` · win `%USERPROFILE%\.continue` | **partial** ◐ | Session JSON stores chat history; usage fields (`usage`, `promptTokens/completionTokens`) appear only in newer versions and not for local models. |
| **Qwen Code** | mac, win, linux | `~/.qwen/tmp/<project>/chats/session-*.json` · win `%USERPROFILE%\.qwen` | **partial** ◐ | Fork of Gemini CLI; when chat transcripts exist they carry token counts, same shape as Gemini CLI. Not installed here. |
| **Grok Build** | mac, win, linux | `~/.grok/sessions/**/updates.jsonl` · env `GROK_HOME` · win `%USERPROFILE%\.grok` | **readable** ✅ | ACP updates; only `sessionUpdate:"turn_completed"` lines carry `usage.{inputTokens (inclusive of cache), outputTokens, cachedReadTokens, cacheCreationTokens, reasoningTokens, costUsdTicks}` and optional `modelUsage` split. `costUsdTicks / 1e10` = USD. Empty `modelUsage` falls back to model `"grok"` (unpriced). |
| **Factory Droid** | mac, win, linux | `~/.factory/sessions/*.json` (droid CLI), `~/.factory/settings.json` · win `%USERPROFILE%\.factory` | **partial** ◐ | Verified here: settings only (hooks), no session history — CLI/IDE usage not run on this machine. Droid sessions store messages and token usage in newer versions; confirm per release. |
| **Antigravity** | mac, win, linux | `~/.gemini/antigravity*/conversations/*.db`, `~/.config/antigravity` · env `ANTIGRAVITY_DATA_DIR` (comma list) · win `%USERPROFILE%\.gemini\antigravity` | **readable** ✅ (brittle) | 136 DBs here. SQLite tables `gen_metadata`/`steps` hold **protobuf field blobs**, not JSON: decode fields 2 (input), 3/9+10 (output), 4 (cache write), 5 (cache read), 9 (reasoning). Model ids are numeric enum + `antigravity-model-N` fallback. Layout changes per Google release → mark source `partial`, never throw. |
| **Zed** | mac, win, linux | mac `~/Library/Application Support/Zed/threads/threads.db` · win `%LOCALAPPDATA%\Zed\threads\threads.db` | **partial** ◐ | SQLite `threads.data` is a compressed blob (zstd) containing the agent thread JSON; token usage may be stored per assistant message but the schema is versioned. Low priority: Zed's own token view is not local-first. |
| **CodeBuddy** | mac, win | `~/Library/Application Support/CodeBuddy CN/User/globalStorage/state.vscdb` · win `%APPDATA%\CodeBuddy CN\User\globalStorage\state.vscdb` | **partial** ◐ | Tencent VS Code fork; verified dir exists. Chat data in `state.vscdb`; token counters not documented, can differ between CN and international builds. |
| **Muse Code** | mac, win, linux | `<muse home>/sessions/**/session.jsonl`, home resolved from the Muse CLI; `XDG_DATA_HOME` applies | **readable** ✅ | JSONL runtime envelopes: `payload_type:"runtime.session"`, `payload.event.kind` `model_completed`/`automated_review_completed`, `usage.{input_tokens, output_tokens, cached_*, cache_write_tokens, reasoning_tokens}` (cache is a subset of input). `recorded_at` is µs. Dedupe by `payload.source_run_record_id`. |
| **Kiro (AWS)** | mac, win, linux | `~/.kiro/` (kiro-cli sessions, agents, specs); VS Code Kiro extension globalStorage | **no** — | T3 Code ships a Kiro *provider* with **no usage reader** — a strong signal there is no parseable local token record. Kiro meters "agentic requests", not tokens. |
| **Augment Code** | VS Code / JetBrains | `~/Library/Application Support/Code/User/globalStorage/augment.vscode-augment/` · win `%APPDATA%\...` | **no** | Usage/credits are account-side; extension storage holds no per-request token counters. |
| **Warp** | mac, win, linux | `~/.warp/settings.toml`, mac app DB `~/Library/Application Support/dev.warp.Warp-Stable/` | **no** | Agent conversations are stored in an opaque app database; token usage is not exposed locally (Warp reports request counts). |

## 3. Quick env-override reference

| Env var | Provider | Semantics |
| --- | --- | --- |
| `CLAUDE_CONFIG_DIR` | Claude Code | Alternate `~/.claude` root (projects live under it) |
| `CODEX_HOME` | Codex | Alternate `~/.codex` root |
| `GROK_HOME` | Grok Build | Alternate `~/.grok` root |
| `PI_CODING_AGENT_DIR` | Pi | Alternate `~/.pi/agent`; sessions under `<dir>/sessions` |
| `PI_CODING_AGENT_SESSION_DIR` | Pi | Absolute/`~/` session directory, overrides the above (must match `--session-dir`) |
| `OPENCODE_DATA_DIR` | OpenCode | **Comma-separated** list of data roots |
| `ANTIGRAVITY_DATA_DIR` | Antigravity | **Comma-separated** list of data roots |
| `XDG_DATA_HOME` | OpenCode, Muse, Pi-ish | Base for `$XDG_DATA_HOME/<app>` when set |
| `CURSOR_API_KEY` | Cursor | Account API key (not local usage) |

Rules we should keep: expand `~` and `${ENV}`; treat comma lists as multiple sources; canonicalise with
`realPath` so symlinked/duplicated homes are not counted twice; relative paths are unreliable (T3 Code
requires absolute or `~/` paths in account env settings).

## 4. Risks / principles for our providers

1. **Never fabricate tokens.** Tools that meter requests/credits (Kiro, Augment, Copilot, Cursor,
   Devin Desktop, Warp, WorkBuddy) must return zero cells plus a `sources` note and one warning.
   Devin **CLI** is not in that group any more: its `cli/sessions.db` carries per-response token
   metrics (verified 2026-11-04, 5.52 B tokens).
2. **VS Code `state.vscdb` is a moving target.** Chat schemas differ per fork and per release and are
   frequently compressed; treat every parse as best-effort, cap file sizes, and skip undecodable rows.
3. **SQLite needs read-only + busy timeout.** OpenCode, Antigravity and Zed are live databases with
   WAL files; open `readOnly`, `PRAGMA busy_timeout = 100`, `try/finally close`.
4. **Inclusive vs exclusive input tokens is per-tool**: Codex/Grok include cached input in
   `input_tokens`; Claude's `input_tokens` is uncached; Pi's counters are already disjoint; Muse's
   cache counters are subsets. Always check before subtracting.
5. **Dedupe aggressively.** Repeated usage objects (Claude), copied rollouts (Codex), duplicated
   session envelopes (Muse), forked session ids (Pi), and multi-environment accounts (t3code, Cursor).
6. **Free/promo model ids** (`*-free`, `big-pickle`) are not "priced models" — leave them unpriced so
   the UI says "unpriced", not "$0.00".
7. **Compressed history is normal**: `.jsonl.zst` / multi-frame `.zstd` archives (Codex, DSH) must be
   decompressed before scanning; `node:zlib` zstd handles multi-frame streams in Node 24.
