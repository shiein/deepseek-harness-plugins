import assert from 'node:assert/strict';
import { test } from 'node:test';
import { posixResumeScript } from '../host/launch.js';

const plan = { kind: 'cli', command: 'codex', args: ['resume', "it's"], cwd: '/work/my proj' };

test('the resume script loads ~/.zshrc so version-managed runtimes are on PATH', () => {
  const script = posixResumeScript(plan, null, 'codex resume');
  assert.equal(script.split('\n')[0], '#!/bin/zsh -il');
  assert.match(script, /^cd '\/work\/my proj' \|\|/m);
  assert.match(script, /^'codex' 'resume' 'it'\\''s'$/m);
});

test('a resolved CLI puts its own folder first on PATH', () => {
  const script = posixResumeScript(plan, '/Users/u/.nvm/versions/node/v24/bin/codex', 'codex resume');
  assert.match(script, /^export PATH='\/Users\/u\/\.nvm\/versions\/node\/v24\/bin':"\$PATH"$/m);
  assert.match(script, /^'\/Users\/u\/\.nvm\/versions\/node\/v24\/bin\/codex' 'resume'/m);
});

test('a session whose project folder is gone is not resumed somewhere else', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { launchInTerminal } = await import('../host/launch.js');
  const dataDir = await mkdtemp(join(tmpdir(), 'ah-launch-'));
  try {
    const result = await launchInTerminal({ ...plan, cwd: join(dataDir, 'deleted-project') }, { dataDir });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'cwdMissing');
    const notFolder = await launchInTerminal({ ...plan, cwd: import.meta.filename }, { dataDir });
    assert.equal(notFolder.code, 'cwdMissing', 'a file is not a project folder');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
