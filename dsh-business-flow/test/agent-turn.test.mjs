/**
 * Session turn correlation: overlapping requests on one analysis Session must each get the answer
 * of their own turn. Runs against a synthetic sessionController (queue semantics, durable seq).
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { apply } from '../index.js';

const projectDir = mkdtempSync(join(tmpdir(), 'business-flow-turn-'));
after(() => rmSync(projectDir, { recursive: true, force: true }));

/**
 * Fake Session: prompts queue up and run one turn at a time
 * (user/message → assistant/message → turn/end). `answerFor` decides each turn's reply.
 */
function fakeController({ withRpcId = true, answerFor }) {
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
      emit('turn/end', { reason: { kind: 'completed' } });
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

function mountPlugin(controller) {
  const routes = new Map();
  const ctx = {
    get: (name) => (name === 'sessionController' ? controller : undefined),
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
