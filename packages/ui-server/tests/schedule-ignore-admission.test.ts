/** Real Git children obey the schedule probe's existing shared writer gate. */
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHostBoundary } from "../src/brain/host-boundary.js";
import { createWriterGate, type GateHold } from "../src/brain/writer-gate.js";
import { createUiDb } from "../src/db/client.js";
import { gitCheckIgnored } from "../src/schedules/service.js";

function fixture(attached = true, repository = true) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-schedule-gate-")), brain = join(root, "brain");
  mkdirSync(brain);
  const git = Bun.which("git", { PATH: "/usr/bin:/bin" });
  if (!git) throw Error("Schedule admission proof requires installed Git");
  if (repository) expect(Bun.spawnSync([git, "init", "-q", brain], { env: { PATH: "/usr/bin:/bin", HOME: root,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).exitCode).toBe(0);
  writeFileSync(join(brain, ".gitignore"), "ignored.md\n");
  const db = createUiDb(join(root, "ui.db")), gate = createWriterGate(db, brain, { pollMs: 5 });
  const boundary = createHostBoundary({ brainPath: brain, gate: () => attached ? gate : null, requireGate: true,
    workerHost: () => ({ ok: false, requirement: "fictional pre-governed fixture" }) });
  const spawnRows: ReturnType<typeof gate.holders>[] = [], holds: GateHold[] = [], pending: Promise<unknown>[] = [];
  const original = Bun.spawn;
  const observing = spyOn(Bun, "spawn").mockImplementation(((argv: string[], options: any) => {
    if (argv[0] === "git") {
      spawnRows.push(gate.holders());
      // The host fallback control uses real Git with only fixture configuration.
      return original([git, ...argv.slice(1)], { ...options, env: { ...options.env, PATH: "/usr/bin:/bin", HOME: root,
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    }
    return original(argv, options);
  }) as typeof Bun.spawn);
  const ignored = gitCheckIgnored(brain, boundary);
  const check = (path: string) => { const task = ignored(path); pending.push(task.catch(() => {})); return task; };
  return { gate, spawnRows, holds, check, async close() {
    for (const hold of holds) hold.release();
    await Promise.all(pending); observing.mockRestore(); db.close(); rmSync(root, { recursive: true, force: true });
  } };
}

test("schedule Git runs shared beside a peer and keeps ordinary ignored/nonignored answers", async () => {
  const f = fixture();
  try {
    f.holds.push(await f.gate.acquire("shared", "Odysseus peer"));
    expect(await f.check("ignored.md")).toBe(true);
    expect(await f.check("public.md")).toBe(false);
    expect(f.spawnRows, "SCHEDULE_ACTUAL_GIT_HOLDS_SHARED_ADMISSION").toHaveLength(2);
    for (const rows of f.spawnRows) expect(rows).toMatchObject([{ mode: "shared", purpose: "Odysseus peer" },
      { mode: "shared", purpose: "git check-ignore" }]);
    expect(f.gate.holders()).toMatchObject([{ purpose: "Odysseus peer" }]);
  } finally { await f.close(); }
});

test("schedule Git waits for an exclusive holder before creating its actual child", async () => {
  const f = fixture();
  try {
    const held = await f.gate.acquire("exclusive", "Athena maintenance"); f.holds.push(held);
    const result = f.check("ignored.md");
    await Bun.sleep(25);
    expect(f.spawnRows, "SCHEDULE_EXCLUSIVE_OWNER_BLOCKS_PROCESS_CREATION").toEqual([]);
    held.release();
    expect(await result).toBe(true);
    expect(f.spawnRows).toHaveLength(1);
    expect(f.gate.holders()).toEqual([]);
  } finally { await f.close(); }
});

test("a required missing schedule gate refuses before a Git child exists", async () => {
  const f = fixture(false);
  try {
    const ignored = await f.check("ignored.md");
    expect(f.spawnRows, "REQUIRED_SCHEDULE_GATE_REFUSES_BEFORE_PROCESS_CREATION").toEqual([]);
    expect(ignored).toBe(false);
    expect(f.gate.holders()).toEqual([]);
  } finally { await f.close(); }
});

test("a real nonrepository Git failure releases schedule admission", async () => {
  const f = fixture(true, false);
  try {
    expect(await f.check("ignored.md")).toBe(false);
    expect(f.spawnRows).toHaveLength(1);
    expect(f.gate.holders()).toEqual([]);
  } finally { await f.close(); }
});
