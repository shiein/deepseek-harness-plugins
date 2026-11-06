#!/usr/bin/env node
/**
 * Development harness: run one provider (or all of them) against the real machine data and print a
 * human-readable summary. Uses a throwaway cache so every line is parsed on each run.
 *
 * Usage (bundled Node keeps runtime semantics identical to the DSH Host):
 *   E="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
 *   ELECTRON_RUN_AS_NODE=1 "$E" dsh-agent-usage/host/providers/self-test.mjs claude-code
 *   ELECTRON_RUN_AS_NODE=1 "$E" dsh-agent-usage/host/providers/self-test.mjs --all
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { makeScanContext } from '../context.js';
import { mergeCells, finalizeCells, cellTokens } from '../cells.js';
import { estimateCellCost, hasPrice } from '../pricing.js';

const here = dirname(fileURLToPath(import.meta.url));
const throwawayCache = { get: () => undefined, set: () => {} };

/** Load one provider module by id. */
async function loadOne(id) {
  const file = join(here, `${id}.js`);
  return import(pathToFileURL(file).href);
}

async function runProvider(mod, label) {
  const providerId = mod.meta?.id || label;
  const warnings = [];
  const started = Date.now();
  const context = makeScanContext({ providerId, cache: throwawayCache, warnings });
  let result;
  try {
    result = await mod.scan(context);
  } catch (error) {
    console.log(`\n=== ${providerId} FAILED in ${Date.now() - started}ms`);
    console.log('   ', error?.stack || error);
    return { ok: false };
  }
  const cells = finalizeCells(mergeCells(result?.cells || []));
  const tokens = cells.reduce((sum, cell) => sum + cellTokens(cell), 0);
  const cost = cells.reduce((sum, cell) => sum + (estimateCellCost(cell) || 0), 0);
  const unpriced = [...new Set(cells.filter((cell) => !hasPrice(cell.model)).map((cell) => cell.model))];
  console.log(`\n=== ${providerId} (${mod.meta?.name || '?'}) — ${Date.now() - started}ms`);
  for (const source of result?.sources || []) {
    console.log(`  source ${source.exists ? 'OK ' : 'MISS'}  ${source.path}`);
    console.log(`         files=${source.files ?? 0} bytes=${source.bytes ?? 0}${source.note ? ` note=${source.note}` : ''}`);
  }
  if (warnings.length > 0) console.log(`  warnings: ${warnings.join(' | ')}`);
  console.log(`  cells=${cells.length} tokens=${tokens.toLocaleString()} estCost=$${cost.toFixed(4)}`);
  if (unpriced.length > 0) console.log(`  unpriced models: ${unpriced.slice(0, 12).join(', ')}`);
  const byDay = new Map();
  for (const cell of cells) byDay.set(cell.day, (byDay.get(cell.day) || 0) + cellTokens(cell));
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 5);
  if (days.length > 0) console.log(`  recent days: ${days.map(([day, count]) => `${day}=${count.toLocaleString()}`).join(' ')}`);
  const models = new Map();
  for (const cell of cells) {
    const entry = models.get(cell.model) || { tokens: 0, cost: 0 };
    entry.tokens += cellTokens(cell);
    entry.cost += estimateCellCost(cell) || 0;
    models.set(cell.model, entry);
  }
  const top = [...models.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 6);
  for (const [model, entry] of top) console.log(`  model ${model}: ${entry.tokens.toLocaleString()} tok, $${entry.cost.toFixed(4)}`);
  return { ok: true, cells: cells.length, tokens };
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help') {
  console.log('usage: self-test.mjs <provider-id> | --all');
  process.exit(0);
}
if (args[0] === '--all') {
  const { loadProviders } = await import('./index.js');
  const providers = await loadProviders();
  for (const provider of providers) {
    if (provider.error) {
      console.log(`\n=== ${provider.meta.id} LOAD FAILED\n   ${provider.error?.message || provider.error}`);
      continue;
    }
    await runProvider(provider.module, provider.meta.id);
  }
} else {
  const mod = await loadOne(args[0]);
  await runProvider(mod, args[0]);
}
