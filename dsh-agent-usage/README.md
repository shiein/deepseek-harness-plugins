# Agent Token Usage — DSH plugin

A left-sidebar dashboard inside the DeepSeek Harness Web GUI that shows **token consumption of every
AI coding agent installed on this machine**, aggregated **by agent, by model, and by date**, with an
API-equivalent cost estimate.

Everything is read from **local session/usage files**. Nothing is uploaded, no account login is
required, and **files are scanned only when you press Refresh** — there is no timer, no watcher, no
background polling, and opening the panel only re-displays the last saved scan.

![](icon.svg)

## Features

- **One panel for all agents** — 25 provider adapters covering the mainstream 2026 tools; the ones
  with locally readable usage show real numbers, the others are listed honestly as
  *installed but no local usage* or *not installed* (9 / 5 / 11 on the development machine).
- **One-screen, tabbed layout** — a fixed header + KPI strip + tab bar with a single fill-height
  pane: **Overview / By agent / By model / By date / Sources**. Every list paginates to its
  measured pane height, so the page itself never scrolls; the panel is styled with DSH theme
  tokens (`--dsw-alias-*`, `--dsw-font-family`) and matches the Host's panel/tab/table patterns.
- **Three aggregations** — By agent, by model, by date, plus a daily stacked trend chart
  (input / output / cache read / cache write).
- **Token-type granularity** — uncached input, output, cache-read and cache-write are tracked
  separately, so a 95% cache hit rate does not hide the real consumption.
- **Effective vs cached** — by default the daily chart shows *effective* tokens
  (input + output + cache write); one click switches to the full stack including the cached reads
  that otherwise dominate a 95% cache-hit workload. Hovering a day shows the exact breakdown.
- **Estimated cost** — priced from a public price table (Claude, OpenAI/Codex, DeepSeek, Gemini,
  Grok, Qwen, GLM, Kimi, MiniMax, Devin SWE/Fable families, …); provider-reported costs win when
  the tool itself records them. Unpriced models are visible, never silently zeroed.
- **Filters** — time range (7/30/90 days/all), agent, model.
- **Cross-platform** — macOS and Windows 10/11 paths (`%APPDATA%`, `%LOCALAPPDATA%`,
  `%USERPROFILE%`, `XDG_DATA_HOME`, documented per-tool env overrides such as `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`, `OPENCODE_DATA_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `GROK_HOME`, …). Windows
  hardening (BOM/CRLF, SQLite lock retries, `USERPROFILE` precedence, IPv6-mapped loopback) is
  covered by a 45-check simulation — see [docs/windows.md](docs/windows.md). Real-Windows smoke
  test still pending.
- **Cheap refresh** — a per-file `size+mtime` fingerprint cache (SQLite fingerprints include
  `-wal`/`-shm`) means a refresh after the first one only re-parses changed files; the last
  snapshot is persisted, so a restart does not rescan. The Devin CLI database is read
  incrementally (only rows above the last processed `row_id`).
- **Off the Host thread** — every scan runs on a `worker_threads` worker, so synchronous SQLite
  reads of multi-GB stores never stall the DSH Host process (other plugins, agent sessions).

## Supported agents

Verified against real local data on the development machine (macOS):

| Agent | Local source | Status |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` (`CLAUDE_CONFIG_DIR`) | ✅ verified |
| Codex | `~/.codex/sessions/**`, `~/.codex/archived_sessions` (`CODEX_HOME`) | ✅ verified |
| DeepSeek Harness | `~/.dsh/sessions/**/session.v4.jsonl.zstd` (`DSH_HOME`) | ✅ verified |
| OpenCode | `~/.local/share/opencode/opencode.db` + legacy JSON (`OPENCODE_DATA_DIR`) | ✅ verified |
| Pi | `~/.pi/agent/sessions/**` (`PI_CODING_AGENT_DIR`) | ✅ verified |
| Grok Build | `~/.grok/**` (`GROK_HOME`) | ✅ verified |
| Antigravity | `~/.gemini/antigravity/conversations/*.db` (Protobuf generations) | ✅ verified |
| Zed | `~/Library/Application Support/Zed/threads/threads.db` | ✅ verified |
| Cursor | `state.vscdb` / `cursorDiskKV` composer token counts, CLI sessions | ◐ parser ready, local counters are usually stripped |
| Trae / Trae CN | agent DB is SQLCipher-encrypted on desktop | ◐ detected, not locally readable |
| Devin | Devin CLI `~/.local/share/devin/cli/sessions.db` (per-message metrics, dedup by message id) | ✅ verified (desktop app itself is still not locally readable) |
| Windsurf | `state.vscdb`, encrypted Cascade `.pb` | ◐ detected, not locally readable |
| Copilot CLI | `~/.copilot/session-state` | ◐ detected, no usage rows yet |
| CodeBuddy | `state.vscdb` + CLI JSONL | ◐ IDE only, no counters |
| Qoder / WorkBuddy / Cline·Roo·Kilo | VS Code fork `globalStorage`, `~/.workbuddy`, tasks | ○ parser ready, not installed |
| Gemini CLI, Amp, Goose, Crush, Aider, Qwen Code, Factory Droid, Continue | their documented local stores | ○ parser ready, not installed |

The dashboard's **Data sources** section lists every adapter with its exact data directory, file
count and status, so it is always clear which numbers are real and which tool has nothing readable
locally. No token numbers are ever invented: an agent without locally readable usage reports zero
cells plus a warning explaining why.

## How refresh works

```
sidebar entry (Agent 用量)
      │  click
      ▼
GET /api/dsh-agent-usage/snapshot   → last saved scan (no file reads)
      │  "刷新" button
      ▼
POST /api/dsh-agent-usage/scan      → walks local session files once, updates cache + snapshot
      ▼
dashboard re-renders (agent / model / date views)
```

On this machine the **first** scan takes ~24 s, almost all of it one full pass over the Devin CLI
database (3.8 GB). After that, a changed Devin database only costs reading its new rows (≈4 s for
~50k new rows, milliseconds for a normal day); a full pass happens again only when old rows were
removed (a deleted Devin session), and the Devin source note in the dashboard says which path
ran. A refresh where nothing changed takes **~50–300 ms**, because the fingerprint cache reuses
every parsed file and every SQL result. A changed session file is the only thing re-parsed. The
Devin resume state adds ~5 MB to `scan-cache.json`.

## Install

The bundle is a DSH profile bundle. From this repository:

```bash
# inside the DSH profile (or through the plugin manager):
dsh plugin add link:/path/to/dsh-agent-usage
# or via the Plugin Manager in the Web GUI: install bundle from a local directory
```

`cordis.patch.yml` inserts the single `agent-usage` Host row; `package.json` declares the Client
half (`dsh.client`) and the display resources (`icon`, `locale/*.json`).

After installing or updating host files, toggle the plugin row (or restart DSH) so the Host loads
the new module generation; after a `client.js` update, reload the Web page once. Then click
**Agent 用量 / Agent Usage** in the left sidebar.

## Data locations

- Snapshot: `<DSH_HOME|~/.dsh>/agent-usage/last-scan.json`
- Fingerprint cache: `<DSH_HOME|~/.dsh>/agent-usage/scan-cache.json`
- Override the directory: `DSH_AGENT_USAGE_DATA_DIR` (or a `dataDir` field in the plugin config)

## Project layout

```
dsh-agent-usage/
├── index.js                 Host plugin: loopback JSON routes, lazy snapshot, scan-on-refresh
├── client.js                Client plugin: sidebar entry + dashboard (plain React, no build step)
├── cordis.patch.yml         Bundle patch inserting the Host row
├── package.json             Bundle manifest (dsh.bundle + dsh.client + resources)
├── locale/{en,zh}.json      Plugin Manager title/description
├── icon.svg                 Original plugin icon
├── CONTRACT.md              Provider contract (Cell/Source/ScanContext, cache protocol)
├── docs/                    t3code reference, coverage matrix, Windows notes, provider research
└── host/
    ├── scanner.js           Orchestration, cost estimation, snapshot persistence
    ├── scan-worker.js       worker_threads entry: one scan off the Host thread
    ├── scan-utils.js        fs/JSONL/zstd/SQLite helpers
    ├── scan-cache.js        size+mtime fingerprint cache
    ├── cells.js             usage-bucket merge helpers
    ├── pricing.js           model price table (USD / 1M tokens)
    ├── context.js           ScanContext factory
    ├── providers/*.js       one adapter per agent tool
    └── tools/
        ├── windows-sim.mjs      Windows code-path simulation (45 checks, no real data touched)
        └── devin-incremental.mjs  Devin incremental == full-scan checks (11 checks, temp DB)
```

## Development

Node.js builtins only — no npm dependencies, no build step. Run a provider against real data with
the Node runtime bundled with DSH Desktop (same version the Host uses):

```bash
E="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 "$E" host/providers/self-test.mjs claude-code
ELECTRON_RUN_AS_NODE=1 "$E" host/providers/self-test.mjs --all
```

On Windows, use the `node` binary shipped with the DSH installation instead.

Adding an agent = adding one `host/providers/<id>.js` module exporting `meta` and `scan(ctx)`; the
registry discovers it automatically. See `CONTRACT.md`.

## Notes and limitations

- **Cursor / Trae / Windsurf / Devin** intentionally report no local tokens when the app keeps usage
  only server-side or encrypts it. Cursor's local `tokenCount` fields are usually zeroed in current
  builds; its account usage lives behind the Cursor API.
- **Antigravity** parses Google's Protobuf conversation metadata; the field map was inferred from
  several independent adapters and skips malformed rows rather than guessing.
- **Pi** integration fixtures record fake model ids (`a`, `b`); model ids are validated and such
  records are bucketed as `unknown`.
- Costs are **estimates** from public list prices, not subscription bills. Add rates in
  `host/pricing.js` (`PRICING_VERSION` bumps invalidate nothing but tells you which table produced
  a snapshot).
- The dashboard is loopback-only (`127.0.0.1`/`::1`); requests from other hosts are rejected.
