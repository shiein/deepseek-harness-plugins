import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Vault, defaultRules, normalizeRules } from '../host/engine.js';
import { BLOCKED_CODE, Interceptor } from '../host/interceptor.js';
import { maskRequest } from '../host/request.js';
import { Store } from '../host/store.js';

function freshStore(rules) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-masking-test-'));
  const store = new Store(dir);
  if (rules) store.saveRules(rules);
  return store;
}

function enabledRules() {
  const rules = defaultRules();
  rules.enabled = true;
  rules.categories.find((c) => c.code === 'PERSON').terms = ['张三丰'];
  rules.categories.find((c) => c.code === 'DEPT').terms = ['风控二部'];
  return normalizeRules(rules);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function request(text = '请联系张三丰') {
  return deepFreeze({
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    sessionId: 'session-1',
    system: '你在风控二部工作',
    tools: [{ name: 'bash', description: '运行命令（风控二部专用）', parameters: { type: 'object', properties: { command: { type: 'string', description: '命令' } } } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text }, { type: 'file', attachment: { id: 'f1' } }, { type: 'custom-plugin-block', payload: { note: '张三丰' } }], source: { kind: 'user', label: '张三丰' } },
      { role: 'assistant', content: [{ type: 'reasoning', text: '想到张三丰' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"echo 张三丰"}' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '张三丰\n' }] }] },
    ],
  });
}

function fakeLlm(captured) {
  return {
    fileRequestText: (ref) => `[file ${ref.id} saved at /work/张三丰.txt]`,
    async *adapterStream(options) {
      captured.push(options);
      const token = JSON.stringify(options).match(/\{\{PERSON_[0-9a-f]{6}\}\}/)[0];
      yield { type: 'text-delta', index: 0, text: `好的，${token}` };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `好的，${token}` } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

async function drain(stream) {
  const out = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

test('masks every string leaf, keeps structure, restores the reply', async () => {
  const store = freshStore(enabledRules());
  const core = new Interceptor({ store });
  const captured = [];
  let nextCalled = false;
  const out = await drain(core.onStream(request(), () => { nextCalled = true; }, fakeLlm(captured)));
  assert.equal(nextCalled, false);
  const sent = JSON.stringify(captured[0]);
  // Only the provider-owned `source` metadata keeps the raw value; it is never serialized to the wire.
  assert.equal(sent.replace(JSON.stringify(captured[0].messages[0].source), '').includes('张三丰'), false);
  assert.equal(sent.includes('风控二部'), false);
  assert.equal(captured[0].messages[0].content[1].type, 'text', 'file block projected before masking');
  assert.equal(captured[0].messages[1].content[1].name, 'bash');
  assert.equal(captured[0].messages[1].content[1].id, 'c1');
  assert.equal(captured[0].tools[0].name, 'bash');
  assert.equal(out.find((c) => c.type === 'block-end').block.text, '好的，张三丰');
  const history = store.readHistory().entries;
  assert.equal(history.length, 1);
  assert.equal(history[0].kind, 'mask');
  assert.ok(!JSON.stringify(history).includes('张三丰'), 'history never stores values');
  assert.deepEqual(JSON.parse(readFileSync(store.paths.sessions, 'utf8')), ['session-1']);

  // Same history again: no new history entry (values already recorded for this session).
  await drain(core.onStream(request(), () => {}, fakeLlm([])));
  assert.equal(store.readHistory().entries.length, 1);
});

test('maskRequest leaves requests without hits untouched', () => {
  const core = new Interceptor({ store: freshStore(enabledRules()) });
  const options = deepFreeze({ provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
  const hits = [];
  assert.equal(maskRequest(options, core.masker, new Vault(core.matcher), hits, () => ''), options);
  assert.equal(hits.length, 0);
});

test('disabled masking passes straight through', async () => {
  const core = new Interceptor({ store: freshStore() });
  let called = false;
  core.onStream(request(), () => { called = true; return []; }, fakeLlm([]));
  assert.equal(called, true);
  assert.equal(core.excludeSessionLog({ sessionId: 'session-x' }), false);
});

test('fail closed: corrupt rules file blocks every request', async () => {
  const store = freshStore();
  store.ensureDir();
  writeFileSync(store.paths.rules, '{ not json');
  const core = new Interceptor({ store });
  const captured = [];
  const out = await drain(core.onStream(request(), () => { throw new Error('must not pass through'); }, fakeLlm(captured)));
  assert.equal(captured.length, 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason.failure.code, BLOCKED_CODE);
  assert.match(out[0].reason.failure.message, /规则文件/);
  assert.equal(core.excludeSessionLog({ sessionId: 'any' }), true);
});

test('fail closed: missing adapter seam, session-log guard not ready, masking error', async () => {
  const core = new Interceptor({ store: freshStore(enabledRules()), sessionLogPresent: () => true });
  let out = await drain(core.onStream(request(), () => { throw new Error('no'); }, fakeLlm([])));
  assert.match(out[0].reason.failure.message, /Session Log/);
  core.exclusionActive = true;
  out = await drain(core.onStream(request(), () => { throw new Error('no'); }, { fileRequestText: () => '' }));
  assert.match(out[0].reason.failure.message, /内部接口/);
  const broken = { ...fakeLlm([]), fileRequestText: undefined };
  out = await drain(core.onStream(request(), () => { throw new Error('no'); }, broken));
  assert.match(out[0].reason.failure.message, /文件引用投影/);
});

test('session-log exclusion persists after masking is turned off', async () => {
  const store = freshStore(enabledRules());
  const core = new Interceptor({ store });
  await drain(core.onStream(request(), () => {}, fakeLlm([])));
  core.saveRules({ ...core.rules, enabled: false });
  const reloaded = new Interceptor({ store });
  assert.equal(reloaded.active, false);
  assert.equal(reloaded.excludeSessionLog({ sessionId: 'session-1' }), true);
  assert.equal(reloaded.excludeSessionLog({ sessionId: 'session-2' }), false);
});

test('tool guard: network tools with protected data, and unresolved placeholders', () => {
  const store = freshStore(enabledRules());
  const core = new Interceptor({ store });
  assert.match(core.guardTool({ name: 'web_search', arguments: { query: '张三丰 风控二部' } }), /web_search.*人员、部门/);
  assert.equal(core.guardTool({ name: 'web_search', arguments: { query: 'node streams' } }), undefined);
  assert.equal(core.guardTool({ name: 'bash', arguments: { command: 'echo 张三丰' } }), undefined);
  assert.match(core.guardTool({ name: 'write', arguments: { content: 'x {{PERSON_123456}}' } }), /无法还原/);
  core.saveRules({ ...core.rules, blockedTools: ['mcp__remote__*'] });
  assert.match(core.guardTool({ name: 'mcp__remote__post', arguments: { body: '张三丰' } }), /mcp__remote__post/);
  assert.equal(core.guardTool({ name: 'mcp__local__read', arguments: { body: '张三丰' } }), undefined);
  const kinds = store.readHistory().entries.map((e) => e.kind);
  assert.ok(kinds.every((k) => k === 'tool-block'));
  assert.ok(!JSON.stringify(store.readHistory()).includes('张三丰'));
});

test('preview uses draft rules without saving them', () => {
  const store = freshStore(enabledRules());
  const core = new Interceptor({ store });
  const draft = normalizeRules({ ...core.rules, categories: [{ id: 'x', code: 'TERM', label: '术语', terms: ['天穹计划'] }] });
  const result = core.preview('天穹计划与张三丰', draft);
  assert.match(result.masked, /^\{\{TERM_[0-9a-f]{6}\}\}与张三丰$/);
  assert.equal(result.items[0].label, '术语');
  assert.equal(core.preview('张三丰').items[0].code, 'PERSON');
});

test('guard: literal placeholders from files pass, quoted terms are still caught', async () => {
  const rules = enabledRules();
  rules.categories.find((c) => c.code === 'TERM').terms = ['A "quoted" \\ term'];
  const store = freshStore(normalizeRules(rules));
  const core = new Interceptor({ store });
  // The README of some project literally contains a placeholder-shaped example.
  const options = deepFreeze({ provider: 'p', model: 'm', sessionId: 's', messages: [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: '示例：{{PERSON_abcdef}} 与 张三丰' }] }] }] });
  await drain(core.onStream(options, () => {}, fakeLlm([])));
  assert.equal(core.guardTool({ name: 'edit', arguments: { new_str: '示例：{{PERSON_abcdef}}' } }), undefined);
  assert.match(core.guardTool({ name: 'edit', arguments: { new_str: '{{PERSON_fedcba}}' } }), /无法还原/);
  assert.match(core.guardTool({ name: 'web_search', arguments: { query: 'about A "quoted" \\ term' } }), /术语/);
});

test('a broken rules file never echoes its content into errors or history', async () => {
  const store = freshStore();
  store.ensureDir();
  writeFileSync(store.paths.rules, '{"categories":[{"code":"PERSON","label":"人员","terms":["绝密人名",]}]}');
  const core = new Interceptor({ store });
  assert.ok(core.rulesError);
  assert.ok(!core.rulesError.includes('绝密人名'), core.rulesError);
  await drain(core.onStream(request(), () => {}, fakeLlm([])));
  assert.ok(!readFileSync(store.paths.history, 'utf8').includes('绝密人名'));
});

test('history can be filtered by session', () => {
  const store = freshStore();
  store.appendHistory({ kind: 'mask', sessionId: 'a' });
  store.appendHistory({ kind: 'mask', sessionId: 'b' });
  store.appendHistory({ kind: 'block', sessionId: 'a' });
  assert.deepEqual(store.readHistory({ sessionId: 'a' }).entries.map((e) => e.kind), ['block', 'mask']);
  assert.equal(store.readHistory().entries.length, 3);
});
