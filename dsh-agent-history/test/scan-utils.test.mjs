import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readJsonl } from '../host/scan-utils.js';

test('readJsonl rejects with AbortError when aborted mid-file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-jsonl-'));
  try {
    const file = join(dir, 'big.jsonl');
    await writeFile(file, '{"a":1}\n'.repeat(400_000));
    const controller = new AbortController();
    let lines = 0;
    await assert.rejects(
      readJsonl(file, () => { if (++lines === 10) controller.abort(); }, { signal: controller.signal }),
      { name: 'AbortError' },
    );
    await assert.rejects(readJsonl(file, () => {}, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal((await readJsonl(file, () => {})).lines, 400_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fileUriToPath keeps the server of a UNC share and the drive of a Windows path', async () => {
  const { fileUriToPath } = await import('../host/scan-utils.js');
  assert.equal(fileUriToPath('file:///Users/me/my%20proj/'), '/Users/me/my proj');
  assert.equal(fileUriToPath('file:///c%3A/Users/me/p'), 'c:/Users/me/p');
  assert.equal(fileUriToPath('file:///C:/'), 'C:/');
  assert.equal(fileUriToPath('file://localhost/C:/w'), 'C:/w');
  assert.equal(fileUriToPath('file://nas/team/project'), '\\\\nas\\team\\project');
  assert.equal(fileUriToPath('file://nas/team/project/'), '\\\\nas\\team\\project');
  assert.equal(fileUriToPath('file:////nas/team/project'), '\\\\nas\\team\\project');
  assert.equal(fileUriToPath('vscode-remote://ssh/x'), '');
  assert.equal(fileUriToPath('/plain/path'), '');
});
