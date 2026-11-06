# Agent History provider contract

This package is a DeepSeek Harness (DSH) profile bundle. It scans the **local conversation stores**
of other AI coding agents and renders one multi-agent history browser in the DSH Web UI.

Only Node.js builtins may be imported (`node:fs`, `node:path`, `node:os`, `node:zlib`,
`node:sqlite`, ...). No npm dependencies, no build step, no TypeScript. The Host runtime is the
Node bundled with DSH Desktop (Node 24.21.0), so `node:sqlite` and the `node:zlib` zstd APIs are
available. Platform is macOS or Windows (`process.platform`).

Hard rules:

- **Never scan on a timer, on module load, or on UI mount.** Scans run only when the user presses
  Refresh (POST `/api/dsh-agent-history/scan`).
- **Never invent a conversation.** A session may only be reported when its transcript exists. If a
  tool keeps its history server-side or encrypted, report `sources` + one warning and no sessions.
- **Never throw for "not installed" / unreadable data.** Return zero sessions, a `sources` entry
  with `exists: false`, and optionally a warning. Only genuinely unexpected errors may throw.

## Files

```
host/providers/index.js       provider registry, loaded by the scanner (owned by the Lead)
host/providers/self-test.mjs  run one provider against real local data (owned by the Lead)
host/providers/<id>.js        one provider per agent tool
host/model.js                 normalization helpers (owned by the Lead)
host/scan-utils.js            shared helpers (owned by the Lead)
```

Do not edit files outside your assigned provider files. Ask the Lead for framework additions.

## Provider module shape

`host/providers/<id>.js` is an ES module with named exports:

```js
export const meta = {
  id: 'claude-code',            // stable kebab-case id, also the UI agent id
  name: 'Claude Code',          // human name
  color: '#d97757',             // brand-ish hex used by the UI badge
  homepage: 'https://...',      // optional
  cacheVersion: 1,              // bump when the parser output changes; invalidates cached rows
  resume: { kind: 'cli', command: 'claude', args: ['--resume', '{id}'] },
  // resume.kind: 'cli' | 'dsh' | 'none'. 'cli' spawns a native terminal in the project folder;
  // '{id}' is replaced with the session's nativeId, '{cwd}' with its project path.
  // 'dsh' means "a DeepSeek Harness session, resumed in this GUI by the Client half".
};

/** @param {ScanContext} ctx */
export async function scan(ctx) { /* -> { sources, sessions } */ }

/**
 * Optional. Read one session's transcript for the detail view. Only called when the user opens a
 * session or a project timeline, never during `scan`.
 * @param {ScanContext} ctx
 * @param {SessionSummary} session
 * @returns {Promise<{messages: TranscriptMessage[]}>}
 */
export async function readMessages(ctx, session) { ... }
```

A provider that cannot resume its agent still sets `resume: { kind: 'none' }` (or omits it) and the
UI hides the launch button but keeps the transcript.

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
  get(filePath, fingerprint),          // -> session rows | undefined
  set(filePath, fingerprint, rows),    // store this provider's rows for that file
}
ctx.warn(message)           // collect a warning (string) for this provider
```

### Source

```js
{
  label: 'Claude Code transcripts',   // short human label
  path: '/Users/me/.claude/projects', // exact path (or a description)
  exists: true,
  files: 42,                          // files/SQLite rows considered readable
  bytes: 123456,                      // bytes read (optional; 0 ok)
  note: 'one JSONL transcript per session', // optional, shown in the Sources view
}
```

### SessionSummary

`scan` returns an array of these (raw shape: the framework normalizes it, see `finalizeSession`):

```js
{
  nativeId: '0aa33e43-……',     // REQUIRED. Agent-native session id used by the resume command.
  title: '重构地址匹配服务',    // human title; fall back to the first prompt
  projectPath: '/abs/folder',  // absolute cwd/project folder ('' when the agent records none)
  startedAt: 1793682966922,    // epoch ms of the first message
  updatedAt: 1793682966922,    // epoch ms of the last activity
  messages: 42,                // user + assistant text messages
  userMessages: 12,            // user prompts
  sizeBytes: 123456,           // transcript size (approx.)
  preview: '……',               // first prompt preview (plain text, ~220 chars)
  lastPreview: '……',           // last message preview
  sourcePath: '/abs/file',     // file/database path (display only)
  extra: '',                   // optional short note (model, git branch, ...)
  ref: { file: '/abs/file' },  // REQUIRED. Provider-private JSON locator for readMessages.
}
```

Rules:

- `nativeId` must be stable across scans and unique within one agent.
- `projectPath` must be the **real** folder (usually the transcript's recorded `cwd`), because the
  UI merges different agents that worked in the same folder into one project timeline. Use `''`
  only when the agent truly records no folder.
- Use `startedAt`/`updatedAt` from message timestamps, not file mtime, when available.
- Skip sessions with no user/assistant content (empty files, metadata-only shells).
- Skip the agent's own injected context (system reminders, AGENTS.md blocks, bootstrap prompts)
  when choosing `preview`/`title`; prefer the first real user prompt.
- `ref` is opaque to the framework; keep it small (paths/ids only, no message bodies).

### TranscriptMessage

```js
{ role: 'user'|'assistant'|'tool'|'system', ts: 1793682966922, text: '……',
  kind: 'tool-call'|'tool-result'|'thinking'|undefined, name: 'Bash'|'claude-sonnet-4-5'|undefined }
```

`readMessages` should return the readable conversation: user prompts, assistant text, tool calls
(truncated names/arguments), tool results (short, truncated), model reasoning is optional. Cap the
result at ~4000 messages and each text at ~8000 characters; the UI renders tool traffic collapsed.

## ctx.utils API (host/scan-utils.js)

```js
utils.homeDir()                       // string
utils.expandPath('~/foo')             // absolute path with ~ and ${ENV} expanded
utils.join(...) utils.resolve(...)    // node:path helpers
utils.statSafe(path)                  // Promise<{size, mtimeMs, isFile, isDirectory}|null>
utils.readdirSafe(path)               // Promise<Dirent[]> ([] when absent)
utils.exists(path)                    // Promise<boolean>
utils.listFilesRecursive(root, opts)  // Promise<{path,size,mtimeMs}[]>
//   opts: { exts: ['.jsonl'], maxFiles = 20000, maxDepth = 12, signal }
utils.readJsonl(path, onLine, {startOffset=0, signal}) // stream lines; onLine(line, index)
utils.readText(path)                  // Promise<string|null> (BOM stripped)
utils.readBuffer(path)                // Promise<Buffer|null>
utils.safeJsonParse(line)             // object|null (never throws)
utils.isZstd(buffer) / utils.zstdDecompressAll(buffer) // DSH-style multi-frame zstd logs
utils.openSqliteDatabase(path, {readOnly=true}) // Promise<DatabaseSync> from node:sqlite
utils.querySqlite(db, sql, params=[]) // all rows as plain objects
utils.localDay(tsMs)                  // 'YYYY-MM-DD' in local time
utils.basenameOf(path) / utils.normalizeSlashes(path)
```

## Cache protocol (important)

Use `ctx.cache` for every file whose parse is expensive. Fingerprint = `size + mtimeMs` of the
underlying file(s) (for SQLite include `-wal`). When a fingerprint matches, the cached rows are
reused without reading the file — this is what makes Refresh cheap after the first scan.

```js
const st = await utils.statSafe(file.path);
const fp = `${st.size}:${Math.round(st.mtimeMs)}`;
let rows = cache.get(file.path, fp);
if (!rows) {
  rows = [ /* parsed session summaries for this file */ ];
  cache.set(file.path, fp, rows);
}
```

Bump `meta.cacheVersion` whenever the parse logic or row semantics change.

## Windows rules

Providers must run unchanged on Windows 10/11. Build every path with `node:path`; Windows roots
come from `env.home`, `env.appData`, `env.localAppData`. Tolerate UTF-8 BOM and CRLF via the shared
helpers. Open SQLite only through `utils.openSqliteDatabase` (read-only, retries `SQLITE_BUSY`) and
always `close()` in `finally`. No external binaries and no shell-outs (`sqlite3.exe`, `zstd.exe`).
Keep per-file failures non-fatal (skip + one warning).

## Testing

Run a provider against this machine's real data with the Node runtime bundled with DSH Desktop:

```bash
E="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 "$E" host/providers/self-test.mjs <provider-id>
ELECTRON_RUN_AS_NODE=1 "$E" host/providers/self-test.mjs --all
```

The self-test prints sources, session count, the newest sessions and a transcript sample, and
`--messages <agentId>:<nativeId>` reads one transcript. Always run your provider on real data
before reporting done, and include the observed output.
