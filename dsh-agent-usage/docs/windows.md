# Windows support

The plugin targets **Windows 10/11 (x64 and arm64)** alongside macOS. DSH Desktop for Windows ships
the same Node 24 runtime (`runtime/bin/node`), so `node:sqlite` and `node:zlib` zstd APIs are
available there — the plugin has **no native dependencies, no shell-outs, and no build step**.

> Verification status: the code paths are audited and exercised by
> `host/tools/windows-sim.mjs` (45 checks, including every provider running under
> `env.platform = 'win32'` with `%APPDATA%`/`%LOCALAPPDATA%` roots, BOM + CRLF files, multi-frame
> zstd logs and SQLite fixtures). It has **not yet been run on a physical Windows machine**.

## Data locations used on Windows

| Agent | Windows source |
| --- | --- |
| Claude Code | `%USERPROFILE%\.claude\projects\**\*.jsonl` (`CLAUDE_CONFIG_DIR` override) |
| Codex | `%USERPROFILE%\.codex\sessions\**`, `%USERPROFILE%\.codex\archived_sessions` (`CODEX_HOME`) |
| DeepSeek Harness | `%USERPROFILE%\.dsh\sessions\**\session.v4.jsonl.zstd` (`DSH_HOME`) |
| OpenCode | `%LOCALAPPDATA%\opencode\opencode.db`, `%APPDATA%\opencode`, `%USERPROFILE%\.local\share\opencode` (`OPENCODE_DATA_DIR`) |
| Cursor | `%APPDATA%\Cursor\User\globalStorage\state.vscdb`, `%USERPROFILE%\.cursor` |
| Trae / Trae CN | `%APPDATA%\Trae\User\...`, `%APPDATA%\Trae CN\ModularData\ai-agent\database.db` (SQLCipher-encrypted) |
| Qoder | `%APPDATA%\Qoder\SharedClientCache\cache\db\local.db` |
| WorkBuddy | `%USERPROFILE%\.workbuddy` (`WORKBUDDY_HOME`) |
| Devin | CLI: `%APPDATA%\devin\cli\sessions.db`, `%LOCALAPPDATA%\devin\cli\sessions.db` · Desktop: `%APPDATA%\devin` (no local counters) |
| Pi | `%USERPROFILE%\.pi\agent\sessions` (`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`) |
| Gemini CLI | `%USERPROFILE%\.gemini\tmp\**` (`GEMINI_DIR`) |
| Copilot CLI | `%USERPROFILE%\.copilot\session-state` |
| Amp | `%LOCALAPPDATA%\amp`, `%USERPROFILE%\.amp` |
| Goose | `%APPDATA%\Block\goose\sessions\sessions.db`, `%LOCALAPPDATA%\Block\goose\...` |
| Crush | `%LOCALAPPDATA%\crush\projects.json`, `%LOCALAPPDATA%\crush\**` |
| Aider | `%USERPROFILE%\.aider\analytics`, `%USERPROFILE%\.aider.chat.history.md` |
| Cline / Roo / Kilo | `%APPDATA%\<IDE>\User\globalStorage\<extension-id>\tasks\**` for Code, Code - Insiders, Cursor, Windsurf, Trae, Qoder, CodeBuddy, VSCodium, Devin |
| Continue | `%USERPROFILE%\.continue\sessions` |
| Qwen Code | `%USERPROFILE%\.qwen\projects`, `%USERPROFILE%\.qwen\tmp` |
| Grok Build | `%USERPROFILE%\.grok\**` (`GROK_HOME`) |
| Factory Droid | `%USERPROFILE%\.factory` |
| Antigravity | `%USERPROFILE%\.gemini\{antigravity,antigravity-ide,antigravity-cli,antigravity-acp,antigravity-backup}\conversations\*.db` |
| Windsurf | `%APPDATA%\Windsurf\User\...`, `%USERPROFILE%\.windsurf` |
| Zed | `%LOCALAPPDATA%\Zed\threads\threads.db`, `%USERPROFILE%\.zed` |
| CodeBuddy / CodeBuddy CN | `%APPDATA%\CodeBuddy*\User\globalStorage\state.vscdb` |

Plugin data (snapshot + fingerprint cache) lives in `%USERPROFILE%\.dsh\agent-usage\` by default;
override it with `DSH_AGENT_USAGE_DATA_DIR`.

## Windows-specific hardening in the code

1. **`USERPROFILE` wins over `HOME`.** Git Bash and some launchers export a Cygwin-style `HOME`;
   using it would look in the wrong directory. macOS/Linux keep `HOME` precedence.
2. **UTF-8 BOM and CRLF tolerated.** Windows editors and PowerShell write BOMs / CRLF; `readText`,
   `readJsonl` and `safeJsonParse` strip them before JSON parsing.
3. **SQLite locks and disk pressure are retried, then survived.** `state.vscdb` / `sessions.db` can
   be held by a running app, and another app can briefly fill the disk while it rewrites its own
   store; read-only connections wait on a 5 s busy timeout and retry `SQLITE_BUSY`/`SQLITE_LOCKED`/
   `SQLITE_FULL` opens. If a provider read still fails, the dashboard keeps that provider's last
   successful numbers and labels them cached data (status `stale`) instead of dropping the agent,
   with the error shown in the source list.
4. **Quoted / `~\` config paths.** `expandPath` strips surrounding quotes and expands
   `%APPDATA%`, `${ENV}`, `~` and `~\` (Windows users paste quoted paths).
5. **Path building only through `node:path`.** No hardcoded `/`; `%APPDATA%`, `%LOCALAPPDATA%` and
   `%USERPROFILE%` come from `env.appData` / `env.localAppData` / `env.home`.
6. **No external binaries.** zstd and SQLite are read through Node builtins (`node:zlib`,
   `node:sqlite`), so no `zstd.exe`/`sqlite3.exe` is required on Windows.
7. **Atomic snapshot/cache writes** (temp file + `rename`, which replaces on Windows too).
8. **Loopback fence accepts Windows IPv6-mapped loopback** (`::ffff:127.0.0.1`, `::1`) and
   `localhost` Host headers, so the dashboard API works from the WebView2/Electron page.
9. **Case-insensitive file extensions** (`.JSONL` etc.) and case-insensitive VS Code globalStorage
   extension folder matching.
10. **WAL sidecars** are part of the SQLite fingerprint; the `-shm` mtime is excluded because a
    read-only open bumps it and would defeat the cache.
11. **No SQLite `localtime` modifier.** Day bucketing happens in JS (`utils.localDay`) after
    reading UTC timestamps, because Windows SQLite builds may omit the `localtime` modifier
    (`SQLITE_OMIT_LOCALTIME`); this also keeps day boundaries correct across time zones.

## Verification

Run the simulation from the plugin directory (works on any OS, no real agent data touched):

```bash
# macOS
E="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 "$E" host/tools/windows-sim.mjs

# Windows (from a shell where DSH Desktop is installed; adjust the exe path)
set ELECTRON_RUN_AS_NODE=1
set DSH_DESKTOP_NODE_EXECUTABLE=C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe
"%DSH_DESKTOP_NODE_EXECUTABLE%" host\tools\windows-sim.mjs
```

Expected: `45/45 checks passed`.

A real Windows smoke test (if you have a Windows box) is:

1. Install the bundle, reload the page, open **Agent 用量 → 数据来源**.
2. Confirm the expected paths above appear as `已读取`; run a refresh and compare totals with the
   CLI tools if available.
3. Report any path that shows `未安装` even though the app is installed — that means a path
   candidate is missing and should be added to that provider.

## Known limitations (Windows and macOS alike)

- **Trae** agent databases are SQLCipher-encrypted; the provider reports detected-but-unavailable.
- **Cursor / Windsurf / Devin Desktop** keep usage server-side or encrypted; only their local
  counters are read, and they are usually zeroed. Devin **CLI** is fully readable.
- **Antigravity** parses Google Protobuf conversation metadata; the field map is inferred and
  malformed rows are skipped.
- Long paths (> 260 characters) may fail without Windows `LongPathsEnabled`; the affected file is
  skipped with a warning rather than failing the scan.
- Antivirus/backup tools can briefly lock session files; unreadable files are skipped and reported
  in the per-provider warnings.
