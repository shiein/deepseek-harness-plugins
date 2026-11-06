# Agent Usage provider contract

This package is a DeepSeek Harness (DSH) profile bundle. It scans **local session/usage files** of
other AI coding agents and renders a token-usage dashboard in the DSH Web UI.

Only Node.js builtins may be imported (`node:fs`, `node:path`, `node:os`, `node:zlib`,
`node:sqlite`, ...). No npm dependencies, no build step, no TypeScript. The Host runtime is
Node **24.21.0** (bundled with DSH Desktop), so `node:sqlite` and `node:zlib` zstd APIs are
available. Platform is macOS or Windows (`process.platform`).

Hard rule: **never scan on a timer, on module load, or on UI mount.** Scans run only when the user
presses Refresh (POST /api/dsh-agent-usage/scan) or the agent calls the `agent_usage` tool.

## Files

```
host/scan-utils.js      shared helpers (read-only; owned by the Lead)
host/scan-cache.js      per-file fingerprint cache (owned by the Lead)
host/pricing.js         model -> USD per 1M tokens price table (owner: pricing task)
host/scanner.js         provider orchestration (owned by the Lead)
host/providers/<id>.js  one provider per agent tool (owner: provider tasks)
host/providers/index.js provider registry (owned by the Lead)
```

Do not edit files outside your assigned scope. Ask the Lead for framework additions via a message.

## Provider module shape

`host/providers/<id>.js` is an ES module with this exact shape (named exports, no default):

```js
export const meta = {
  id: 'claude-code',        // stable kebab-case id; also the UI agent id
  name: 'Claude Code',      // human name
  color: '#d97757',         // brand-ish hex used by the UI chart
  homepage: 'https://...',  // optional
  cacheVersion: 1,          // bump when the parser output changes; invalidates cached cells
};

/**
 * @param {ScanContext} ctx
 * @returns {Promise<{ sources: Source[], cells: Cell[], warnings?: string[] }>}
 */
export async function scan(ctx) { ... }
```

A provider MUST NOT throw for "not installed" or unreadable data: return zero cells, an
`sources` entry with `exists: false`, and optionally a warning. Only genuinely unexpected errors
may throw; the framework records them per provider.

### ScanContext

```js
ctx.providerId              // string
ctx.signal                  // AbortSignal: check ctx.signal.aborted in long loops
ctx.env = {
  home,                     // process.env.HOME / USERPROFILE
  platform,                 // process.platform ('darwin' | 'win32' | ...)
  appData,                  // macOS: ~/Library/Application Support ; win: %APPDATA% ; linux: ~/.config
  localAppData,             // win: %LOCALAPPDATA% ('' elsewhere)
  xdgData,                  // ~/.local/share
  config,                   // plugin config object (open-ended; usually {})
}
ctx.utils                   // see below
ctx.cache = {
  get(filePath, fingerprint),          // -> Cell[] | undefined
  set(filePath, fingerprint, cells, state?), // store parsed result (+ optional JSON resume state)
  peek(filePath),                      // -> {fp, cells, state?} | undefined, ignores the fingerprint
}
ctx.warn(message)           // collect a warning (string) for this provider
```

### Source

```js
{
  label: 'Claude Code transcripts',     // short human label
  path: '/Users/me/.claude/projects',   // exact path (or 'macOS Keychain' etc.)
  exists: true,
  files: 42,                            // files parsed (0 when absent)
  bytes: 123456,                        // bytes read (optional; 0 ok)
  note: 'read from SQLite state.vscdb'  // optional, shown in the UI source list
}
```

### Cell

An aggregated usage bucket. Keep one cell per (model, day) — merge inside the provider; the
framework merges across providers too.

```js
{
  model: 'claude-sonnet-4-5',   // raw model id; use 'unknown' if genuinely unavailable
  day: '2026-11-04',            // LOCAL calendar day of the usage timestamp
  input: 1234,                  // uncached input tokens
  output: 567,                  // output tokens
  cacheRead: 0,                 // cache-read tokens (0 when not reported)
  cacheWrite: 0,                // cache-write tokens (0 when not reported)
  reasoning: 0,                 // optional reasoning tokens (already included in output when the
                                // source includes them in output; report only separate blocks)
  costUsd: undefined,           // ONLY when the source itself reports a cost, in USD
  messages: 1,                  // number of model responses/turns contributing to the cell
  firstTs: 1793682966922,       // epoch ms, optional
  lastTs: 1793682966922,        // epoch ms, optional
  tier: undefined,              // optional: 'fast' | 'standard' | ... when the source reports one
}
```

Rules:
- `day` must be the **local** calendar day: `utils.localDay(tsMs)`.
- Token counts are integers; use 0 when unknown. Never invent numbers from message text.
- If a tool records total/cached input in one number (e.g. OpenAI `input_tokens` includes
  cached), subtract to get uncached `input`, keep `cacheRead` separate.
- `costUsd`: if the source stores a cost (OpenCode, Pi, ...), pass it through. Do not estimate
  cost in the provider; `host/pricing.js` does that centrally.
- Missing/unparseable lines must be skipped silently; count a warning at most once per file kind.

## ctx.utils API (host/scan-utils.js)

```js
utils.homeDir()                       // string
utils.expandPath('~/foo')             // absolute path with ~ and ${ENV} expanded (use for config paths)
utils.join(...) utils.resolve(...)    // re-exported node:path helpers
utils.statSafe(path)                  // Promise<{size, mtimeMs, isFile, isDirectory}|null>
utils.readdirSafe(path)               // Promise<Dirent[]> ([] when absent)
utils.exists(path)                    // Promise<boolean>
utils.listFilesRecursive(root, opts)  // Promise<{path,size,mtimeMs}[]>
//   opts: { exts: ['.jsonl'], maxFiles = 20000, maxDepth = 12, signal }
utils.readJsonl(path, onLine, {startOffset=0, signal}) // stream lines; onLine(line, index)
utils.readText(path)                  // Promise<string|null>
utils.readBuffer(path)                // Promise<Buffer|null>
utils.endOfLastNewline(buffer)        // last '\n' index + 1 (for partial-tail handling)
utils.localDay(tsMs)                  // 'YYYY-MM-DD' in local time
utils.isZstd(buffer)                  // bool (magic 0x28 0xB5 0x2F 0xFD)
utils.zstdDecompressAll(buffer)       // Buffer; handles multi-frame (DSH session logs), throws on garbage
utils.openSqliteDatabase(path, {readOnly=true}) // Promise<DatabaseSync> from node:sqlite
utils.querySqlite(db, sql, params=[]) // all rows as plain objects
utils.safeJsonParse(line)             // object|null (never throws)
```

SQLite notes: open read-only, always `try/finally` `db.close()`. A live app may keep a WAL file;
read-only opening is fine for `state.vscdb`/`opencode.db` on macOS and Windows as long as the
parent directory is readable. Wrap in try/catch and degrade to a warning.

## Cache protocol (important)

Use `ctx.cache` for every file whose parse is expensive. Fingerprint = `size + mtimeMs` of the
underlying file(s) (for SQLite include `-wal` too, see example). When a fingerprint matches, the
cached `Cell[]` is reused without reading the file — this is what makes Refresh cheap.

Append-only stores too large to re-read on every change may resume instead: `peek` returns the
previous entry whatever its fingerprint, and the `state` saved with `set` carries what is needed
to read only the new part (see `providers/devin.js`: a `row_id` watermark plus per-message
state, with an exact removed-rows check that falls back to a full rebuild). `peek` is optional
in test harnesses, so guard it with `typeof cache.peek === 'function'`.

```js
const st = await utils.statSafe(file.path);
const fp = `${st.size}:${Math.round(st.mtimeMs)}`;
let cells = cache.get(file.path, fp);
if (!cells) {
  cells = [];
  await utils.readJsonl(file.path, (line) => { /* push merged cells */ });
  cache.set(file.path, fp, cells);
}
```

Cells stored in the cache must be frozen in meaning: bump `meta.cacheVersion` whenever the parse
logic or cell semantics change. Never store non-JSON values.

## Windows rules

Providers must run unchanged on Windows 10/11 (x64 and arm64). Follow these rules:

- Build every path with `utils.joinPath` / `node:path`; never hardcode `/`. Windows roots come from
  `env.home` (`USERPROFILE`), `env.appData` (`APPDATA`) and `env.localAppData` (`LOCALAPPDATA`).
- Always tolerate UTF-8 BOM and CRLF: use `utils.readJsonl`, `utils.readText` and
  `utils.safeJsonParse`, which strip them. Do not call `JSON.parse` on raw bytes.
- Open SQLite only through `utils.openSqliteDatabase` (read-only, transient `SQLITE_BUSY` retried);
  always `close()` in `finally`. Include `-wal` in the cache fingerprint but not the `-shm` mtime
  (a read-only open bumps it on this platform).
- No external binaries and no shell-outs (`zstd.exe`, `sqlite3.exe`, PowerShell): use `node:zlib`
  and `node:sqlite`.
- Keep per-file failures non-fatal: a locked or unreadable file is skipped with a warning.
- Verify with `host/tools/windows-sim.mjs`, which runs every provider under a simulated `win32`
  environment and asserts the Windows path roots and BOM/CRLF parsing.

## Testing

Run provider code directly with the bundled node (same runtime as DSH):

```bash
E="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 "$E" /path/to/dsh-agent-usage/host/providers/self-test.mjs cursor
```

`host/providers/self-test.mjs` (owned by the Lead) loads the provider, runs `scan` with a real
context and prints sources/cells summary. On Windows, use the DSH installation's node. Always run
your provider against this machine's real data before declaring done, and include the observed
output in your report.

## Coverage expectations (2026 market)

First-class (must work when data exists): Claude Code, Codex, DeepSeek Harness, OpenCode,
Cursor, Trae (CN/global), Qoder, WorkBuddy, Devin, Pi. Then Gemini CLI, GitHub Copilot CLI, Amp,
Goose, Crush, Aider, Cline/Roo/Kilo (VS Code globalStorage), Continue, Qwen Code, Grok Build,
Factory Droid, Antigravity, Windsurf, Zed, CodeBuddy.

If a tool stores no token usage locally (or stores it encrypted/only remotely), the provider must
report `sources` with a `note` explaining that, return no cells, and emit one warning — the UI
shows it under "Detected but unavailable". Never fabricate token counts.
