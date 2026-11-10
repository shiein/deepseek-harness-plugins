// A transcript worker that dies on its first request (pool crash handling).
import { parentPort } from 'node:worker_threads';
parentPort?.on('message', () => process.exit(3));
