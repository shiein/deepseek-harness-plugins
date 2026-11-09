/**
 * Session turn correlation: overlapping requests on one analysis Session must each get the answer
 * of their own turn. Runs against a synthetic sessionController (queue semantics, durable seq).
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { apply } from '../index.js';

const projectDir = mkdtempSync(join(tmpdir(), 'business-flow-turn-'));
const graphJson = JSON.stringify({ business: 'checkout', nodes: [{ id: 'n1', name: 'Order', kind: 'process' }], edges: [] });
const cleanupDirs = [projectDir];
after(() => { for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true }); });

/**
 * Fake Session: prompts queue up and run one turn at a time
 * (user/message → assistant/message → turn/end). `answerFor` decides each turn's reply.
 */
function fakeController({ withRpcId = true, answerFor, endReason = { kind: 'completed' } }) {
  const records = [];
  const bus = new EventEmitter();
  const queue = [];
  let busy = false;
  let seq = 0;
  const emit = (type, data) => {
    const event = { type, seq: ++seq, time: Date.now(), data };
    records.push({ event });
    bus.emit('event', event);
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const pump = async () => {
    if (busy) return;
    busy = true;
    while (queue.length > 0) {
      const request = queue.shift();
      const text = request.content[0].text;
      const source = withRpcId ? { kind: 'user', rpcId: request.requestId } : { kind: 'user' };
      emit('user/message', { message: { role: 'user', source, content: [{ type: 'text', text }] } });
      await tick();
      emit('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: answerFor(text) }] } });
      await tick();
      emit('turn/end', { reason: endReason });
    }
    busy = false;
  };
  return {
    prompts: [],
    async prompt(request) {
      this.prompts.push(request);
      queue.push(request);
      setTimeout(pump, 1);
      return { accepted: true };
    },
    follow(_request, signal) {
      const pending = [];
      let wake;
      const onEvent = (event) => {
        pending.push({ type: 'event', event });
        wake?.();
      };
      bus.on('event', onEvent);
      let opened = false;
      let done = false;
      const close = () => {
        done = true;
        bus.off('event', onEvent);
        wake?.();
      };
      signal?.addEventListener('abort', close, { once: true });
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (!opened) {
            opened = true;
            return { done: false, value: { type: 'snapshot', records: [...records] } };
          }
          while (pending.length === 0 && !done) await new Promise((resolve) => { wake = resolve; });
          if (pending.length > 0) return { done: false, value: pending.shift() };
          return { done: true, value: undefined };
        },
        async return() {
          close();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/** Fake `agents` service; `withSession: false` models a handle the sandbox mode cannot be set on. */
function fakeAgents(log = [], { withSession = true } = {}) {
  return {
    disposed: 0,
    async create({ sessionId }) {
      const session = { append: (type, data) => log.push({ type, data }) };
      return {
        agent: { id: sessionId, ...(withSession ? { session } : {}) },
        dispose: async () => { this.disposed += 1; },
      };
    },
  };
}

function mountPlugin(controller, agents = fakeAgents()) {
  const routes = new Map();
  const services = { sessionController: controller, agents };
  const ctx = {
    get: (name) => services[name],
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
    effect(fn) {
      fn();
    },
    logger: { warn() {} },
  };
  apply(ctx);
  return routes;
}

/** Drive one route handler with a loopback request carrying a JSON body. */
async function call(routes, path, body) {
  const handler = routes.get(`/api/dsh-business-flow${path}`);
  assert.ok(handler, `route ${path} is registered`);
  const request = new EventEmitter();
  request.method = 'POST';
  request.socket = { remoteAddress: '127.0.0.1' };
  request.headers = { host: '127.0.0.1:3080' };
  const payload = Buffer.from(JSON.stringify(body));
  request[Symbol.asyncIterator] = async function* chunks() {
    yield payload;
  };
  let status = 0;
  let text = '';
  const response = new EventEmitter();
  response.writableFinished = false;
  response.writeHead = (code) => {
    status = code;
    return response;
  };
  response.setHeader = () => {};
  response.statusCode = 0;
  response.end = (chunk) => {
    text = String(chunk ?? '');
    response.writableFinished = true;
    status ||= response.statusCode;
  };
  await handler(request, response);
  return { status, body: JSON.parse(text) };
}

const draftBody = (requirement) => ({
  projectPath: projectDir,
  sessionId: 'session-shared',
  business: 'checkout',
  node: { id: 'n1', name: 'Order service', files: [] },
  requirement,
});

for (const withRpcId of [true, false]) {
  test(`overlapping drafts on one Session each get their own answer (rpcId ${withRpcId ? 'present' : 'absent'})`, async () => {
    const controller = fakeController({
      withRpcId,
      answerFor: (text) => `answer:${/REQ-(\w+)/.exec(text)?.[1] ?? '?'}`,
    });
    const routes = mountPlugin(controller);
    const [first, second, third] = await Promise.all([
      call(routes, '/draft', draftBody('REQ-alpha add a coupon field')),
      call(routes, '/draft', draftBody('REQ-beta validate stock')),
      call(routes, '/draft', draftBody('REQ-gamma audit log')),
    ]);
    assert.equal(first.body.prompt, 'answer:alpha');
    assert.equal(second.body.prompt, 'answer:beta');
    assert.equal(third.body.prompt, 'answer:gamma');
    assert.equal(controller.prompts.length, 3);
  });
}

test('a new analysis Session is read-only before its first prompt', async () => {
  const log = [];
  const controller = fakeController({ answerFor: () => 'ok' });
  const prompt = controller.prompt.bind(controller);
  controller.prompt = (request) => { log.push({ type: 'prompt' }); return prompt(request); };
  const { sessionId: _unused, ...body } = draftBody('REQ-x anything');
  const result = await call(mountPlugin(controller, fakeAgents(log)), '/draft', body);
  assert.equal(result.status, 200);
  assert.deepEqual(log, [{ type: 'sandbox/mode', data: { mode: 'read-only' } }, { type: 'prompt' }]);
});

test('an analysis that cannot be made read-only never starts', async () => {
  const controller = fakeController({ answerFor: () => 'ok' });
  const agents = fakeAgents([], { withSession: false });
  const { sessionId: _unused, ...body } = draftBody('REQ-x anything');
  const result = await call(mountPlugin(controller, agents), '/draft', body);
  assert.equal(result.status, 503);
  assert.equal(controller.prompts.length, 0);
  assert.equal(agents.disposed, 1);
});

test('credentials never reach the prompt, while ordinary code and config stay readable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'business-flow-secrets-'));
  cleanupDirs.push(dir);
  writeFileSync(join(dir, 'application.yml'), [
    'server:',
    '  port: 8080',
    'spring:',
    '  datasource:',
    '    url: jdbc:mysql://root:urlsecret1@db.internal/orders',
    '    password: yamlsecret1',
    '  redis:',
    '    api-key: yamlsecret2',
  ].join('\n'));
  writeFileSync(join(dir, 'application-prod.yml'), 'marker: prodfilesecret\n');
  writeFileSync(join(dir, 'config.xml'), '<db><password>xmlsecret1</password><name>orders</name></db>');
  writeFileSync(join(dir, 'auth-service.js'), [
    'const apiKey = "codesecret1";',
    'const leaked = "sk-abcdefghijklmnopqrstuvwxyz123456";',
    'const token = getToken();',
    'export const PEM = `-----BEGIN RSA PRIVATE KEY-----',
    'pemsecret1',
    '-----END RSA PRIVATE KEY-----`;',
  ].join('\n'));
  const controller = fakeController({ answerFor: () => graphJson });
  const result = await call(mountPlugin(controller), '/analyze', { projectPath: dir, business: 'orders' });
  assert.equal(result.status, 200);
  const prompt = controller.prompts[0].content[0].text;
  for (const secret of ['urlsecret1', 'yamlsecret1', 'yamlsecret2', 'prodfilesecret', 'xmlsecret1', 'codesecret1', 'abcdefghijklmnop', 'pemsecret1']) {
    assert.ok(!prompt.includes(secret), secret);
  }
  for (const kept of ['port: 8080', 'db.internal/orders', '<name>orders</name>', 'const token = getToken();']) {
    assert.ok(prompt.includes(kept), kept);
  }
  // A node's files are excerpted under the same rules.
  const draftController = fakeController({ answerFor: () => 'a prompt' });
  await call(mountPlugin(draftController), '/draft', {
    projectPath: dir,
    node: { id: 'n1', name: 'Order', files: ['application-prod.yml', 'application.yml'] },
    requirement: 'x',
  });
  const draftPrompt = draftController.prompts[0].content[0].text;
  assert.ok(!draftPrompt.includes('prodfilesecret') && !draftPrompt.includes('yamlsecret1'));
});

test('a failed turn is an error, not an answer built from its mid-work message', async () => {
  const controller = fakeController({ answerFor: () => 'let me check the files first', endReason: { kind: 'error', error: { message: 'model overloaded' } } });
  const result = await call(mountPlugin(controller), '/draft', draftBody('REQ-x anything'));
  assert.equal(result.status, 502);
  assert.match(result.body.error.message, /did not finish \(error: model overloaded\)/);
});

for (const [label, wrap] of [
  ['a stray unbalanced brace', (json) => `路由写法是 /api/{id 这样。\n${json}`],
  ['prose in balanced braces', (json) => `{说明 ${json} 结束}`],
]) {
  test(`the graph is still found after ${label} in the model's output`, async () => {
    const controller = fakeController({ answerFor: () => wrap(graphJson) });
    const result = await call(mountPlugin(controller), '/analyze', { projectPath: projectDir, sessionId: 'session-shared', business: 'checkout' });
    assert.equal(result.status, 200);
    assert.equal(result.body.graph.nodes[0].name, 'Order');
  });
}

test('the loopback fence accepts only this server as the request source', async () => {
  const routes = mountPlugin(fakeController({ answerFor: () => '' }));
  const statusFor = async (headers, method = 'GET') => {
    const request = new EventEmitter();
    request.method = method;
    request.socket = { remoteAddress: '127.0.0.1' };
    request.headers = { host: '127.0.0.1:3080', ...headers };
    request[Symbol.asyncIterator] = async function* chunks() {};
    let status = 0;
    const response = new EventEmitter();
    response.writeHead = (code) => { status = code; return response; };
    response.end = () => {};
    await routes.get('/api/dsh-business-flow/ping')(request, response);
    return status;
  };
  assert.equal(await statusFor({}), 200);
  assert.equal(await statusFor({ origin: 'http://127.0.0.1:3080' }), 200);
  assert.equal(await statusFor({ origin: 'http://127.0.0.1:5173' }), 403);
  assert.equal(await statusFor({ referer: 'http://localhost:3080/page' }), 403);
  assert.equal(await statusFor({ origin: 'null' }), 403);
  assert.equal(await statusFor({ host: '127.0.0.1.evil.example' }), 403);
  assert.equal(await statusFor({ 'content-type': 'text/plain' }, 'POST'), 403);
  assert.equal(await statusFor({ 'content-type': 'application/json; charset=utf-8' }, 'POST'), 405);
});

test('a turn still running from an earlier prompt is skipped when ids are visible', async () => {
  const controller = fakeController({
    answerFor: (text) => `answer:${/REQ-(\w+)/.exec(text)?.[1] ?? '?'}`,
  });
  // A foreign prompt (e.g. a cancelled earlier request) is already queued on the Session.
  await controller.prompt({
    requestId: 'foreign',
    sessionId: 'session-shared',
    mode: 'queue',
    content: [{ type: 'text', text: 'REQ-stale leftover' }],
  });
  // Let that turn start, so its user/message is already in the snapshot when our follow opens.
  await new Promise((resolve) => setTimeout(resolve, 3));
  const routes = mountPlugin(controller);
  const result = await call(routes, '/draft', draftBody('REQ-fresh new requirement'));
  assert.equal(result.body.prompt, 'answer:fresh');
});
