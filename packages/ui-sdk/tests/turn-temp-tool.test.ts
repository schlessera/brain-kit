import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchAgentWorker, prepareWorkerSandbox, WORKER_SCRATCH, WORKER_STATE } from "../src/server/worker-launcher";
import { WORKER_XDG_DIRS, WORKER_XDG_HOME } from "../src/server/worker-sandbox";
import { createTurnTempPressure, purgeTurnTemp, turnTempPath, turnTempUsage, TURN_TEMP_WALK_LIMIT, type TurnTempAccess } from "../src/server/worker-turn-temp";
import { handleTurnTemp, type TurnTempPurgeRecord } from "../src/server/bridge-tools/turn-temp";

const ROOT = resolve(import.meta.dir, "../../..");
const LINUX = process.platform === "linux" && Boolean(Bun.which("bwrap"));
const MIB = 1024 * 1024;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** A turn-temp root laid out as bubblewrap lays out a worker's /tmp, and a host directory beside it. */
function fixture() {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const base = mkdtempSync(join(ROOT, "tmp/turn-temp-tool-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "tmp"), outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "host-secret.txt"), "Polyphemus: never removed.\n");
  for (const dir of [WORKER_SCRATCH, ...Object.values(WORKER_XDG_DIRS)]) mkdirSync(join(root, dir.slice("/tmp".length)), { recursive: true });
  let text = "";
  const access: TurnTempAccess = { root: () => root, allowanceBytes: 64 * MIB, scratch: WORKER_SCRATCH, exclude: [WORKER_STATE],
    keep: [WORKER_SCRATCH, ...Object.values(WORKER_XDG_DIRS)], linkedText: () => text };
  return { root, outside, access, link: (value: string) => { text = value; } };
}

const put = (root: string, rel: string, content = "Odysseus.") => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), content);
};

describe("turn_temp paths (#1703)", () => {
  test("resolve below the turn-temp root only", () => {
    for (const outside of ["", "/", "/tmp", "/etc/passwd", "/tmp/../etc/passwd", "../etc", "a/../../x", "a/..", "/tmpx/a", "x\u0000y"]) {
      expect(turnTempPath(outside, WORKER_SCRATCH), outside).toBeNull();
    }
    expect(turnTempPath("brain-worker-scratch/a.pdf", WORKER_SCRATCH)).toBe("/tmp/brain-worker-scratch/a.pdf");
    expect(turnTempPath("/tmp/./x//y", WORKER_SCRATCH)).toBe("/tmp/x/y");
    expect(turnTempPath("$BRAIN_WORKER_SCRATCH/frames", WORKER_SCRATCH)).toBe(`${WORKER_SCRATCH}/frames`);
    expect(turnTempPath("${BRAIN_WORKER_SCRATCH}", WORKER_SCRATCH)).toBe(WORKER_SCRATCH);
  });
});

describe("turn_temp purge (#1703)", () => {
  test("a bounded purge reports remaining entries and its governance receipt admits truncation", () => {
    const f = fixture();
    for (let n = 0; n < TURN_TEMP_WALK_LIMIT + 2; n++) writeFileSync(join(f.root, `draft-${n}`), "");
    const events: TurnTempPurgeRecord[] = [];
    const result = handleTurnTemp({ action: "purge", all: true }, f.access, event => events.push(event)) as any;
    expect(result.truncated, "a partial purge must report truncation").toBe(true);
    expect(events[0]!.truncated).toBe(true);
    expect(readdirSync(f.root).some(name => name.startsWith("draft-"))).toBe(true);
    const retry = handleTurnTemp({ action: "purge", all: true }, f.access, event => events.push(event)) as any;
    expect(retry.truncated).toBe(false);
    expect(events[1]!.truncated).toBe(false);
    expect(readdirSync(f.root).some(name => name.startsWith("draft-"))).toBe(false);
  });

  test("a named path outside turn temp is refused, and nothing outside is touched", () => {
    const f = fixture();
    const result = purgeTurnTemp(f.access, { paths: ["../outside/host-secret.txt", f.outside, "/etc/hostname", "/tmp"] });
    expect(result.removed).toEqual([]);
    expect(result.skipped.map(s => s.reason)).toEqual(["outside", "outside", "outside", "outside"]);
    expect(readFileSync(join(f.outside, "host-secret.txt"), "utf8")).toBe("Polyphemus: never removed.\n");
  });

  test("a planted symlink in the path is not followed; a symlink or hardlink named is unlinked, its target kept", () => {
    const f = fixture();
    symlinkSync(f.outside, join(f.root, "escape"));
    symlinkSync(join(f.outside, "host-secret.txt"), join(f.root, "secret-link"));
    linkSync(join(f.outside, "host-secret.txt"), join(f.root, "secret-hardlink"));
    symlinkSync(f.outside, join(f.root, "dir-link"));
    const result = purgeTurnTemp(f.access, { paths: ["escape/host-secret.txt", "secret-link", "secret-hardlink", "dir-link"] });
    expect(result.skipped).toEqual([{ path: "/tmp/escape/host-secret.txt", reason: "symlink_in_path" }]);
    expect(result.removed.map(r => r.path)).toEqual(["/tmp/secret-link", "/tmp/secret-hardlink", "/tmp/dir-link"]);
    expect(readdirSync(f.root).sort()).toEqual(["brain-worker-home", "brain-worker-scratch", "escape"]);
    expect(readdirSync(f.outside)).toEqual(["host-secret.txt"]);
    expect(readFileSync(join(f.outside, "host-secret.txt"), "utf8")).toBe("Polyphemus: never removed.\n");
  });

  test("files the answer links are kept unless force names them; all never forces", () => {
    const f = fixture();
    put(f.root, "brain-worker-scratch/report.pdf", "report");
    put(f.root, "brain-worker-scratch/frames/001.png", "frame");
    put(f.root, "ithaca/plan.txt", "plan");
    f.link("See [the report]($BRAIN_WORKER_SCRATCH/report.pdf) and ![plan](</tmp/ithaca/plan.txt>).");
    const kept = purgeTurnTemp(f.access, { all: true, force: true });
    expect(kept.skipped).toEqual([{ path: "/tmp/brain-worker-scratch/report.pdf", reason: "linked" },
      { path: "/tmp/ithaca/plan.txt", reason: "linked" }]);
    expect(kept.removed.map(r => r.path)).toEqual(["/tmp/brain-worker-scratch/frames/001.png", "/tmp/brain-worker-scratch/frames"]);
    // The directories bubblewrap made for the worker stay; a linked file keeps its directory.
    for (const dir of [WORKER_SCRATCH, WORKER_XDG_HOME, ...Object.values(WORKER_XDG_DIRS), "/tmp/ithaca"]) {
      expect(existsSync(join(f.root, dir.slice("/tmp".length))), dir).toBe(true);
    }
    const named = purgeTurnTemp(f.access, { paths: ["brain-worker-scratch/report.pdf"] });
    expect(named.skipped).toEqual([{ path: "/tmp/brain-worker-scratch/report.pdf", reason: "linked" }]);
    const forced = purgeTurnTemp(f.access, { paths: ["ithaca"], force: true });
    expect(forced.removed.map(r => r.path)).toEqual(["/tmp/ithaca/plan.txt", "/tmp/ithaca"]);
    expect(existsSync(join(f.root, "brain-worker-scratch/report.pdf"))).toBe(true);
  });

  test("runtime state below /tmp is never purged, by name or with all", () => {
    const f = fixture();
    put(f.root, "brain-worker-state/projects/session.jsonl", "Calypso.");
    put(f.root, "scratchpad.txt", "x");
    const named = purgeTurnTemp(f.access, { paths: ["brain-worker-state/projects", "/tmp/brain-worker-state"] });
    expect(named.skipped.map(s => s.reason)).toEqual(["not_turn_temp", "not_turn_temp"]);
    const all = purgeTurnTemp(f.access, { all: true });
    expect(all.removed.map(r => r.path)).toEqual(["/tmp/scratchpad.txt"]);
    expect(readFileSync(join(f.root, "brain-worker-state/projects/session.jsonl"), "utf8")).toBe("Calypso.");
  });

  test("usage lists the largest files and directories, outside runtime state", () => {
    const f = fixture();
    put(f.root, "brain-worker-scratch/frames/001.png", "x".repeat(3000));
    put(f.root, "brain-worker-scratch/frames/002.png", "x".repeat(2000));
    put(f.root, "notes.txt", "x".repeat(100));
    put(f.root, "brain-worker-state/session.jsonl", "x".repeat(9000));
    const usage = turnTempUsage(f.access);
    expect(usage.limitBytes).toBe(64 * MIB);
    expect(usage.largest.slice(0, 4)).toEqual([
      { path: "/tmp/brain-worker-scratch", bytes: 5000, type: "directory" },
      { path: "/tmp/brain-worker-scratch/frames", bytes: 5000, type: "directory" },
      { path: "/tmp/brain-worker-scratch/frames/001.png", bytes: 3000, type: "file" },
      { path: "/tmp/brain-worker-scratch/frames/002.png", bytes: 2000, type: "file" },
    ]);
    expect(usage.largest.some(entry => entry.path.includes("brain-worker-state"))).toBe(false);
    expect(usage.truncated).toBe(false);
  });

  test("the tool validates its input and records each purge as a governance event", () => {
    const f = fixture();
    put(f.root, "draft.md", "draft");
    const events: TurnTempPurgeRecord[] = [];
    expect(() => handleTurnTemp({ action: "usage", all: true }, f.access)).toThrow("takes no paths");
    expect(() => handleTurnTemp({ action: "purge" }, f.access)).toThrow("either paths or all");
    expect(() => handleTurnTemp({ action: "purge", all: true, paths: ["x"] }, f.access)).toThrow("either paths or all");
    expect(() => handleTurnTemp({ action: "purge", all: true, force: true }, f.access)).toThrow("named paths only");
    expect(() => handleTurnTemp({ action: "usage" }, undefined)).toThrow("no turn temp");
    expect(() => handleTurnTemp({ action: "purge", paths: Array(101).fill("x") }, f.access)).toThrow();
    expect(() => handleTurnTemp({ action: "usage" }, { ...f.access, root: () => undefined })).toThrow("No worker is running");
    const result = handleTurnTemp({ action: "purge", paths: ["draft.md", "../escape"] }, f.access, event => events.push(event)) as Record<string, unknown>;
    expect(result).toMatchObject({ removedCount: 1, skippedCount: 1, limitBytes: 64 * MIB });
    expect(events).toEqual([{ kind: "turn_temp_purge", truncated: false, all: false, force: false, paths: ["draft.md", "../escape"], removedEntries: 1,
      freedBytes: expect.any(Number), skippedLinked: [], skippedOther: 1, usedBytes: expect.any(Number), limitBytes: 64 * MIB }]);
  });

  test.skipIf(!LINUX)("a live worker's purge never crosses into its runtime-state mount, even unexcluded", async () => {
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    const base = mkdtempSync(join(ROOT, "tmp/turn-temp-live-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const brain = join(base, "brain");
    mkdirSync(join(brain, ".brain/scratch"), { recursive: true });
    writeFileSync(join(brain, ".gitignore"), ".brain/scratch/\n");
    const program = `import * as fs from "node:fs";
      fs.writeFileSync(${JSON.stringify(WORKER_STATE)} + "/transcript.jsonl", "Calypso: private.");
      fs.writeFileSync("/tmp/scratchpad.txt", "draft");
      console.log("ready");
      await Bun.stdin.text();
      console.log(fs.readFileSync(${JSON.stringify(WORKER_STATE)} + "/transcript.jsonl", "utf8"), fs.existsSync("/tmp/scratchpad.txt"));`;
    const worker = launchAgentWorker({ brainPath: brain, command: [process.execPath, "-e", program], env: {},
      sandbox: prepareWorkerSandbox(brain, {}), turnTempBytes: 8 * MIB, stateBytes: 4 * MIB });
    cleanups.push(() => { worker.kill("SIGKILL"); worker.turnTemp?.close(); worker.state?.close(); });
    const output = new Response(worker.stdout as unknown as ReadableStream).text();
    const deadline = Date.now() + 5_000;
    while (!existsSync(join(worker.state!.root, "transcript.jsonl")) && Date.now() < deadline) await Bun.sleep(10);
    const access: TurnTempAccess = { root: () => worker.turnTemp!.root, allowanceBytes: 8 * MIB, scratch: WORKER_SCRATCH,
      exclude: [], keep: [WORKER_SCRATCH], linkedText: () => "" };
    const all = purgeTurnTemp(access, { all: true });
    expect(all.removed.map(r => r.path)).toContain("/tmp/scratchpad.txt");
    expect(all.skipped).toContainEqual({ path: WORKER_STATE, reason: "not_turn_temp" });
    const named = purgeTurnTemp(access, { paths: ["brain-worker-state/transcript.jsonl"] });
    expect(named.skipped).toEqual([{ path: `${WORKER_STATE}/transcript.jsonl`, reason: "not_turn_temp" }]);
    worker.stdin.end();
    expect(await worker.exited).toBe(0);
    expect((await output).trim().split("\n").at(-1)).toBe("Calypso: private. false");
  });
});

describe("turn-temp pressure (#1703)", () => {
  test("warns once past 80%, says when full, and names the tool both times", () => {
    const allowance = 100 * 4096;
    const check = createTurnTempPressure(allowance, "mcp__brain-ui__turn_temp");
    const at = (used: number) => check({ usedBytes: used, freeBytes: allowance - used });
    expect(at(79 * 4096)).toBeUndefined();
    const warning = at(81 * 4096);
    expect(warning).toContain("81% full");
    expect(warning).toContain("`mcp__brain-ui__turn_temp`");
    expect(at(90 * 4096)).toBeUndefined();
    const full = at(allowance);
    expect(full).toContain("Turn temp is full");
    expect(full).toContain("ENOSPC");
    expect(full).toContain("`mcp__brain-ui__turn_temp`");
    expect(at(allowance)).toBeUndefined();
    // Freed and filled again: said again, but the 80% warning stays one-time.
    expect(at(10 * 4096)).toBeUndefined();
    expect(at(85 * 4096)).toBeUndefined();
    expect(at(allowance)).toContain("Turn temp is full");
  });
});
