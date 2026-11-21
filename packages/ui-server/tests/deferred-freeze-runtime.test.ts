import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { startInferenceRelay } from "@schlessera/brain-ui-sdk/internal";
import { fixture, body } from "./helpers/deferred-freeze-fixture";
import { watchdogMs } from "../../../scripts/test-deadlines";

// A real stopped reader and a response above the socket buffer are the failure
// mode: controlled time and a fake worker cannot exercise kernel backpressure.
// Ten seconds is the issue's observation window, not a readiness sleep.
test("a real stopped worker receives an 8 MiB stream only after its ten-second observation commits", async () => {
  const realNow = performance.now.bind(performance);
  const child = Bun.spawn([process.execPath, "-e", `
    import { request } from "node:http";
    const reader = Bun.stdin.stream().getReader();
    const { value } = await reader.read();
    const { socketPath, body } = JSON.parse(new TextDecoder().decode(value));
    const req = request({ socketPath, path: "/v1/messages", method: "POST" }, res => {
      let bytes = 0; res.on("data", chunk => bytes += chunk.length);
      res.on("end", () => { console.log(JSON.stringify({ status: res.statusCode, bytes })); process.exit(0); });
    }); req.on("error", error => { console.error(String(error)); process.exit(1); }); req.end(body);
  `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let stopped = false, committed = false, earlyResume: unknown;
  const freeze = () => {
    child.kill("SIGSTOP");
    const deadline = realNow() + watchdogMs(5000);
    for (;;) {
      const state = readFileSync(`/proc/${child.pid}/stat`, "utf8").replace(/^.*\) /s, "")[0];
      if (state === "T") { stopped = true; return true; }
      if (realNow() > deadline) throw new Error("Owned worker did not stop");
      Bun.sleepSync(1);
    }
  };
  const f = await fixture(100, { freeze, resume() { try { expect(committed, "PROCESS_CANNOT_RESUME_BEFORE_COMMIT").toBe(true); } catch (error) { earlyResume = error; throw error; } child.kill("SIGCONT"); stopped = false; return true; }, kill(signal) { child.kill(signal); return true; }, exited: child.exited });
  const checkpoint = f.native.manager.checkpoint, dispatched = Promise.withResolvers<void>();
  let produced = 0;
  const total = 8 * 1024 * 1024;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    expect(stopped, "REAL_PROCESS_STOP_CONFIRMED_BEFORE_UPSTREAM").toBe(true); dispatched.resolve();
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (produced === total) controller.close();
      else { const chunk = new Uint8Array(64 * 1024).fill(73); produced += chunk.length; controller.enqueue(chunk); }
    } }));
  } });
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: {}, egress: f.proxy });
  try {
    let captureStarted = 0;
    f.native.manager.checkpoint = async (...args) => {
      captureStarted = realNow(); await Bun.sleep(10_000);
      return checkpoint(...args);
    };
    f.afterNativeCommit(() => { committed = true; });
    const observed = f.result();
    child.stdin.write(JSON.stringify({ socketPath: relay.socketPath, body: body() })); child.stdin.end();
    await dispatched.promise;
    expect(stopped).toBe(true);
    await observed;
    if (earlyResume) throw earlyResume;
    expect(realNow() - captureStarted, "TEN_SECOND_OBSERVATION_WAS_EXERCISED").toBeGreaterThanOrEqual(10_000);
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ status: 200, bytes: total });
    expect(await new Response(child.stderr).text()).toBe("");
    expect(produced).toBe(total);
  } finally { child.kill("SIGKILL"); await child.exited; f.native.manager.checkpoint = checkpoint; relay.stop(); origin.stop(true); await f.close(); }
}, watchdogMs(60_000));
