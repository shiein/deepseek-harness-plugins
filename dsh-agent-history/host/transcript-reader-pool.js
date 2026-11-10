/**
 * Host-side client of transcript-worker.js: one lazily started worker thread, request/response by id,
 * stopped after a quiet period so an idle panel holds no thread or database handles.
 *
 * A crashed or terminated worker fails only the reads in flight; the next read starts a new one.
 */

import { Worker } from 'node:worker_threads';

const DEFAULT_IDLE_MS = 60_000;

export class TranscriptReaderPool {
  /**
   * @param {URL} workerUrl
   * @param {{dataDir: string, config?: Record<string, unknown>, idleMs?: number}} options
   */
  constructor(workerUrl, options) {
    this.workerUrl = workerUrl;
    this.workerData = { dataDir: options.dataDir, config: JSON.parse(JSON.stringify(options.config ?? {})) };
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    /** @type {Worker|null} */
    this.worker = null;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
    this.nextId = 1;
    this.idleTimer = null;
    this.disposed = false;
  }

  /**
   * @param {import('./types.js').SessionSummary} session
   * @returns {Promise<{supported: boolean, messages: any[]}>}
   */
  read(session) {
    if (this.disposed) return Promise.reject(new Error('transcript reader is disposed'));
    const worker = this.ensureWorker();
    const id = this.nextId++;
    this.clearIdle();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, session });
    });
  }

  /** @returns {Worker} */
  ensureWorker() {
    if (this.worker !== null) return this.worker;
    const worker = new Worker(this.workerUrl, { workerData: this.workerData });
    worker.unref();
    worker.on('message', (message) => {
      const request = this.pending.get(message?.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.ok) request.resolve(message.result);
      else request.reject(new Error(message.error || 'transcript read failed'));
      this.scheduleIdle();
    });
    const fail = (error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.clearIdle();
      const pending = [...this.pending.values()];
      this.pending.clear();
      for (const request of pending) request.reject(error);
    };
    worker.on('error', (error) => fail(error));
    worker.on('exit', (code) => fail(new Error(`transcript worker exited with code ${code}`)));
    this.worker = worker;
    return worker;
  }

  scheduleIdle() {
    if (this.pending.size > 0 || this.worker === null) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0) this.stopWorker();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  clearIdle() {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  stopWorker() {
    const worker = this.worker;
    if (worker === null) return;
    this.worker = null;
    void worker.terminate();
  }

  /** Terminate the worker; reads in flight reject. */
  dispose() {
    this.disposed = true;
    this.clearIdle();
    const worker = this.worker;
    this.worker = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(new Error('transcript reader is disposed'));
    if (worker !== null) void worker.terminate();
  }

  /** Whether a worker thread is currently running (diagnostics and tests). */
  get running() {
    return this.worker !== null;
  }
}
