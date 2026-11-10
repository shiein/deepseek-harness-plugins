import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { TranscriptReaderPool } from '../host/transcript-reader-pool.js';

const WORKER = new URL('../host/transcript-worker.js', import.meta.url);
const EXIT_WORKER = new URL('./fixtures/exit-worker.mjs', import.meta.url);
const session = { id: 'nobody:1', agentId: 'no-such-agent', nativeId: '1', ref: {} };

test('reads run on a worker thread that stops when idle', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ah-pool-'));
  const pool = new TranscriptReaderPool(WORKER, { dataDir, idleMs: 50 });
  try {
    const [a, b] = await Promise.all([pool.read(session), pool.read(session)]);
    assert.deepEqual(a, { supported: false, messages: [] });
    assert.deepEqual(b, a);
    assert.equal(pool.running, true);
    await delay(150);
    assert.equal(pool.running, false, 'idle worker stopped');
    assert.deepEqual(await pool.read(session), a, 'a later read starts a new worker');
  } finally {
    pool.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a crashed worker fails the reads in flight and the next read starts over', async () => {
  const pool = new TranscriptReaderPool(EXIT_WORKER, { dataDir: tmpdir() });
  await assert.rejects(pool.read(session), /exited with code 3/);
  assert.equal(pool.running, false);
  await assert.rejects(pool.read(session), /exited with code 3/);
  pool.dispose();
  await assert.rejects(pool.read(session), /disposed/);
});
