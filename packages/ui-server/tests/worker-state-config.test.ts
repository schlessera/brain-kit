/** The Claude worker runtime-state allowance and budget come from trusted host configuration (#1625). */
import { expect, spyOn, test } from "bun:test";
import { resolveServerConfig } from "../src/config/env.js";

const MiB = 1024 * 1024;

test("defaults: 64 MiB per worker and a budget of the allowance times the session cap", () => {
  expect(resolveServerConfig({}).agent).toMatchObject({ workerStateBytes: 64 * MiB, workerStateBudgetBytes: 192 * MiB });
  expect(resolveServerConfig({ MAX_CONCURRENT_SESSIONS: "5" }).agent.workerStateBudgetBytes).toBe(320 * MiB);
});

test("overrides reach the agent configuration the Claude backend receives", () => {
  expect(resolveServerConfig({ BRAIN_UI_WORKER_STATE_BYTES: "33554432" }).agent)
    .toMatchObject({ workerStateBytes: 32 * MiB, workerStateBudgetBytes: 96 * MiB });
  expect(resolveServerConfig({ BRAIN_UI_WORKER_STATE_BUDGET_BYTES: "134217728" }).agent)
    .toMatchObject({ workerStateBytes: 64 * MiB, workerStateBudgetBytes: 128 * MiB });
});

test("invalid values refuse the boot by name", () => {
  for (const [name, value] of [["BRAIN_UI_WORKER_STATE_BYTES", "64MiB"], ["BRAIN_UI_WORKER_STATE_BYTES", "4097"],
    ["BRAIN_UI_WORKER_STATE_BUDGET_BYTES", "-1"], ["BRAIN_UI_WORKER_STATE_BUDGET_BYTES", "1e9"]] as const) {
    expect(() => resolveServerConfig({ [name]: value }), `${name}=${value}`).toThrow(name);
  }
  expect(() => resolveServerConfig({ BRAIN_UI_WORKER_STATE_BUDGET_BYTES: String(32 * MiB) }))
    .toThrow("no worker could ever start");
  expect(() => resolveServerConfig({ BRAIN_UI_WORKER_STATE_BYTES: String(2 ** 52), MAX_CONCURRENT_SESSIONS: "3" }))
    .toThrow("overflows");
});

test("the recorded host probe mounts the Claude allowance when given one (#1625)", async () => {
  const { workerHostBoundary } = await import("@schlessera/brain-ui-sdk/internal");
  const { probeWorkerHostRecorded } = await import("../src/agent/worker-host.js");
  const seen: unknown[] = [];
  const probe = spyOn(workerHostBoundary, "probe").mockImplementation((_brain: string, options?: unknown) => {
    seen.push(options);
    return { ok: false, requirement: "bubblewrap 0.7 or later, for the worker's size-limited runtime-state tmpfs" };
  });
  const recorded: unknown[] = [];
  try {
    const result = probeWorkerHostRecorded("/brain", "ordinary", { recordWorkerHost: (...args: unknown[]) => recorded.push(args) } as never, "boot", 64 * MiB);
    expect(seen).toEqual([{ restricted: false, stateBytes: 64 * MiB }]);
    expect(result).toEqual({ ok: false, requirement: "bubblewrap 0.7 or later, for the worker's size-limited runtime-state tmpfs" });
    expect(recorded).toHaveLength(1);
    probeWorkerHostRecorded("/brain", "ordinary", undefined, "boot");
    expect(seen[1]).toEqual({ restricted: false });
  } finally { probe.mockRestore(); }
});
