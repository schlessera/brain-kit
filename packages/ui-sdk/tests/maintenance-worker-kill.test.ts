import { afterEach, expect, test } from "bun:test";
import { invocationChild } from "../../../scripts/test-invocation-child.ts";
// Static ownership edges: loading these modules does not register a worker.
import "../src/server/maintenance-worker-kill.js";
import "../src/server/maintenance-worker.js";

type Owner = {
  child?: ReturnType<typeof invocationChild>;
  timer?: ReturnType<typeof setTimeout>;
  readers: ReadableStreamDefaultReader<Uint8Array>[];
  stdout: string; stderr: string; forwarded: boolean; timedOut: boolean; testEnded: boolean;
  cleanup?: Promise<void>;
};
// Resolving keeps Bun --changed ownership without loading the child test body.
const childPath = require.resolve("./maintenance-worker-kill-child.ts");
const owners = new Set<Owner>();
function cleanup(owner: Owner): Promise<void> {
  return owner.cleanup ??= (async () => {
    clearTimeout(owner.timer);
    const errors: unknown[] = [];
    try { await owner.child?.stop("SIGTERM"); } catch (error) { errors.push(error); }
    const cancelled = await Promise.allSettled(owner.readers.map(reader => reader.cancel()));
    for (const result of cancelled) if (result.status === "rejected") errors.push(result.reason);
    try { await owner.child?.finish(); } catch (error) { errors.push(error); }
    owners.delete(owner);
    if (errors.length) throw new AggregateError(errors, "Maintenance regression child cleanup failed");
  })();
}
afterEach(async () => {
  const active = [...owners];
  for (const owner of active) owner.testEnded = true;
  const results = await Promise.allSettled(active.map(cleanup));
  for (const result of results) if (result.status === "rejected") throw result.reason;
});
async function drain(owner: Owner, channel: "stdout" | "stderr", stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader(), decoder = new TextDecoder(); owner.readers.push(reader);
  for (;;) { const next = await reader.read(); if (next.done) break; owner[channel] += decoder.decode(next.value, { stream: true }); }
  owner[channel] += decoder.decode();
}
function forward(owner: Owner): void {
  if (owner.forwarded) return;
  owner.forwarded = true; process.stdout.write(owner.stdout); process.stderr.write(owner.stderr);
}

test("maintenance cancellation controls own a fresh native library and pass all thirty cases", async () => {
  const owner: Owner = { readers: [], stdout: "", stderr: "", forwarded: false, timedOut: false, testEnded: false };
  owners.add(owner); // Teardown and deadline exist before any process is acquired.
  owner.timer = setTimeout(() => {
    owner.timedOut = true;
    void cleanup(owner).catch(error => console.error("Maintenance regression deadline cleanup failed", error));
  }, 90_000);
  try {
    const child = owner.child = invocationChild([process.execPath, "test", "--timeout", "30000", childPath],
      { cwd: new URL("..", import.meta.url).pathname });
    const joined = Promise.all([child.exited, drain(owner, "stdout", child.stdout), drain(owner, "stderr", child.stderr)]);
    void joined.catch(() => {});
    await child.ready;
    const [code] = await joined;
    await child.finish();
    forward(owner);
    const passed = /^\s*(\d+) pass$/m.exec(owner.stderr), failed = /^\s*(\d+) fail$/m.exec(owner.stderr);
    const result = { code, passed: passed ? Number(passed[1]) : null, failed: failed ? Number(failed[1]) : null };
    console.error(JSON.stringify({ kind: "maintenance-child-result", ...result, timedOut: owner.timedOut }));
    // Bun may have already failed this test at its outer deadline. Teardown
    // still joins the group/outputs; it must not emit a late assertion.
    if (owner.testEnded) return;
    expect(owner.timedOut, "MAINTENANCE_CHILD_DEADLINE").toBe(false);
    expect(result, "MAINTENANCE_CHILD_EXIT_AND_COUNTS").toEqual({ code: 0, passed: 30, failed: 0 });
  } finally {
    try { await cleanup(owner); } finally { forward(owner); }
  }
}, 120_000);
