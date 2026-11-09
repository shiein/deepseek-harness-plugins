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
