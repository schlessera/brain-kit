import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchAgentWorker, prepareWorkerSandbox, WORKER_SCRATCH, WORKER_STATE, workerCommand } from "../src/server/worker-launcher";
import { rewriteLinkDestinations } from "../src/internal-client";
import { createTurnTempPromoter, type TurnTempPromoterOptions } from "../src/server/worker-turn-temp";

const ROOT = resolve(import.meta.dir, "../../..");
const TURN = "5e1c7a2b-0d3f-4b8e-9a61-7c2d4e5f6a7b";
const LINUX = process.platform === "linux" && Boolean(Bun.which("bwrap"));
/** A small allowance, so a test can fill it quickly. */
const ALLOWANCE = 8 * 1024 * 1024;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** A brain on the repository's disk, so turn temp can never share its device. */
function fixture() {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "tmp/turn-temp-"));
  const brain = join(root, "brain"), home = join(root, "home"), outside = join(root, "outside");
  mkdirSync(join(brain, ".brain/scratch"), { recursive: true }); mkdirSync(join(brain, "notes"));
  mkdirSync(home); mkdirSync(outside);
  writeFileSync(join(brain, ".gitignore"), ".brain/scratch/\n");
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Penelope\n");
  writeFileSync(join(outside, "host-secret.txt"), "Polyphemus: never copied.\n");
  // What the promoter reads as the worker's /tmp: in production the root of
  // the held descriptor to its private tmpfs; any directory works the same.
  const tmp = join(root, "tmp");
  mkdirSync(tmp);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, brain, home, outside, tmp };
}

function promoter(f: { brain: string; tmp: string }, extra: Partial<TurnTempPromoterOptions> = {}) {
  return createTurnTempPromoter({ brain: f.brain, tmp: f.tmp, turnId: TURN, scratch: WORKER_SCRATCH, scratchWritable: true, ...extra });
}

/** Turn-temp paths as the host holds them. */
const inTmp = (tmp: string, rel: string) => join(tmp, rel);
const promotedDir = (brain: string) => join(brain, ".brain/scratch/turns", TURN);

/** Every file below `dir`, relative, to prove nothing else was written. */
function tree(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name), rel = prefix ? `${prefix}/${name}` : name;
    return lstatSync(path).isDirectory() ? tree(path, rel) : [rel];
  });
}

/** Runs a real worker with a size-limited turn temp; resolves once it has exited, with its output. */
async function run(f: ReturnType<typeof fixture>, program: string, extra: { stateBytes?: number } = {}) {
  const sandbox = prepareWorkerSandbox(f.brain, { home: f.home });
  const worker = launchAgentWorker({ brainPath: f.brain, command: [process.execPath, "-e", program], env: { HOME: f.home },
    sandbox, turnTempBytes: ALLOWANCE, ...extra });
  cleanups.push(() => { worker.turnTemp?.close(); worker.state?.close(); });
  worker.stdin.end();
  const [code, output, errors] = await Promise.all([worker.exited, new Response(worker.stdout as unknown as ReadableStream).text(),
    new Response(worker.stderr as unknown as ReadableStream).text()]);
  return { code, output, errors, worker, sandbox };
}

describe("turn temp (#1655, #1703)", () => {
  test.skipIf(!LINUX)("the held-root gate refuses a private tmpfs whose size differs from admission", () => {
    const f = fixture();
    const spawn = Bun.spawn.bind(Bun);
    const altered = spyOn(Bun, "spawn").mockImplementation(((command: any, options: any) => {
      if (options?.env?.BRAIN_WORKER_LAUNCH) {
        const launch = JSON.parse(options.env.BRAIN_WORKER_LAUNCH);
        launch.argv[launch.argv.indexOf("--size") + 1] = String(ALLOWANCE + 4096);
        options = { ...options, env: { ...options.env, BRAIN_WORKER_LAUNCH: JSON.stringify(launch) } };
      }
      return spawn(command, options);
    }) as typeof Bun.spawn);
    let worker: ReturnType<typeof launchAgentWorker> | undefined;
    try {
      expect(() => { worker = launchAgentWorker({ brainPath: f.brain, command: [process.execPath, "-e", "console.log('unexpected-worker')"],
        env: {}, sandbox: prepareWorkerSandbox(f.brain, {}), turnTempBytes: ALLOWANCE }); })
        .toThrow("private turn-temp tmpfs was not mounted in time");
    } finally { altered.mockRestore(); worker?.kill("SIGKILL"); worker?.turnTemp?.close(); }
  });

  test.skipIf(!LINUX)("a real worker's /tmp is a private tmpfs of exactly the allowance; the server promotes from it after exit", async () => {
    const f = fixture();
    const program = `import * as fs from "node:fs";
      const scratch = process.env.BRAIN_WORKER_SCRATCH;
      const tmp = fs.statfsSync("/tmp");
      fs.writeFileSync(scratch + "/report.pdf", "Odysseus: the voyage report.");
      fs.mkdirSync("/tmp/ithaca"); fs.writeFileSync("/tmp/ithaca/plan.txt", "Return home.");
      fs.mkdirSync(process.env.XDG_CACHE_HOME + "/tool", { recursive: true });
      // $HOME stays the host's, read-only: there is no per-turn home overlay.
      let home = "written";
      try { fs.writeFileSync(process.env.HOME + "/letter.md", "Dear Penelope."); } catch (error) { home = error.code; }
      console.log(JSON.stringify({ scratch, size: tmp.blocks * tmp.bsize, type: tmp.type, home, cache: process.env.XDG_CACHE_HOME }));`;
    const { code, output, worker } = await run(f, program);
    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual({ scratch: WORKER_SCRATCH, size: ALLOWANCE, type: 0x01021994, home: "EROFS",
      cache: "/tmp/brain-worker-home/cache" });
    expect(existsSync(join(f.home, "letter.md"))).toBe(false);
    // Nothing of the turn reached the host: not its /tmp, not the fixture.
    expect(readdirSync(f.tmp)).toEqual([]);
    const root = worker.turnTemp!.root;
    expect(statfsSync(root).blocks * statfsSync(root).bsize).toBe(ALLOWANCE);
    expect(readFileSync(join(root, "ithaca/plan.txt"), "utf8")).toBe("Return home.");

    const p = promoter({ brain: f.brain, tmp: root });
    const answer = [
      "Here is [the report](/tmp/brain-worker-scratch/report.pdf) and ![plan](</tmp/ithaca/plan.txt> \"plan\").",
      "Again: [report](file:///tmp/brain-worker-scratch/report.pdf#page=2).",
      `Elsewhere: [home](${f.home}/.gitconfig) and [home again](~/.gitconfig).`,
      "Kept: [scratch](.brain/scratch/map.png), [note](notes/ithaca.md) and [brain](" + f.brain + "/notes/ithaca.md).",
      "```sh\ncat [x](/tmp/ithaca/plan.txt)\n```",
    ].join("\n");
    const stored = p.rewrite(answer);
    const dest = `.brain/scratch/turns/${TURN}`;
    expect(stored).toBe([
      `Here is [the report](${dest}/report.pdf) and ![plan](${dest}/plan.txt "plan").`,
      `Again: [report](${dest}/report.pdf#page=2).`,
      `Elsewhere: [home](${f.home}/.gitconfig) and [home again](~/.gitconfig).`,
      "Kept: [scratch](.brain/scratch/map.png), [note](notes/ithaca.md) and [brain](" + f.brain + "/notes/ithaca.md).",
      "```sh\ncat [x](/tmp/ithaca/plan.txt)\n```",
    ].join("\n"));
    expect(stored).not.toMatch(/promot|turn temp|copied/i);
    expect(readFileSync(join(promotedDir(f.brain), "report.pdf"), "utf8")).toBe("Odysseus: the voyage report.");
    expect(p.records).toEqual([
      { kind: "promotion", source: "/tmp/brain-worker-scratch/report.pdf", destination: `${dest}/report.pdf`, bytes: 28,
        originalLink: "/tmp/brain-worker-scratch/report.pdf", rewrittenLink: `${dest}/report.pdf`,
        aliases: [{ originalLink: "file:///tmp/brain-worker-scratch/report.pdf#page=2", rewrittenLink: `${dest}/report.pdf#page=2` }] },
      { kind: "promotion", source: "/tmp/ithaca/plan.txt", destination: `${dest}/plan.txt`, bytes: 12,
        originalLink: "</tmp/ithaca/plan.txt>", rewrittenLink: `${dest}/plan.txt` },
    ]);
    expect(tree(join(f.brain, ".brain/scratch")).sort()).toEqual([`turns/${TURN}/plan.txt`, `turns/${TURN}/report.pdf`]);
    // What the host sends a live view (#1698), applied with the client's
    // function, turns the streamed answer into exactly the stored one.
    const links = new Map(p.records.flatMap(r => r.kind === "promotion" ? [r, ...(r.aliases ?? [])] : [])
      .map(link => [link.originalLink, link.rewrittenLink]));
    expect(rewriteLinkDestinations(answer, destination => links.get(destination) ?? destination)).toBe(stored);
  });

  test.skipIf(!LINUX)("one worker filling its turn temp leaves another worker's turn temp and the host untouched", async () => {
    const f = fixture();
    const hostBefore = statfsSync("/dev/shm").bavail;
    const filler = `import * as fs from "node:fs";
      let written = 0;
      try { for (;;) { fs.appendFileSync("/tmp/flood.bin", Buffer.alloc(1 << 20, 79)); written += 1 << 20; } }
      catch (error) { console.log(JSON.stringify({ code: error.code, written })); }`;
    const quiet = `import * as fs from "node:fs";
      fs.writeFileSync(process.env.BRAIN_WORKER_SCRATCH + "/note.txt", "Ithaca.");
      const tmp = fs.statfsSync("/tmp");
      console.log(JSON.stringify({ free: tmp.bavail * tmp.bsize, entries: fs.readdirSync("/tmp").sort() }));`;
    const [full, other] = await Promise.all([run(f, filler), run(f, quiet)]);
    const flooded = JSON.parse(full.output);
    expect(flooded.code).toBe("ENOSPC");
    expect(flooded.written).toBeLessThanOrEqual(ALLOWANCE);
    expect(flooded.written).toBeGreaterThan(ALLOWANCE / 2);
    expect(full.worker.turnTemp!.space().free).toBeLessThan(1024 * 1024);
    const quietState = JSON.parse(other.output);
    expect(quietState.entries).not.toContain("flood.bin");
    expect(quietState.free).toBeGreaterThan(ALLOWANCE - 1024 * 1024);
    expect(readFileSync(join(other.worker.turnTemp!.root, "brain-worker-scratch/note.txt"), "utf8")).toBe("Ithaca.");
    // The host's own tmpfs did not absorb the flood.
    expect(Math.abs(statfsSync("/dev/shm").bavail - hostBefore) * statfsSync("/dev/shm").bsize).toBeLessThan(ALLOWANCE / 2);
    expect(readdirSync(f.tmp)).toEqual([]);
  });

  test.skipIf(!LINUX)("links a worker plants in its turn temp mid-turn are refused after exit, through the held descriptor", async () => {
    const f = fixture();
    const program = `import * as fs from "node:fs";
      const s = process.env.BRAIN_WORKER_SCRATCH;
      fs.symlinkSync(${JSON.stringify(join(f.outside, "host-secret.txt"))}, s + "/secret.txt");
      fs.symlinkSync(${JSON.stringify(f.outside)}, s + "/outside");
      fs.symlinkSync("/proc/self/root/etc", s + "/etc");
      fs.writeFileSync(s + "/twice.txt", "Scylla and Charybdis.");
      fs.linkSync(s + "/twice.txt", s + "/twice-again.txt");
      fs.mkdirSync(s + "/cave");
      fs.symlinkSync(s + "/cave", "/tmp/cave-link");`;
    const { code, worker } = await run(f, program);
    expect(code).toBe(0);
    const p = promoter({ brain: f.brain, tmp: worker.turnTemp!.root });
    const answer = ["secret.txt", "outside/host-secret.txt", "etc/hostname", "twice.txt", "cave"]
      .map(name => `[${name}](/tmp/brain-worker-scratch/${name})`).join(" ") + " [c](/tmp/cave-link/x)";
    expect(p.rewrite(answer)).toBe(answer);
    expect(p.records.map(r => r.kind === "promotion_refused" ? [r.source.split("/").slice(-2).join("/"), r.reason] : r.kind)).toEqual([
      ["brain-worker-scratch/secret.txt", "symlink"], ["outside/host-secret.txt", "symlink"], ["etc/hostname", "symlink"],
      ["brain-worker-scratch/twice.txt", "multiple_links"], ["brain-worker-scratch/cave", "not_regular_file"], ["cave-link/x", "symlink"],
    ]);
    expect(tree(join(f.brain, ".brain/scratch"))).toEqual([]);
    expect(readFileSync(join(f.outside, "host-secret.txt"), "utf8")).toBe("Polyphemus: never copied.\n");
  });

  test.skipIf(!LINUX)("runtime state mounted below /tmp is never read as turn temp, even unexcluded", async () => {
    const f = fixture();
    const program = `import * as fs from "node:fs";
      fs.writeFileSync(${JSON.stringify(WORKER_STATE)} + "/transcript.jsonl", "Calypso: private.");
      // Wait until the server has read: the state mount only exists while the namespace lives.
      await Bun.stdin.text();`;
    const sandbox = prepareWorkerSandbox(f.brain, { home: f.home });
    const worker = launchAgentWorker({ brainPath: f.brain, command: [process.execPath, "-e", program], env: { HOME: f.home },
      sandbox, turnTempBytes: ALLOWANCE, stateBytes: 4 * 1024 * 1024 });
    cleanups.push(() => { worker.kill("SIGKILL"); worker.turnTemp?.close(); worker.state?.close(); });
    const state = worker.state!.root;
    const deadline = Date.now() + 5_000;
    while (!existsSync(join(state, "transcript.jsonl")) && Date.now() < deadline) await Bun.sleep(10);
    expect(readFileSync(join(state, "transcript.jsonl"), "utf8")).toBe("Calypso: private.");
    // No exclusion: only the mount boundary keeps the promotion out of runtime state.
    const p = promoter({ brain: f.brain, tmp: worker.turnTemp!.root });
    expect(p.rewrite(`[t](${WORKER_STATE}/transcript.jsonl)`)).toBe(`[t](${WORKER_STATE}/transcript.jsonl)`);
    expect(p.records).toMatchObject([{ kind: "promotion_refused", reason: "missing" }]);
    expect(tree(join(f.brain, ".brain/scratch"))).toEqual([]);
    worker.stdin.end();
    expect(await worker.exited).toBe(0);
  });

  test("a symlink (to a host file or a directory), a hardlink, a directory and a missing file are refused", () => {
    const f = fixture();
    const scratch = inTmp(f.tmp, "brain-worker-scratch");
    mkdirSync(scratch);
    symlinkSync(join(f.outside, "host-secret.txt"), join(scratch, "secret.txt"));
    symlinkSync(f.outside, join(scratch, "outside"));
    writeFileSync(join(scratch, "twice.txt"), "Scylla and Charybdis.");
    linkSync(join(scratch, "twice.txt"), join(scratch, "twice-again.txt"));
    mkdirSync(join(scratch, "cave"));
    const p = promoter(f);
    const answer = ["secret.txt", "outside/host-secret.txt", "twice.txt", "cave", "absent.txt"]
      .map(name => `[${name}](/tmp/brain-worker-scratch/${name})`).join(" ");
    expect(p.rewrite(answer)).toBe(answer);
    expect(p.records.map(r => r.kind === "promotion_refused" ? [r.source.split("/").pop(), r.reason] : r.kind)).toEqual([
      ["secret.txt", "symlink"], ["host-secret.txt", "symlink"], ["twice.txt", "multiple_links"], ["cave", "not_regular_file"],
      ["absent.txt", "missing"],
    ]);
    expect(p.records[2]).toMatchObject({ originalLink: "/tmp/brain-worker-scratch/twice.txt", bytes: 21, limitBytes: null });
    expect(tree(join(f.brain, ".brain/scratch"))).toEqual([]);
    expect(readFileSync(join(f.outside, "host-secret.txt"), "utf8")).toBe("Polyphemus: never copied.\n");
  });

  test("a file that grows past the bound while it is copied is refused, and no partial copy stays", () => {
    const f = fixture();
    mkdirSync(inTmp(f.tmp, "brain-worker-scratch"));
    const source = inTmp(f.tmp, "brain-worker-scratch/log.txt");
    writeFileSync(source, "x".repeat(1000));
    const p = promoter(f, { limits: { fileBytes: 4096 }, beforeCopy: () => appendFileSync(source, "y".repeat(8192)) });
    expect(p.rewrite("[log](/tmp/brain-worker-scratch/log.txt)")).toBe("[log](/tmp/brain-worker-scratch/log.txt)");
    expect(p.records).toEqual([{ kind: "promotion_refused", source: "/tmp/brain-worker-scratch/log.txt",
      originalLink: "/tmp/brain-worker-scratch/log.txt", reason: "file_too_large", bytes: expect.any(Number), limitBytes: 4096 }]);
    expect((p.records[0] as { bytes: number }).bytes).toBeGreaterThan(4096);
    expect(tree(promotedDir(f.brain))).toEqual([]);
  });

  test("the per-file, per-turn and file-count bounds refuse before copying", () => {
    const f = fixture();
    mkdirSync(inTmp(f.tmp, "notes"));
    for (const [name, bytes] of [["big.bin", 5000], ["a.txt", 1500], ["b.txt", 1500], ["c.txt", 10]] as const) {
      writeFileSync(inTmp(f.tmp, `notes/${name}`), "o".repeat(bytes));
    }
    const p = promoter(f, { limits: { fileBytes: 4096, turnBytes: 2048, files: 2 } });
    const text = p.rewrite("[big](/tmp/notes/big.bin) [a](/tmp/notes/a.txt) [b](/tmp/notes/b.txt) [c](/tmp/notes/c.txt)");
    expect(text).toBe(`[big](/tmp/notes/big.bin) [a](.brain/scratch/turns/${TURN}/a.txt) [b](/tmp/notes/b.txt) [c](.brain/scratch/turns/${TURN}/c.txt)`);
    expect(p.records.map(r => r.kind === "promotion" ? "promoted" : [r.reason, r.bytes, r.limitBytes])).toEqual([
      ["file_too_large", 5000, 4096], "promoted", ["turn_too_large", 1500, 2048], "promoted",
    ]);
    writeFileSync(inTmp(f.tmp, "notes/d.txt"), "d");
    p.rewrite("[d](/tmp/notes/d.txt)");
    expect(p.records.at(-1)).toMatchObject({ reason: "turn_too_large", bytes: null, limitBytes: null });
  });

  test("a symlinked destination directory is refused and nothing is written outside scratch", () => {
    const f = fixture();
    mkdirSync(inTmp(f.tmp, "brain-worker-scratch"));
    writeFileSync(inTmp(f.tmp, "brain-worker-scratch/report.pdf"), "Odysseus.");
    // A worker with writable scratch could plant this during its turn.
    symlinkSync(f.outside, join(f.brain, ".brain/scratch/turns"));
    const p = promoter(f);
    expect(p.rewrite("[r](/tmp/brain-worker-scratch/report.pdf)")).toBe("[r](/tmp/brain-worker-scratch/report.pdf)");
    expect(p.records).toMatchObject([{ kind: "promotion_refused", reason: "io_error" }]);
    expect(readdirSync(f.outside)).toEqual(["host-secret.txt"]);
  });

  test("unusable scratch refuses every promotion by name; names are sanitized and kept apart", () => {
    const f = fixture();
    mkdirSync(inTmp(f.tmp, "a")); mkdirSync(inTmp(f.tmp, "b"));
    writeFileSync(inTmp(f.tmp, "a/Voyage Report.pdf"), "1"); writeFileSync(inTmp(f.tmp, "b/Voyage Report.pdf"), "2");
    const off = promoter(f, { scratchWritable: false });
    off.rewrite("[r](</tmp/a/Voyage Report.pdf>)");
    expect(off.records).toMatchObject([{ reason: "scratch_unavailable" }]);
    const p = promoter(f);
    expect(p.rewrite("[1](/tmp/a/Voyage%20Report.pdf) [2](</tmp/b/Voyage Report.pdf>) [1 again]($BRAIN_WORKER_SCRATCH/../a/Voyage%20Report.pdf)"))
      .toBe(`[1](.brain/scratch/turns/${TURN}/Voyage-Report.pdf) [2](.brain/scratch/turns/${TURN}/Voyage-Report-2.pdf) [1 again](.brain/scratch/turns/${TURN}/Voyage-Report.pdf)`);
    expect(p.records).toHaveLength(2);
    expect(readFileSync(join(promotedDir(f.brain), "Voyage-Report-2.pdf"), "utf8")).toBe("2");
  });

  test("a destination with parentheses is read whole, and excluded runtime state is never promoted", () => {
    const f = fixture();
    mkdirSync(inTmp(f.tmp, "brain-worker-scratch/pi-state"), { recursive: true });
    writeFileSync(inTmp(f.tmp, "report"), "decoy"); writeFileSync(inTmp(f.tmp, "report(v1).pdf"), "Odysseus v1.");
    writeFileSync(inTmp(f.tmp, "brain-worker-scratch/pi-state/auth.json"), "{\"key\":\"Cyclops\"}");
    const p = promoter(f, { exclude: ["/tmp/brain-worker-scratch/pi-state"] });
    const state = "[login](/tmp/brain-worker-scratch/pi-state/auth.json)";
    expect(p.rewrite(`[v1](/tmp/report(v1).pdf "Version one") [bad](/tmp/report(v1).pdfx%) ${state}`))
      .toBe(`[v1](.brain/scratch/turns/${TURN}/report-v1.pdf "Version one") [bad](/tmp/report(v1).pdfx%) ${state}`);
    expect(readFileSync(join(promotedDir(f.brain), "report-v1.pdf"), "utf8")).toBe("Odysseus v1.");
    expect(p.records.map(r => [r.kind, r.source])).toEqual([["promotion", "/tmp/report(v1).pdf"], ["promotion_refused", "/tmp/report(v1).pdfx%"]]);
    // Line endings Markdown allows inside the parentheses, and nested parentheses.
    writeFileSync(inTmp(f.tmp, "chart(v(2)).png"), "chart"); writeFileSync(inTmp(f.tmp, "log.txt"), "log");
    expect(p.rewrite("![c](\n/tmp/chart(v(2)).png\n) [l](</tmp/log.txt>\n\"Log\")"))
      .toBe(`![c](\n.brain/scratch/turns/${TURN}/chart-v-2.png\n) [l](.brain/scratch/turns/${TURN}/log.txt\n"Log")`);
  });

  test.skipIf(!LINUX)("the launch mounts /tmp at exactly the allowance, with scratch inside it and no home overlay", () => {
    const f = fixture();
    const sandbox = prepareWorkerSandbox(f.brain, { home: f.home });
    const argv = workerCommand({ brainPath: f.brain, command: [process.execPath], env: { HOME: f.home }, sandbox, turnTempBytes: ALLOWANCE });
    const at = argv.indexOf("--size");
    expect(argv.slice(at, at + 4)).toEqual(["--size", String(ALLOWANCE), "--tmpfs", "/tmp"]);
    expect(argv).toEqual(expect.arrayContaining(["--dir", WORKER_SCRATCH]));
    expect(argv).not.toContain("--overlay");
    expect(argv).not.toContain("--tmp-overlay");
    expect(argv.join(" ")).not.toContain(` --bind ${f.home}`);
    expect(() => workerCommand({ brainPath: f.brain, command: [process.execPath], env: {}, turnTempBytes: ALLOWANCE + 1 })).toThrow("turn-temp allowance");
    expect(() => workerCommand({ brainPath: f.brain, command: [process.execPath], env: {}, turnTempBytes: ALLOWANCE,
      scratchPath: f.outside })).toThrow("size-limited /tmp");
  });
});
