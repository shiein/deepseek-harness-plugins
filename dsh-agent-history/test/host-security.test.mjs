/**
 * Resume launcher quoting and the loopback fence.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { apply } from '../index.js';
import {
  copyableCommand, findWindowsTerminal, launchInTerminal, windowsResumeScript, windowsTerminalArgs,
} from '../host/launch.js';

const root = mkdtempSync(join(tmpdir(), 'agent-history-security-'));
after(() => rmSync(root, { recursive: true, force: true }));

const posixShell = process.platform !== 'win32' && existsSync('/bin/zsh');

test('a session id or folder name cannot run commands in the resume script', { skip: !posixShell }, async () => {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'open'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'open'), 0o755);
  const marker = join(root, 'executed');
  const payload = `$(touch ${marker})`;
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const plan = {
    kind: 'cli', command: '/usr/bin/true', args: ['--resume', `abc${payload}\`touch ${marker}\``], cwd,
    display: `/usr/bin/true --resume abc${payload}\`touch ${marker}\``,
  };
  const dataDir = join(root, 'data');
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    assert.equal((await launchInTerminal(plan, { dataDir, config: {} })).ok, true);
  } finally {
    process.env.PATH = originalPath;
  }
  const launchDir = join(dataDir, 'launch');
  const script = join(launchDir, readdirSync(launchDir).find((name) => name.startsWith('resume-')));
  const output = execFileSync('/bin/zsh', [script], { encoding: 'utf8' });
  assert.equal(existsSync(marker), false, 'the payload must stay literal text');
  assert.ok(output.includes(payload), 'the command line is still shown');

  const missing = { ...plan, cwd: join(root, `gone${payload}`) };
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    await new Promise((resolve) => setTimeout(resolve, 2));
    await launchInTerminal(missing, { dataDir, config: {} });
  } finally {
    process.env.PATH = originalPath;
  }
  const newest = readdirSync(launchDir).filter((name) => name.startsWith('resume-')).sort().pop();
  try {
    execFileSync('/bin/zsh', [join(launchDir, newest)], { encoding: 'utf8' });
    assert.fail('a missing folder must exit non-zero');
  } catch (error) {
    assert.equal(error.status, 1);
  }
  assert.equal(existsSync(marker), false, 'the missing-folder message must not expand it either');
});

test('launch reports what the launcher actually did', { skip: process.platform === 'win32' }, async () => {
  const plan = { kind: 'cli', command: '/usr/bin/true', args: [], cwd: root, display: 'x' };
  const withOpen = async (dirName, script) => {
    const bin = join(root, dirName);
    mkdirSync(bin);
    if (script !== undefined) {
      writeFileSync(join(bin, 'open'), script);
      chmodSync(join(bin, 'open'), 0o755);
    }
    const originalPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      return await launchInTerminal(plan, { dataDir: join(root, 'launch-results'), config: {} });
    } finally {
      process.env.PATH = originalPath;
    }
  };
  const ok = await withOpen('open-ok', '#!/bin/sh\nexit 0\n');
  assert.equal(ok.ok, true);
  const refused = await withOpen('open-fail', "#!/bin/sh\necho 'Unable to find application named X' >&2\nexit 1\n");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Unable to find application/);
  const missing = await withOpen('open-missing');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /cannot run open/);
});

test('Windows Terminal is found on PATH or under WindowsApps', () => {
  const apps = join(root, 'wt-apps');
  mkdirSync(join(apps, 'Microsoft', 'WindowsApps'), { recursive: true });
  const alias = join(apps, 'Microsoft', 'WindowsApps', 'wt.exe');
  writeFileSync(alias, '');
  assert.equal(findWindowsTerminal({ PATH: join(root, 'nowhere'), LOCALAPPDATA: apps }), alias);
  assert.equal(findWindowsTerminal({ PATH: `${join(root, 'nowhere')};${join(apps, 'Microsoft', 'WindowsApps')}` }), alias);
  assert.equal(findWindowsTerminal({ PATH: join(root, 'nowhere') }), null);
});

test('the Windows resume script keeps paths and percent signs literal', () => {
  const script = windowsResumeScript('C:\\My Work\\100%done', 'devin', ['--resume', 'abc%PATH%']);
  assert.deepEqual(script.split('\r\n'), [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "C:\\My Work\\100%%done"',
    'devin --resume "abc%%PATH%%"',
    '',
  ]);
  assert.ok(!windowsResumeScript('C:\\a', 'devin', ['x\r\necho injected']).includes('\r\necho injected'));
  assert.deepEqual(windowsTerminalArgs('C:\\a;b', 'C:\\x y\\r.cmd'), ['-d', 'C:\\a\\;b', 'cmd.exe', '/k', 'C:\\x y\\r.cmd']);
});

test('the copyable command quotes only what needs quoting', { skip: process.platform === 'win32' }, () => {
  const plan = { kind: 'cli', command: 'codex', args: ['resume', 'abc$(id)', '--cd', '/a b'], cwd: '/tmp/x', display: 'x' };
  assert.equal(copyableCommand(plan), "cd '/tmp/x' && codex resume 'abc$(id)' --cd '/a b'");
});

test('the loopback fence accepts only this server as the request source', async () => {
  const routes = new Map();
  apply({
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {}; } },
    effect: (fn) => { fn(); },
  }, { dataDir: join(root, 'fence') });
  const statusFor = async (headers, method = 'GET') => {
    const request = { method, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080', ...headers } };
    let status = 0;
    const response = new EventEmitter();
    response.writeHead = (code) => { status = code; };
    response.end = () => {};
    await routes.get('/api/dsh-agent-history/health')(request, response);
    return status;
  };
  assert.equal(await statusFor({}), 200);
  assert.equal(await statusFor({ origin: 'http://127.0.0.1:3080' }), 200);
  assert.equal(await statusFor({ host: '127.0.0.1.evil.example' }), 403);
  assert.equal(await statusFor({ origin: 'http://127.0.0.1:5173' }), 403);
  assert.equal(await statusFor({ origin: 'null' }), 403);
  assert.equal(await statusFor({ 'sec-fetch-site': 'cross-site' }), 403);
  assert.equal(await statusFor({ 'content-type': 'text/plain' }, 'POST'), 403);
  assert.equal(await statusFor({}, 'POST'), 405, 'a bodyless POST (the Client scan) passes the fence');
});
