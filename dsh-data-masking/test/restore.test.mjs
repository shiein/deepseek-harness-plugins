import assert from 'node:assert/strict';
import test from 'node:test';
import { Masker, Vault, compileRules, defaultRules, normalizeRules } from '../host/engine.js';
import { holdBackIndex, restoreStream, restoreText } from '../host/restore.js';

const SECRET = Buffer.alloc(32, 3);

function setup() {
  const rules = defaultRules();
  rules.categories.find((c) => c.code === 'PERSON').terms = ['张三丰'];
  rules.categories.find((c) => c.code === 'ADDR').terms = ['路 "90" 号\\B座\n二层'];
  const matcher = compileRules(normalizeRules(rules), SECRET);
  const masker = new Masker(matcher);
  const vault = new Vault(matcher);
  return { masker, vault };
}

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

async function* fromArray(chunks) {
  for (const chunk of chunks) yield chunk;
}

test('mask then restore is the identity', () => {
  const { masker, vault } = setup();
  const original = '负责人张三丰，地址：路 "90" 号\\B座\n二层。张三丰';
  const masked = masker.maskText(original, vault, []);
  assert.ok(!masked.includes('张三丰'));
  assert.equal(restoreText(masked, vault), original);
});

test('text restore survives a split at every position', async () => {
  const { masker, vault } = setup();
  const original = '前缀 {{ 模板 }} 张三丰 中间 张三丰{尾';
  const masked = masker.maskText(original, vault, []);
  for (let cut = 0; cut <= masked.length; cut += 1) {
    for (let cut2 = cut; cut2 <= masked.length; cut2 += 3) {
      const parts = [masked.slice(0, cut), masked.slice(cut, cut2), masked.slice(cut2)];
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        ...parts.map((text) => ({ type: 'text-delta', index: 0, text })),
        { type: 'block-end', index: 0, block: { type: 'text', text: masked } },
        { type: 'finish', reason: { kind: 'stop' } },
      ];
      const out = await collect(restoreStream(fromArray(chunks), vault));
      const streamed = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
      assert.equal(streamed, original, `cut at ${cut}/${cut2}`);
      assert.equal(out.find((c) => c.type === 'block-end').block.text, original);
      assert.equal(out.at(-1).type, 'finish');
    }
  }
});

test('tool-call arguments restore with JSON escaping at every split', async () => {
  const { masker, vault } = setup();
  const args = { command: `printf '%s' '张三丰' > out.txt`, address: '路 "90" 号\\B座\n二层' };
  const maskedJson = masker.maskJson(JSON.stringify(args), vault, []);
  assert.ok(!maskedJson.includes('张三丰'));
  for (let cut = 0; cut <= maskedJson.length; cut += 1) {
    const chunks = [
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: 'c1', name: 'bash', argumentsDelta: maskedJson.slice(0, cut) },
      { type: 'tool-call-delta', index: 1, id: 'c1', argumentsDelta: maskedJson.slice(cut) },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name: 'bash', arguments: maskedJson } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ];
    const out = await collect(restoreStream(fromArray(chunks), vault));
    const streamed = out.filter((c) => c.type === 'tool-call-delta').map((c) => c.argumentsDelta).join('');
    assert.deepEqual(JSON.parse(streamed), args, `cut at ${cut}`);
    assert.deepEqual(JSON.parse(out.find((c) => c.type === 'block-end').block.arguments), args);
    assert.equal(out[1].name, 'bash', 'first delta keeps the tool name');
  }
});

test('held text is flushed when a stream ends without block-end', async () => {
  const { masker, vault } = setup();
  const masked = masker.maskText('张三丰', vault, []);
  const chunks = [
    { type: 'text-delta', index: 0, text: masked.slice(0, 5) },
    { type: 'tool-call-delta', index: 1, id: 'x', argumentsDelta: '{"a":"' + masked.slice(0, 4) },
    { type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT', message: 't' } } },
  ];
  const out = await collect(restoreStream(fromArray(chunks), vault));
  assert.equal(out.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), masked.slice(0, 5));
  assert.equal(out.filter((c) => c.type === 'tool-call-delta').map((c) => c.argumentsDelta).join(''), '{"a":"' + masked.slice(0, 4));
  assert.equal(out.find((c) => c.type === 'tool-call-delta' && c.argumentsDelta.includes('{{')).id, 'x');
  assert.equal(out.at(-1).type, 'finish');
});

test('replayState and unknown chunks pass through untouched; unknown tokens stay', async () => {
  const { masker, vault } = setup();
  const masked = masker.maskText('张三丰', vault, []);
  const replayState = { reasoning: masked };
  const chunks = [
    { type: 'usage', usage: { input: 1 } },
    { type: 'text-delta', index: 0, text: `${masked} {{PERSON_000000}}` },
    { type: 'block-end', index: 0, block: { type: 'text', text: `${masked} {{PERSON_000000}}` } },
    { type: 'finish', reason: { kind: 'stop' }, replayState },
  ];
  const out = await collect(restoreStream(fromArray(chunks), vault));
  assert.equal(out[0].type, 'usage');
  assert.equal(out.find((c) => c.type === 'block-end').block.text, '张三丰 {{PERSON_000000}}');
  assert.equal(out.at(-1).replayState, replayState);
});

test('holdBackIndex only holds real placeholder prefixes', () => {
  assert.equal(holdBackIndex('abc'), 3);
  assert.equal(holdBackIndex('abc{'), 3);
  assert.equal(holdBackIndex('abc{{PER'), 3);
  assert.equal(holdBackIndex('abc{{PERSON_1a'), 3);
  assert.equal(holdBackIndex('abc{{ x'), 7);
  assert.equal(holdBackIndex('const a = {b}'), 13);
  assert.equal(holdBackIndex('{{PERSON_abcdef}}'), 17);
});
