/**
 * The merged timeline says when a long session was cut down to its latest messages.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TranscriptReader } from '../host/transcript.js';

const session = { id: 's1', updatedAt: 1 };
const messages = (count, text = 'hello') => Array.from({ length: count }, (_, index) => ({ role: 'user', ts: index + 1, text: `${text} ${index}` }));
const readerOf = (list) => new TranscriptReader({ read: async () => ({ supported: true, messages: list }) });

test('a session still being written re-reads when its source changes, and only then', async () => {
  let reads = 0;
  let version = 'v1';
  const reader = new TranscriptReader({
    read: async () => { reads += 1; return { supported: true, messages: messages(reads) }; },
    version: async () => version,
  });
  const signal = new AbortController().signal;
  assert.equal((await reader.get(session, signal)).messages.length, 1);
  assert.equal((await reader.get(session, signal)).messages.length, 1, 'unchanged source stays cached');
  version = 'v2';
  assert.equal((await reader.get(session, signal)).messages.length, 2);
  assert.equal(reads, 2);
});

test('a short session is not marked truncated', async () => {
  const result = await readerOf(messages(10)).getForTimeline(session, new AbortController().signal);
  assert.equal(result.truncated, false);
  assert.equal(result.messages.length, 10);
});

test('a session over the message limit keeps its tail and says so, also from the cache', async () => {
  const reader = readerOf(messages(400));
  const first = await reader.getForTimeline(session, new AbortController().signal);
  assert.equal(first.truncated, true);
  assert.equal(first.messages.length, 300);
  assert.equal(first.messages[299].text, 'hello 399');
  assert.equal((await reader.getForTimeline(session, new AbortController().signal)).truncated, true);
});

test('a session cut by the character budget is marked even under the message limit', async () => {
  const result = await readerOf(messages(150, 'x'.repeat(19_990))).getForTimeline(session, new AbortController().signal);
  assert.equal(result.truncated, true);
  assert.ok(result.messages.length <= 150);
});

test('repeated full-text search over more sessions than the transcript cache reads each one once', async () => {
  let reads = 0;
  const reader = new TranscriptReader({
    read: async () => { reads += 1; return { supported: true, messages: [{ role: 'user', ts: 1, text: 'needle' }, { role: 'assistant', kind: 'tool-call', ts: 2, text: 'tool' }] }; },
  });
  const sessions = Array.from({ length: 200 }, (_, index) => ({ id: `s${index}`, updatedAt: 1 }));
  const signal = new AbortController().signal;
  for (let round = 0; round < 2; round += 1) {
    reader.retainSearch(new Set(sessions.map((item) => item.id)));
    for (const item of sessions) assert.deepEqual(await reader.getSearchText(item, signal), [{ text: 'needle', ts: 1 }]);
  }
  assert.equal(reads, 200, 'the second search is served from the search cache');
  assert.equal(reader.cache.size, 0, 'search does not evict the transcripts the user opened');
});

test('concurrent requests for one session version share one read; a failed read is retried', async () => {
  let reads = 0;
  let fail = true;
  const reader = new TranscriptReader({
    read: async () => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (fail) throw new Error('boom');
      return { supported: true, messages: messages(3) };
    },
  });
  const signal = new AbortController().signal;
  const failed = await Promise.allSettled([reader.get(session, signal), reader.get(session, signal), reader.getSearchText(session, signal)]);
  assert.deepEqual(failed.map((item) => item.status), ['rejected', 'rejected', 'rejected']);
  assert.equal(reads, 1);
  fail = false;
  const results = await Promise.all([1, 2, 3, 4].map(() => reader.get(session, signal)));
  assert.equal(reads, 2);
  assert.ok(results.every((item) => item.messages.length === 3));
});
