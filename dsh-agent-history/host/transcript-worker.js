/**
 * Worker-thread entry that reads session transcripts.
 *
 * Several providers read their transcripts from multi-GB SQLite stores through the synchronous
 * `node:sqlite` API, and a project timeline reads up to a few hundred sessions. Run on the Host
 * thread, that blocks every other DSH plugin and the live agent sessions, so reads happen here.
 * One long-lived worker serves all reads; it exits when idle (see transcript-reader-pool.js).
 */

import { parentPort, workerData } from 'node:worker_threads';
import { readSessionViaProvider } from './scanner.js';

parentPort?.on('message', async (message) => {
  const id = message?.id;
  try {
    const result = await readSessionViaProvider(workerData.dataDir, workerData.config, message.session, new AbortController().signal);
    parentPort?.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort?.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
