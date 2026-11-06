/**
 * Render test for the Agent Assets client half.
 *
 * The DSH client host is not available under plain Node, so this test:
 *   1. stubs `window.__ModuleLoader__` and captures the module definition,
 *   2. supplies the real React 18 (+ react-dom/server) — resolved from
 *      `AGENT_ASSETS_TEST_REACT` (a directory containing react + react-dom, e.g.
 *      the ACP plugin's node_modules) or from candidates under the repo; when no
 *      React install can be found the test skips instead of crashing,
 *   3. stubs `fetch` with API fixtures so no request can escape,
 *   4. loads `client.js`, runs `apply()` against a fake ctx, captures both slot registrations,
 *   5. server-renders the icon and the page for the initial loading state and for seeded data /
 *      dialog states (SSR does not run effects, so data states are seeded through the page's
 *      optional `initialState` prop, which the host never passes).
 *
 * Run: node test/client-render.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_DIR = path.resolve(HERE, '..');
const CLIENT_FILE = path.join(BUNDLE_DIR, 'client.js');
// React is borrowed from a sibling plugin's node_modules (the client host is not
// on disk here). `AGENT_ASSETS_TEST_REACT` may point at any directory that
// contains `react` + `react-dom`; the legacy macOS path stays as a candidate so
// existing dev machines keep working without configuration.
const REACT_BASE_CANDIDATES = [
  process.env.AGENT_ASSETS_TEST_REACT,
  '/Users/aesc/Documents/workspace/dsh/plugins/dsh-acp-rc5/test/client-render.test.mjs',
  path.resolve(BUNDLE_DIR, '..', 'dsh-acp-rc5', 'test', 'client-render.test.mjs'),
  path.join(BUNDLE_DIR, 'node_modules', 'react', 'index.js'),
].filter((value) => typeof value === 'string' && value !== '');

let React = null;
let renderToStaticMarkup = null;
for (const base of REACT_BASE_CANDIDATES) {
  try {
    const candidateRequire = createRequire(base);
    React = candidateRequire('react');
    ({ renderToStaticMarkup } = candidateRequire('react-dom/server'));
    break;
  } catch {
    // Try the next candidate.
  }
}
if (React === null || typeof renderToStaticMarkup !== 'function') {
  console.log(
    'SKIP client-render: no React 18 install found ' +
      '(set AGENT_ASSETS_TEST_REACT to a directory containing react + react-dom)',
  );
  process.exit(0);
}
const h = React.createElement;

// ---------------------------------------------------------------------------------------
// Fixtures (shapes copied from API.md)
// ---------------------------------------------------------------------------------------

const bootstrapPayload = {
  ok: true,
  version: '0.1.0',
  defaultWorkspace: '/ws',
  workspaces: [{ id: 'w1', title: 'dsh', path: '/ws' }],
  homes: { dshHome: '/Users/tester/.dsh', agentsHome: '/Users/tester/.agents' },
  supports: { skills: true, instructions: true, mcp: true },
};

const skillView = {
  name: 'location-map',
  description: '区位图 / 区位分析图设计，使用真实地理数据生成可交付的区位分析展板。',
  whenToUse: '当用户要求制作区位图或场地分析图时',
  scope: 'workspace',
  source: 'project-dsh',
  provider: 'filesystem',
  path: '/ws/.dsh/skills/location-map/SKILL.md',
  dir: '/ws/.dsh/skills/location-map',
  editable: true,
  shadowed: [{ scope: 'user', path: '/Users/tester/.dsh/skills/location-map/SKILL.md' }],
};

const bundledSkill = {
  name: 'office',
  description: 'Office 文档处理',
  whenToUse: null,
  scope: 'bundled',
  source: 'bundled',
  provider: 'service',
  path: null,
  dir: null,
  editable: false,
  shadowed: [],
};

const userSkill = {
  name: 'review',
  description: '代码审查清单',
  whenToUse: null,
  scope: 'user',
  source: 'user-dsh',
  provider: 'filesystem',
  path: '/Users/tester/.dsh/skills/review/SKILL.md',
  dir: '/Users/tester/.dsh/skills/review',
  editable: true,
  shadowed: [],
};

const skillsPayload = {
  ok: true,
  counts: { user: 1, workspace: 1, bundled: 1 },
  skills: [skillView, userSkill, bundledSkill],
  warnings: ['skills: one SKILL.md could not be parsed'],
};

const instructionView = {
  id: 'workspace|/ws/AGENTS.md',
  scope: 'workspace',
  file: 'AGENTS.md',
  label: 'AGENTS.md',
  path: '/ws/AGENTS.md',
  displayPath: './AGENTS.md',
  exists: true,
  editable: true,
  size: 2345,
  modifiedAt: '2026-11-01T08:00:00.000Z',
};

const userInstruction = {
  id: 'user|/Users/tester/.dsh/AGENTS.md',
  scope: 'user',
  file: 'AGENTS.md',
  label: '~/.dsh/AGENTS.md',
  path: '/Users/tester/.dsh/AGENTS.md',
  displayPath: '~/.dsh/AGENTS.md',
  exists: true,
  editable: true,
  size: 512,
  modifiedAt: '2026-10-28T08:00:00.000Z',
};

const missingInstruction = {
  id: 'workspace|/ws/CLAUDE.md',
  scope: 'workspace',
  file: 'CLAUDE.md',
  label: 'CLAUDE.md',
  path: '/ws/CLAUDE.md',
  displayPath: './CLAUDE.md',
  exists: false,
  editable: true,
  size: 0,
  modifiedAt: null,
};

const instructionsPayload = {
  ok: true,
  files: [userInstruction, instructionView, missingInstruction],
  warnings: [],
};

function instructionsFixture(files) {
  return { ok: true, files, warnings: [] };
}

function missingUserInstruction(path, label) {
  return {
    ...userInstruction,
    id: `user|${path}`,
    label,
    path,
    displayPath: label,
    exists: false,
    size: 0,
    modifiedAt: null,
  };
}

function withExists(file, exists) {
  return { ...file, exists, size: exists ? file.size : 0, modifiedAt: exists ? file.modifiedAt : null };
}

const mcpPayload = {
  ok: true,
  servers: [
    {
      serverName: 'files',
      scope: 'user',
      transport: 'stdio',
      summary: 'npx -y @modelcontextprotocol/server-filesystem /tmp',
      enabled: true,
      status: { state: 'connected', tools: 14, error: null },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    },
    {
      serverName: 'remote',
      scope: 'workspace',
      transport: 'streamable-http',
      summary: 'https://example.com/mcp',
      enabled: false,
      status: { state: 'disabled', tools: 0, error: null },
      createdAt: '2026-10-02T00:00:00.000Z',
      updatedAt: '2026-11-03T00:00:00.000Z',
    },
  ],
  external: [
    {
      entryId: 'mcp-client:1',
      moduleName: '@deepseek-ai/dsh-mcp-client',
      serverName: 'ext-server',
      transport: 'stdio',
      summary: 'uvx ext-server',
      configurable: false,
    },
  ],
  warnings: [],
};

const skillDetail = {
  ...skillView,
  body: '# Location map\n\nRender a site-analysis board with real geography data.',
  raw: '---\nname: location-map\n---\n# Location map\n',
};

const instructionDetail = {
  ...instructionView,
  content: '# AGENTS\n\nPrefer targeted tests.',
};

const mcpDetail = {
  serverName: 'files',
  scope: 'user',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  cwd: '',
  env: { TOKEN: 's3cr3t-token' },
  enabled: true,
  toolCallTimeoutMs: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
  summary: 'npx -y @modelcontextprotocol/server-filesystem /tmp',
  status: { state: 'connected', tools: 14, error: null },
};

const fixtures = new Map([
  ['/api/dsh-agent-assets/bootstrap', bootstrapPayload],
  ['/api/dsh-agent-assets/skills', skillsPayload],
  ['/api/dsh-agent-assets/instructions', instructionsPayload],
  ['/api/dsh-agent-assets/mcp', mcpPayload],
]);

const fetchCalls = [];
function installFetchStub() {
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), method: options?.method || 'GET' });
    const key = String(url).split('?')[0];
    const payload = fixtures.get(key);
    if (!payload) {
      const body = { ok: false, error: { code: 'not_found', message: `no fixture for ${key}` } };
      return { ok: false, status: 404, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => payload };
  };
}

// ---------------------------------------------------------------------------------------
// Load the client module through the real module-loader contract
// ---------------------------------------------------------------------------------------

let definition = null;
globalThis.window = {
  __ModuleLoader__: {
    load(nextDefinition) {
      definition = nextDefinition;
    },
  },
};

const source = readFileSync(CLIENT_FILE, 'utf8');
// eslint-disable-next-line no-new-func
const loadClient = new Function('window', 'fetch', `${source}\n//# sourceURL=client.js`);
loadClient(globalThis.window, globalThis.fetch);

assert.ok(definition, 'client.js must call window.__ModuleLoader__.load');
assert.equal(definition.id, '@local/dsh-agent-assets');

const requireStub = (specifier) => {
  assert.equal(specifier, 'react', `client.js must not require "${specifier}" (React only)`);
  return React;
};
const clientModule = definition.factory(requireStub);
assert.deepEqual(clientModule.inject, ['slots', 'locale']);
assert.equal(typeof clientModule.apply, 'function');

// ---------------------------------------------------------------------------------------
// Fake client ctx: capture slot registrations
// ---------------------------------------------------------------------------------------

const localeState = { current: 'zh-CN' };
const registrations = [];
const effects = [];
const localeRegistrations = [];
const ctx = {
  locale: {
    register(namespace, dictionaries) {
      localeRegistrations.push({ namespace, dictionaries });
    },
    getSnapshot: () => ({ locale: localeState.current }),
    subscribe: () => () => {},
  },
  slots: {
    inject(_name, callback) {
      return callback();
    },
    register(options, Component) {
      registrations.push({ options, Component });
      return () => {};
    },
  },
  effect(setup, label) {
    effects.push({ setup, label });
  },
};

clientModule.apply(ctx);
assert.equal(registrations.length, 2, 'apply() must register exactly two slots');

const iconRegistration = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
const mainRegistration = registrations.find((entry) => entry.options.name === 'main');
assert.ok(iconRegistration, 'sidebar.panellist must be registered');
assert.equal(iconRegistration.options.id, 'agent-assets');
assert.equal(iconRegistration.options.order, 30);
assert.equal(iconRegistration.options.label(), 'Agent 资产');
assert.ok(mainRegistration, 'main must be registered');
assert.equal(mainRegistration.options.key, 'agent-assets');
assert.equal(typeof mainRegistration.options.inject, 'function');
const injectProps = mainRegistration.options.inject();
assert.equal(typeof injectProps.t, 'function');
assert.equal(typeof injectProps.subscribeLocale, 'function');
assert.ok(effects.length >= 1, 'apply() must register a disposal effect');


// ---------------------------------------------------------------------------------------
// SSR helpers
// ---------------------------------------------------------------------------------------

const reactWarnings = [];

function render(Component, props) {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => {
    const line = args.map((value) => (typeof value === 'string' ? value : String(value))).join(' ');
    errors.push(line);
    if (line.includes('Warning:')) reactWarnings.push(line);
  };
  try {
    const html = renderToStaticMarkup(h(Component, props));
    return { html, errors };
  } finally {
    console.error = originalError;
  }
}

function renderPage(initialState, hostProps = {}) {
  return render(mainRegistration.Component, { ...injectProps, initialState, ...hostProps });
}

/** Minimal `useSessions` stub matching the host hook contract: (selector) => selector(state). */
function stubUseSessions(state) {
  return (selector) => selector(state);
}

function selectedWorkspaceValue(html) {
  const match = html.match(/<option[^>]*value="([^"]*)"[^>]*selected[^>]*>/i);
  return match ? match[1] : null;
}

const PROFILE_DEFAULT = '/Users/tester/.dsh/profiles/desktop';

function profileBootstrap() {
  return {
    ...bootstrapPayload,
    defaultWorkspace: PROFILE_DEFAULT,
    workspaces: [
      { id: 'default', title: 'desktop', path: PROFILE_DEFAULT },
      { id: 'w1', title: 'dsh', path: '/ws' },
    ],
  };
}

function makeSeed(overrides = {}) {
  return {
    bootstrap: bootstrapPayload,
    workspace: '/ws',
    activeTab: 'skills',
    data: {
      skills: skillsPayload,
      instructions: instructionsPayload,
      mcp: mcpPayload,
    },
    views: {
      skills: { status: 'ready', error: null, at: Date.now() },
      instructions: { status: 'ready', error: null, at: Date.now() },
      mcp: { status: 'ready', error: null, at: Date.now() },
    },
    dialog: null,
    confirm: null,
    toasts: [],
    scopeFilter: 'all',
    query: '',
    ...overrides,
  };
}

const skillTarget = {
  kind: 'skill',
  scope: 'workspace',
  name: 'location-map',
  path: '/ws/.dsh/skills/location-map/SKILL.md',
  editable: true,
};

function expectContains(html, needles, label) {
  for (const needle of needles) {
    assert.ok(html.includes(needle), `${label}: expected HTML to contain ${JSON.stringify(needle)}`);
  }
}

function expectMissing(html, needles, label) {
  for (const needle of needles) {
    assert.ok(!html.includes(needle), `${label}: expected HTML NOT to contain ${JSON.stringify(needle)}`);
  }
}

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, ok: false, error });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------


await check('locale registration carries zh + en with identical key coverage', () => {
  assert.equal(localeRegistrations.length, 1, 'exactly one locale namespace must be registered');
  const registration = localeRegistrations[0];
  assert.equal(registration.namespace, 'agent-assets');
  const zhKeys = Object.keys(registration.dictionaries.zh).sort();
  const enKeys = Object.keys(registration.dictionaries.en).sort();
  assert.ok(zhKeys.length >= 150, `expected a full zh dictionary, got ${zhKeys.length} keys`);
  assert.deepEqual(zhKeys, enKeys, 'zh and en dictionaries must expose the same keys');
  for (const key of zhKeys) {
    assert.ok(registration.dictionaries.zh[key].length > 0, `empty zh copy for ${key}`);
    assert.ok(registration.dictionaries.en[key].length > 0, `empty en copy for ${key}`);
  }
  // Every key used in the page must resolve (spot-check via the exported translate function).
  for (const key of ['entry.label', 'page.title', 'action.save', 'state.error.title']) {
    assert.ok(registration.dictionaries.zh[key] && registration.dictionaries.en[key]);
  }
});

installFetchStub();
assert.ok(globalThis.fetch, 'fetch stub must be installed before rendering');

await check('active session cwd matching a registered workspace wins over the bootstrap default', () => {
  const seed = makeSeed({ workspace: undefined, bootstrap: profileBootstrap() });
  const { html } = renderPage(seed, {
    useSessions: stubUseSessions({ ids: ['s1'], byId: { s1: { cwd: '/ws' } } }),
  });
  expectContains(html, ['工作区级 · dsh'], 'session workspace wins');
  expectMissing(html, ['工作区级 · desktop'], 'session workspace wins (default not used)');
  assert.equal(selectedWorkspaceValue(html), '/ws', 'workspace selector must show the session workspace');
});

await check('session cwd is compared after normalizing separators/trailing slashes', () => {
  const seed = makeSeed({ workspace: undefined, bootstrap: profileBootstrap() });
  const { html } = renderPage(seed, {
    useSessions: stubUseSessions({ ids: ['s1'], byId: { s1: { cwd: '/ws/' } } }),
  });
  expectContains(html, ['工作区级 · dsh'], 'normalized session workspace');
  assert.equal(selectedWorkspaceValue(html), '/ws');
});

await check('fallback: any session row with a cwd is used when ids[0] has none', () => {
  const seed = makeSeed({ workspace: undefined, bootstrap: profileBootstrap() });
  const { html } = renderPage(seed, {
    useSessions: stubUseSessions({
      ids: ['blank', 's2'],
      byId: { blank: { cwd: '' }, s2: { cwd: '/ws' } },
    }),
  });
  expectContains(html, ['工作区级 · dsh'], 'fallback session cwd');
  assert.equal(selectedWorkspaceValue(html), '/ws');
});

await check('no session cwd available keeps the bootstrap default workspace', () => {
  const seed = makeSeed({ workspace: undefined, bootstrap: profileBootstrap() });
  const { html } = renderPage(seed, { useSessions: stubUseSessions({ ids: [], byId: {} }) });
  expectContains(html, ['工作区级 · desktop'], 'bootstrap default workspace');
  expectMissing(html, ['工作区级 · dsh'], 'bootstrap default workspace (no session override)');
  assert.equal(selectedWorkspaceValue(html), PROFILE_DEFAULT);
});

await check('session cwd outside the workspace registry keeps the bootstrap default', () => {
  const seed = makeSeed({ workspace: undefined, bootstrap: profileBootstrap() });
  const { html } = renderPage(seed, {
    useSessions: stubUseSessions({ ids: ['s1'], byId: { s1: { cwd: '/not/registered' } } }),
  });
  expectContains(html, ['工作区级 · desktop'], 'unregistered session cwd');
  assert.equal(selectedWorkspaceValue(html), PROFILE_DEFAULT);
});

await check('a workspace explicitly chosen in the page stays sticky over the session cwd', () => {
  const seed = makeSeed({ workspace: '/ws', bootstrap: profileBootstrap() });
  const { html } = renderPage(seed, {
    useSessions: stubUseSessions({ ids: ['s1'], byId: { s1: { cwd: PROFILE_DEFAULT } } }),
  });
  expectContains(html, ['工作区级 · dsh'], 'manual workspace is sticky');
  assert.equal(selectedWorkspaceValue(html), '/ws');
});

await check('malformed session snapshots are ignored without throwing', () => {
  const seed = makeSeed({ workspace: undefined, bootstrap: profileBootstrap() });
  const { html } = renderPage(seed, { useSessions: stubUseSessions({ ids: 'nope', byId: 'nope' }) });
  expectContains(html, ['工作区级 · desktop'], 'malformed session snapshot');
  assert.equal(selectedWorkspaceValue(html), PROFILE_DEFAULT);
});

await check('fetch fixtures are wired for every bootstrap/tab URL', async () => {
  // The stub is exercised directly; SSR never runs effects, so the page does not call it.
  // This keeps the network layer honest: no request can reach a real endpoint in this test.
  const urls = [...fixtures.keys()].map((url) => `${url}?workspace=%2Fws`);
  for (const url of urls) {
    const response = await globalThis.fetch(url, { method: 'GET' });
    assert.equal(response.ok, true, `fixture missing for ${url}`);
  }
  assert.ok(fetchCalls.length >= fixtures.size);
});

await check('sidebar icon renders the SVG mark at the owner size', () => {
  const active = render(iconRegistration.Component, { size: 18, active: true });
  expectContains(active.html, ['<svg', 'width="18"', 'height="18"', 'data-dsh-panel-entry="agent-assets"'], 'icon');
  const small = render(iconRegistration.Component, { size: 14, active: false });
  expectContains(small.html, ['width="14"', 'height="14"'], 'icon small');
});

await await check('page renders the initial loading state without throwing (zh)', () => {
  const { html } = renderPage(null);
  expectContains(
    html,
    ['<style', 'Agent 资产', '管理技能', '技能', 'MCP 服务', 'Agent 提示词', '正在加载', '新建技能'],
    'initial page',
  );
});

await check('page renders English copy after a locale switch', () => {
  localeState.current = 'en';
  try {
    const { html } = renderPage(makeSeed());
    expectContains(html, ['Agent Assets', 'Manage skills', 'Skills', 'MCP servers', 'Agent prompts', 'New skill'], 'en page');
  } finally {
    localeState.current = 'zh-CN';
  }
});

await check('skills tab renders grouped rows, counts and badges', () => {
  const { html, errors } = renderPage(makeSeed());
  expectContains(
    html,
    [
      'Agent 资产',
      'location-map',
      '区位图 / 区位分析图设计',
      'review',
      'office',
      '工作区级 · dsh',
      '用户级 · ~/.dsh',
      '内置（只读）',
      'project-dsh',
      '只读',
      '遮蔽 1',
      '1 条读取提示',
      '1 项',
    ],
    'skills tab',
  );
  assert.equal(errors.filter((line) => line.startsWith('Warning:')).length, 0, `React warnings: ${errors.join(' | ')}`);
});

await check('MCP tab renders servers, live status, switch and external note', () => {
  const { html } = renderPage(makeSeed({ activeTab: 'mcp' }));
  expectContains(
    html,
    ['files', '已连接 · 14 个工具', '已禁用', 'remote', '外部', 'ext-server', '作用范围', '新建 MCP'],
    'mcp tab',
  );
});

await check('instructions tab lists only existing files; count matches rows; hint keeps existing/total', () => {
  const { html } = renderPage(makeSeed({ activeTab: 'instructions' }));
  expectContains(
    html,
    ['AGENTS.md', '~/.dsh/AGENTS.md', './AGENTS.md', '已存在 2 / 3', '新建提示词文件'],
    'instructions existing rows',
  );
  expectMissing(html, ['CLAUDE.md', '未创建'], 'missing candidates must not render as rows');
  assert.equal(
    (html.match(/class="aa-row(?: is-selected)?"/g) || []).length,
    2,
    'only the two existing instruction files render as rows',
  );
});

await check('instruction create dialog offers every missing candidate from both scopes', () => {
  const files = [
    missingUserInstruction('/Users/tester/.dsh/AGENTS.md', '~/.dsh/AGENTS.md'),
    missingUserInstruction('/Users/tester/.agents/AGENTS.md', '~/.agents/AGENTS.md'),
    instructionView, // workspace AGENTS.md exists
    missingInstruction, // workspace CLAUDE.md missing
  ];
  const { html } = renderPage(
    makeSeed({
      activeTab: 'instructions',
      data: { skills: skillsPayload, mcp: mcpPayload, instructions: instructionsFixture(files) },
      dialog: {
        kind: 'editor',
        tab: 'instructions',
        mode: 'create',
        target: null,
        status: 'ready',
        error: null,
        initial: null,
      },
    }),
  );
  expectContains(
    html,
    ['工作区级 · CLAUDE.md', '用户级 · ~/.dsh/AGENTS.md', '用户级 · ~/.agents/AGENTS.md', '已存在 1 / 4'],
    'candidate picker both scopes',
  );
  assert.match(
    html,
    /<option[^>]*value="\/ws\/CLAUDE\.md"[^>]*selected/,
    'default selection must be the first missing workspace candidate',
  );
  expectMissing(html, ['value="/ws/AGENTS.md"'], 'existing files must not be offered as create targets');
});

await check('create dialog falls back to a missing user-scope candidate when no workspace candidate is missing', () => {
  const files = [
    missingUserInstruction('/Users/tester/.dsh/AGENTS.md', '~/.dsh/AGENTS.md'),
    missingUserInstruction('/Users/tester/.agents/AGENTS.md', '~/.agents/AGENTS.md'),
    instructionView,
    { ...instructionView, id: 'workspace|/ws/CLAUDE.md', file: 'CLAUDE.md', label: 'CLAUDE.md', path: '/ws/CLAUDE.md', displayPath: './CLAUDE.md' },
    { ...instructionView, id: 'workspace|/ws/AGENTS.local.md', file: 'AGENTS.local.md', label: 'AGENTS.local.md', path: '/ws/AGENTS.local.md', displayPath: './AGENTS.local.md' },
    { ...instructionView, id: 'workspace|/ws/CLAUDE.local.md', file: 'CLAUDE.local.md', label: 'CLAUDE.local.md', path: '/ws/CLAUDE.local.md', displayPath: './CLAUDE.local.md' },
  ];
  const { html } = renderPage(
    makeSeed({
      activeTab: 'instructions',
      data: { skills: skillsPayload, mcp: mcpPayload, instructions: instructionsFixture(files) },
      dialog: {
        kind: 'editor',
        tab: 'instructions',
        mode: 'create',
        target: null,
        status: 'ready',
        error: null,
        initial: null,
      },
    }),
  );
  expectContains(html, ['用户级 · ~/.agents/AGENTS.md', '用户级 · ~/.dsh/AGENTS.md'], 'user candidates offered');
  assert.match(
    html,
    /<option[^>]*value="\/Users\/tester\/\.agents\/AGENTS\.md"[^>]*selected/,
    'must default to the first missing user candidate when every workspace candidate exists',
  );
});

await check('an empty candidate array still counts as loaded (0 / 0 hint, empty state)', () => {
  const { html } = renderPage(
    makeSeed({
      activeTab: 'instructions',
      data: { skills: skillsPayload, mcp: mcpPayload, instructions: instructionsFixture([]) },
    }),
  );
  expectContains(html, ['还没有 Agent 提示词文件', '已存在 0 / 0', '新建提示词文件'], 'empty candidate array');
  const dialog = renderPage(
    makeSeed({
      activeTab: 'instructions',
      data: { skills: skillsPayload, mcp: mcpPayload, instructions: instructionsFixture([]) },
      dialog: {
        kind: 'editor',
        tab: 'instructions',
        mode: 'create',
        target: null,
        status: 'ready',
        error: null,
        initial: null,
      },
    }),
  );
  expectContains(dialog.html, ['没有可用的固定候选文件'], 'no candidates note');
});

await check('all-missing instruction candidates show the empty state, not placeholder rows', () => {
  const files = [
    withExists(instructionView, false),
    missingInstruction,
    withExists(userInstruction, false),
  ];
  const { html } = renderPage(
    makeSeed({
      activeTab: 'instructions',
      data: { skills: skillsPayload, mcp: mcpPayload, instructions: instructionsFixture(files) },
    }),
  );
  expectContains(html, ['还没有 Agent 提示词文件', '新建提示词文件', '已存在 0 / 3'], 'instructions empty state');
  expectMissing(html, ['未创建'], 'all-missing set must not render placeholder rows');
  assert.equal(
    (html.match(/class="aa-row(?: is-selected)?"/g) || []).length,
    0,
    'all-missing set must not render rows',
  );
});

await check('scope filter + search produce the empty-filter state', () => {
  const { html } = renderPage(makeSeed({ query: 'no-such-skill' }));
  expectContains(html, ['当前筛选下没有结果', '清除筛选'], 'empty filter');
});

await check('error view shows the localized error with the API code', () => {
  const { html } = renderPage(
    makeSeed({
      data: { skills: null, instructions: instructionsPayload, mcp: mcpPayload },
      views: {
        skills: { status: 'error', error: { code: 'internal', message: 'boom' }, at: 0 },
        instructions: { status: 'ready', error: null, at: Date.now() },
        mcp: { status: 'ready', error: null, at: Date.now() },
      },
    }),
  );
  expectContains(html, ['读取失败', 'internal', 'boom', '重试'], 'error view');
});

await check('unsupported category renders instead of an empty list', () => {
  const { html } = renderPage(
    makeSeed({
      bootstrap: { ...bootstrapPayload, supports: { skills: false, instructions: true, mcp: true } },
    }),
  );
  expectContains(html, ['当前 Host 不支持此分类', '技能'], 'unsupported');
});

await check('malformed API rows never crash the list', () => {
  const { html } = renderPage(
    makeSeed({
      data: {
        skills: { ok: true, skills: [{}], counts: null, warnings: [] },
        instructions: { ok: true, files: [{}], warnings: [] },
        mcp: { ok: true, servers: [{}], external: null, warnings: [] },
      },
    }),
  );
  assert.ok(html.includes('Agent 资产'));
});

await check('skill detail dialog renders description and body', () => {
  const { html } = renderPage(
    makeSeed({
      dialog: { kind: 'detail', tab: 'skills', target: skillTarget, status: 'ready', error: null, detail: skillDetail },
    }),
  );
  expectContains(
    html,
    ['技能 / location-map', '描述', '何时使用', 'Render a site-analysis board', '编辑', '删除', '关闭', 'project-dsh'],
    'skill detail',
  );
});

await check('instruction detail dialog renders the existing file content', () => {
  const { html } = renderPage(
    makeSeed({
      activeTab: 'instructions',
      dialog: {
        kind: 'detail',
        tab: 'instructions',
        target: instructionView,
        status: 'ready',
        error: null,
        detail: instructionDetail,
      },
    }),
  );
  expectContains(
    html,
    ['Agent 提示词 / AGENTS.md', '# AGENTS', 'Prefer targeted tests', '编辑', '删除', '关闭'],
    'instruction detail existing',
  );
  expectMissing(html, ['文件尚未创建'], 'existing instruction has no missing-file notice');
});

await check('MCP detail masks env secrets until revealed', () => {
  const { html } = renderPage(
    makeSeed({
      activeTab: 'mcp',
      dialog: {
        kind: 'detail',
        tab: 'mcp',
        target: { kind: 'mcp', scope: 'user', serverName: 'files', transport: 'stdio' },
        status: 'ready',
        error: null,
        detail: mcpDetail,
      },
    }),
  );
  expectContains(
    html,
    ['MCP 服务 / files', '••••••', 'TOKEN', 'npx', '已连接 · 14 个工具', '显示敏感值', '环境变量'],
    'mcp detail',
  );
  expectMissing(html, ['s3cr3t-token'], 'mcp detail masked');
});

await check('skill editor (create) renders the form and storage path note', () => {
  const { html } = renderPage(
    makeSeed({
      dialog: { kind: 'editor', tab: 'skills', mode: 'create', target: null, status: 'ready', error: null, initial: null },
    }),
  );
  expectContains(
    html,
    ['新建技能', '名称', '描述', '何时使用（可选）', '内容（Markdown）', '保存位置', '/.dsh/skills', '保存', '取消'],
    'skill editor',
  );
});

await check('skill editor (edit) pre-fills the existing skill', () => {
  const { html } = renderPage(
    makeSeed({
      dialog: {
        kind: 'editor',
        tab: 'skills',
        mode: 'edit',
        target: skillTarget,
        status: 'ready',
        error: null,
        initial: skillDetail,
      },
    }),
  );
  expectContains(html, ['编辑技能', 'location-map', 'Render a site-analysis board', '保存'], 'skill edit');
});

await check('instruction editor (create) lists missing fixed candidates', () => {
  const { html } = renderPage(
    makeSeed({
      activeTab: 'instructions',
      dialog: {
        kind: 'editor',
        tab: 'instructions',
        mode: 'create',
        target: null,
        status: 'ready',
        error: null,
        initial: null,
      },
    }),
  );
  expectContains(html, ['新建提示词文件', '工作区级 · CLAUDE.md', '内容', '保存'], 'instruction editor');
  expectMissing(html, ['<option value="/ws/AGENTS.md"'], 'instruction editor candidates');
});

await check('MCP editor (create) renders transport-specific fields and the plaintext warning', () => {
  const { html } = renderPage(
    makeSeed({
      activeTab: 'mcp',
      dialog: { kind: 'editor', tab: 'mcp', mode: 'create', target: null, status: 'ready', error: null, initial: null },
    }),
  );
  expectContains(
    html,
    ['新建 MCP 服务', '传输方式', 'stdio', 'streamable-http', '命令', '参数（每行一个）', '环境变量', '启用', '明文'],
    'mcp editor',
  );
});

await check('MCP editor (edit) pre-fills command, args and env text', () => {
  const { html } = renderPage(
    makeSeed({
      activeTab: 'mcp',
      dialog: {
        kind: 'editor',
        tab: 'mcp',
        mode: 'edit',
        target: { kind: 'mcp', scope: 'user', serverName: 'files', transport: 'stdio' },
        status: 'ready',
        error: null,
        initial: mcpDetail,
      },
    }),
  );
  expectContains(html, ['编辑 MCP 服务', 'npx', '@modelcontextprotocol/server-filesystem', 'TOKEN=s3cr3t-token'], 'mcp edit');
});

await check('destructive confirm names the target and exact path, defaults to cancel', () => {
  const { html } = renderPage(makeSeed({ confirm: { tab: 'skills', target: skillTarget } }));
  expectContains(
    html,
    ['删除技能', 'location-map', '/ws/.dsh/skills/location-map/SKILL.md', '取消', '删除'],
    'confirm dialog',
  );
  const cancelIndex = html.indexOf('data-autofocus="true"');
  assert.ok(cancelIndex > -1, 'confirm dialog must mark the cancel button as the initial focus');
});

await check('success and error toasts render with the API code', () => {
  const { html } = renderPage(
    makeSeed({
      toasts: [
        { id: 1, kind: 'success', message: '技能「location-map」已创建', detail: null },
        { id: 2, kind: 'error', message: '操作失败', detail: 'conflict: already exists' },
      ],
    }),
  );
  expectContains(html, ['技能「location-map」已创建', '操作失败', 'conflict: already exists'], 'toasts');
});

await await check('guarded page renders with every payload absent', () => {
  // Client-side error boundaries cannot be exercised under SSR (React rethrows server render
  // errors), so this asserts the registered component (already wrapped by the boundary) still
  // renders the loading/empty path without data.
  const { html } = renderPage(makeSeed({ data: { skills: null, instructions: null, mcp: null } }));
  assert.ok(html.length > 0);
  expectContains(html, ['Agent 资产', 'aa-skeleton-row'], 'guarded page');
});

// ---------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------

await check('all seeded renders are free of React warnings', () => {
  assert.deepEqual(reactWarnings, [], `React warnings:\n${reactWarnings.join('\n')}`);
});

const failed = checks.filter((entry) => !entry.ok);
const skippedFetchChecks = fetchCalls.length;

console.log('');
console.log(`client.js render test: ${checks.length - failed.length}/${checks.length} checks passed`);
console.log(`fixtures: ${fixtures.size} API payloads; fetch stub calls: ${skippedFetchChecks} (SSR does not run effects)`);
if (failed.length > 0) {
  console.error('FAILURES:');
  for (const entry of failed) console.error(` - ${entry.name}: ${entry.error.stack || entry.error.message}`);
  process.exitCode = 1;
}
