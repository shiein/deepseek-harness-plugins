# Agent Assets — Client page design brief

Owner: `client-ui`. Read `API.md` first; it is the data contract. This file is the visual and
interaction contract. Ask the Lead before deviating.

## Surface

Register two slots exactly like `/Users/aesc/Documents/workspace/overview/dsh-agent-usage/client.js`
(read that file as the working precedent — copy its module skeleton, lifecycle and locale plumbing,
not its dashboard content):

- `sidebar.panellist`, id `agent-assets`, order `30`, `label: () => t('entry.label')`.
  The icon component receives `{ size }` and renders our SVG mark at that edge.
- `main`, key `agent-assets`, component `AgentAssetsPage`; `inject: () => ({ t, subscribeLocale })`.

The page is a **management page**, like the Plugins page: header, tab bar, toolbar, grouped list,
detail/edit dialogs. It must look native in light and dark themes, using only `--dsw-alias-*` /
`--dsw-font-*` tokens (a literal color is allowed only inside the icon artwork).

Root: `height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden;`
Work at three widths (narrow < 720, regular, wide ≥ 1180): the layout must not horizontally scroll;
long descriptions are 2-line clamped; paths are ellipsized with `title` tooltip.

## Structure

1. **Header** — icon (24px) + title `Agent 资产` + subtitle (`管理技能 · MCP · Agent 提示词，按作用范围分组`);
   right side: workspace `<select>` (from `/bootstrap`), refresh button (icon, spins while loading).
2. **Scope summary strip** — four compact stat tiles: 技能 / MCP / Agent 提示词 / 内置（只读）,
   each with a count from the loaded data. Tiles are informational, not buttons.
3. **Tab bar** — `技能 Skills`, `MCP 服务`, `Agent 提示词`; each shows its count in a muted pill;
   `role="tablist"` / `role="tab"` / `aria-selected`; active tab uses the same underline treatment as
   the host's tabs (`border-bottom: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))`).
4. **Toolbar** — left: scope segmented control `全部 / 用户级 / 工作区级 / 内置`; right: search input
   (with a magnifier icon, clears with Escape) and the primary action `新建技能` / `新建 MCP` /
   `新建提示词文件` for the active tab.
5. **Content** — grouped list. One section per scope that has rows: section header
   (`用户级 · ~/.dsh` / `工作区级 · <workspace>` / `内置（只读）`, right-aligned count), then rows.
   Sections follow scope order: workspace, user, bundled (most specific first), but when a scope
   filter is active only that section renders. Empty state per tab, empty-filter state, error state
   with retry, initial loading skeleton rows (no spinner-only screen).
6. **Row** — icon chip (32px, letter or glyph per kind), title line (name + badges), description line,
   meta line (path/endpoint, right side: status badge + hover action buttons 编辑 / 删除 / 启用切换).
   Row is a button (keyboard: Enter opens detail; Space toggles selection). Hover raises background
   using `--dsw-alias-interactive-bg-hover`. Do not nest interactive elements inside the row button:
   use absolutely-positioned sibling buttons or `onClick` with `stopPropagation` on a wrapping div
   with `role="button"` — simplest acceptable: row is a `<div role="button" tabIndex={0}>` and the
   trailing actions are `<button>` children with `stopPropagation`.
7. **Detail dialog** — breadcrumb (`技能 / location-map`), title, scope + source badges, path in mono,
   then read-only content (for skills: description, whenToUse, body in a scrollable mono/pre block;
   for MCP: full config with masked secrets and live status; for instructions: the file content).
   Footer: `编辑`, `删除` (destructive, confirm first), `关闭`. Escape closes; focus the dialog on open;
   restore focus to the row on close; `role="dialog" aria-modal="true"` with a labelled title.
8. **Editor dialog** — kind-specific form, validated inline, dirty-state awareness.
   - Skill: 名称 (create only, kebab-case, live-validated hint), 描述 (2-line textarea, required),
     何时使用 (optional input), 内容（Markdown，monospace textarea ≥ 12 rows，可滚动）,
     footer 取消 / 保存 (disabled while saving or invalid). Show a short note that it writes
     `<root>/<name>/SKILL.md`.
   - Instruction file: 文件 selector listing every missing fixed candidate from both scopes
     (`~/.dsh/AGENTS.md`, `~/.agents/AGENTS.md`, `AGENTS.md`, `CLAUDE.md`, `AGENTS.local.md`,
     `CLAUDE.local.md`), defaulting to the first missing workspace candidate; the request scope comes
     from the selected candidate. Content textarea, footer 取消 / 保存; for existing files the file is
     fixed. A delete button appears only for existing files.
   - MCP: 名称 (serverName, create only, pattern `^[A-Za-z0-9_-]{1,32}$`), 作用范围 (固定为当前 scope，
     create 时可选 user/workspace), 传输 (`stdio` | `streamable-http`), then either 命令 / 参数（每行一个）/
     工作目录 / 环境变量（KEY=VALUE 每行一个）or URL / 请求头（KEY: VALUE 每行一个）, 启用 switch
     (`role="switch" aria-checked`), footer 取消 / 保存. Warn (muted note) that env/header values are
     stored in plain text under `~/.dsh/agent-assets` or `<workspace>/.dsh/agent-assets`.
9. **Confirm dialog** — destructive actions (`删除技能`, `删除 MCP 服务`, `删除提示词文件`) name the
   target and the exact path, primary action is destructive-colored, default focus is 取消.
10. **Toasts** — bottom-center, 2.6s auto-dismiss, success/error variants; errors append the API
    `error.code` in a muted suffix. A failed mutation keeps the dialog open and shows the message there
    too. Never leave a dialog stuck in a saving state.

## Behavior rules

- Load `/bootstrap` once, then the active tab's data; refresh on tab switch only when data is stale
  (> 30s) or after a mutation. Workspace change reloads everything.
- Mutations: call the API, on success close dialog + refresh current tab + toast; on failure show
  inline error. Optimistic updates are not required and must not be used for destructive actions.
- MCP enable/disable switch calls `POST /mcp {op:'toggle'}`; show pending state on the switch.
- All user-visible strings go through the client locale dictionaries (`zh` + `en`), `{placeholders}`
  interpolated; numbers via `Intl.NumberFormat`. Active locale from `ctx.locale` via `subscribeLocale`;
  re-render on change. Default copy language is Chinese; `en` mirrors every key.
- Never import a Harness Client package; `require('react')` only (plus `require('react-dom')` is NOT
  needed). No `document.body` writes, no global listeners outside `ctx.effect`/component effects.
- Guard the whole page and the icon with a tiny class-based ErrorBoundary that renders a localized
  `出错了 / 重新打开` fallback and `console.error`s the error — the host must never get a blank slot.
- Performance: memoize derived groups/filters; no polling; fetch only on explicit actions.

## Acceptance

- Sidebar icon appears and selects the page; page renders in light and dark; no console errors from
  our module on mount.
- Skills: list user/workspace/bundled with scope badges; create a workspace skill → appears under
  workspace group; edit description/body → detail reflects it; delete → row disappears; user scope
  works the same; bundled rows show no edit/delete affordances.
- Instructions: the list shows only files that already exist (fixed candidates + discovered nested
  files); not-yet-created candidates are NOT listed as rows. The 新建提示词文件 action is the only
  creation path and its picker offers every missing fixed candidate from both scopes (user and
  workspace); editing saves and reloads content; delete removes it. The stat tile hint keeps
  `已存在 {existing} / {total}` so the hidden candidates stay discoverable.
- MCP: create a stdio server → row shows `连接中` then `已连接 · N 个工具` (or `错误` with reason);
  toggle disables it; edit changes command; delete removes it and its tools unmount.
- All dialogs close with Escape and the backdrop click; focus returns to the opener.
