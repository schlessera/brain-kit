import { afterEach, expect, spyOn, test } from "bun:test";
import { alive } from "../src/storage/shared-scan-writes";

// A reaped child's pid has no /proc entry, so the stat reads fail naturally; the
// kill(pid, 0) probes are the only thing the spy decides (#5027).
async function reapedPid() {
  const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  expect(await child.exited).toBe(0);
  return child.pid;
}
let spy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { spy?.mockRestore(); spy = undefined; });

test("a worker reaped between the liveness probe and the stat read is dead", async () => {
  const pid = await reapedPid();
  let calls = 0;
  spy = spyOn(process, "kill").mockImplementation(((target: number, signal?: string | number) => {
    expect([target, signal]).toEqual([pid, 0]);
    if (++calls === 1) return true;
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  }) as typeof process.kill);
  expect(alive({ pid, start: "1" })).toBe(false);
  expect(calls).toBe(2);
});

test("a live pid without procfs evidence stays alive", async () => {
  const pid = await reapedPid();
  spy = spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
  expect(alive({ pid, start: "1" })).toBe(true);
});
