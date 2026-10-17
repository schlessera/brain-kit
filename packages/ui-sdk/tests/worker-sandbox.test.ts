import { launchFixtureAgentWorker as launchAgentWorker, prepareFixtureWorkerSandbox as prepareWorkerSandbox, createFixtureMaintenanceHost } from "./helpers/worker-startup-view-fixture.js";
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { workerCommand } from "../src/server/worker-launcher";
import { resolveScratchMount, WORKER_XDG_DIRS, workerSandboxNote, workerSandboxWarnings, type WorkerSandbox } from "../src/server/worker-sandbox";

const GOLDEN = "Odysseus: only the server owns policy writes.\n";
const ROOT = resolve(import.meta.dir, "../../..");

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
  const binds = argv.flatMap((arg, i) => arg === "--bind" ? [argv[i + 1]!] : []);
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
        for (const [name, dir] of [["scratch", "/tmp/brain-worker-areas/scratch"], ["workspaces", "/tmp/brain-worker-areas/workspaces/ithaca"]]) {
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
      // No per-turn home overlay (#1703): $HOME is read-only, the XDG directories are in turn temp.
      expect(sandbox.home?.mode, "HOME_MODE").toBe("xdg");
      expect({ home: out.home, xdg: out.xdg }, "HOME_MODE").toEqual({ home: "EROFS", xdg: WORKER_XDG_DIRS.XDG_CONFIG_HOME });
      // Observed from outside the namespace.
      expect(readFileSync(f.policy, "utf8")).toBe(GOLDEN);
      expect(readdirSync(join(f.brain, "notes"))).toEqual([]);
      expect(readdirSync(join(f.brain, ".brain"))).toEqual(["scratch"]);
      expect(readFileSync(join(f.brain, ".brain/scratch/kept.txt"), "utf8")).toBe("Odysseus: scratch");
      expect(readFileSync(join(f.brain, "workspaces/ithaca/kept.txt"), "utf8")).toBe("Odysseus: workspaces");
      expect(existsSync(join(f.home, ".cache-note")), "HOME_DISCARDED").toBe(false);
    } finally { f.cleanup(); }
  });

  test("the home stays read-only and per-turn XDG directories are writable (#1703)", async () => {
    const f = fixture();
    try {
      const sandbox = prepareWorkerSandbox(f.brain, { home: f.home });
      expect(sandbox.home).toEqual({ mode: "xdg" });
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

  test("every interactive home is the XDG fallback, without probing the home", () => {
    const f = fixture();
    try {
      expect(prepareWorkerSandbox(f.brain, { home: f.home }).home).toEqual({ mode: "xdg" });
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
      expect(prepareWorkerSandbox(f.brain, { home: f.home }).areas[1], "CONTAINED_LINK").toEqual({ name: "workspaces", rel: "workspaces",
        mount: { writable: true, path: join(f.brain, "workspaces") } });
      linkSync(f.policy, join(repo, "policy-alias.md"));
      const sandbox = prepareWorkerSandbox(f.brain, { home: f.home });
      expect(sandbox.areas[1], "OUTSIDE_LINK").toEqual({ name: "workspaces", rel: "workspaces", mount: { writable: false,
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
        { name: "scratch", rel: ".brain/scratch", mount: { writable: false, reason: ".brain/scratch/ could not be verified: .brain/scratch/hidden cannot be opened (EACCES)" } },
        { name: "workspaces", rel: "workspaces", mount: { writable: false, reason: "workspaces/ could not be verified: workspaces/ithaca/hidden cannot be opened (EACCES)" } },
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
      const byChild = (path: unknown) => String(path).endsWith("/child") && !swapped;
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
      const maintenance = createFixtureMaintenanceHost(f.brain);
      let scratchMount;
      try { scratchMount = resolveScratchMount(f.brain, maintenance); } finally { maintenance.cleanup(); }
      spy.mockRestore();
      expect(swapped, "SWAP_HAPPENED").toBe(true);
      expect(readFileSync(join(f.brain, "notes/rule.md"), "utf8"), "SWAP_FOLLOWED").toBe(GOLDEN);
      expect(lstatSync(join(f.brain, "notes/rule.md")).nlink).toBe(2);
      // Mid-walk, the walk retries and then sees a plain symlink, which the bind makes harmless; mid-unlink, the alias stays and scratch is refused.
      expect(scratchMount.mount.writable).toBe(moment === "walk");
      // The parked directory still holds a real alias of the policy file; only that scratch name goes.
      expect(scratchMount.removed).toEqual(moment === "walk" ? [".brain/scratch/child-parked/rule.md"] : []);
      expect(readFileSync(f.policy, "utf8")).toBe(GOLDEN);
    } finally { spy.mockRestore(); f.cleanup(); }
  });

  test("a name that is not UTF-8 cannot hide an outside link", () => {
    const f = fixture();
    try {
      const odd = Buffer.concat([Buffer.from(join(f.brain, "workspaces/")), Buffer.from([0xff])]);
      mkdirSync(odd);
      linkSync(f.policy, Buffer.concat([odd, Buffer.from("/b"), Buffer.from([0xfe])]));
      const mount = prepareWorkerSandbox(f.brain, { home: f.home }).areas[1]?.mount;
      expect(mount?.writable, "BYTE_NAMES").toBe(false);
      expect(mount && !mount.writable && mount.reason).toStartWith("hard-linked to files outside workspaces/: workspaces/");
    } finally { f.cleanup(); }
  });

  // An alias moved from a directory not yet walked into one already walked
  // is counted nowhere, so its inode looks fully accounted for.
  test("an alias moved during the walk is still found", () => {
    const f = fixture();
    const original = fs.readdirSync;
    let moved = false;
    const spy = spyOn(fs, "readdirSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      const names = (original as (...args: unknown[]) => unknown)(path, ...rest);
      // The first listing is the area root's; the alias moves there before its own directory is listed.
      if (!moved) { moved = true; renameSync(join(f.brain, "workspaces/ithaca/palace/alias.md"), join(f.brain, "workspaces/alias.md")); }
      return names;
    }) as typeof fs.readdirSync);
    try {
      linkSync(f.policy, join(f.brain, "workspaces/ithaca/palace/alias.md"));
      const { resolveWorkspacesMount } = require("../src/server/worker-sandbox") as typeof import("../src/server/worker-sandbox");
      expect(resolveWorkspacesMount(f.brain), "MOVED_ALIAS").toEqual({ writable: false,
        reason: "hard-linked to files outside workspaces/: workspaces/alias.md" });
      expect(moved).toBe(true);
    } finally { spy.mockRestore(); f.cleanup(); }
  });

  test("an over-limit walk leaves workspaces read-only", () => {
    const f = fixture();
    try {
      for (let i = 0; i < 5; i++) writeFileSync(join(f.brain, `workspaces/ithaca/f${i}`), "x");
      const { resolveWorkspacesMount, scanForOutsideLinks } = require("../src/server/worker-sandbox") as typeof import("../src/server/worker-sandbox");
      expect(scanForOutsideLinks(f.brain, join(f.brain, "workspaces"), 3).overLimit).toBe(true);
      expect(resolveWorkspacesMount(f.brain, 3), "OVER_LIMIT").toEqual({ writable: false, reason: "workspaces/ holds more than 3 entries, too many to verify" });
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
      expect(sandbox.areas[0]).toEqual({ name: "scratch", rel: ".brain/scratch", mount: { writable: false, reason: `${link} is a symlink` } });
      expect(readdirSync(target)).toEqual([]);
      expect(mountsIn(workerCommand({ brainPath: f.brain, command: [process.execPath], env: { HOME: f.home }, sandbox })).binds)
        .toEqual([join(f.brain, "workspaces")]);
    } finally { f.cleanup(); }
  });

  test("a symlinked workspaces directory stays read-only", () => {
    const f = fixture({ workspaces: false });
    try {
      mkdirSync(join(f.root, "repos")); symlinkSync(join(f.root, "repos"), join(f.brain, "workspaces"));
      expect(prepareWorkerSandbox(f.brain, { home: f.home }).areas[1]).toEqual({ name: "workspaces", rel: "workspaces",
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

  test("scratch in a brain inside a parent repository is writable only while git ignores it", () => {
    const f = fixture();
    try {
      expect(Bun.spawnSync(["git", "init", "-q", f.root]).exitCode).toBe(0);
      expect(prepareWorkerSandbox(f.brain, { home: f.home }).areas[0]?.mount, "PARENT_REPO").toMatchObject({ writable: false,
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
        expect(note.includes("`/tmp/brain-worker-areas/scratch/` is writable"), "NOTE_SCRATCH").toBe(mounts.binds.includes(join(f.brain, ".brain/scratch")));
        expect(note.includes("`/tmp/brain-worker-areas/workspaces/` is writable"), "NOTE_WORKSPACES").toBe(mounts.binds.includes(join(f.brain, "workspaces")));
        expect(mounts.overlay, "NOTE_HOME").toBe(false);
        expect(note).toContain("`$HOME` itself is read-only");
        expect(note.includes("XDG_CONFIG_HOME"), "NOTE_XDG").toBe(mounts.xdg);
        expect(note.includes("There is no `workspaces/` directory")).toBe(sandbox.areas.some(a => a.name === "workspaces" && !a.mount.writable && a.mount.missing));
        // The three places a file can be, with the link rule the reader depends on.
        expect(note).toContain("never link to a file there");
        expect(note.includes("a link in your answer must point into the brain or `.brain/scratch/`"))
          .toBe(mounts.binds.includes(join(f.brain, ".brain/scratch")));
        expect(note).toContain("**Profile: `strict`.** The brain is read-only here");
        expect(note).toContain("3. **The brain: canonical and versioned.**");
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
      rmSync(join(f.brain, "workspaces"), { recursive: true }); symlinkSync(g.brain, join(f.brain, "workspaces"));
      expect(() => workerCommand({ brainPath: f.brain, command: [process.execPath], env: { HOME: f.home }, sandbox }), "RELAUNCH_RECHECK")
        .toThrow("real directory at its own path");
    } finally { f.cleanup(); g.cleanup(); }
  });
});

describe("the sandbox note's wording (#1654)", () => {
  const brain = "/srv/ithaca/brain";
  const strict: WorkerSandbox = {
    brain, restricted: false, scratchAliasesRemoved: [], home: { mode: "xdg" },
    areas: [
      { name: "scratch", rel: ".brain/scratch", mount: { writable: true, path: `${brain}/.brain/scratch` } },
      { name: "workspaces", rel: "workspaces", mount: { writable: true, path: `${brain}/workspaces` } },
    ],
  };

  test.each(["governed", "strict"] as const)("%s capabilities disclose shared uid and mask-only server-state protection", profile => {
    const note = workerSandboxNote({ ...strict, profile });
    expect(note, "SHARED_UID_DISCLOSED").toContain("The worker shares the server's uid");
    expect(note, "MASK_ONLY_PROTECTION_DISCLOSED").toContain("server state is protected by masks only");
    expect(note, "READ_ONLY_IS_NOT_IDENTITY_ISOLATION").toContain("A read-only brain does not prevent access to other host paths available to that uid");
  });

  test("the strict note states the profile, the three areas and the link rule", () => {
    expect(workerSandboxNote(strict)).toMatchInlineSnapshot(`
      "# Where files go in this turn

      **Profile: \`strict\`.** The brain is read-only here: change it through \`write_file\`, \`edit_file\` and the curated brain tools. Any other write, \`git commit\` or index command in the brain fails with \`EROFS\` (\`Read-only file system\`), and so do hard links, renames and symlinks from the writable areas into it: that is the sandbox, not something to work around.
      The worker shares the server's uid; server state is protected by masks only. A read-only brain does not prevent access to other host paths available to that uid.

      1. **Turn temp:** \`$BRAIN_WORKER_SCRATCH\`, \`/tmp\` and the per-turn \`XDG_CONFIG_HOME\`, \`XDG_CACHE_HOME\` and \`XDG_DATA_HOME\` under \`/tmp/brain-worker-home\` (\`$HOME\` itself is read-only: a write there fails with \`EROFS\`, so point the tool at an XDG directory or \`/tmp\`). It is deleted when the turn ends: use it for intermediate work only, and never link to a file there.
      2. **Persistent areas: kept across turns.**
         - \`/tmp/brain-worker-areas/scratch/\` is writable. Write the file there, then link its repo-relative destination, such as \`.brain/scratch/<name>.pdf\`.
         - \`/tmp/brain-worker-areas/workspaces/\` is writable: clone, fetch and commit other repositories there, never in \`/tmp\`.
      Configuration executes from an immutable startup view, including imported helpers and absent names.
      Write \`.brain/scratch/\` through \`/tmp/brain-worker-areas/scratch/\`, outside that view; link the repo-relative destination.
      Write \`workspaces/\` through \`/tmp/brain-worker-areas/workspaces/\`, outside that view; link the repo-relative destination.
      3. **The brain: canonical and versioned.**

      Anything the reader should open goes in \`.brain/scratch/\` and is linked from there: a link in your answer must point into the brain or \`.brain/scratch/\`.
      The brain's packaged CLI directory \`/srv/ithaca/brain/node_modules/.bin\` is first on PATH.
      The packaged \`brain\` CLI is missing. Install \`@schlessera/brain\` in the brain repository and run \`bun install\` there before using \`brain\` commands."
    `);
  });

  test("the note names each area by the path the resolved list gives it", () => {
    const moved: WorkerSandbox = { ...strict, areas: [
      { name: "scratch", rel: ".brain/loom", mount: { writable: true, path: `${brain}/.brain/loom` } },
      { name: "workspaces", rel: "harbour", mount: { writable: false, reason: "harbour/ does not exist", missing: true } },
    ] };
    const note = workerSandboxNote(moved);
    expect(note, "SCRATCH_PATH").toContain("Write `.brain/loom/` through `/tmp/brain-worker-areas/scratch/`");
    expect(note, "LINK_RULE_PATH").toContain("a link in your answer must point into the brain or `.brain/loom/`");
    expect(note, "WORKSPACES_PATH").toContain("There is no `harbour/` directory");
    expect(note).not.toContain(".brain/scratch");
    expect(note).not.toContain("workspaces/");
    // The launcher binds an area only at its own path, so a moved area never reaches a worker.
    const f = fixture();
    try {
      const resolved = prepareWorkerSandbox(f.brain, { home: f.home });
      const relabelled = { ...resolved, areas: resolved.areas.map(area => area.name === "scratch" ? { ...area, rel: ".brain/loom" } : area) };
      expect(() => workerCommand({ brainPath: f.brain, command: [process.execPath], env: { HOME: f.home }, sandbox: relabelled }))
        .toThrow("the scratch area is not at .brain/scratch/");
    } finally { f.cleanup(); }
  });

  test("without a writable scratch area, links may only point into the brain", () => {
    const note = workerSandboxNote({ ...strict,
      areas: [{ name: "scratch", rel: ".brain/scratch", mount: { writable: false, reason: ".brain/scratch/ is a symlink" } }] });
    expect(note).toContain("A link in your answer must point into the brain.");
    expect(note).toContain("2. **Persistent areas: none writable this turn.**");
    expect(note).not.toContain("is linked from there");
  });

  test("limits are stated as their owners resolved them, and only when given", () => {
    expect(workerSandboxNote(strict)).not.toContain("Limits in this turn");
    const note = workerSandboxNote(strict, { limits: [{ name: "Runtime state", value: "64 MiB", onHit: "Past it the conversation continues in a new one." }] });
    expect(note.endsWith("Limits in this turn:\n- **Runtime state: 64 MiB.** Past it the conversation continues in a new one.")).toBe(true);
  });
});

for (const profile of ["governed", "strict"] as const) test(`${profile} sandbox note names missing packaged CLI and installation`, () => {
  const f = fixture();
  try {
    const sandbox: WorkerSandbox = { brain: f.brain, profile, restricted: false, areas: [], scratchAliasesRemoved: [] };
    expect(workerSandboxNote(sandbox), "MISSING_CLI_INSTALL_GUIDANCE").toContain("The packaged `brain` CLI is missing. Install `@schlessera/brain` in the brain repository and run `bun install` there");
    expect(workerSandboxNote(sandbox)).toContain(`${f.brain}/node_modules/.bin`);
    mkdirSync(join(f.brain, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(f.brain, "node_modules/.bin/brain"), "#!/bin/sh\n", { mode: 0o755 });
    expect(workerSandboxNote(sandbox), "INSTALLED_CLI_HAS_NO_MISSING_WARNING").not.toContain("CLI is missing");
    expect(workerSandboxNote({ ...sandbox, restricted: true, profile: "restricted" }), "RESTRICTED_HAS_NO_CLI_ADVERTISEMENT").not.toContain("CLI");
  } finally { f.cleanup(); }
});


test("separate-UID notes use qualified identity facts in both ordinary profiles", () => {
  const sandbox: WorkerSandbox = {brain:"/fixture/ithaca",restricted:false,profile:"strict",areas:[],scratchAliasesRemoved:[]};
  for (const profile of ["strict","governed"] as const) {
    const note = workerSandboxNote({...sandbox,profile},{identity:{kind:"separate_uid",workerUid:21002}});
    expect(note,"QUALIFIED_IDENTITY_NOTE_NAMES_ACTUAL_WORKER_UID").toContain("verified separate non-root uid (21002)");
    expect(note,"SEPARATE_UID_NOTE_NEVER_CLAIMS_SHARED_UID").not.toContain("shares the server's uid");
    expect(note).toContain("external references may outlive that tree");
  }
  expect(workerSandboxNote(sandbox,{identity:{kind:"separate_uid",workerUid:0}}),"ROOT_UID_IS_NOT_VERIFIED_NONROOT").not.toContain("verified separate non-root uid");
});
