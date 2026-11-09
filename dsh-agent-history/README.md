# Agent History — DSH plugin

A left-sidebar **conversation browser** inside the DeepSeek Harness Web GUI that collects the
historical conversations of **every AI coding agent installed on this machine** and lets you read
them the way you actually worked: **open a project folder first**, then see that folder's agent
history as one timeline.

Everything is read from **local session stores**. Nothing is uploaded and no account login is
required. **Every time the panel is opened it shows the last saved scan immediately and then runs an
incremental refresh** (only changed files are re-parsed; at most one automatic refresh per 15 s).
There is no timer or file watcher while the panel is closed.

## Features

- **Project-first navigation** — nothing is open by default. **Open project** offers the native
  folder picker plus every folder the scan found conversations in. Only the folders you open are
  kept (saved in `<dataDir>/opened-projects.json`).
- **Recent-projects tab row** — one compact row under the header shows the opened projects as
  tabs (folder name + session count, the current one highlighted; missing folders are struck
  through). Clicking a tab only switches project and never reorders the row; a newly opened
  project is added at the front. Hovering a tab turns its count into **×** to remove that record
  after a confirmation (only the record, never files or conversations). **Browse by agent** sits at
  the left end, **＋** opens another project.
- **Full project list** — the **All / N more** button at the right end expands the complete list
  on hover (and pins it on click, or with ⌘O / Ctrl+O): search, arrow-key selection, Enter to
  open, remove, plus open project, browse by agent and clear history.
- **Sorting and filters** — both timelines default to newest first and can be flipped; the message
  timeline also filters by role (user / AI), by agent and by text (server-side, so counts and
  paging stay exact).
- **One timeline across agents** — sessions of every agent that worked in the same folder are
  ordered by start time. Sessions that overlap in time (your usual 4–5 agents developing in
  parallel) are grouped and marked **parallel**, so the order stays complete without turning into
  an unreadable interleaving.
- **Merged message timeline** — one switch merges every agent's messages of that folder into a
  single chronological stream, each row labelled with the agent and the session it came from.
- **Readable transcripts** — a session card expands into the real conversation (user prompts,
  assistant replies, tool calls folded behind a toggle), with the source file shown.
- **Continue the conversation** — one click resumes the conversation in its own agent:
  Claude Code, Codex, OpenCode, Pi, Grok Build and Devin open in a native terminal window in the
  session's original project folder; DeepSeek Harness sessions reopen inside this GUI. Agents
  without a local resume command still show the conversation and a copyable command.
- **Honest coverage** — agents that keep history server-side or encrypted are listed with their
  exact path and a reason instead of being hidden. No conversation is ever invented.
- **Cheap refresh** — a per-file `size+mtime` fingerprint cache means a refresh after the first one
  only re-parses changed files; the last snapshot is persisted, so a restart does not rescan. Inside
  the Devin database, only sessions whose rows changed re-read their previews.
- **Off the Host thread** — every scan runs on a `worker_threads` worker, so synchronous SQLite
  reads (Devin, Cursor, OpenCode, …) never stall the DSH Host process; single-session transcript
  reads stay on the Host thread because each is bounded (~16 ms for the largest Devin session).
- **Cross-platform** — macOS and Windows paths, BOM/CRLF tolerance, read-only SQLite, no external
  binaries.

## Supported agents

| Agent | Local source | History |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` (`CLAUDE_CONFIG_DIR`) | ✅ full transcript, `claude --resume <id>` |
| DeepSeek Harness | `~/.dsh/sessions/**/session.v*.jsonl.zstd` (`DSH_HOME`) | ✅ full transcript, reopens in this GUI |
| Codex | `~/.codex/sessions/**`, archived sessions (`CODEX_HOME`) | ✅ full transcript, `codex resume <id>` |
| OpenCode | `~/.local/share/opencode/*.db` | ✅ full transcript, `opencode --session <id>` |
| Pi | `~/.pi/agent/sessions/**` | ✅ full transcript, `pi --session <id>` |
| Grok Build | `~/.grok/sessions/**` (`GROK_HOME`) | ✅ full transcript, `grok --resume <id>` |
| Devin | `~/.local/share/devin/cli/sessions.db` | ✅ full transcript, `devin --resume <id>` |
| Antigravity | `~/.gemini/antigravity/conversations/*.db` + `brain/<id>/.system_generated/logs/transcript.jsonl` | ✅ full transcript, no local resume command |
| Zed | `~/Library/Application Support/Zed/threads/threads.db` | ✅ thread transcript where the payload is local |
| Cursor | `state.vscdb` composer data | ◐ parser ready, usually no readable history (not installed here) |
| Gemini CLI | `~/.gemini/tmp/**/chats/*.json` (`GEMINI_CLI_HOME`) | ✅ parser, fixture-verified (not installed here), `gemini --resume <id>` |
| Qwen Code | `~/.qwen/projects/**/chats/*.jsonl` | ✅ parser, fixture-verified |
| Cline / Roo / Kilo | VS Code `globalStorage/*/tasks/<id>/ui_messages.json` | ✅ parser, fixture-verified |
| Aider | `~/.aider.chat.history.md` | ✅ parser, fixture-verified |
| Goose | `~/.local/share/goose/sessions/sessions.db` | ✅ parser, fixture-verified |
| Copilot CLI / CodeBuddy | `~/.copilot/session-state`, `~/.codebuddy/projects` | ◐ parser ready, no transcripts on this machine |
| Crush / Amp / Factory Droid / Continue | their documented stores | ○ detection only, depends on install |
| Trae / Windsurf / Qoder / WorkBuddy | encrypted or remote stores | ○ detected, not locally readable |

The panel's agent list and project badges show exactly what was found, so it is always clear which
number is real and which tool has nothing readable locally.

## How it works

```
sidebar entry (Agent 历史)
      │  click
      ▼
GET /api/dsh-agent-history/snapshot → last snapshot (no file reads), shown immediately
      │  then automatically (and on "刷新")
      ▼
POST /api/dsh-agent-history/scan → walk local session stores once, update cache + snapshot
      ▼
project list  →  project timeline (sessions / merged messages)
      │  expand a session / load more messages
      ▼
GET /api/dsh-agent-history/session | /timeline  → lazy transcript reads
      │  "继续对话"
      ▼
POST /api/dsh-agent-history/launch → native terminal with the agent's resume command
```

The first scan reads the transcripts once (tens of seconds on a busy machine); every later refresh
only touches changed files (well under a second when nothing changed — measured 118 ms on a machine
with 2 200+ sessions in 9 agents). While a scan runs, the rest of DSH stays responsive (Host-thread
latency stayed under 2 ms during a 12 s cold scan).

The merged message timeline is bounded so one huge project cannot stall the panel: it reads the most
recently active sessions of that folder (120 by default) and shows the count it merged when the
folder has more. Every session's own timeline entry is always available.

## Install

The bundle is a DSH profile bundle:

```bash
# via the Plugin Manager in the Web GUI: install bundle from a local directory,
# or from this repository through the dsh CLI:
dsh plugin add link:/path/to/dsh-agent-history
```

`cordis.patch.yml` inserts the single `agent-history` Host row; `package.json` declares the Client
half (`dsh.client`) and the display resources (`icon`, `locale/*.json`). After installing or
updating host files, toggle the plugin row (or restart DSH) so the Host loads the new module
generation; after a `client.js` update, reload the Web page once.

## Data locations

- Snapshot: `<DSH_HOME|~/.dsh>/agent-history/last-scan.json`
- Fingerprint cache: `<DSH_HOME|~/.dsh>/agent-history/scan-cache.json`
- Override the directory: `DSH_AGENT_HISTORY_DATA_DIR` (or a `dataDir` field in the plugin config)

## Configuration

```yaml
- id: agent-history
  name: "@local/dsh-agent-history"
  config:
    dataDir: /Users/me/.dsh/agent-history
    terminalApp: auto          # macOS: 'auto' | 'Terminal' | 'iTerm' | ...; Windows: Windows Terminal when installed, 'conhost' forces cmd.exe
    commands:                  # optional per-agent resume command override
      claude-code: ['claude', '--resume', '{id}']
```

## Project layout

```
dsh-agent-history/
├── index.js                 Host plugin: loopback JSON routes, lazy snapshot, scan-on-refresh
├── client.js                Client plugin: sidebar entry + project-first browser
├── cordis.patch.yml         Bundle patch inserting the Host row
├── package.json             Bundle manifest (dsh.bundle + dsh.client + resources)
├── locale/{en,zh}.json      Plugin Manager title/description
├── icon.svg                 Original plugin icon
├── CONTRACT.md              Provider contract (SessionSummary, ScanContext, cache protocol)
└── host/
    ├── scanner.js           Orchestration, normalization, snapshot persistence
    ├── scan-worker.js       worker_threads entry: one scan off the Host thread
    ├── cache.js             size+mtime fingerprint cache
    ├── context.js           ScanContext factory
    ├── model.js             Normalization / project grouping / preview cleaning
    ├── transcript.js        Lazy transcript reads + merged project timeline
    ├── launch.js            Resume commands and native-terminal launching
    ├── scan-utils.js        fs/JSONL/zstd/SQLite helpers
    ├── fs-extra.js          Atomic write helpers
    ├── providers/index.js   Provider registry (drops in new provider files)
    ├── providers/*.js       One adapter per agent tool
    └── tools/
        ├── devin-incremental.mjs  Devin incremental == full-scan checks (15 checks, temp DB)
        └── cursor-transcript.mjs  Cursor transcript lookup is an index SEARCH, same rows/order (3 checks)
```

## Development

Node.js builtins only — no npm dependencies, no build step. Run a provider against real local data
with the Node runtime bundled with DSH Desktop:

```bash
E="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 "$E" host/providers/self-test.mjs claude-code
ELECTRON_RUN_AS_NODE=1 "$E" host/providers/self-test.mjs --all
ELECTRON_RUN_AS_NODE=1 "$E" host/providers/self-test.mjs --messages "claude-code:<nativeId>"
```

Adding an agent = adding one `host/providers/<id>.js` module exporting `meta`, `scan(ctx)` and
optionally `readMessages(ctx, session)`; the registry discovers it automatically. See `CONTRACT.md`.

## Notes and limitations

- **Cursor / Trae / Windsurf / Devin Desktop** intentionally report no history when the app keeps
  conversations only server-side or encrypts its local store. Devin is readable through its CLI
  database.
- **Antigravity / Zed** history is best-effort by nature of their private formats: Antigravity
  reads the generated transcript log first and falls back to protobuf metadata; Zed reads thread
  payloads that are stored locally.
- **Devin** scan counts are the cheap index-only aggregate over its multi-GB database (they include
  duplicated compaction/tool nodes); opening a session returns the exact deduplicated main chain.
- **Merged timeline scope** — the merged message view covers the most recent 120 sessions of a
  folder and states how many it merged; the per-session timeline always lists every session.
- Resume commands run in the session's recorded project folder. If a folder was moved or deleted,
  the terminal opens with an explicit error instead of running in the wrong place.
- The panel is loopback-only (`127.0.0.1`/`::1`); requests from other hosts are rejected.
