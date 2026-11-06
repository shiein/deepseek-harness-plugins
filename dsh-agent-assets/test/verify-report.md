# Agent Assets — independent QA verification report

- **Bundle:** `plugins/dsh-agent-assets` (`@local/dsh-agent-assets` v0.1.0)
- **Task:** task-4 — independent review + live API/slot verification
- **Verifier:** `qa-verify` (independent reviewer; did not author or install the bundle)
- **Verified against:** running DSH Web GUI `http://127.0.0.1:49536` (Host process PID 73927, started
  2026-11-04 11:16:20; bundle installed/live-activated at ~13:10 **without a restart**)
- **Verification time:** 2026-11-04 13:10–13:20 (pre-fix live generation) and 13:33–13:40
  (post-fix reinstall, final)
- **Verdict:** **PASS** — 0 blocking defects. **Post-fix reinstall:** read-only suite 30 passed /
  0 failed / 1 warning (real machine skill data) / 1 skipped; `--write` suite 48 passed / 0 failed.
  The pre-fix findings D1–D4/D6/D8 were fixed in source and re-verified live after the reinstall
  (§10); D5 addressed client-side; D7 intentionally unchanged.

---

## 1. Scope and method

1. **Static/adversarial review** of `index.js`, `host/*.js`, `client.js`, `package.json`,
   `cordis.patch.yml`, `locale/*.json`, `icon.svg`, `README.md` against `API.md` and the real
   installed Harness contracts (read from
   `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/…`:
   `dsh-host-webserver`, `dsh-mcp-client`, `dsh-tool`/`dsh-tools`, `dsh-working-directory`,
   `dsh-workspace`, `dsh-skill`, `dsh-skill-filesystem`, `dsh-agent`, `dsh-agent-instructions`,
   `dsh-client-modules`, `dsh-app-boot`, `dsh-config-editor`, `cordis`).
2. **Manifest/asset validation** (existence, resolution through the same export paths app-boot uses,
   icon XML/size, locale metadata, zh/en key parity).
3. **Pre-install dynamic checks**: `node --check`, a stub-`window`/`react` execution of the client
   factory + `apply` (slot registration), and 21 seeded DOM-less render scenarios of the management
   page (ready/empty/error/loading states, all three tabs, detail/editor/confirm dialogs).
4. **Live verification** with `test/live-api.mjs` (read-only, then `--write` against
   `/Users/aesc/Documents/workspace/dsh`), plus live loopback fence probes, live-artifact execution of
   the *served* client bundle, and the bundle's own test suite (`node --test`).
5. **Client-slot verification** attempted with the Cordis inspect tool (platform `client`, provider
   `Slots`, method `listSubTree`) — see §7 for the limitation hit in this session.

Rules honoured: read-only review of plugin source; no `plugin_manager`; no profile edits; no DSH
restart; only `test/live-api.mjs` and this report were written by QA; verification writes were
workspace-scope (`/Users/aesc/Documents/workspace/dsh`) and cleaned up. User-scope
(`~/.dsh`, `~/.agents`) assets were never written by QA; `~/.dsh/agent-assets/mcp.json` kept its
pre-run content and mtime (13:12) through the run.

---

## 2. Manifest / asset validation (static)

| Check | Result |
| --- | --- |
| `package.json` name | `@local/dsh-agent-assets` |
| `dsh.bundle.patch` | `./cordis.patch.yml` exists; inserted row `name: '@local/dsh-agent-assets'` matches the package name; row `id: agent-assets` |
| `dsh.client.platform` | `web`; `immediately: true`; `inject` = `[dsh-client-locale, dsh-client-ui-renderer, dsh-client-ui-layout]` (all strings) |
| `exports` | `.` → `./index.js`, `./client` → `./client.js`, `./locale/*.json`, `./icon` → `./icon.svg`; all resolve from the installed profile (`node --input-type=module`, 2026-11-04) |
| `files` | every entry exists (`index.js`, `client.js`, `host/*.js`, `locale/*.json`, `icon.svg`, `cordis.patch.yml`, `README.md`, `API.md`, `DESIGN.md`) |
| `icon.svg` | well-formed XML (`xmllint --noout`), 1,250 bytes (< 256 KiB), SVG media type accepted by app-boot |
| `locale/en.json` + `locale/zh.json` | `meta.title` / `meta.description` present, localized and meaningful (`Agent Assets` / `Agent 资产`); zh and en differ |
| Display metadata resolution | `readPluginMeta` semantics reproduced: locale dir resolves, `…/icon` export resolves, and `./package.json` is now exported (D8 fixed) so app-boot can also read the manifest for this package. |
| Source syntax | `node --check index.js`, `client.js`, `host/*.js` all OK |
| Version consistency | `package.json` 0.1.0 = `index.js` `VERSION` = `/health` `version` = `/bootstrap` `version` |

Harness contracts checked against the real packages (all matched):

- `ctx.webServer.register({ kind:'exact', path, handler })` returns a disposer (real
  `dsh-host-webserver` API) — routes are one exact route per endpoint.
- `@deepseek-ai/dsh-mcp-client` exports `{ Config, apply, inject, name }`; its `Config` accepts the
  generated rows incl. `failOnStartupError:false`; mounting via `ctx.plugin(pluginObject, config)` and
  waiting with `fiber.await()` are valid Cordis 4.0.5 usage.
- Service names/props: `webServer`, `workingDirectory.defaultDirectory`, `workspaceRegistry.list()`,
  `tools.schemas(scope)`, `skills.list({cwd})`, `configEditor.configuration()`, `agent/created`
  `({ agent })` with `agent.ctx` + `agent.session.header.cwd`.
- Skill `source` vocabulary (`project-dsh` > `project-agents` > `user-dsh` > `user-agents` >
  `bundled`/`runtime`/`custom`) matches `dsh-skill-filesystem`; user-global instruction roots
  (`~/.dsh/AGENTS.md`, `~/.agents/AGENTS.md`) match `dsh-agent-instructions`.

---

## 3. Adversarial code review (static) — what was checked

- **Path traversal / root escape:** skill names are validated kebab-case before any path join; all
  scans and mutations re-check lexical + `realpath` containment; instruction writes only accept the
  enumerated candidate set (fixed users/workspace files + already-existing nested `AGENTS.md`/
  `CLAUDE.md`). Live: `POST /skill` with `name:"../verify-escape"` → 400 `bad_request` (no write);
  `GET /instruction` with a non-candidate path → 403 `forbidden` (no read/write).
- **Symlink escape:** `realpath` containment checks for skill dir/file and instruction candidates;
  symlinked directories are not followed during nested discovery. No bypass found.
- **Secret exposure:** `/mcp` list rows contain only `serverName/scope/transport/summary/enabled/
  status/createdAt/updatedAt` — no `env`/`headers`/`command`/`url`/`cwd`/`args`. Verified live by
  schema assertion on every row. `/mcp/detail` intentionally returns stored secrets per `API.md`
  (loopback-only; client masks them behind a "show sensitive values" toggle).
- **Loopback fence:** checks loopback socket + loopback `Host` + rejects `Sec-Fetch-Site: cross-site`;
  live probes confirm 403 for a non-loopback `Host` and for cross-site; normal loopback requests
  served. Hardening gaps in §5 (D4).
- **Workspace restriction:** requests are validated against the live workspace registry; live probe
  with an unregistered path → 400 `bad_request`.
- **Writes:** atomic temp-file+rename; MCP stores written with mode `0600` (verified live on the
  created workspace store); parent dirs created for `create`.
- **Unhandled rejections / activation crashes:** every `void` promise is caught (`agent/created`
  attach, `dispose`, `scheduleUserMounts`); route handlers catch all handler errors and always answer;
  optional Harness services (`skills`, `configEditor`, `workspaceRegistry`, `workingDirectory`) are
  read defensively; a missing MCP bridge is a reportable `health.mcp.moduleError`, not a crash;
  duplicate-route throw is the only activation-fatal path (would require installing the bundle twice).
- **Client half:** only `require('react')`; `window.__ModuleLoader__.load({id, factory})`; registers
  `sidebar.panellist` (`id agent-assets`, order 30) and `main` (`key agent-assets`); class-based
  `ErrorBoundary` guards page and icon; all copy in zh/en dictionaries (186 keys each, key parity,
  placeholder parity — verified programmatically); no polling; `document.addEventListener` is inside
  an effect with cleanup; `fetch` helper validates the `{ok:…, error:{code,message}}` envelope;
  mutation payload shapes match `API.md` (`POST /skill`, `POST /instruction`, `POST /mcp` incl.
  `toggle`/`delete`).
- **Dynamic pre-install checks:** client factory + `apply` executed with stub React/slots/locale →
  registered exactly the two expected slots; 21 seeded DOM-less render scenarios (ready/empty/error/
  loading, scope filter/search, all detail/editor/confirm dialogs, toasts, boot error) rendered with
  0 exceptions.

---

## 4. Live verification — read-only

Command (from the bundle directory):

```bash
node test/live-api.mjs
```

Result: **RESULT: PASS — 30 passed, 0 failed, 1 warning, 1 skipped** (post-fix, post-reinstall final
run — exact output below; the pre-fix run was 24/0/3/1 with D2/D3 warnings, which are now gone).

| Area | Live evidence |
| --- | --- |
| `/health` | `ok:true`, `plugin:"@local/dsh-agent-assets"`, `version:"0.1.0"`, absolute `homes`, `workspace:"/Users/aesc/.dsh/profiles/desktop"`, `mcp.moduleLoaded:true`, `mcp.moduleError:null`, `mcp.mounted:[]` |
| Routes | all 8 documented endpoints answer with the plugin JSON envelope (`/health`, `/bootstrap`, `/skills`, `/skill`, `/instructions`, `/instruction`, `/mcp`, `/mcp/detail`); a missing route would fall through to the gateway’s plain 401 |
| Loopback fence | `Host: assets.example.com` → 403 `forbidden`; `Sec-Fetch-Site: cross-site` → 403 `forbidden`; plain loopback → 200 |
| Envelope | every response `content-type: application/json; charset=utf-8`, `cache-control: no-store`; failures `{ok:false,error:{code,message}}` |
| `/bootstrap` | `version 0.1.0`, absolute `defaultWorkspace`, 8 unique workspaces `{id,title,path}`, `homes`, `supports{s k i l l s,instructions,mcp}=true` |
| Workspace validation | `workspace=/nonexistent-…` → 400 `bad_request`; `/Users/aesc/Documents/workspace/dsh` accepted (registered) |
| `/skills` | 14 skills: `user=6 workspace=1 bundled=7`; counts sum = list length; every row matches `SkillView`; bundled rows `editable:false, path:null, dir:null`; source vocabulary correct; `shadowed` arrays present; real warning surfaced: `~/.agents/skills/herdr-gpui-browser/SKILL.md is missing` (contract “never abort the whole list”) |
| `/skill` | reading a bundled skill works (read-only, empty body/raw for provider entries); bundled mutation → 400 `bad_request`; unknown name → 404 `not_found`; `../` name → 400 (no write) |
| `/instructions` | 8 candidates = 2 user-global + exactly the 4 fixed workspace candidates + 2 existing nested files (`plugins/dsh-acp-adapter/AGENTS.md`, `plugins/dsh-acp-rc5/AGENTS.md`); ordering user→workspace-fixed→nested-sorted; every workspace candidate `exists`/`size` matches the filesystem; nested `displayPath` starts with `./`; reading an existing nested file returns exactly the on-disk bytes (3,039 B) |
| `/instruction` | missing fixed candidate → `{exists:false, content:""}` (not 404); non-candidate path → 403 `forbidden` (no file created); wrong-scope path → 403 `forbidden` |
| `/mcp` | shape valid, 0 managed + 0 external at verification time; each list row free of `env`/`headers`/`command`/`url`/`cwd`/`args`; unknown detail → 404 `not_found`; 4 invalid create payloads → 400 `bad_request` |
| Client half | served bundle at computed artifact revision: 200, `text/javascript; charset=utf-8`, **176,036 bytes, rev `6ebb0cab471a`, sha256 prefix `067594ab`** (final post-reinstall pass incl. the `useSessions` initial-workspace fix; earlier snapshots `348c1ae3bdf2` / `a1828e7b7f92` passed the same check while `client-ui` was still editing — the served composition followed each edit without a Host restart, i.e. client HMR propagation works); served bytes == installed `client.js` + source-map trailer; contains `__ModuleLoader__.load`, `id: '@local/dsh-agent-assets'`, `sidebar.panellist`, `'main'`, `useSessions`/`selectSessionCwd`/`preferredWorkspace`; executing the served bytes with stub React/slots/locale registers exactly `{name:'sidebar.panellist', id:'agent-assets', order:30}` and `{name:'main', key:'agent-assets'}` with no exception |

Notes from the run:

- `GET /` itself is behind the `dsh-web` browser cookie (`HTTP 401` for a shell client), so the page
  boot graph could not be fetched over HTTP. The script falls back to the unauthenticated
  `/plugins/…` bundle route and derives the revision exactly like `dsh-client-modules`
  (`sha1("plugin-artifact", mtimeMs/ctimeMs/size)`), then verifies the served bytes.
- `client.js` changed several times while QA ran (13:09 → 13:18 → 13:28). The final verified artifact
  is the post-reinstall `client.js` mtime 13:28:11, rev `6ebb0cab471a` (176,036 served bytes,
  sha256 `067594ab…`), including the task-5 `useSessions`-derived initial workspace fix (client
  `initialState`/bootstrap default remains `defaultWorkspace` server-side). If `client.js` changes
  again, re-run `node test/live-api.mjs` — the served-bundle check recomputes the revision and fails
  loudly on a stale composition.
- Skills warning is real machine data, not a defect.
- External MCP rows (`external: []`) could not be exercised live because no installed bundle row
  currently declares `@deepseek-ai/dsh-mcp-client`.

---

## 5. Live verification — write round-trip (`--write`)

Command (from the bundle directory):

```bash
node test/live-api.mjs --write
```

Result: **RESULT: PASS — 48 passed, 0 failed, 1 warning, 1 skipped** (post-fix, post-reinstall final
run; pre-fix run was 42/0/3/1). All writes were workspace scope
(`/Users/aesc/Documents/workspace/dsh`) and cleaned up; no `~/.dsh`/`~/.agents` file was touched.

| Check | Evidence |
| --- | --- |
| Skill create | `POST /skill {op:create,scope:workspace,name:"verify-<pid>"}` → 200, `SkillView` with `editable:true`, `path=<workspace>/.dsh/skills/verify-<pid>/SKILL.md`, `dir` correct; file on disk contains frontmatter + description + body |
| Skill read/list | `GET /skill` round-trips body and raw SKILL.md; `GET /skills` lists it, `counts.workspace` increments (live: 1→2) |
| Skill conflict | duplicate create → 409 `conflict` |
| Skill update | injected unknown frontmatter key `license: MIT`, then `op:update` → description/whenToUse/body updated **and `license` preserved**; `GET /skill` reflects it |
| Skill delete | 200 `{deleted:true,name,scope}`; directory gone; `GET /skill` → 404 `not_found`; second delete → 404 |
| Instruction write | chose the missing fixed candidate `AGENTS.local.md`; `POST /instruction {op:write}` → 200 `{exists:true, content, size}` (byte-exact), file on disk matches; `GET /instruction` round-trips it |
| Instruction delete | 200 `{deleted:true}`; file gone; `GET /instruction` → `{exists:false, content:""}`; second delete → 404; non-candidate write → 403 and no file created |
| MCP store create | `POST /mcp {op:create,scope:workspace,server:{transport:stdio,command:"true",enabled:false}}` → 200; store `<workspace>/.dsh/agent-assets/mcp.json` version 1, **mode 0600**, row present; row status `disabled` |
| MCP list/detail | `/mcp` and `/mcp/detail` reflect the row (detail includes command/env, list never does) |
| MCP toggle | enable → status `session-scoped` (workspace-scope semantics per contract); disable → `disabled` |
| MCP update/conflict/delete | `args` update reflected in detail; duplicate create → 409; delete → row absent from list and detail 404 |
| Cleanup | `cleanup: zero leftovers` — workspace restored to its pre-run state (skill dir removed, `AGENTS.local.md` removed, store rows emptied; the pre-existing empty store file was preserved/compared) |

Concurrency: the Lead was running its own `lead-verify-*` CRUD during this window; the script uses
`verify-*`/`verify_<pid>` names only and its cleanup tolerates a concurrently-created foreign store
row without failing.

---

## 6. Bundle test suite

Run from the bundle directory (the suite is authored by the other teammates; QA executed it unchanged
as an additional signal):

```bash
node --check index.js && node --check client.js            # OK
node --test test/host-assets.test.mjs                      # PASS (host skills + instruction modules)
node --test test/host-mcp.test.mjs                         # PASS (MCP store/mount/status lifecycle, ~5.5 s)
node --test test/client-render.test.mjs                    # PASS — "31/31 checks passed" (4 seeded API payloads, SSR)
```

Caveats for the documented command (`README.md:67`, `node --test test/`): on Node 24.13.1 it fails with
`Cannot find module '…/plugins/dsh-agent-assets/test'`. Running the bare discovery form `node --test`
is also not safe here: Node’s `test/` directory discovery pulls in the helper/fixture scripts
(`test/host-integration.mjs`, `test/fixtures/mcp-echo-server.mjs` — the latter starts a server), so
the run does not terminate. Reproducible invocation: `node --test test/*.test.mjs`. Documentation nit
only, reported as D6.

---

## 7. What could not be verified (and why)

| Not verified | Why | What was verified instead |
| --- | --- | --- |
| **Live slot tree via Cordis inspect** (`client` / `Slots` / `listSubTree` for `sidebar.panellist` and `main`) | All client-side inspect queries timed out in this session (`Slots.listSubTree` ×4 including a post-reinstall retry, control query `Theme.listTokens` ×1, each "Client inspect query … timed out after 10000ms"). The Lead had confirmed occupants `{id:"agent-assets", order:30, active:true}` and `{key:"agent-assets", active:true}` earlier; QA could not independently re-confirm through the tool at verification time. | Independently executed the **served** client bundle (fetched from `/plugins/…`) with stub React/slots/locale: registration calls observed for both slots, no exception; plus 21 seeded DOM-less render scenarios with 0 failures. |
| **Visual appearance** (light/dark theme, three widths, no horizontal scroll, dialog focus/Escape, spinner states) | No browser/screenshot control of the DSH GUI for a teammate; the page is behind the dsh-web browser cookie. | Static token/CSS review + DOM-less render of all states; component tree rendered without exceptions. Visual quality remains a browser check for the user/Lead. |
| **Live Plugin Manager display metadata** (title/description/icon diagnostics) | Not inspectable without the browser page; `plugin_manager` is out of QA scope by rule. | Manifest + locale + icon validated statically, and `readPluginMeta`'s resolution paths reproduced through Node ESM resolve from the installed profile (§2). |
| **MCP external rows** | No installed bundle row currently declares `@deepseek-ai/dsh-mcp-client`, so `external` was legitimately empty. | Static review against the real `configEditor.configuration()` row shape; live managed-row CRUD exercised instead. |
| **A real MCP server connection from the UI** (connected / error / connecting transitions, tools unmount on delete) | QA did not write user-scope stores and did not create new Sessions to trigger workspace-scope mounts. The Lead exercised a live user-scope MCP server (`leadverify`) before cleanup. | Store CRUD + validation + `disabled`/`session-scoped` statuses verified live; `mcp.moduleLoaded:true` verified live; bridge contract checked against `dsh-mcp-client` source. |
| **User-scope skill/instruction CRUD in the live GUI** | QA rule: never write user-scope (`~/.dsh`, `~/.agents`) assets. | Same code paths exercised workspace-scope; user-scope roots are read-only-visible (6 user skills listed; user instruction candidates listed). |

---

## 8. Defect list (ordered by severity)

No blocking defects. All findings below are LOW severity or informational; each includes an exact
reproduction and expected-vs-actual.

### D1 — LOW (security hardening) — **FIXED in source, re-verified live**: loopback `Host` check accepted DNS names starting with `127.`; no `Origin`/`Referer` check

- **Where:** `index.js:92` (`hostname.startsWith('127.')`), fence at `index.js:76-95`.
- **Repro (live):**
  ```bash
  # non-loopback Host is correctly rejected:
  node -e "…http.request({headers:{host:'assets.example.com'}})"      # -> 403 forbidden
  # but a DNS name whose hostname text starts with 127. is accepted:
  node -e "…http.request({headers:{host:'127.0.0.1.evil.example:49536'}})"  # -> 200 {"ok":true,…}
  # and Origin is never inspected (only Sec-Fetch-Site is):
  node -e "…http.request({headers:{host:'127.0.0.1:49536', origin:'https://evil.example'}})"  # -> 200
  ```
- **Expected:** per `API.md` “loopback Host header” — an exact loopback authority (`127.0.0.1`,
  `localhost`, `[::1]`) should be required.
- **Actual:** any hostname string beginning with `127.` passes; `Origin`/`Referer` are ignored.
- **Impact:** not directly exploitable in modern browsers (a cross-origin page cannot read the JSON
  and cross-site fetch/form POSTs are already rejected via `Sec-Fetch-Site`, which is shipped by all
  current engines; the API also requires JSON bodies for mutations, which forces a CORS preflight that
  the server does not grant). It lowers defense-in-depth for legacy clients and is inconsistent with
  the documented fence. Fix: parse `host` and require an exact loopback IP/`localhost` authority, and
  reject a present non-loopback `Origin`/`Referer` for `/api/dsh-agent-assets/*`.
- **Note:** the same helper is copied from the working `@local/dsh-agent-usage` precedent, so this is
  a shared pattern rather than a regression unique to this bundle.

### D2 — LOW (contract drift) — **FIXED in source (API.md corrected), re-verified live**: `/health` nests `skippedAgents` under `mcp` instead of top level

- **Where:** `index.js:353,359` + `host/mcp.js:1082-1096`.
- **Repro:** `curl -s http://127.0.0.1:49536/api/dsh-agent-assets/health | jq '{keys: keys, skipped: .mcp.skippedAgents}'`
- **Expected (API.md §GET /health):** `{ …, "mcp": { "moduleLoaded", "moduleError", "mounted" }, "skippedAgents": 0 }`
- **Actual:** response keys are `["ok","plugin","version","homes","workspace","mcp"]` and
  `mcp.skippedAgents` is `0`; no top-level `skippedAgents`.
- **Impact:** diagnostics-only field; client does not consume it. Machine assertion in
  `test/live-api.mjs` records it as WARN.

### D3 — LOW (contract drift) — **FIXED in source (API.md corrected), re-verified live**: method gate / oversized body use undocumented statuses with `code:"bad_request"`

- **Where:** `index.js:149-153` (405), `index.js:104` (413).
- **Repro:** `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:49536/api/dsh-agent-assets/health` → `405`; body `{"ok":false,"error":{"code":"bad_request",…}}`.
- **Expected (API.md §Conventions):** `bad_request` is documented as HTTP 400; 405/413 are not listed.
- **Actual:** 405 with `code:"bad_request"` (and 413 for bodies > 4 MiB).
- **Impact:** harmless for the client (it keys on `ok`/`code`), but the code→status mapping in the
  contract is not honored. Either document 405/413 or normalize to 400.

### D4 — LOW (contract drift) — **FIXED in source (API.md corrected)**: `POST /skill` `update` requires `description` although `API.md` says update only supplies changed fields

- **Where:** `index.js:412` (`description: requireString(body,'description')` for `op:'update'`).
- **Repro:** `curl -s -X POST …/skill -d '{"op":"update","scope":"workspace","workspace":"…","name":"location-map","body":"x"}'`
  → 400 `bad_request: missing required field: description`.
- **Expected (API.md §POST /skill):** “`update`: rewrites the existing SKILL.md; preserves unknown
  frontmatter keys and the body verbatim except for the fields supplied.” That wording implies field
  omission is allowed.
- **Actual:** `description` is mandatory for update (the current client always sends it, so no
  user-visible impact). Same for `whenToUse`/`body` being optional — those are fine.

### D5 — INFO (UX) — **ADDRESSED client-side**: default workspace advertised by `/bootstrap` is the Host process cwd (profile directory)

- **Where:** `index.js:279-323` (`workingDirectory.defaultDirectory`, defaulting to `process.cwd()`);
  client consumes `payload.defaultWorkspace` at `client.js:2814`.
- **Live:** `health.workspace = bootstrap.defaultWorkspace = /Users/aesc/.dsh/profiles/desktop`, and
  that path is listed as one of the 8 registered workspaces.
- **Expected (UX):** the page would ideally open on the project workspace (e.g.
  `/Users/aesc/Documents/workspace/dsh`) that the session belongs to.
- **Actual:** the management page opens on `~/.dsh/profiles/desktop`; the user must switch the
  workspace selector to see project skills. Root cause is the desktop profile not configuring
  `working-directory.defaultDirectory` (Host process cwd), not a plugin logic bug — reported for
  awareness; a client-side “prefer the workspace containing the last project / first non-profile
  workspace” heuristic could mitigate it.

### D6 — INFO — **FIXED in source**: `README.md` verification command was wrong on Node 24

- **Where:** `README.md:67` (`node --test test/`).
- **Repro:** `cd plugins/dsh-agent-assets && node --test test/` →
  `Error: Cannot find module '…/plugins/dsh-agent-assets/test'`; bare `node --test` pulls in
  `test/fixtures/mcp-echo-server.mjs` (a long-running server) and does not terminate.
- **Expected:** the documented command runs the three test files.
- **Actual:** `node --test test/*.test.mjs` runs them (all pass). Documentation-only.

### D7 — INFO — **INTENTIONALLY UNCHANGED**: client `dsh.client.inject` omits `@deepseek-ai/dsh-client-ui-sidebar`

- **Where:** `package.json:36-44` vs the working precedent
  `/Users/aesc/Documents/workspace/overview/dsh-agent-usage/package.json` (which lists
  `…dsh-client-ui-sidebar`).
- **Impact:** none observed — the client half is served and its `apply` registers both slots
  (verified), and `ctx.slots.inject('sidebar.panellist', …)` waits for the slot rather than for the
  module graph. Parity nit only.

### D8 — INFO — **FIXED in source**: package `exports` lacks `"./package.json"`

- **Where:** `package.json:17-22`.
- **Impact:** `dsh-app-boot`'s `readPluginMeta` cannot read the manifest for this package, so the
  manifest `icon`/`description` fields are ignored; metadata comes from `locale/*.json` + the
  `./icon` export (verified to resolve). Display is complete; adding `"./package.json":
  "./package.json"` would make the manifest the source of truth for `icon`/fallback description
  (the precedent bundle also omits it, so this is a convention nuance).

### Post-fix status summary

All findings above were re-checked after the Lead applied source fixes and reinstalled the bundle
(§10): **D1, D2, D3 re-verified live against the new module generation; D4, D6, D8 verified in source
and with the bundle harness (not observable through the live API); D5 fixed client-side (initial
workspace now derived from `useSessions` when available, server `defaultWorkspace` unchanged); D7
intentionally left unchanged (parity-only, no observed effect).** No open defects remain.

### Non-defects observed (correct behaviour worth recording)

- The live `/skills` warning `~/.agents/skills/herdr-gpui-browser/SKILL.md is missing` is the
  documented “invalid skill still lists + warning” behaviour (name from directory), not a bug.
- An earlier transient during parallel authoring had `client.js` referencing an undefined icon
  symbol; by the time of final verification (client.js mtime 13:09) the file registers correctly and
  the served artifact executes cleanly — no action needed, recorded only because QA saw the interim
  state.
- `plugin_manager` reported “application restart-required” for this unmanaged bundle, but the Host
  row activated live (`/health` serves immediately) and the client bundle is served from the live
  boot graph without a process restart (process start 11:16:20 predates installation ~13:10). The
  restart note is a plugin-manager caution, not an actual activation failure.

---

## 9. Reproduction summary

```bash
cd /Users/aesc/Documents/workspace/dsh/plugins/dsh-agent-assets

# static
node --check index.js && node --check client.js && for f in host/*.js; do node --check "$f"; done
xmllint --noout icon.svg

# live read-only (expect RESULT: PASS 30/0 with 1 real-data warning; 1 skip is the browser-auth boot graph)
node test/live-api.mjs

# live workspace-scope CRUD (expect RESULT: PASS 48/0, cleanup zero leftovers)
node test/live-api.mjs --write

# bundle's own suites (explicit glob; bare `node --test` also loads the MCP fixture server and hangs)
node test/host-integration.mjs
node --test test/*.test.mjs
```

`test/live-api.mjs` supports `DSH_WEB_ORIGIN` (default `http://127.0.0.1:49536`) and
`--workspace <abs path>`; it never writes user-scope assets and cleans up in a `finally` block.

---

## 10. Post-fix reinstall — module-reload finding, new live generation, re-verification

After the pre-fix review, the Lead applied source fixes (D1 fence, D2/D3/D4 API.md wording, D6 README +
`package.json` scripts, D8 `./package.json` export; D5 client-side via task-5) and ran
`plugin_manager remove_bundle` + `install_bundle`.

**Reload finding:** removing and reinstalling the *linked* bundle **does reload the Host module
generation without a DSH restart** (the Host process PID 73927 started 11:16:20 remained the same
process throughout). The fresh generation is observable without a version marker: the fixed fence
rejects requests the old generation served.

**Live generation proof (QA, post-reinstall):**

| Probe (expected vs actual) | Result |
| --- | --- |
| `Host: 127.0.0.1.evil.example:49536` → expect 403 | **403** `forbidden` (old generation: 200) |
| `Origin: https://evil.example` (no Sec-Fetch-Site) → expect 403 | **403** `forbidden` (old generation: 200) |
| `Origin: null` → expect 403 | **403** `forbidden` |
| `Origin: http://127.0.0.1:49536` → expect 200 | **200** `ok:true` (fence does not over-block same-origin) |
| `Referer: https://evil.example/page` → expect 403 | **403** `forbidden` |
| `POST /health` → expect 405 + `code:"bad_request"` | **405** `{"ok":false,"error":{"code":"bad_request","message":"method not allowed: POST; use GET"}}` |
| Oversized `POST /skill` body (4,195,387 B > 4 MiB) → expect 413 + `bad_request` | **413** `{"ok":false,"error":{"code":"bad_request","message":"request body exceeds 4194304 bytes"}}` |
| `/health` shape (D2) | top-level keys `["ok","plugin","version","homes","workspace","mcp"]`; no top-level `skippedAgents`; `mcp` keys `["moduleLoaded","moduleError","mounted","skippedAgents"]`, `mcp.skippedAgents = 0` — matches the corrected API.md |
| `mcp.moduleLoaded` | `true` (MCP bridge stayed loaded across the reinstall) |
| Other API data | `/skills` user=6 workspace=1 bundled=7; `/instructions` 8 candidates; `/mcp` 0 managed/0 external; `/bootstrap` 8 workspaces (default still Host process cwd, as expected server-side) |

**Post-reinstall suites (final):**

```bash
node test/live-api.mjs          # RESULT: PASS — 30 passed, 0 failed, 1 warning, 1 skipped
node test/live-api.mjs --write  # RESULT: PASS — 48 passed, 0 failed, 1 warning, 1 skipped, cleanup zero leftovers
node test/host-integration.mjs  # 26 passed, 0 failed (source, fake Cordis ctx; includes the new fence cases)
node --test test/*.test.mjs     # 47 tests, 47 passed, 0 failed
```

The single remaining warning is real machine data (`~/.agents/skills/herdr-gpui-browser/SKILL.md is
missing`, correctly surfaced per contract); the one skip is the `GET /` browser-auth boot-graph
fallback. Client artifact re-checked after the reinstall: served 176,036 bytes at rev
`6ebb0cab471a` (sha256 `067594ab…`), matching the installed `client.js` (mtime 13:28:11) and
executing cleanly with both slot registrations plus the `useSessions` initial-workspace helper.

## 11. Final assessment

The bundle is installable, activates live without a restart, mounts the documented loopback JSON API
(all 8 routes, correct envelopes/headers/fence/validation), lists real machine skills/instructions and
MCP stores with the documented scope grouping and precedence surfaces, serves a working client half
that registers the `sidebar.panellist` (`agent-assets`, order 30) and `main` (`agent-assets`) slots,
and its workspace-scope CRUD round-trip (skills, instruction files, MCP store) is correct and leaves
no residue. The three warnings are a contract-position nit (`skippedAgents`), a status/code mapping
nit (405/413), and real machine skill data. The only security-relevant finding is the loopback-fence
hostname-prefix hardening gap (D1), shared with the existing precedent and not directly exploitable in
modern browsers. **No blocking defects; recommend ship.**
