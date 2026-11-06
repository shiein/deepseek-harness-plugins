#!/usr/bin/env node
/**
 * Provider self-test: runs one history provider (or all of them) against this machine's real local
 * data and prints what it found. Uses the same ScanContext the Host builds, so a provider that
 * works here works in the panel.
 *
 * Usage:
 *   E="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
 *   ELECTRON_RUN_AS_NODE=1 "$E" host/providers/self-test.mjs claude-code
 *   ELECTRON_RUN_AS_NODE=1 "$E" host/providers/self-test.mjs --all
 *   ELECTRON_RUN_AS_NODE=1 "$E" host/providers/self-test.mjs --messages claude-code:<nativeId>
 */

import { loadProviders } from './index.js';
import { makeScanContext } from '../context.js';
import { HistoryCache } from '../cache.js';
import { finalizeSession, finalizeMessages } from '../model.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const messagesArgIndex = args.indexOf('--messages');
const onlyMessages = messagesArgIndex >= 0 ? args[messagesArgIndex + 1] || '' : '';
const all = args.includes('--all');
const messageProviderId = onlyMessages.includes(':') ? onlyMessages.split(':')[0] : onlyMessages;
const wanted = args.filter((arg) => !arg.startsWith('--') && arg !== onlyMessages);

const providers = await loadProviders();
if (providers.length === 0) {
  console.log('no providers found');
  process.exit(1);
}

const cache = new HistoryCache({ filePath: join(tmpdir(), `dsh-agent-history-selftest-${process.pid}.json`), providerVersions: Object.fromEntries(providers.map((p) => [p.meta.id, p.meta.cacheVersion ?? 1])) });
await cache.load();

/** The scanner hands providers a providerId-bound 2-arg cache face; mirror it here. */
function boundCache(providerId) {
  return {
    get: (filePath, fingerprint) => cache.get(providerId, filePath, fingerprint),
    set: (filePath, fingerprint, rows) => cache.set(providerId, filePath, fingerprint, rows),
    touch: (filePath) => cache.touch(providerId, filePath),
  };
}

async function runProvider(provider) {
  const id = provider.meta.id;
  const warnings = [];
  const started = Date.now();
  const ctx = makeScanContext({ providerId: id, cache: boundCache(id), signal: new AbortController().signal, warnings });
  if (provider.error) {
    console.log(`\n=== ${id} BROKEN: ${provider.error.message || provider.error}`);
    return;
  }
  const result = await provider.scan(ctx);
  const sessions = (result.sessions || []).map((raw) => finalizeSession(id, raw)).filter(Boolean);
  console.log(`\n=== ${id} (${provider.meta.name}) in ${Date.now() - started}ms`);
  for (const source of result.sources || []) {
    console.log(`  source ${source.exists ? 'OK ' : 'MISS'} ${source.path} files=${source.files} bytes=${source.bytes}${source.note ? ` — ${source.note}` : ''}`);
  }
  console.log(`  sessions: ${sessions.length}`);
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const session of sorted.slice(0, 6)) {
    console.log(`  · ${new Date(session.updatedAt || 0).toISOString()} [${session.messages} msg] ${session.projectPath || '(no project)'}`);
    console.log(`      ${session.title}`);
    console.log(`      id=${session.nativeId}  ${session.preview.slice(0, 90)}`);
  }
  if (warnings.length > 0) {
    console.log('  warnings:');
    for (const warning of warnings) console.log(`  ! ${warning}`);
  }
  return sessions;
}

async function runMessages(provider, target) {
  if (!target || typeof provider.readMessages !== 'function') {
    console.log(`\n=== ${provider.meta.id} has no readMessages()`);
    return;
  }
  const sessions = await runProvider(provider);
  const session = sessions.find((entry) => entry.nativeId === target || entry.id === target);
  if (!session) {
    console.log(`  (no session matched ${target})`);
    return;
  }
  const warnings = [];
  const ctx = makeScanContext({ providerId: provider.meta.id, cache: boundCache(provider.meta.id), signal: new AbortController().signal, warnings });
  const result = await provider.readMessages(ctx, session);
  const messages = finalizeMessages(result.messages || []);
  console.log(`  transcript messages: ${messages.length}`);
  for (const message of messages.slice(0, 12)) {
    console.log(`  [${message.role}${message.kind ? `/${message.kind}` : ''}] ${message.text.replace(/\s+/g, ' ').slice(0, 140)}`);
  }
  for (const warning of warnings) console.log(`  ! ${warning}`);
}

const targets = onlyMessages
  ? providers.filter((provider) => provider.meta.id === messageProviderId)
  : all
    ? providers
    : providers.filter((provider) => wanted.includes(provider.meta.id));
if (targets.length === 0) {
  console.log(`no provider matched ${wanted.join(', ')}; available: ${providers.map((p) => p.meta.id).join(', ')}`);
  process.exit(1);
}

for (const provider of targets) {
  if (onlyMessages) {
    await runMessages(provider, onlyMessages.split(':').slice(1).join(':'));
  } else {
    await runProvider(provider);
  }
}
