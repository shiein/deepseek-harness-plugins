#!/usr/bin/env node
/**
 * Copies shared/host/* into each plugin's host/ folder. Every plugin is installed as a self-contained
 * bundle, so it cannot import from outside its own directory; one source plus generated copies keeps
 * both properties.
 *
 *   node scripts/sync-shared.mjs          write the copies
 *   node scripts/sync-shared.mjs --check  fail if any copy differs (run by each plugin's npm test)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCANNERS = ['dsh-agent-history', 'dsh-agent-usage'];
const TARGETS = {
  'loopback.js': ['dsh-agent-assets', 'dsh-business-flow', ...SCANNERS],
  'concurrency.js': SCANNERS,
  'context.js': SCANNERS,
  'fingerprint-cache.js': SCANNERS,
  'fs-extra.js': SCANNERS,
  'scan-in-worker.js': SCANNERS,
  'scan-utils.js': SCANNERS,
  'scan-worker.js': SCANNERS,
};

const check = process.argv.includes('--check');
const stale = [];
for (const [name, plugins] of Object.entries(TARGETS)) {
  const header = `// GENERATED from shared/host/${name}. Edit that file, then run: node scripts/sync-shared.mjs\n`;
  const text = header + readFileSync(join(root, 'shared', 'host', name), 'utf8');
  for (const plugin of plugins) {
    const target = join(root, plugin, 'host', name);
    let current = null;
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      // missing counts as stale
    }
    if (current === text) continue;
    if (check) {
      stale.push(`${plugin}/host/${name}`);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  }
}
if (stale.length > 0) {
  console.error(`Generated files differ from shared/host:\n  ${stale.join('\n  ')}\nRun: node scripts/sync-shared.mjs`);
  process.exit(1);
}
