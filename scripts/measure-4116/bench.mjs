// Fixed CPU work, single thread then four threads; prints wall ms for each.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { availableParallelism } from "node:os";
const work = () => { let x = 0; for (let i = 0; i < 6e8; i++) x = (x + i * 31) % 1000003; return x; };
if (!isMainThread) { work(); parentPort.postMessage(1); }
else {
  let t = performance.now(); work(); const single = performance.now() - t;
  t = performance.now();
  await Promise.all(Array.from({ length: 4 }, () => new Promise(done => new Worker(new URL(import.meta.url)).on("message", done))));
  const four = performance.now() - t;
  console.log(`BENCH single=${single.toFixed(0)}ms four=${four.toFixed(0)}ms nodeParallelism=${availableParallelism()}`);
}
