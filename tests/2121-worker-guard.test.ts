import { test } from "bun:test";
test("2121 queued-worker external-fetch mutation", async () => {
  console.log("QUEUED_WORKER_PID", process.pid);
  await fetch("http://192.0.2.1:9/");
  throw new Error("OFFLINE_GUARD_DID_NOT_REFUSE");
});
