// Runs report jobs one at a time in a background worker thread.
// - Check-ins and page loads keep flowing while a big report is built.
// - The worker has its own memory cap: an oversized report fails with a clear message
//   instead of taking the whole server down. A crashed worker is replaced automatically.
// - One job at a time keeps memory predictable; a short queue absorbs bursts.
import { Worker } from 'node:worker_threads';

const MEMORY_MB = Number(process.env.REPORT_WORKER_MEMORY_MB || 1024);
const TIMEOUT_MS = Number(process.env.REPORT_TIMEOUT_MS || 120000);
const MAX_WAITING = 10;

let worker = null;
let current = null;
const queue = [];
let seq = 0;

const err = (status, message) => Object.assign(new Error(message), { status });

function settle(job, fn) {
  if (!job || job.done) return;
  job.done = true;
  clearTimeout(job.timer);
  fn();
  if (current === job) current = null;
  setImmediate(pump);
}

function start() {
  worker = new Worker(new URL('./reportWorker.js', import.meta.url), {
    resourceLimits: { maxOldGenerationSizeMb: MEMORY_MB },
  });
  worker.unref();
  worker.on('message', (msg) => {
    const job = current;
    if (!job || msg.id !== job.id) return;
    settle(job, () => (msg.ok ? job.resolve(msg.result) : job.reject(err(msg.status, msg.message))));
  });
  worker.on('error', (e) => {
    const tooBig = e.code === 'ERR_WORKER_OUT_OF_MEMORY';
    if (!tooBig) console.error('[reports] worker crashed:', e);
    settle(current, () =>
      current.reject(
        tooBig
          ? err(413, 'This report is too large to build. Choose a shorter period or fewer people, or download it as CSV.')
          : err(500, 'The report could not be built.'),
      ),
    );
  });
  worker.on('exit', () => {
    worker = null;
    settle(current, () => current.reject(err(500, 'The report could not be built.')));
  });
}

function pump() {
  if (current || queue.length === 0) return;
  current = queue.shift();
  if (!worker) start();
  const job = current;
  job.timer = setTimeout(() => {
    settle(job, () => job.reject(err(504, 'The report took too long to build. Choose a shorter period.')));
    worker?.terminate();
  }, TIMEOUT_MS);
  worker.postMessage({ ...job.payload, id: job.id });
}

/**
 * Queues a report job and resolves with its result.
 * payload: { task: 'preview' | 'export', instId, query: { type, from, to, userId }, format, generatedBy }
 */
export function runReportJob(payload) {
  if (queue.length >= MAX_WAITING) {
    return Promise.reject(err(503, 'Reports are busy right now. Please try again in a minute.'));
  }
  return new Promise((resolve, reject) => {
    queue.push({ id: ++seq, payload, resolve, reject });
    pump();
  });
}
