import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { apply, revealCommand } from '../index.js';

const root = mkdtempSync(join(tmpdir(), 'bf-open-'));
after(() => rmSync(root, { recursive: true, force: true }));
const project = join(root, 'project');
mkdirSync(join(project, 'src'), { recursive: true });
writeFileSync(join(root, 'secret.txt'), 'x');
symlinkSync(join(root, 'secret.txt'), join(project, 'src', 'link.txt'));

const routes = new Map();
apply({ get: () => undefined, webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {}; } }, effect: (fn) => fn(), logger: { warn() {} } });
async function post(body) {
  const request = new EventEmitter();
  request.method = 'POST';
  request.socket = { remoteAddress: '127.0.0.1' };
  request.headers = { host: '127.0.0.1:3080' };
  request[Symbol.asyncIterator] = async function* chunks() { yield Buffer.from(JSON.stringify(body)); };
  let status = 0;
  let text = '';
  const response = new EventEmitter();
  response.writeHead = (code) => { status = code; return response; };
  response.end = (chunk) => { text = String(chunk ?? ''); };
  await routes.get('/api/dsh-business-flow/open-file')(request, response);
  return { status, body: JSON.parse(text) };
}

test('open-file refuses paths outside the project, links out of it, and missing files', async () => {
  assert.equal((await post({ projectPath: project, file: '../secret.txt' })).status, 403);
  assert.equal((await post({ projectPath: project, file: 'src/link.txt' })).status, 403);
  assert.equal((await post({ projectPath: project, file: 'src/missing.js' })).status, 404);
  assert.equal((await post({ projectPath: project, file: 'src' })).status, 400);
});

test('files are revealed or opened as text, never run', () => {
  assert.deepEqual(revealCommand('/p/x.command', 'darwin'), { command: '/usr/bin/open', args: ['-t', '/p/x.command'] });
  const windows = revealCommand('C:\\p\\run.bat', 'win32');
  assert.match(windows.command, /explorer\.exe$/);
  assert.deepEqual(windows.args, ['/select,C:\\p\\run.bat']);
  assert.deepEqual(revealCommand('/p/a/x.sh', 'linux'), { command: 'xdg-open', args: ['/p/a'] });
});
