/**
 * Concurrent Claude turns share one runtime-state tmpfs (#1625). The ledger
 * makes check-then-copy atomic across turns, holds growth headroom, releases
 * on every exit path and names every refusal; agent memory persists (#1626).
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClaudeWorkerState, stateReserveBytes } from "../src/worker-state.js";
import { createStateLedger, usage, WorkerStateError, type StateLedger } from "../src/worker-state-budget.js";

const MiB = 1024 * 1024;
const TROY = "11111111-1111-4111-8111-111111111111";
const ITHACA = "22222222-2222-4222-8222-222222222222";
let root: string, brain: string, saved: string, project: string, stateRoot: string;
let total: number, ledger: StateLedger;
const states: ReturnType<typeof createClaudeWorkerState>[] = [];
/** Bytes a test hid from `usage`; the kernel still counts them. */
let unmeasured = 0;
/** A tmpfs of `total` bytes: what the state directories hold is no longer free. */
const free = () => {
  try { return total - usage(stateRoot); } catch { return total - unmeasured; }
};
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "claude-state-budget-"));
  brain = join(root, "brain"); saved = join(root, "config"); stateRoot = join(root, "shm");
  project = `projects/${brain.replace(/[^a-zA-Z0-9]/g, "-")}`;
  fs.mkdirSync(brain); fs.mkdirSync(stateRoot); fs.mkdirSync(join(saved, project), { recursive: true });
  fs.writeFileSync(join(saved, "settings.json"), "{}");
  total = 64 * MiB; unmeasured = 0;
  ledger = createStateLedger({ space: () => ({ free: free(), total }), growth: stateReserveBytes(0), max: 128 * MiB });
});
afterEach(() => { for (const state of states.splice(0)) state.cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
function turn(resume?: string, options: { ephemeral?: boolean } = {}) {
  const result = createClaudeWorkerState(brain, { CLAUDE_CONFIG_DIR: saved },
    { resume, stateRoot, freeBytes: free, totalBytes: () => total, ledger, ...options });
  states.push(result); return result;
}
function refusal(run: () => unknown): WorkerStateError | undefined {
  try { run(); } catch (error) { if (error instanceof WorkerStateError) return error; throw error; }
  return undefined;
}
const history = (id: string, mib: number) => fs.writeFileSync(join(saved, project, `${id}.jsonl`), Buffer.alloc(mib * MiB, 0x41));

test("two interleaved turns whose state exceeds the tmpfs: the second refuses by name before copying", () => {
  history(TROY, 20); history(ITHACA, 20);
  const first = turn(TROY);
  expect(ledger.live).toBe(1);
  // The first turn's copy is on the tmpfs and its headroom is not yet
  // written: a bare free-space reading would admit the second turn.
  expect(free()).toBeGreaterThan(20 * MiB + stateReserveBytes(20 * MiB));
  const before = fs.readdirSync(stateRoot);
  const busy = refusal(() => turn(ITHACA));
  expect(busy?.errorClass).toBe("worker_state_busy");
  expect(busy?.message).toContain("1 other conversation running");
  expect(fs.readdirSync(stateRoot), "nothing of the refused turn stays on the tmpfs").toEqual(before);
  expect(ledger.live).toBe(1);
  // Released when the first turn ends: the second now runs.
  first.cleanup();
  expect(ledger.live).toBe(0);
  const second = turn(ITHACA);
  expect(fs.statSync(join(second.path, project, `${ITHACA}.jsonl`)).size).toBe(20 * MiB);
});

test("two interleaved turns whose state fits both run, and both reservations are released", () => {
  history(TROY, 5); history(ITHACA, 5);
  const first = turn(TROY), second = turn(ITHACA);
  expect(ledger.live).toBe(2);
  first.cleanup(); second.cleanup();
  expect(ledger.live).toBe(0);
  expect(fs.readdirSync(stateRoot)).toEqual([]);
});

test("autonomous turns reserve their growth room too", () => {
  total = 40 * MiB;
  turn(undefined, { ephemeral: true }); turn(undefined, { ephemeral: true });
  expect(refusal(() => turn(undefined, { ephemeral: true }))?.errorClass).toBe("worker_state_busy");
});

test("a reservation is released when the copy fails", () => {
  history(TROY, 1);
  const write = spyOn(fs, "writeFileSync").mockImplementation(() => { throw Object.assign(new Error("no space left"), { code: "ENOSPC" }); });
  try {
    expect(() => turn(TROY)).toThrow("ran out of space");
  } finally { write.mockRestore(); }
  expect(ledger.live).toBe(0);
  expect(fs.readdirSync(stateRoot)).toEqual([]);
});

test("cleanup releases the reservation even when removing the state fails", () => {
  const state = turn();
  const remove = spyOn(fs, "rmSync").mockImplementationOnce(() => { throw new Error("EBUSY"); });
  try { expect(() => state.cleanup()).toThrow("EBUSY"); } finally { remove.mockRestore(); }
  expect(ledger.live).toBe(0);
});

test("growth past the reservation extends into free space, and is stopped by name when other turns hold it", () => {
  history(TROY, 20);
  const grower = turn(), holder = turn(TROY);
  const transcript = join(grower.path, project, `${ITHACA}.jsonl`);
  fs.mkdirSync(join(grower.path, project), { recursive: true });
  // Within the 16 MiB headroom: nothing to do.
  fs.writeFileSync(transcript, Buffer.alloc(6 * MiB));
  expect(() => grower.ensure()).not.toThrow();
  // Past it, while the holder's unwritten headroom is all that is left.
  fs.writeFileSync(transcript, Buffer.alloc(18 * MiB));
  const exceeded = refusal(() => grower.ensure());
  expect(exceeded?.errorClass).toBe("worker_state_exceeded");
  expect(exceeded?.message).toContain("reservation");
  expect(free(), "stopped before the tmpfs ran out").toBeGreaterThan(0);
  // Once the holder ends, the same growth fits again.
  holder.cleanup();
  expect(() => grower.ensure()).not.toThrow();
});

test("a worker that hides its state from measurement is stopped, and its reservation stays held for others", () => {
  total = 50 * MiB;
  const hider = turn();
  const hidden = join(hider.path, project);
  fs.mkdirSync(hidden, { recursive: true });
  fs.writeFileSync(join(hidden, `${ITHACA}.jsonl`), Buffer.alloc(10 * MiB));
  fs.chmodSync(hidden, 0);
  try {
    const stopped = refusal(() => hider.ensure());
    expect(stopped?.errorClass).toBe("worker_state_exceeded");
    expect(stopped?.message).toContain("could not be measured");
    // 40 MiB is free. Taking the hider's 10 MiB as written would leave 34 MiB
    // for two more 16 MiB turns; holding its whole reservation leaves room
    // for one, and the ledger still admits that one.
    unmeasured = 10 * MiB;
    turn();
    expect(refusal(() => turn())?.errorClass).toBe("worker_state_busy");
  } finally { fs.chmodSync(hidden, 0o700); }
});

test("a turn may not grow past the per-turn bound, whatever the tmpfs holds", () => {
  total = 1024 * MiB;
  const grower = turn();
  fs.mkdirSync(join(grower.path, project), { recursive: true });
  fs.writeFileSync(join(grower.path, project, `${ITHACA}.jsonl`), Buffer.alloc(129 * MiB));
  expect(refusal(() => grower.ensure())?.errorClass).toBe("worker_state_exceeded");
});

test("a session that never fits this tmpfs is session_too_large, not busy", () => {
  history(TROY, 50);
  let error: any; try { turn(TROY); } catch (e) { error = e; }
  expect(error?.errorClass).toBe("session_too_large");
});

test("agent memory is copied in and changed or new notes persist; nothing else in the folder does", () => {
  const memory = join(saved, project, "memory");
  fs.mkdirSync(memory); fs.writeFileSync(join(memory, "MEMORY.md"), "- [Ithaca](ithaca.md)\n");
  fs.writeFileSync(join(memory, "ithaca.md"), "Penelope waits.\n");
  fs.writeFileSync(join(memory, "unchanged.md"), "Argos sleeps.\n");
  const state = turn();
  const copy = join(state.path, project, "memory");
  expect(fs.readFileSync(join(copy, "ithaca.md"), "utf8")).toBe("Penelope waits.\n");
  fs.appendFileSync(join(copy, "MEMORY.md"), "- [Troy](troy.md)\n");
  fs.writeFileSync(join(copy, "troy.md"), "The horse is inside the walls.\n");
  fs.rmSync(join(copy, "ithaca.md"));
  fs.writeFileSync(join(copy, "notes.txt"), "not a note");
  fs.mkdirSync(join(copy, "nested")); fs.writeFileSync(join(copy, "nested", "deep.md"), "too deep");
  state.persist();
  expect(fs.readFileSync(join(memory, "MEMORY.md"), "utf8")).toBe("- [Ithaca](ithaca.md)\n- [Troy](troy.md)\n");
  expect(fs.readFileSync(join(memory, "troy.md"), "utf8")).toBe("The horse is inside the walls.\n");
  expect(fs.readFileSync(join(memory, "ithaca.md"), "utf8"), "a deletion is never carried back").toBe("Penelope waits.\n");
  expect(fs.readdirSync(memory).sort()).toEqual(["MEMORY.md", "ithaca.md", "troy.md", "unchanged.md"]);
});

test("memory is created for a brain that had none", () => {
  const state = turn();
  fs.mkdirSync(join(state.path, project, "memory"), { recursive: true });
  fs.writeFileSync(join(state.path, project, "memory", "MEMORY.md"), "- [Troy](troy.md)\n");
  state.persist();
  expect(fs.readFileSync(join(saved, project, "memory", "MEMORY.md"), "utf8")).toBe("- [Troy](troy.md)\n");
});

test("a note another turn changed meanwhile is refused alone and named; the rest persist", () => {
  const memory = join(saved, project, "memory");
  fs.mkdirSync(memory); fs.writeFileSync(join(memory, "MEMORY.md"), "index\n");
  const state = turn();
  fs.writeFileSync(join(memory, "MEMORY.md"), "index changed by another turn\n");
  fs.writeFileSync(join(state.path, project, "memory", "MEMORY.md"), "index changed by this turn\n");
  fs.writeFileSync(join(state.path, project, "memory", "troy.md"), "The horse is inside the walls.\n");
  expect(() => state.persist()).toThrow("saved memory changed concurrently; refusing overwrite of memory/MEMORY.md");
  expect(fs.readFileSync(join(memory, "MEMORY.md"), "utf8")).toBe("index changed by another turn\n");
  expect(fs.readFileSync(join(memory, "troy.md"), "utf8")).toBe("The horse is inside the walls.\n");
});

test("memory refuses aliases both ways", () => {
  const memory = join(saved, project, "memory");
  fs.mkdirSync(memory); fs.writeFileSync(join(brain, "policy.md"), "Athena policy");
  fs.symlinkSync(join(brain, "policy.md"), join(memory, "policy.md"));
  expect(() => turn()).toThrow("alias");
  expect(ledger.live).toBe(0);
  fs.rmSync(join(memory, "policy.md"));
  const state = turn();
  fs.mkdirSync(join(state.path, project, "memory"), { recursive: true });
  fs.symlinkSync(join(brain, "policy.md"), join(state.path, project, "memory", "policy.md"));
  expect(() => state.persist()).toThrow("alias");
  expect(fs.existsSync(join(memory, "policy.md"))).toBe(false);
  expect(fs.readFileSync(join(brain, "policy.md"), "utf8")).toBe("Athena policy");
});

test("memory counts against the reservation", () => {
  total = 20 * MiB;
  fs.mkdirSync(join(saved, project, "memory"));
  fs.writeFileSync(join(saved, project, "memory", "MEMORY.md"), Buffer.alloc(5 * MiB, 0x41));
  let error: any; try { turn(); } catch (e) { error = e; }
  expect(error?.errorClass).toBe("worker_host_unsupported");
});

test("live usage is measured before free space is read, at admission and while growing", () => {
  const calls: string[] = [];
  const space = () => { calls.push("space"); return { free: 64 * MiB, total: 64 * MiB }; };
  const own = createStateLedger({ space, growth: 16 * MiB, max: 128 * MiB,
    measure: () => { calls.push("measure"); return 15 * MiB; } });
  const first = own.reserve({ path: "a", bytes: 16 * MiB, space });
  calls.length = 0;
  own.reserve({ path: "b", bytes: 16 * MiB, space });
  expect(calls).toEqual(["measure", "space"]);
  calls.length = 0;
  first.ensure();
  expect(calls).toEqual(["measure", "measure", "space"]);
});
