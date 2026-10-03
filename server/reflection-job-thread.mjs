// Assembles one reflection batch on a worker thread (see runReflectionJob below and handleReflectionJob in
// worker/src/index.js). The thread opens its own Postgres pool, so it needs DATABASE_URL: the in-memory
// driver cannot be shared across threads.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const THREAD_TIMEOUT_MS = Number(process.env.REFLECTION_JOB_TIMEOUT_MS) || 15 * 60_000;

if (!isMainThread) {
  const { createCacheStorage } = await import('./cache-mem.mjs');
  globalThis.caches = createCacheStorage({ maxBytes: 8 * 1024 * 1024 });   // the worker module expects caches.default
  const { createPgDriver } = await import('./driver-pg.mjs');
  const { buildEnv } = await import('./harness.mjs');
  const driver = await createPgDriver(process.env.DATABASE_URL, { max: 2 });
  try {
    const { assembleReflectionJobBody } = await import('../worker/src/index.js');
    const body = await assembleReflectionJobBody(buildEnv(driver), workerData.network);
    parentPort.postMessage({ body });
  } catch (e) {
    parentPort.postMessage({ error: String(e?.message || e) });
  } finally {
    await driver.close();
  }
}

// → the job's JSON body, or null when caught up. Rejects with the thread's error, or when it exits without
// answering (killed for memory, or past the timeout).
export function runReflectionJob(network) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const worker = new Worker(new URL(import.meta.url), { workerData: { network } });
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { worker.terminate(); done(reject, new Error(`reflection job thread timed out after ${THREAD_TIMEOUT_MS} ms`)); }, THREAD_TIMEOUT_MS);
    worker.on('message', (m) => {
      console.log(`[reflection-thread] ${network} ${m.error ? 'failed' : m.body ? `${(m.body.length / 1e6).toFixed(1)}MB job` : 'caught up'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      if (m.error) done(reject, new Error(m.error)); else done(resolve, m.body ?? null);
    });
    worker.on('error', (e) => done(reject, e));
    worker.on('exit', (code) => done(reject, new Error(`reflection job thread exited (${code}) without an answer`)));
  });
}
