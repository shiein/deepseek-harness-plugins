/**
 * Codex compressed rollouts: `*.jsonl.zst` archives must count the same tokens as the plain JSONL,
 * and a rollout present in both forms (or in sessions/ and archived_sessions/) must count once.
 *
 *   node host/tools/codex-zstd.mjs
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

import * as codex from '../providers/codex.js';
import * as utils from '../scan-utils.js';

let failures = 0;
let checks = 0;
function check(label, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${detail}`}`);
}

const rollout = [
  { timestamp: '2026-03-04T10:00:00Z', type: 'turn_context', payload: { model: 'gpt-5-codex' } },
  {
    timestamp: '2026-03-04T10:00:05Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 },
        total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 },
      },
    },
  },
].map((line) => JSON.stringify(line)).join('\n') + '\n';

async function scan(home) {
  const saved = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  const warnings = [];
  try {
    const result = await codex.scan({
      providerId: 'codex',
      signal: new AbortController().signal,
      env: { home },
      utils,
      cache: { get: () => undefined, set: () => {} },
      warn: (message) => warnings.push(message),
    });
    let tokens = 0;
    for (const cell of result.cells) tokens += cell.input + cell.output + cell.cacheRead + cell.cacheWrite;
    return { tokens, warnings, sources: result.sources };
  } finally {
    if (saved !== undefined) process.env.CODEX_HOME = saved;
  }
}

const root = await mkdtemp(join(tmpdir(), 'dsh-agent-usage-codex-zstd-'));
try {
  const stem = 'rollout-2026-03-04T10-00-00-0199a0b0-0000-7000-8000-000000000001';

  // 1) plain JSONL baseline
  const plainHome = join(root, 'plain');
  await mkdir(join(plainHome, '.codex', 'sessions', '2026', '03', '04'), { recursive: true });
  await writeFile(join(plainHome, '.codex', 'sessions', '2026', '03', '04', `${stem}.jsonl`), rollout);
  const plain = await scan(plainHome);
  check('plain rollout counts 120 tokens', plain.tokens === 120, JSON.stringify(plain));

  // 2) the same rollout, zstd-compressed in archived_sessions
  const zstHome = join(root, 'zst');
  await mkdir(join(zstHome, '.codex', 'archived_sessions'), { recursive: true });
  await writeFile(join(zstHome, '.codex', 'archived_sessions', `${stem}.jsonl.zst`), zlib.zstdCompressSync(rollout));
  const zst = await scan(zstHome);
  check('compressed rollout counts the same 120 tokens', zst.tokens === 120 && zst.warnings.length === 0, JSON.stringify(zst));

  // 3) both forms present (and in both directories): counted once
  const bothHome = join(root, 'both');
  await mkdir(join(bothHome, '.codex', 'sessions', '2026', '03', '04'), { recursive: true });
  await mkdir(join(bothHome, '.codex', 'archived_sessions'), { recursive: true });
  await writeFile(join(bothHome, '.codex', 'sessions', '2026', '03', '04', `${stem}.jsonl`), rollout);
  await writeFile(join(bothHome, '.codex', 'sessions', '2026', '03', '04', `${stem}.jsonl.zst`), zlib.zstdCompressSync(rollout));
  await writeFile(join(bothHome, '.codex', 'archived_sessions', `${stem}.jsonl.zst`), zlib.zstdCompressSync(rollout));
  const both = await scan(bothHome);
  check('a rollout present in several forms is counted once', both.tokens === 120, JSON.stringify(both));

  // 4) a corrupt archive is a visible warning, not a crash or silent zero
  const badHome = join(root, 'bad');
  await mkdir(join(badHome, '.codex', 'archived_sessions'), { recursive: true });
  await writeFile(join(badHome, '.codex', 'archived_sessions', `${stem}.jsonl.zst`), Buffer.from('not zstd at all'));
  const bad = await scan(badHome);
  check('a corrupt archive yields a warning', bad.tokens === 0 && bad.warnings.some((w) => w.includes('cannot read')), JSON.stringify(bad));

  // 5) readJsonl refuses an offset on compressed input
  let refused = false;
  try {
    await utils.readJsonl(join(zstHome, '.codex', 'archived_sessions', `${stem}.jsonl.zst`), () => {}, { startOffset: 10 });
  } catch {
    refused = true;
  }
  check('readJsonl rejects startOffset on .zst', refused);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
