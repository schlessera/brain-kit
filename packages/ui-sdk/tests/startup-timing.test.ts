import { expect, test } from "bun:test";
import { safeStartupTiming } from "../src/server/startup-timing.js";
import { watchdogMs } from "../../../scripts/test-deadlines.js";

for (const mode of ["startup", "relay"]) {
  test(`asynchronous ${mode} diagnostics cannot reject the process or block observed work`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", new URL("./fixtures/async-startup-observer.ts", import.meta.url).pathname, mode],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: watchdogMs(10000) });
    try {
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ exit, stderr }, "ASYNC_STARTUP_DIAGNOSTICS_ARE_CONTAINED").toEqual({ exit: 0, stderr: "" });
      const result = JSON.parse(stdout);
      if (mode === "startup") expect(result).toEqual(["completion", "worker", "missing", "received", "pending", "thenable"]);
      else {
        expect(result.responses.map((response: { status: number }) => response.status)).toEqual([200, 200, 405]);
        expect(result.responses.slice(0, 2).map((response: { body: string }) => response.body)).toEqual(["Ithaca model response", "Ithaca model response"]);
        expect(result.events).toEqual(["receipt", "credentials", "upstream", "forwarded", "pending receipt", "credentials", "upstream", "forwarded", "refused"]);
      }
    } finally { child.kill(); await child.exited; }
  });
}

test("startup observer failures never escape any diagnostic method or returned completion", () => {
  const events: string[] = [];
  const fail = (event: string) => { events.push(event); throw Error("Ithaca diagnostics unavailable"); };
  const timing = safeStartupTiming({ start: name => fail(`start:${name}`), worker: name => fail(`worker:${name}`),
    missing: name => fail(`missing:${name}`), received: () => fail("received") })!;
  timing.start("host_probe")(); timing.worker("resources", 31); timing.missing("first_enqueue"); timing.received();
  const ending = safeStartupTiming({ start: () => () => fail("end:worker_launch"), worker() {}, missing() {}, received() {} })!;
  ending.start("worker_launch")();
  expect(events).toEqual(["start:host_probe", "worker:resources", "missing:first_enqueue", "received", "end:worker_launch"]);
  expect(safeStartupTiming(undefined)).toBeUndefined();
});

test("startup observations preserve names, durations and method receivers", () => {
  const events: unknown[] = [];
  const observer = { label: "ithaca", start(name: string) { events.push([this.label, name]); return () => events.push("ended"); },
    worker(name: string, ms: number) { events.push([this.label, name, ms]); }, missing(name: string) { events.push([this.label, name]); }, received() { events.push(this.label); } };
  const timing = safeStartupTiming(observer)!;
  timing.start("worker_launch")(); timing.worker("resources", 31); timing.missing("prompt_recorded"); timing.received();
  expect(events).toEqual([["ithaca", "worker_launch"], "ended", ["ithaca", "resources", 31], ["ithaca", "prompt_recorded"], "ithaca"]);
});
