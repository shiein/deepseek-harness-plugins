#!/usr/bin/env node
/**
 * End-to-end check against a real DSH desktop install, in a throwaway $DSH_HOME (your ~/.dsh is
 * never touched). A local mock Anthropic-Messages endpoint stands in for DeepSeek and records every
 * request body, so the test asserts what would actually have left the machine.
 *
 *   node test/e2e/headless.mjs            (DSH_CLI overrides the dsh launcher path)
 *
 * Scenarios: masked dispatch + restore into files; session-log field absent; resume with masking
 * off does not upload the backlog; corrupted rules block requests; web_fetch with protected data is
 * denied by the tool guard.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DSH = process.env.DSH_CLI || '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
if (!existsSync(DSH)) {
  console.log(`skip: DSH launcher not found at ${DSH}`);
  process.exit(0);
}

// Throwaway key for the mock provider only; generated so no key-shaped literal is committed.
const FAKE_API_KEY = `sk-${randomBytes(16).toString('hex')}`;
const SENSITIVE = ['张三丰', '华东大区', '风控二部', '天穹计划', '杭州市西湖区文三路90号', 'EMP-881234'];
const TOKEN_RE = /\{\{[A-Z][A-Z0-9]*_[0-9a-f]{6,16}\}\}/g;

// ---------------------------------------------------------------- mock provider
const wire = [];
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}
const start = (id) => ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }];
const stop = (reason) => [['message_delta', { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 5 } }], ['message_stop', { type: 'message_stop' }]];
const text = (index, value, cut = Math.floor(value.length / 2)) => [
  ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: value.slice(0, cut) } }],
  ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: value.slice(cut) } }],
  ['content_block_stop', { type: 'content_block_stop', index }],
];
const thinking = (index, value) => [
  ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: value } }],
  ['content_block_stop', { type: 'content_block_stop', index }],
];
const toolUse = (index, id, name, input, cutAfter) => {
  const json = JSON.stringify(input);
  const cut = cutAfter && json.includes(cutAfter) ? json.indexOf(cutAfter) + 5 : Math.floor(json.length / 2);
  return [
    ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, cut) } }],
    ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(cut) } }],
    ['content_block_stop', { type: 'content_block_stop', index }],
  ];
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    wire.push(j);
    const tools = j.tools ?? [];
    if (tools.length === 0) return sse(res, [start('title'), ...text(0, '标题'), ...stop('end_turn')]);
    const firstUser = JSON.stringify(j.messages[0]);
    const results = j.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'tool_result') : []));
    const seen = [...new Set(JSON.stringify(j.messages).match(TOKEN_RE) ?? [])];
    if (firstUser.includes('CHILDTASK')) {
      return sse(res, [start('child'), ...text(0, `子任务完成：${seen.join('、')}`), ...stop('end_turn')]);
    }
    if (firstUser.includes('SUBAGENT')) {
      if (results.length === 0) return sse(res, [start('s1'), ...toolUse(0, 's1', 'subagent', { description: '查询负责人', prompt: `CHILDTASK 查询 ${seen[0]} 的信息并汇报` }), ...stop('tool_use')]);
      return sse(res, [start('s2'), ...text(0, `汇总：${JSON.stringify(results[0].content)}`), ...stop('end_turn')]);
    }
    if (firstUser.includes('WEBFETCH')) {
      if (results.length === 0) return sse(res, [start('w1'), ...toolUse(0, 'w1', 'web_fetch', { url: `https://example.com/search?q=${seen[0]}` }), ...stop('tool_use')]);
      return sse(res, [start('w2'), ...text(0, `fetch result: ${JSON.stringify(results[0].content)}`), ...stop('end_turn')]);
    }
    if (results.length === 0) return sse(res, [start('m1'), ...toolUse(0, 'c1', 'bash', { command: 'cat data.txt', description: 'read' }), ...stop('tool_use')]);
    if (results.length === 1) {
      const tokens = [...new Set(JSON.stringify(results[0]).match(TOKEN_RE) ?? [])];
      const command = `printf '%s\\n' ${tokens.map((t) => `'${t}'`).join(' ')} > result.txt`;
      return sse(res, [start('m2'), ...thinking(0, `写入 ${tokens[0]}`), ...toolUse(1, 'c2', 'bash', { command, description: 'write' }, tokens[0]), ...stop('tool_use')]);
    }
    const reply = `完成：${seen.join('、')}`;
    return sse(res, [start('m3'), ...text(0, reply, reply.indexOf('{{') + 4), ...stop('end_turn')]);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// ---------------------------------------------------------------- scratch DSH home
const home = mkdtempSync(join(tmpdir(), 'dsh-masking-e2e-'));
const profile = join(home, 'profiles', 'maskingtest');
mkdirSync(join(profile, 'node_modules', '@local'), { recursive: true });
symlinkSync(PLUGIN_DIR, join(profile, 'node_modules', '@local', 'dsh-data-masking'));
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-maskingtest',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@local/dsh-data-masking'] } },
}));
writeFileSync(join(profile, 'cordis.yml'), '[]\n');
writeFileSync(join(profile, 'cordis.patch.yml'), [
  '- id: llm-deepseek',
  "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
  '  config:',
  `    baseURL: http://127.0.0.1:${port}`,
  '    apiKeyEnv: DEEPSEEK_API_KEY',
  '- id: agent-default-model',
  "  name: '@deepseek-ai/dsh-agent-default-model'",
  '  config:',
  '    provider: deepseek-official',
  '    model: deepseek-flash',
  '',
].join('\n'));
const work = join(home, 'work');
mkdirSync(work);
writeFileSync(join(work, 'data.txt'), '负责人：张三丰（工号 EMP-881234），所属 华东大区 风控二部\n项目代号：天穹计划\n办公地址：杭州市西湖区文三路90号\n');
const dataDir = join(home, 'data-masking');
mkdirSync(dataDir);
const rules = {
  enabled: true,
  categories: [
    { id: 'region', code: 'REGION', label: '区域', terms: ['华东大区'] },
    { id: 'dept', code: 'DEPT', label: '部门', terms: ['风控二部'] },
    { id: 'term', code: 'TERM', label: '术语', terms: ['天穹计划'] },
    { id: 'person', code: 'PERSON', label: '人员', terms: ['张三丰'] },
    { id: 'addr', code: 'ADDR', label: '地址', terms: ['杭州市西湖区文三路90号'] },
  ],
  patterns: [{ id: 'emp', code: 'EMPID', label: '员工号段', regex: 'EMP-88\\d{4}' }],
  blockedTools: ['web_search', 'web_fetch'],
};
const writeRules = (value) => writeFileSync(join(dataDir, 'rules.json'), typeof value === 'string' ? value : JSON.stringify(value));

// Async on purpose: the mock provider lives in this process and must keep serving while dsh runs.
function runDsh(task, extra = []) {
  return new Promise((resolve) => {
    const child = spawn(DSH, ['--profile', 'maskingtest', '--permission-mode', 'workspace-write', '--approval-policy', 'never', ...extra, task], {
      cwd: work,
      env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: FAKE_API_KEY },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
const leaks = (bodies) => SENSITIVE.filter((word) => bodies.some((b) => JSON.stringify(b).includes(word)));
const history = () => (existsSync(join(dataDir, 'history.jsonl')) ? readFileSync(join(dataDir, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (error) {
    results.push(['FAIL', name, error.message]);
  }
}

let sessionId;
await scenario('masked dispatch, restored tool calls and reply', async () => {
  writeRules(rules);
  const before = wire.length;
  const run = await runDsh('请读取 data.txt，把负责人张三丰的信息整理到 result.txt');
  assert.equal(run.code, 0, run.stderr);
  const bodies = wire.slice(before);
  assert.ok(bodies.length >= 3, `expected >=3 requests, got ${bodies.length}`);
  assert.deepEqual(leaks(bodies), [], 'originals reached the provider');
  assert.ok(bodies.every((b) => !('dsh_session_log' in b)), 'dsh_session_log must not be sent');
  assert.equal(readFileSync(join(work, 'result.txt'), 'utf8'), `${['张三丰', 'EMP-881234', '华东大区', '风控二部', '天穹计划', '杭州市西湖区文三路90号'].join('\n')}\n`);
  for (const word of ['张三丰', '天穹计划']) assert.ok(run.stdout.includes(word), `reply not restored: ${run.stdout}`);
  const masks = history().filter((e) => e.kind === 'mask');
  assert.ok(masks.length >= 1);
  assert.ok(!JSON.stringify(history()).includes('张三丰'), 'history must not contain values');
  sessionId = JSON.parse(readFileSync(join(dataDir, 'protected-sessions.json'), 'utf8'))[0];
  assert.match(sessionId, /^session-/);
});

await scenario('masking off: protected session still never uploads its session log', async () => {
  writeRules({ ...rules, enabled: false });
  const before = wire.length;
  const run = await runDsh('继续', ['--session-id', sessionId]);
  assert.equal(run.code, 0, run.stderr);
  const bodies = wire.slice(before);
  assert.ok(bodies.length >= 1);
  assert.ok(bodies.every((b) => !('dsh_session_log' in b)), 'backlog uploaded after masking was turned off');
});

await scenario('masking off: a new session is not masked and uploads normally', async () => {
  const before = wire.length;
  const run = await runDsh('请读取 data.txt，把负责人张三丰的信息整理到 result.txt');
  assert.equal(run.code, 0, run.stderr);
  const bodies = wire.slice(before);
  assert.ok(leaks(bodies).includes('张三丰'), 'expected plain traffic when masking is off');
  assert.ok(bodies.some((b) => 'dsh_session_log' in b), 'expected session log upload for an unprotected session');
});

await scenario('corrupted rules file blocks every request (fail closed)', async () => {
  writeRules('{ broken json');
  const before = wire.length;
  const run = await runDsh('请联系张三丰');
  assert.notEqual(run.code, 0);
  assert.equal(wire.length, before, 'a request reached the provider');
  assert.match(run.stderr, /DATA_MASKING_BLOCKED|数据脱敏/);
});

await scenario('web_fetch with protected data is denied by the tool guard', async () => {
  writeRules(rules);
  const before = wire.length;
  const run = await runDsh('WEBFETCH 查一下张三丰');
  assert.equal(run.code, 0, run.stderr);
  const bodies = wire.slice(before);
  assert.deepEqual(leaks(bodies), []);
  const toolResult = JSON.stringify(bodies.at(-1).messages);
  assert.match(toolResult, /web_fetch 会把参数发送到外部服务/);
  assert.ok(history().some((e) => e.kind === 'tool-block' && e.tool === 'web_fetch'));
});

await scenario('sub-agent requests are masked too', async () => {
  writeRules(rules);
  const before = wire.length;
  const run = await runDsh('SUBAGENT 让子 Agent 查一下张三丰');
  assert.equal(run.code, 0, run.stderr);
  const bodies = wire.slice(before);
  const child = bodies.filter((b) => JSON.stringify(b.messages[0]).includes('CHILDTASK'));
  assert.ok(child.length >= 1, 'no sub-agent request observed');
  assert.match(JSON.stringify(child[0].messages[0]), /\{\{PERSON_[0-9a-f]{6}\}\}/);
  assert.deepEqual(leaks(bodies), [], 'originals reached the provider');
  assert.ok(bodies.every((b) => !('dsh_session_log' in b)));
});

server.close();
for (const [status, name, detail] of results) console.log(`${status}  ${name}${detail ? `\n      ${detail}` : ''}`);
console.log(`scratch home: ${home}`);
process.exit(results.some(([status]) => status === 'FAIL') ? 1 : 0);
