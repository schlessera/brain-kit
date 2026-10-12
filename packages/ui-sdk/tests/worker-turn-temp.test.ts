import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
  statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchAgentWorker, prepareWorkerSandbox, WORKER_SCRATCH, workerCommand } from "../src/server/worker-launcher";
import { createTurnTemp, createTurnTempPromoter, turnTempRoot, type TurnTemp, type TurnTempPromoterOptions } from "../src/server/worker-turn-temp";

const ROOT = resolve(import.meta.dir, "../../..");
const TURN = "5e1c7a2b-0d3f-4b8e-9a61-7c2d4e5f6a7b";
const BWRAP = Bun.spawnSync([Bun.which("bwrap") ?? "bwrap", "--version"]).stdout.toString().match(/(\d+)\.(\d+)/);
const OVERLAY = Boolean(BWRAP && (Number(BWRAP[1]) > 0 || Number(BWRAP[2]) >= 11));
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
  const temp = createTurnTemp(brain);
  if (!temp) throw new Error("this host has no tmpfs for turn temp");
  cleanups.push(() => { temp.cleanup(); rmSync(root, { recursive: true, force: true }); });
  return { root, brain, home, outside, temp };
}

function promoter(f: ReturnType<typeof fixture>, extra: Partial<TurnTempPromoterOptions> = {}) {
  return createTurnTempPromoter({ brain: f.brain, turnTemp: f.temp, turnId: TURN, scratch: WORKER_SCRATCH, scratchWritable: true, ...extra });
}

/** Turn-temp paths as the host holds them. */
const inTmp = (temp: TurnTemp, rel: string) => join(temp.tmp, rel);
const promotedDir = (brain: string) => join(brain, ".brain/scratch/turns", TURN);

/** Every file below `dir`, relative, to prove nothing else was written. */
function tree(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name), rel = prefix ? `${prefix}/${name}` : name;
    return lstatSync(path).isDirectory() ? tree(path, rel) : [rel];
  });
}

describe("turn temp (#1655)", () => {
  test("lives on a tmpfs apart from the brain, private to the server", () => {
    const f = fixture();
    expect(statfsSync(f.temp.tmp).type).toBe(0x01021994);
    expect(statSync(f.temp.tmp).dev).not.toBe(statSync(f.brain).dev);
    expect(statSync(f.temp.root).mode & 0o777).toBe(0o700);
    // A candidate on the brain's own device, or holding the brain, is never chosen.
    expect(turnTempRoot(f.brain, [f.root])).toBeNull();
    expect(turnTempRoot(f.brain, [join(f.brain, "notes")])).toBeNull();
  });

  for (const forceXdg of [false, true]) test.skipIf(process.platform !== "linux" || !Bun.which("bwrap"))(`a real worker's /tmp, scratch and home writes land in host turn temp${forceXdg ? " (XDG fallback)" : ""}`, async () => {
    const f = fixture();
    const sandbox = prepareWorkerSandbox(f.brain, { home: f.home, ...(forceXdg ? { probeOverlay: () => "forced for the test" } : {}) });
    expect(sandbox.home?.mode, "HOME_MODE").toBe(OVERLAY && !forceXdg ? "overlay" : "xdg");
    const program = `import * as fs from "node:fs";
      const scratch = process.env.BRAIN_WORKER_SCRATCH;
      fs.writeFileSync(scratch + "/report.pdf", "Odysseus: the voyage report.");
      fs.mkdirSync("/tmp/ithaca"); fs.writeFileSync("/tmp/ithaca/plan.txt", "Return home.");
      // Only an overlaid home is writable; the XDG fallback keeps it read-only.
      try {
        fs.mkdirSync(process.env.HOME + "/drafts", { recursive: true });
        fs.writeFileSync(process.env.HOME + "/drafts/letter.md", "Dear Penelope.");
      } catch (error) { if (${JSON.stringify(sandbox.home?.mode === "overlay")}) throw error; }
      console.log(JSON.stringify({ scratch }));`;
    const worker = launchAgentWorker({ brainPath: f.brain, command: [process.execPath, "-e", program], env: { HOME: f.home }, sandbox, turnTemp: f.temp });
    worker.stdin.end();
    const [code, output] = await Promise.all([worker.exited, new Response(worker.stdout as unknown as ReadableStream).text()]);
    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual({ scratch: WORKER_SCRATCH });
    expect(readFileSync(inTmp(f.temp, "brain-worker-scratch/report.pdf"), "utf8")).toBe("Odysseus: the voyage report.");
    expect(readFileSync(inTmp(f.temp, "ithaca/plan.txt"), "utf8")).toBe("Return home.");
    expect(existsSync(join(f.home, "drafts"))).toBe(false);
    if (sandbox.home?.mode === "overlay") expect(readFileSync(join(f.temp.homeUpper, "drafts/letter.md"), "utf8")).toBe("Dear Penelope.");
    else expect(OVERLAY && !forceXdg).toBe(false);

    const home = sandbox.home?.mode === "overlay" ? f.home : undefined;
    const p = promoter(f, { home });
    const answer = [
      "Here is [the report](/tmp/brain-worker-scratch/report.pdf) and ![plan](</tmp/ithaca/plan.txt> \"plan\").",
      "Again: [report](file:///tmp/brain-worker-scratch/report.pdf#page=2).",
      ...(home ? [`The [letter](${f.home}/drafts/letter.md).`] : []),
      "Kept: [scratch](.brain/scratch/map.png), [note](notes/ithaca.md) and [brain](" + f.brain + "/notes/ithaca.md).",
      "```sh\ncat [x](/tmp/ithaca/plan.txt)\n```",
    ].join("\n");
    const stored = p.rewrite(answer);
    const dest = `.brain/scratch/turns/${TURN}`;
    expect(stored).toBe([
      `Here is [the report](${dest}/report.pdf) and ![plan](${dest}/plan.txt "plan").`,
      `Again: [report](${dest}/report.pdf#page=2).`,
      ...(home ? [`The [letter](${dest}/letter.md).`] : []),
      "Kept: [scratch](.brain/scratch/map.png), [note](notes/ithaca.md) and [brain](" + f.brain + "/notes/ithaca.md).",
      "```sh\ncat [x](/tmp/ithaca/plan.txt)\n```",
    ].join("\n"));
    expect(stored).not.toMatch(/promot|turn temp|copied/i);
    expect(readFileSync(join(promotedDir(f.brain), "report.pdf"), "utf8")).toBe("Odysseus: the voyage report.");
    expect(p.records).toEqual([
      { kind: "promotion", source: "/tmp/brain-worker-scratch/report.pdf", destination: `${dest}/report.pdf`, bytes: 28,
        originalLink: "/tmp/brain-worker-scratch/report.pdf", rewrittenLink: `${dest}/report.pdf` },
      { kind: "promotion", source: "/tmp/ithaca/plan.txt", destination: `${dest}/plan.txt`, bytes: 12,
        originalLink: "</tmp/ithaca/plan.txt>", rewrittenLink: `${dest}/plan.txt` },
      ...(home ? [{ kind: "promotion" as const, source: `${f.home}/drafts/letter.md`, destination: `${dest}/letter.md`, bytes: 14,
        originalLink: `${f.home}/drafts/letter.md`, rewrittenLink: `${dest}/letter.md` }] : []),
    ]);
    expect(tree(join(f.brain, ".brain/scratch")).sort()).toEqual([
      `turns/${TURN}/plan.txt`, `turns/${TURN}/report.pdf`, ...(home ? [`turns/${TURN}/letter.md`] : []),
    ].sort());
  });

  test("a symlink (to a host file or a directory), a hardlink, a directory and a missing file are refused", () => {
    const f = fixture();
    const scratch = inTmp(f.temp, "brain-worker-scratch");
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
    mkdirSync(inTmp(f.temp, "brain-worker-scratch"));
    const source = inTmp(f.temp, "brain-worker-scratch/log.txt");
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
    mkdirSync(inTmp(f.temp, "notes"));
    for (const [name, bytes] of [["big.bin", 5000], ["a.txt", 1500], ["b.txt", 1500], ["c.txt", 10]] as const) {
      writeFileSync(inTmp(f.temp, `notes/${name}`), "o".repeat(bytes));
    }
    const p = promoter(f, { limits: { fileBytes: 4096, turnBytes: 2048, files: 2 } });
    const text = p.rewrite("[big](/tmp/notes/big.bin) [a](/tmp/notes/a.txt) [b](/tmp/notes/b.txt) [c](/tmp/notes/c.txt)");
    expect(text).toBe(`[big](/tmp/notes/big.bin) [a](.brain/scratch/turns/${TURN}/a.txt) [b](/tmp/notes/b.txt) [c](.brain/scratch/turns/${TURN}/c.txt)`);
    expect(p.records.map(r => r.kind === "promotion" ? "promoted" : [r.reason, r.bytes, r.limitBytes])).toEqual([
      ["file_too_large", 5000, 4096], "promoted", ["turn_too_large", 1500, 2048], "promoted",
    ]);
    writeFileSync(inTmp(f.temp, "notes/d.txt"), "d");
    p.rewrite("[d](/tmp/notes/d.txt)");
    expect(p.records.at(-1)).toMatchObject({ reason: "turn_too_large", bytes: null, limitBytes: null });
  });

  test("a symlinked destination directory is refused and nothing is written outside scratch", () => {
    const f = fixture();
    mkdirSync(inTmp(f.temp, "brain-worker-scratch"));
    writeFileSync(inTmp(f.temp, "brain-worker-scratch/report.pdf"), "Odysseus.");
    // A worker with writable scratch could plant this during its turn.
    symlinkSync(f.outside, join(f.brain, ".brain/scratch/turns"));
    const p = promoter(f);
    expect(p.rewrite("[r](/tmp/brain-worker-scratch/report.pdf)")).toBe("[r](/tmp/brain-worker-scratch/report.pdf)");
    expect(p.records).toMatchObject([{ kind: "promotion_refused", reason: "io_error" }]);
    expect(readdirSync(f.outside)).toEqual(["host-secret.txt"]);
  });

  test("unusable scratch refuses every promotion by name; names are sanitized and kept apart", () => {
    const f = fixture();
    mkdirSync(inTmp(f.temp, "a")); mkdirSync(inTmp(f.temp, "b"));
    writeFileSync(inTmp(f.temp, "a/Voyage Report.pdf"), "1"); writeFileSync(inTmp(f.temp, "b/Voyage Report.pdf"), "2");
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
    mkdirSync(inTmp(f.temp, "brain-worker-scratch/pi-state"), { recursive: true });
    writeFileSync(inTmp(f.temp, "report"), "decoy"); writeFileSync(inTmp(f.temp, "report(v1).pdf"), "Odysseus v1.");
    writeFileSync(inTmp(f.temp, "brain-worker-scratch/pi-state/auth.json"), "{\"key\":\"Cyclops\"}");
    const p = promoter(f, { exclude: ["/tmp/brain-worker-scratch/pi-state"] });
    const state = "[login](/tmp/brain-worker-scratch/pi-state/auth.json)";
    expect(p.rewrite(`[v1](/tmp/report(v1).pdf "Version one") [bad](/tmp/report(v1).pdfx%) ${state}`))
      .toBe(`[v1](.brain/scratch/turns/${TURN}/report-v1.pdf "Version one") [bad](/tmp/report(v1).pdfx%) ${state}`);
    expect(readFileSync(join(promotedDir(f.brain), "report-v1.pdf"), "utf8")).toBe("Odysseus v1.");
    expect(p.records.map(r => [r.kind, r.source])).toEqual([["promotion", "/tmp/report(v1).pdf"], ["promotion_refused", "/tmp/report(v1).pdfx%"]]);
    // Line endings Markdown allows inside the parentheses, and nested parentheses.
    writeFileSync(inTmp(f.temp, "chart(v(2)).png"), "chart"); writeFileSync(inTmp(f.temp, "log.txt"), "log");
    expect(p.rewrite("![c](\n/tmp/chart(v(2)).png\n) [l](</tmp/log.txt>\n\"Log\")"))
      .toBe(`![c](\n.brain/scratch/turns/${TURN}/chart-v-2.png\n) [l](.brain/scratch/turns/${TURN}/log.txt\n"Log")`);
  });

  test.skipIf(process.platform !== "linux" || !Bun.which("bwrap"))("the launch refuses turn temp on the brain's device", () => {
    const f = fixture();
    const fake: TurnTemp = { ...f.temp, tmp: join(f.root, "tmp-on-brain-disk") };
    mkdirSync(fake.tmp);
    expect(() => workerCommand({ brainPath: f.brain, command: [process.execPath], env: {}, turnTemp: fake })).toThrow("turn temp");
    expect(workerCommand({ brainPath: f.brain, command: [process.execPath], env: {}, turnTemp: f.temp })).toEqual(
      expect.arrayContaining(["--bind", f.temp.tmp, "/tmp"]));
  });
});
