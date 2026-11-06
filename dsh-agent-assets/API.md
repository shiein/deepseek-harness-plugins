# Agent Assets — Host API contract

This document is the single source of truth for the Host half (`index.js` + `host/*.js`) and the
Client half (`client.js`). Do not change a field name or semantics here without messaging the Lead;
the other half is written against it.

## Mount and identity

- Bundle package: `@local/dsh-agent-assets`
- Host row id: `agent-assets` (inserted by `cordis.patch.yml`)
- Host module: `index.js` → named exports `name`, `inject = ['webServer']`, `apply(ctx)`
- Client module: `client.js` → `window.__ModuleLoader__.load({ id: '@local/dsh-agent-assets', factory })`
- Client registers `sidebar.panellist` id `agent-assets` (order 30) and `main` key `agent-assets`.
- All Host routes live under `/api/dsh-agent-assets/` and are **loopback-only** (a `127.0.0.1`/`::1`
  socket, an exactly spelled loopback `Host` authority (`127.x.x.x` / `localhost` / `[::1]`), no
  `sec-fetch-site: cross-site`, and no foreign `Origin`/`Referer`). Anything else → HTTP 403.

## Conventions

- JSON request and response (`content-type: application/json; charset=utf-8`, `cache-control: no-store`).
- Success: HTTP 200 + `{ "ok": true, ...payload }`.
- Failure: HTTP 4xx/5xx + `{ "ok": false, "error": { "code": string, "message": string } }`.
  - `code`: `bad_request` (400), `not_found` (404), `conflict` (409), `forbidden` (403), `internal` (500).
  - Two gateway-status exceptions keep the same `bad_request` code: a wrong HTTP method returns
    **405**, and a request body over 4 MiB returns **413**. Both still carry the failure envelope.
  - `message`: short human-readable English diagnostic; the Client renders its own localized text and
    shows `message` only as detail.
- `scope` is always one of `"user" | "workspace" | "bundled"`. `bundled` is read-only; CRUD on it is
  rejected with `bad_request`.
- `workspace` is an absolute directory path sent as a query/body field. When omitted the Host uses the
  process default working directory. The Host validates it against the live workspace registry (and
  the default directory); an unregistered path → `bad_request`.
- Homes: `dshHome = $DSH_HOME || ~/.dsh`, `agentsHome = $DSH_AGENTS_HOME || ~/.agents`,
  `claudeHome = $DSH_CLAUDE_HOME || ~/.claude`,
  `windsurfHome = $DSH_WINDSURF_HOME || ~/.codeium/windsurf`,
  `devinHome = $DSH_DEVIN_HOME || ~/.devin`. The last three are third-party agent
  directories: assets found under them are listed read-only.
- Timestamps are ISO-8601 strings. Byte sizes are integers.

## GET /health

No parameters. Diagnostics only.

```json
{ "ok": true, "plugin": "@local/dsh-agent-assets", "version": "0.1.0",
  "homes": { "dshHome": "/Users/x/.dsh", "agentsHome": "/Users/x/.agents",
    "claudeHome": "/Users/x/.claude", "windsurfHome": "/Users/x/.codeium/windsurf",
    "devinHome": "/Users/x/.devin" },
  "workspace": "/abs/default/workspace",
  "mcp": { "moduleLoaded": true, "moduleError": null, "mounted": ["serverA"], "skippedAgents": 0 } }
```

## GET /bootstrap?workspace=

```json
{ "ok": true, "version": "0.1.0",
  "defaultWorkspace": "/abs/dir",
  "workspaces": [ { "id": "w1", "title": "dsh", "path": "/abs/dir" } ],
  "homes": { "dshHome": "/Users/x/.dsh", "agentsHome": "/Users/x/.agents",
    "claudeHome": "/Users/x/.claude", "windsurfHome": "/Users/x/.codeium/windsurf",
    "devinHome": "/Users/x/.devin" },
  "supports": { "skills": true, "instructions": true, "mcp": true } }
```

## Skills

### GET /skills?workspace=

```json
{ "ok": true, "counts": { "user": 2, "workspace": 1, "bundled": 26 },
  "skills": [ SkillView ], "warnings": [ "string" ] }
```

`SkillView`:

```json
{ "name": "location-map",
  "description": "区位图 / 区位分析图设计。…",
  "whenToUse": null,
  "scope": "workspace",
  "source": "project-dsh",
  "provider": "filesystem",
  "path": "/abs/ws/.dsh/skills/location-map/SKILL.md",
  "dir": "/abs/ws/.dsh/skills/location-map",
  "editable": true,
  "shadowed": [ { "scope": "user", "path": "/Users/x/.dsh/skills/location-map/SKILL.md" } ] }
```

- `source` mirrors the Harness skill source vocabulary: `user-dsh`, `user-agents`, `project-dsh`,
  `project-agents`, `bundled`, `runtime`, `custom`, or another provider string. Third-party agent
  directories use `user-claude`, `user-windsurf`, `user-devin`.
- Precedence for a duplicate `name` (winner shown, losers in `shadowed`):
  `project-dsh` > `project-agents` > `user-dsh` > `user-agents` >
  `user-claude`/`user-windsurf`/`user-devin` > `bundled`/`runtime`/`custom`.
- `bundled`/`runtime`/`custom` entries come from the live `skills` service and have
  `editable: false`, `path: null`, `dir: null`.
- `user-claude`/`user-windsurf`/`user-devin` entries are real filesystem rows but read-only
  (`editable: false`): `update`/`delete` on them answers `forbidden`. Creating the same `name` in a
  writable root is allowed — the writable copy shadows the third-party one.
- A filesystem skill with an unreadable/invalid `SKILL.md` still lists (name from the directory) and
  the reason goes into `warnings`; it never aborts the whole list.
- `editable` is true exactly for entries under the writable `user`/`workspace` roots.

### GET /skill?scope=&name=&workspace=

```json
{ "ok": true, "skill": { ...SkillView, "body": "markdown body…", "raw": "full SKILL.md…" } }
```

Missing skill → 404 `not_found`.

### POST /skill

Body: `{ "op": "create" | "update" | "delete", "scope": "user" | "workspace",
"workspace": "/abs/dir" (required for scope=workspace), "name": "kebab-name",
"description": "one line", "whenToUse": "optional one line" | null, "body": "markdown" }`

- `create`: 409 `conflict` when a skill with that name already exists in that scope's writable roots.
- `update`: rewrites the existing `SKILL.md`; `description` is still required (it identifies the
  visible contract of the row), `whenToUse` and `body` are replaced when supplied, and unknown
  frontmatter keys are preserved verbatim. 404 when absent.
- `delete`: removes the whole skill directory (`<root>/<name>/`) recursively; 404 when absent.
- Validation: `name` matches `^[a-z0-9][a-z0-9-]{0,63}$`; `description` non-empty, single line,
  ≤ 1024 chars; `body` is a string (may be empty); `whenToUse` optional single line.
- Response: `{ "ok": true, "skill": SkillView }` for create/update,
  `{ "ok": true, "deleted": true, "name": "…", "scope": "…" }` for delete.
- Writes are atomic (temp file + rename) and the parent directory is created for `create`.

### POST /skills/import

Body: `{ "scope": "user" | "workspace", "workspace": "/abs" (scope=workspace), "source": "/abs | ~/path",
"dryRun": true | false, "names": ["kebab-name", …] (optional), "overwrite": false, "target": "dsh" | "agents" }`

- `source` is a skill folder (contains `SKILL.md`), a folder of skills, a repository with
  `skills/<name>/` (searched up to 3 levels), a `SKILL.md` file, or a `.zip` / `.skill` archive
  (unpacked with the platform `tar`, i.e. bsdtar on macOS / Windows 10+).
- `dryRun: true` → `{ source, kind: "dir"|"file"|"archive", target, candidates: [{ name, description, files,
  bytes, symlinks, source, warning, error, conflict: { path } | null }] }`. Nothing is written.
- Otherwise imports `names` (or every valid candidate) → `{ imported: [{ name, path, replaced }],
  skipped: [{ name, reason }], target }`. Same-name skills in the scope are skipped unless
  `overwrite: true`, which replaces the existing folder in the root where it lives.
- Safety: kebab-case names only; symlinks, `node_modules`, `.git` are never copied; a package over
  5000 files / 100 MB is refused; copies are staged in a hidden sibling directory and renamed into
  place (an existing skill is swapped out only after the new copy is complete).

## Agent prompts (instruction files)

### GET /instructions?workspace=

```json
{ "ok": true, "files": [ InstructionView ], "warnings": [] }
```

`InstructionView`:

```json
{ "id": "workspace|/abs/ws/AGENTS.md",
  "scope": "workspace",
  "file": "AGENTS.md",
  "label": "AGENTS.md",
  "path": "/abs/ws/AGENTS.md",
  "displayPath": "./AGENTS.md",
  "exists": true,
  "editable": true,
  "size": 1234,
  "modifiedAt": "2026-11-04T03:00:00.000Z" }
```

Fixed candidates:

- user scope: `<dshHome>/AGENTS.md` (`label` `~/.dsh/AGENTS.md`),
  `<agentsHome>/AGENTS.md` (`~/.agents/AGENTS.md`)
- user scope, third-party (listed only when the file already exists; `editable: false`,
  `write`/`delete` → `forbidden`): `<claudeHome>/CLAUDE.md`,
  `<windsurfHome>/memories/global_rules.md`, `<devinHome>/AGENTS.md`
- workspace scope: `<workspace>/AGENTS.md`, `<workspace>/CLAUDE.md`,
  `<workspace>/AGENTS.local.md`, `<workspace>/CLAUDE.local.md`
- Nested `AGENTS.md` / `CLAUDE.md` files that already exist in subdirectories of the workspace
  (depth ≤ 2, skipping `node_modules`, `.git`, `dist`, `build`, `.next`, `target`, `vendor`), with
  `label` = workspace-relative path, `editable: true`.
- Order: user candidates, workspace candidates, nested candidates sorted by path.
- `qualified` is not a field: the Client shows `label` and `displayPath`.

### GET /instruction?scope=&path=&workspace=

`path` must be one of the enumerated candidates (validated, symlink-escape rejected). Response
`{ "ok": true, "instruction": { ...InstructionView, "content": "…" } }`; a missing file returns
`content: ""` and `exists: false` (it is still a valid create target), never 404.

### POST /instruction

Body: `{ "op": "write" | "delete", "scope": "user" | "workspace", "workspace": "/abs",
"path": "/abs/file", "content": "…" }`

- `write` creates parent directories and replaces the file atomically; response
  `{ "ok": true, "instruction": { ...InstructionView, "content": "…" } }`.
- `delete` removes the file (404 when absent) and returns `{ "ok": true, "deleted": true }`.
- Read-only third-party candidates reject `write`/`delete` with `forbidden`.
- Directories outside the two candidate sets are rejected (`forbidden`).

## MCP servers

Managed MCP servers are stored in plugin-owned scope stores and mounted live through the Harness MCP
client plugin:

- user store: `<dshHome>/agent-assets/mcp.json`
- workspace store: `<workspace>/.dsh/agent-assets/mcp.json`

Store format: `{ "version": 1, "servers": [ McpStored ] }` (the file itself is the contract between
restarts and is `0600`).

`McpStored`:

```json
{ "serverName": "files", "scope": "user", "transport": "stdio",
  "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  "cwd": "", "env": { "TOKEN": "…" },
  "toolCallTimeoutMs": null, "enabled": true,
  "createdAt": "…", "updatedAt": "…" }
```

Streamable HTTP variant: `{ "transport": "streamable-http", "url": "https://…", "headers": { "Authorization": "…" } }`.
Validation: `serverName` matches `^[A-Za-z0-9_-]{1,32}$` and is unique inside a scope; stdio requires
`command`; http requires an absolute `http(s)` `url`; `args` is an array of strings; `env`/`headers`
are string→string maps.

### GET /mcp?workspace=

```json
{ "ok": true,
  "servers": [ McpServerView ],
  "external": [ { "entryId": "…", "moduleName": "@deepseek-ai/dsh-mcp-client",
                  "serverName": "…", "transport": "stdio", "summary": "npx …",
                  "configurable": false } ],
  "warnings": [] }
```

`McpServerView`:

```json
{ "serverName": "files", "scope": "user", "transport": "stdio",
  "summary": "npx -y @modelcontextprotocol/server-filesystem /tmp",
  "enabled": true,
  "status": { "state": "connected", "tools": 14, "error": null },
  "createdAt": "…", "updatedAt": "…" }
```

`status.state` is one of `connected` (user-scope mounts report live tool count), `connecting`,
`disabled`, `error`, `session-scoped` (workspace-scope servers mount inside each matching Session, so
they have no process-wide status). `env`/`headers` values are never included in list responses.
`external` lists MCP client rows already declared by installed bundles (read-only, for honesty —
`configurable: false`).

### GET /mcp/detail?scope=&serverName=&workspace=

Full stored config including `env`/`headers` values plus `status`:
`{ "ok": true, "server": { ...McpStored, "summary": "…", "status": {...} } }`.
Missing → 404.

### POST /mcp

Body: `{ "op": "create" | "update" | "delete" | "toggle", "scope": "user" | "workspace",
"workspace": "/abs", "server": McpStored, "enabled": true | false }`

- `create`/`update`/`delete`/`toggle` mutate the scope store and immediately remount user-scope
  servers; workspace-scope changes apply to new Sessions (existing Sessions keep their mount until
  disposal). Response: `{ "ok": true, "servers": [ ...McpServerView for that scope ] }`.
- Failure to connect is not a request failure: the row is stored (or kept) and `status.state`
  becomes `error` with a message; only validation/store failures return 4xx/5xx.

## Host module interfaces (internal)

`host/skills.js`:

```js
export function createSkills({ homes, serviceSkills })
// homes: { dshHome, agentsHome, claudeHome, windsurfHome, devinHome }
// serviceSkills: async ({ workspace }) => readonly ServiceSkill[] | null
//   ServiceSkill: { name, description, whenToUse?, source, provider }
// returns {
//   list({ workspace })            -> { skills, counts: { user, workspace, bundled }, warnings }
//   read({ scope, workspace, name })-> { skill }            (throws AssetsError)
//   create({ scope, workspace, name, description, whenToUse, body }) -> { skill }
//   update({ scope, workspace, name, description, whenToUse, body }) -> { skill }
//   remove({ scope, workspace, name }) -> { deleted: true, name, scope }
// }
```

`host/instructions.js`:

```js
export function createInstructions({ homes })
// homes: { dshHome, agentsHome, claudeHome, windsurfHome, devinHome }
// returns {
//   list({ workspace }) -> { files, warnings }
//   read({ scope, workspace, path })  -> { instruction }
//   write({ scope, workspace, path, content }) -> { instruction }
//   remove({ scope, workspace, path }) -> { deleted: true }
// }
```

`host/mcp.js`:

```js
export function createMcp({ ctx, homes, loadClientPlugin })
// loadClientPlugin: async () => namespace object of @deepseek-ai/dsh-mcp-client
// returns {
//   list({ workspace })            -> { servers, external, warnings }
//   detail({ scope, workspace, serverName }) -> { server }
//   apply({ op, scope, workspace, server, enabled }) -> { servers }
//   attachAgent(agent)             -> void   (called from agent/created; mounts workspace-scope servers on agent.ctx)
//   dispose()                      -> Promise<void>
// }
```

`host/shared.js` (Lead-owned; do not rewrite, ask for additions):

`AssetsError`, `fail(code, message, status)`, `resolveHomes()`, `displayPath(abs)`, `isInside(parent, child)`,
`assertScope(scope)`, `assertSkillName(name)`, `parseSkillFile(raw)`, `renderSkillFile({ data, extraLines, body })`,
`readTextIfExists(abs)`, `writeTextAtomic(abs, text, mode?)`, `removeTree(abs)`, `listDirSafe(abs)`,
`ensureDir(abs)`, `pathKey(abs)`, `ENVELOPE_HEADERS`.
