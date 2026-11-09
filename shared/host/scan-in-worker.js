import { Worker } from 'node:worker_threads';

/**
 * Run one scan on a worker thread (see scan-worker.js for why it must leave the Host thread).
 * @param {URL} workerUrl
 * @param {{dataDir: string, config: Record<string, unknown>, onWorker: (worker: Worker|null) => void}} options
 * @returns {Promise<any>} the finished snapshot
 */
export function runScanInWorker(workerUrl, { dataDir, config, onWorker }) {
  return new Promise((resolve, reject) => {
    // Profile config is plain YAML data; a JSON round-trip drops anything a worker cannot clone.
    const worker = new Worker(workerUrl, { workerData: { dataDir, config: JSON.parse(JSON.stringify(config ?? {})) } });
    onWorker(worker);
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      onWorker(null);
      fn(value);
    };
    worker.once('message', (message) => {
      if (message?.ok) settle(resolve, message.snapshot);
      else settle(reject, new Error(`scan worker failed: ${message?.error ?? 'unknown error'}`));
    });
    worker.once('error', (error) => settle(reject, error));
    worker.once('exit', (code) => settle(reject, new Error(`scan worker exited with code ${code} before reporting`)));
  });
}
