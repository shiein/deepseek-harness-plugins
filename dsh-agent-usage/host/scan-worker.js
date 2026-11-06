/**
 * Worker-thread entry for one usage scan.
 *
 * Several providers read multi-GB SQLite stores through the synchronous `node:sqlite` API (a full
 * Devin pass measured 22 s of uninterrupted event-loop block). The plugin's Host half shares its
 * process with every other DSH plugin and the live agent sessions, so the scan runs here and only
 * the finished snapshot crosses back. One worker per scan; it exits when the scan settles.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { runScan } from './scanner.js';

try {
  const snapshot = await runScan({ dataDir: workerData.dataDir, config: workerData.config });
  parentPort?.postMessage({ ok: true, snapshot });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? (error.stack || error.message) : String(error),
  });
}
