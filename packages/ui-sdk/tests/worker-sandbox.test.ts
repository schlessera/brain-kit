import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchAgentWorker, prepareWorkerSandbox, workerCommand } from "../src/server/worker-launcher";
import { resolveScratchMount, WORKER_XDG_DIRS, workerSandboxNote, workerSandboxWarnings, type WorkerSandbox } from "../src/server/worker-sandbox";

const GOLDEN = "Odysseus: only the server owns policy writes.\n";
const ROOT = resolve(import.meta.dir, "../../..");
const BWRAP = Bun.spawnSync([Bun.which("bwrap") ?? "bwrap", "--version"]).stdout.toString().match(/(\d+)\.(\d+)/);
/** Whether this host's bubblewrap has `--tmp-overlay` (0.11.0 or later). */
const OVERLAY = Boolean(BWRAP && (Number(BWRAP[1]) > 0 || Number(BWRAP[2]) >= 11));

function fixture({ workspaces = true }: { workspaces?: boolean } = {}) {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "tmp/worker-sandbox-"));
  const brain = join(root, "brain"), home = join(root, "home");
  const policy = join(brain, "context/policies/rule.md");
  mkdirSync(join(brain, "context/policies"), { recursive: true }); mkdirSync(join(brain, "notes"));
  mkdirSync(home); writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Penelope\n");
  writeFileSync(policy, GOLDEN);
  if (workspaces) mkdirSync(join(brain, "workspaces/ithaca/palace"), { recursive: true });
  return { root, brain, home, policy, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";
  for await (const chunk of stream as AsyncIterable<Buffer>) output += chunk.toString();
  return output;
}

async function run(brain: string, sandbox: WorkerSandbox, program: string, home: string) {
  const worker = launchAgentWorker({ brainPath: brain, command: [process.execPath, "-e", program], env: { HOME: home }, sandbox });
  worker.stdin.end();
  const [code, output, errors] = await Promise.all([worker.exited, collect(worker.stdout), collect(worker.stderr)]);
  expect(errors).toBe(""); expect(code).toBe(0);
  return JSON.parse(output);
}

/** Every area path bound read-write, and whether $HOME is overlaid, read straight from the argv. */
function mountsIn(argv: string[]) {
  const binds = argv.flatMap((arg, i) => arg === "--bind" && argv[i + 1] === argv[i + 2] ? [argv[i + 1]!] : []);
  return { binds, overlay: argv.includes("--tmp-overlay"), xdg: argv.includes("XDG_CONFIG_HOME") };
}

describe("worker sandbox writable areas (#1626)", () => {
  test("scratch and workspaces persist; the rest of the brain survives write, rename, hardlink and symlink escapes", async () => {
    const f = fixture();
    try {
      const sandbox = prepareWorkerSandbox(f.brain, { home: f.home });
      expect(sandbox.areas.map(a => [a.name, a.mount.writable])).toEqual([["scratch", true], ["workspaces", true]]);
      const program = `import * as fs from "node:fs";
        const brain=${JSON.stringify(f.brain)}, policy=${JSON.stringify(f.policy)};
        const attempt=(fn)=>{try{fn();return "ok"}catch(e){return e.code}};
        const out={};
        for (const [name, dir] of [["scratch", brain+"/.brain/scratch"], ["workspaces", brain+"/workspaces/ithaca"]]) {
          fs.writeFileSync(dir+"/kept.txt","Odysseus: "+name);
          fs.writeFileSync(dir+"/moved.txt","moved");
          out[name]={
            rename: attempt(()=>fs.renameSync(dir+"/moved.txt", brain+"/notes/moved.md")),
            linkOut: attempt(()=>fs.linkSync(dir+"/kept.txt", brain+"/notes/linked.md")),
            linkIn: attempt(()=>fs.linkSync(policy, dir+"/policy-alias.md")),
            symlinkWrite: attempt(()=>{fs.symlinkSync(policy, dir+"/policy-link.md"); fs.writeFileSync(dir+"/policy-link.md","changed")}),
            dirSymlinkWrite: attempt(()=>{fs.symlinkSync(brain+"/notes", dir+"/notes-link"); fs.writeFileSync(dir+"/notes-link/new.md","new")}),
          };
        }
        out.brainWrite=attempt(()=>fs.writeFileSync(policy,"changed"));
        out.brainCreate=attempt(()=>fs.writeFileSync(brain+"/notes/new.md","new"));
        out.brainMkdir=attempt(()=>fs.mkdirSync(brain+"/.brain/other"));
        out.areaReplace=attempt(()=>fs.renameSync(brain+"/.brain/scratch", brain+"/.brain/elsewhere"));
        out.home=attempt(()=>fs.writeFileSync(process.env.HOME+"/.cache-note","turn"));
        out.homeRead=fs.readFileSync(process.env.HOME+"/.gitconfig","utf8").includes("Penelope");
        out.xdg=process.env.XDG_CONFIG_HOME ?? null;
        console.log(JSON.stringify(out));`;
      const out = await run(f.brain, sandbox, program, f.home);
      const escaped = { rename: "EXDEV", linkOut: "EROFS", linkIn: "EXDEV", symlinkWrite: "EROFS", dirSymlinkWrite: "EROFS" };
      expect(out, "AREA_ESCAPES").toEqual({ scratch: escaped, workspaces: escaped, brainWrite: "EROFS", brainCreate: "EROFS",
        brainMkdir: "EROFS", areaReplace: "EROFS", homeRead: true, home: out.home, xdg: out.xdg });
      // The real probe chose the home mode; an overlay that leaked to the host would have failed it.
      expect(sandbox.home?.mode, "HOME_MODE").toBe(OVERLAY ? "overlay" : "xdg");
      expect({ home: out.home, xdg: out.xdg }, "HOME_MODE").toEqual(OVERLAY ? { home: "ok", xdg: null }
        : { home: "EROFS", xdg: WORKER_XDG_DIRS.XDG_CONFIG_HOME });
      // Observed from outside the namespace.
      expect(readFileSync(f.policy, "utf8")).toBe(GOLDEN);
      expect(readdirSync(join(f.brain, "notes"))).toEqual([]);
      expect(readdirSync(join(f.brain, ".brain"))).toEqual(["scratch"]);
      expect(readFileSync(join(f.brain, ".brain/scratch/kept.txt"), "utf8")).toBe("Odysseus: scratch");
      expect(readFileSync(join(f.brain, "workspaces/ithaca/kept.txt"), "utf8")).toBe("Odysseus: workspaces");
      expect(existsSync(join(f.home, ".cache-note")), "HOME_DISCARDED").toBe(false);
    } finally { f.cleanup(); }
  });

  test.skipIf(!OVERLAY)("the home overlay discards every write from the host's view", async () => {
    const f = fixture();
    try {
      // The probe is bypassed so this observes the mount itself, not the probe's verdict on it.
      const sandbox = prepareWorkerSandbox(f.brain, { home: f.home, probeOverlay: () => true });
      const program = `import * as fs from "node:fs"; fs.writeFileSync(process.env.HOME+"/.cache-note","turn");
        fs.writeFileSync(process.env.HOME+"/.gitconfig","changed"); console.log(JSON.stringify(fs.readFileSync(process.env.HOME+"/.cache-note","utf8")));`;
      expect(await run(f.brain, sandbox, program, f.home)).toBe("turn");
      expect(readdirSync(f.home), "HOME_DISCARDED").toEqual([".gitconfig"]);
      expect(readFileSync(join(f.home, ".gitconfig"), "utf8"), "HOME_DISCARDED").toContain("Penelope");
    } finally { f.cleanup(); }
  });

  test("without an overlay the home stays read-only and per-turn XDG directories are writable", async () => {
    const f = fixture();
    try {
      const sandbox = prepareWorkerSandbox(f.brain, { home: f.home, probeOverlay: () => "overlay unavailable on this host" });
      expect(sandbox.home).toEqual({ mode: "xdg", reason: "overlay unavailable on this host" });
      const program = `import * as fs from "node:fs";
        const attempt=(fn)=>{try{fn();return "ok"}catch(e){return e.code}};
        console.log(JSON.stringify({home: attempt(()=>fs.writeFileSync(process.env.HOME+"/x","x")),
          xdg: Object.fromEntries(["XDG_CONFIG_HOME","XDG_CACHE_HOME","XDG_DATA_HOME"].map(k=>[k, process.env[k]
            && attempt(()=>fs.mkdirSync(process.env[k]+"/chromium/applications",{recursive:true}))]))}));`;
      expect(await run(f.brain, sandbox, program, f.home), "XDG_FALLBACK").toEqual({ home: "EROFS",
        xdg: { XDG_CONFIG_HOME: "ok", XDG_CACHE_HOME: "ok", XDG_DATA_HOME: "ok" } });
      expect(Object.values(WORKER_XDG_DIRS).every(dir => dir.startsWith("/tmp/"))).toBe(true);
    } finally { f.cleanup(); }
  });

  test("the real overlay probe matches this host's bubblewrap and leaves the home untouched", () => {
    const f = fixture();
    try {
      const home = prepareWorkerSandbox(f.brain, { home: f.home }).home;
      // bubblewrap 0.11.0 added --overlay-src/--tmp-overlay; CI's Ubuntu 24.04 ships 0.9.0.
      if (OVERLAY) expect(home).toEqual({ mode: "overlay", path: f.home });
      else expect(home).toMatchObject({ mode: "xdg", reason: expect.stringContaining("could not overlay the home") });
      expect(readdirSync(f.home)).toEqual([".gitconfig"]);
      expect(prepareWorkerSandbox(f.brain, { home: join(f.brain, "notes") }).home?.mode).toBe("xdg");
      expect(prepareWorkerSandbox(f.brain, {}).home?.mode).toBe("xdg");
    } finally { f.cleanup(); }
  });

  test("hardlinks wholly inside workspaces keep it writable; one to a file outside makes it read-only", () => {
    const f = fixture();
    try {
      const repo = join(f.brain, "workspaces/ithaca/palace");
      writeFileSync(join(repo, "object"), "loom");
      linkSync(join(repo, "object"), join(f.brain, "workspaces/ithaca/object-clone"));
      expect(prepareWorkerSandbox(f.brain, { home: f.home }).areas[1], "CONTAINED_LINK").toEqual({ name: "workspaces",
        mount: { writable: true, path: join(f.brain, "workspaces") } });
      linkSync(f.policy, join(repo, "policy-alias.md"));
      const sandbox = prepareWorkerSandbox(f.brain, { home: f.home });
      expect(sandbox.areas[1], "OUTSIDE_LINK").toEqual({ name: "workspaces", mount: { writable: false,
        reason: "hard-linked to files outside workspaces/: workspaces/ithaca/palace/policy-alias.md" } });
      expect(mountsIn(workerCommand({ brainPath: f.brain, command: [process.execPath], env: { HOME: f.home }, sandbox })).binds)
        .toEqual([join(f.brain, ".brain/scratch")]);
      expect(workerSandboxNote(sandbox)).toContain("`workspaces/` is read-only this turn: hard-linked to files outside workspaces/");
      expect(workerSandboxWarnings(sandbox), "SERVER_LOG").toEqual(["worker workspaces area is read-only this turn: hard-linked to files outside workspaces/: workspaces/ithaca/palace/policy-alias.md"]);
    } finally { f.cleanup(); }
  });

  test("a scratch name hard-linked to a file outside scratch is unlinked; contained links stay", () => {
    const f = fixture();
    try {
      const scratch = join(f.brain, ".brain/scratch");
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, "draft.pdf"), "draft"); linkSync(join(scratch, "draft.pdf"), join(scratch, "draft-copy.pdf"));
      linkSync(f.policy, join(scratch, "policy-alias.md"));
      const sandbox = prepareWorkerSandbox(f.brain, { home: f.home });
      expect(sandbox.scratchAliasesRemoved, "SCRATCH_ALIAS").toEqual([".brain/scratch/policy-alias.md"]);
      expect(sandbox.areas[0]?.mount.writable).toBe(true);
      expect(readdirSync(scratch).sort()).toEqual(["draft-copy.pdf", "draft.pdf"]);
      expect(readFileSync(f.policy, "utf8")).toBe(GOLDEN);
      expect(lstatSync(f.policy).nlink).toBe(1);
    } finally { f.cleanup(); }
  });

  // Root reads an execute-only directory anyway, so the walk would see the link.
  test.skipIf(process.getuid?.() === 0)("an unreadable directory hiding an outside link leaves the area read-only", () => {
    const f = fixture();
    const hidden = join(f.brain, "workspaces/ithaca/hidden"), scratchHidden = join(f.brain, ".brain/scratch/hidden");
    try {
      mkdirSync(hidden); mkdirSync(scratchHidden, { recursive: true });
      linkSync(f.policy, join(hidden, "policy-alias.md")); linkSync(f.policy, join(scratchHidden, "policy-alias.md"));
      chmodSync(hidden, 0o100); chmodSync(scratchHidden, 0o100);
      const sandbox = prepareWorkerSandbox(f.brain, { home: f.home });
      expect(sandbox.areas, "UNREADABLE_DIR").toEqual([
        { name: "scratch", mount: { writable: false, reason: ".brain/scratch/ could not be verified: .brain/scratch/hidden cannot be opened (EACCES)" } },
        { name: "workspaces", mount: { writable: false, reason: "workspaces/ could not be verified: workspaces/ithaca/hidden cannot be opened (EACCES)" } },
      ]);
      expect(mountsIn(workerCommand({ brainPath: f.brain, command: [process.execPath], env: { HOME: f.home }, sandbox })).binds).toEqual([]);
    } finally { chmodSync(hidden, 0o700); chmodSync(scratchHidden, 0o700); f.cleanup(); }
  });

  // A concurrent worker owns scratch and can swap a directory for a symlink
  // into the brain while the host walks it. These fake that swap at the two
  // moments the host touches a directory by name: after it lstats it, and
  // when it reopens it to unlink an alias.
  test.each(["walk", "unlink"] as const)("a directory swapped for a symlink during the %s never redirects it into the brain", (moment) => {
    const f = fixture();
    const original = { lstatSync: fs.lstatSync, openSync: fs.openSync };
    const name = moment === "walk" ? "lstatSync" : "openSync";
    const spy = spyOn(fs, name);
    try {
      const scratch = join(f.brain, ".brain/scratch"), child = join(scratch, "child");
      mkdirSync(child, { recursive: true });
      // The same layout in scratch and in the brain, so a redirected unlink would hit the brain's name.
      writeFileSync(join(f.brain, "notes/rule.md"), GOLDEN); linkSync(join(f.brain, "notes/rule.md"), join(f.brain, "context/rule.md"));
      linkSync(f.policy, join(child, "rule.md"));
      let swapped = false, opens = 0;
      const swap = () => { swapped = true; renameSync(child, `${child}-parked`); symlinkSync(join(f.brain, "notes"), child); };
      const byChild = (path: unknown) => typeof path === "string" && path.endsWith("/child") && !swapped;
      if (name === "lstatSync") {
        spy.mockImplementation(((path: string, ...rest: unknown[]) => {
          const result = (original.lstatSync as (...args: unknown[]) => unknown)(path, ...rest);
          if (byChild(path)) swap();
          return result;
        }) as typeof fs.lstatSync);
      } else {
        spy.mockImplementation(((path: string, ...rest: unknown[]) => {
          if (byChild(path) && ++opens === 2) swap();
          return (original.openSync as (...args: unknown[]) => number)(path, ...rest);
        }) as typeof fs.openSync);
      }
      const scratchMount = resolveScratchMount(f.brain);
      spy.mockRestore();
      expect(swapped, "SWAP_HAPPENED").toBe(true);
      expect(readFileSync(join(f.brain, "notes/rule.md"), "utf8"), "SWAP_FOLLOWED").toBe(GOLDEN);
      expect(lstatSync(join(f.brain, "notes/rule.md")).nlink).toBe(2);
      expect(scratchMount.mount.writable).toBe(false);
      expect(scratchMount.removed).toEqual([]);
    } finally { spy.mockRestore(); f.cleanup(); }
  });

  test("an over-limit walk leaves workspaces read-only", () => {
    const f = fixture();
    try {
      for (let i = 0; i < 5; i++) writeFileSync(join(f.brain, `workspaces/ithaca/f${i}`), "x");
      const { resolveWorkspacesMount, scanForOutsideLinks } = require("../src/server/worker-sandbox") as typeof import("../src/server/worker-sandbox");
      expect(scanForOutsideLinks(f.brain, join(f.brain, "workspaces"), 3).overLimit).toBe(true);
      expect(resolveWorkspacesMount(f.brain).writable).toBe(true);
    } finally { f.cleanup(); }
  });

  test.each([".brain", ".brain/scratch"])("a symlinked %s is never created through or bound", (link) => {
    const f = fixture();
    try {
      const target = join(f.root, "elsewhere"); mkdirSync(target);
      if (link === ".brain/scratch") mkdirSync(join(f.brain, ".brain"));
      symlinkSync(target, join(f.brain, link));
      const sandbox = prepareWorkerSandbox(f.brain, { home: f.home });
      expect(sandbox.areas[0]).toEqual({ name: "scratch", mount: { writable: false, reason: `${link} is a symlink` } });
      expect(readdirSync(target)).toEqual([]);
      expect(mountsIn(workerCommand({ brainPath: f.brain, command: [process.execPath], env: { HOME: f.home }, sandbox })).binds)
        .toEqual([join(f.brain, "workspaces")]);
    } finally { f.cleanup(); }
  });

  test("a symlinked workspaces directory stays read-only", () => {
    const f = fixture({ workspaces: false });
    try {
      mkdirSync(join(f.root, "repos")); symlinkSync(join(f.root, "repos"), join(f.brain, "workspaces"));
      expect(prepareWorkerSandbox(f.brain, { home: f.home }).areas[1]).toEqual({ name: "workspaces",
        mount: { writable: false, reason: "workspaces is a symlink" } });
    } finally { f.cleanup(); }
  });

  test("scratch in a repository is writable only while git ignores it", () => {
    const f = fixture();
    try {
      expect(Bun.spawnSync(["git", "init", "-q", f.brain]).exitCode).toBe(0);
      expect(prepareWorkerSandbox(f.brain, { home: f.home }).areas[0]?.mount, "SCRATCH_IGNORED").toMatchObject({ writable: false,
        reason: expect.stringContaining("not gitignored") });
      writeFileSync(join(f.brain, ".gitignore"), ".brain/scratch/\n");
      expect(prepareWorkerSandbox(f.brain, { home: f.home }).areas[0]?.mount.writable).toBe(true);
    } finally { f.cleanup(); }
  });

  test("the note states exactly the mounts the launcher sets up", () => {
    const f = fixture({ workspaces: false });
    try {
      const variants: WorkerSandbox[] = [
        prepareWorkerSandbox(f.brain, { home: f.home }),
        prepareWorkerSandbox(f.brain, { home: f.home, probeOverlay: () => "no overlay" }),
        prepareWorkerSandbox(f.brain, { home: f.home, areas: [] }),
      ];
      mkdirSync(join(f.brain, "workspaces"));
      variants.push(prepareWorkerSandbox(f.brain, { home: f.home, areas: ["workspaces"] }), prepareWorkerSandbox(f.brain, { home: f.home }));
      // A repository that does not ignore scratch: the scratch area stays read-only.
      expect(Bun.spawnSync(["git", "init", "-q", f.brain]).exitCode).toBe(0);
      variants.push(prepareWorkerSandbox(f.brain, { home: f.home }));
      expect(variants.at(-1)!.areas[0]?.mount.writable).toBe(false);
      for (const sandbox of variants) {
        const mounts = mountsIn(workerCommand({ brainPath: f.brain, command: [process.execPath], env: { HOME: f.home }, sandbox }));
        const note = workerSandboxNote(sandbox);
        expect(note.includes("`.brain/scratch/` is writable"), "NOTE_SCRATCH").toBe(mounts.binds.includes(join(f.brain, ".brain/scratch")));
        expect(note.includes("`workspaces/` is writable"), "NOTE_WORKSPACES").toBe(mounts.binds.includes(join(f.brain, "workspaces")));
        expect(note.includes("anything written under `$HOME`"), "NOTE_HOME").toBe(mounts.overlay);
        expect(note.includes("XDG_CONFIG_HOME"), "NOTE_XDG").toBe(mounts.xdg);
        expect(note.includes("There is no `workspaces/` directory")).toBe(sandbox.areas.some(a => a.name === "workspaces" && !a.mount.writable && a.mount.missing));
        // The three places a file can be, with the link rule the reader depends on.
        expect(note).toContain("**Never link to a file here in a response**");
        expect(note.includes("Put anything you link in your response here, never in turn temp"))
          .toBe(mounts.binds.includes(join(f.brain, ".brain/scratch")));
        expect(note).toContain("3. **The brain: canonical, and read-only here.**");
      }
      const restricted = prepareWorkerSandbox(f.brain, { restricted: true });
      expect(restricted).toEqual({ brain: f.brain, restricted: true, areas: [], scratchAliasesRemoved: [] });
      expect(workerSandboxNote(restricted)).toContain("restricted (autonomous) turn");
      // A restricted worker's argv is unchanged by its (empty) sandbox.
      const relay = join(f.root, "relay"); mkdirSync(relay, { mode: 0o700 });
      const envelope = { readPaths: [process.execPath], inferenceDir: relay };
      expect(workerCommand({ brainPath: f.brain, command: [process.execPath], env: {}, restricted: envelope, sandbox: restricted }))
        .toEqual(workerCommand({ brainPath: f.brain, command: [process.execPath], env: {}, restricted: envelope }));
    } finally { f.cleanup(); }
  });

  test("a sandbox resolved for another brain, envelope or home refuses the launch", () => {
    const f = fixture(), g = fixture();
    try {
      const sandbox = prepareWorkerSandbox(f.brain, { home: f.home });
      expect(() => workerCommand({ brainPath: g.brain, command: [process.execPath], env: { HOME: f.home }, sandbox })).toThrow("another brain");
      // The overlay is what a HOME mismatch would misdirect; fake the probe so this holds on every bubblewrap.
      const overlaid = prepareWorkerSandbox(f.brain, { home: f.home, probeOverlay: () => true });
      expect(overlaid.home?.mode).toBe("overlay");
      expect(() => workerCommand({ brainPath: f.brain, command: [process.execPath], env: { HOME: g.home }, sandbox: overlaid })).toThrow("HOME is not the home");
      rmSync(join(f.brain, "workspaces"), { recursive: true }); symlinkSync(g.brain, join(f.brain, "workspaces"));
      expect(() => workerCommand({ brainPath: f.brain, command: [process.execPath], env: { HOME: f.home }, sandbox }), "RELAUNCH_RECHECK")
        .toThrow("real directory at its own path");
    } finally { f.cleanup(); g.cleanup(); }
  });
});
