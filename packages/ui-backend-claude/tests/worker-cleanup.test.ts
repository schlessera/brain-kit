/**
 * A Claude worker's runtime-state reservation is released only once its
 * handles' awaited cleanup is confirmed (#2854). A separate-UID worker's last
 * handle closes its identity broker off the event loop, so the backend awaits
 * that close; a refusal keeps the reservation charged.
 */
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as internal from "@schlessera/brain-ui-sdk/internal";
import { prepareWorkerSandbox } from "@schlessera/brain-ui-sdk/internal";
import { createWorkerSpawn } from "../src/worker-spawn.js";
import { createStateLedger } from "../src/worker-state-budget.js";

const MiB = 1024 * 1024;
const native = process.platform === "linux" && Boolean(Bun.which("bwrap"));

test.skipIf(!native)("Claude keeps a worker's reservation charged until its awaited handle cleanup confirms, and while it is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-worker-cleanup-"));
  const brain = join(root, "brain"), saved = join(root, "config"), home = join(root, "home");
  mkdirSync(brain); mkdirSync(saved); mkdirSync(home); writeFileSync(join(saved, "settings.json"), "{}");
  const sandbox = prepareWorkerSandbox(brain, { home, profile: "governed", areas: [] });
  const original = internal.launchAgentWorkerAsync;
  let gate = Promise.withResolvers<void>(), closing = Promise.withResolvers<void>();
  const retries: Array<() => Promise<void>> = [];
  // The real worker and handles; only the turn temp's awaited close is held at a gate.
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockImplementation(async input => {
    const worker = await original(input);
    const turnTemp = worker.turnTemp!, close = turnTemp.closeAsync.bind(turnTemp);
    retries.push(close);
    turnTemp.close = () => { throw new Error("CLAUDE_SYNC_TURN_TEMP_CLOSE_ON_AN_ASYNC_LAUNCH"); };
    turnTemp.closeAsync = async () => { closing.resolve(); await gate.promise; await close(); };
    return worker;
  });
  const turn = async (ledger: ReturnType<typeof createStateLedger>) => {
    const spawner = createWorkerSpawn(brain, {}, new AbortController().signal, undefined, sandbox, undefined, undefined,
      { ledger, limits: { allowanceBytes: 4 * MiB, budgetBytes: 8 * MiB }, turnTempLimits: { allowanceBytes: MiB, budgetBytes: 2 * MiB } });
    const child = spawner.spawn({ command: "/bin/true", args: [], env: { CLAUDE_CONFIG_DIR: saved, HOME: home }, signal: new AbortController().signal } as never);
    child.stdout.resume(); child.stdin.end(); child.on("error", () => {});
    await closing.promise;
    return spawner.finish();
  };
  try {
    const confirmed = createStateLedger();
    const finished = turn(confirmed);
    await closing.promise;
    await Bun.sleep(20);
    expect(confirmed.live, "CLAUDE_RESERVATION_HELD_WHILE_CLOSE_PENDING").toBe(1);
    gate.resolve();
    await finished;
    expect(confirmed.live, "CLAUDE_CONFIRMED_CLOSE_RELEASES_RESERVATION").toBe(0);

    gate = Promise.withResolvers<void>(); closing = Promise.withResolvers<void>();
    const refused = createStateLedger();
    const refusing = turn(refused);
    await closing.promise;
    gate.reject(Object.assign(new Error("worker_identity_cleanup_unconfirmed: fixture"), { cleanupUnconfirmed: true }));
    await expect(refusing, "CLAUDE_UNCONFIRMED_CLOSE_REJECTS_THE_LIFECYCLE").rejects.toThrow("worker_identity_cleanup_unconfirmed");
    expect(refused.live, "CLAUDE_UNCONFIRMED_CLOSE_KEEPS_RESERVATION").toBe(1);
    // The refused handle can still be closed later.
    await retries.at(-1)!();
  } finally { launch.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
