import { createFixtureMaintenanceHost } from "./helpers/worker-startup-view-fixture.js";
/**
 * #1648: the maintenance worker, the launcher form the server's own work on a
 * governed brain runs in. The brain is writable; the host is read-only, with
 * its runtime and home directories masked so no host Unix socket or secret
 * below them is reachable; a credential-free worker has no network, no home
 * and cannot read the brain's `.env`; the server's Bun and installation still
 * run from below a masked home.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import { HOST_MASKS, MAINTENANCE_HOME, probeWorkerHost, workerCommand } from "../src/server/worker-launcher";
import { brainGitSync as realBrainGitSync, maintenanceLaunch, runMaintenanceWorker as realRunMaintenanceWorker } from "../src/server/maintenance-worker";

const ROOT = resolve(import.meta.dir, "../../..");
const roots: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

let supported = false;
beforeAll(() => {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const probe = mkdtempSync(join(ROOT, "tmp/maintenance-probe-"));
  try { supported = probeWorkerHost(probe).ok; } finally { rmSync(probe, { recursive: true, force: true }); }
  if (!supported && process.env.CI) throw new Error("CI must run the worker boundary for the maintenance worker proof");
});

const within = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`);
const masked = (path: string) => HOST_MASKS.some(mask => existsSync(mask) && within(realpathSync(mask), path));

/** A brain under the repository's `tmp/`, and a host directory outside it that is neither masked nor the brain. */
function fixture() {
  const root = mkdtempSync(join(ROOT, "tmp/maintenance-"));
  roots.push(root);
  const brain = join(root, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, "notes/harbor.md"), "Odysseus logs the harbor at Ithaca.\n");
  writeFileSync(join(brain, ".env"), "BRAIN_DOTENV_MARK=from-the-brain\n");
  const host = mkdtempSync("/var/tmp/brain-maintenance-host-");
  roots.push(host);
  return { root, brain, host };
}

async function inWorker(brain: string, program: string, options: { credentials: boolean; maskPaths?: string[]; writeFiles?: string[]; home?: string }) {
  const result = await runMaintenanceWorker({ brainPath: brain, command: [process.execPath, "-e", program],
    env: { PATH: "/usr/bin:/bin", SECRET_TOKEN: "only-for-credentialed" }, credentials: options.credentials,
    ...(options.maskPaths ? { maskPaths: options.maskPaths } : {}), ...(options.writeFiles ? { writeFiles: options.writeFiles } : {}),
    ...(options.home ? { home: options.home } : {}), timeoutMs: 30_000 });
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}

const PROBE = (f: ReturnType<typeof fixture>) => `
const fs = require("fs"), path = require("path");
const attempt = fn => { try { fn(); return "ok"; } catch (e) { return e.code; } };
const list = dir => { try { return fs.readdirSync(dir); } catch (e) { return e.code; } };
const read = file => { try { return fs.readFileSync(file, "utf8"); } catch (e) { return e.code; } };
const links = fs.readFileSync("/proc/net/dev", "utf8").split("\\n").slice(2).map(l => l.split(":")[0].trim()).filter(Boolean);
console.log(JSON.stringify({
  brainWrite: attempt(() => fs.writeFileSync(${JSON.stringify(f.brain)} + "/notes/written.md", "Penelope weaves.")),
  hostWrite: attempt(() => fs.writeFileSync(${JSON.stringify(f.host)} + "/escaped", "x")),
  env: read(${JSON.stringify(f.brain)} + "/.env"),
  dotenv: process.env.BRAIN_DOTENV_MARK ?? null,
  secret: process.env.SECRET_TOKEN ?? null,
  home: process.env.HOME ?? null,
  homeWritable: attempt(() => fs.writeFileSync(process.env.HOME + "/probe", "x")),
  links,
  root: list("/root"), srv: list("/srv"), varLib: list("/var/lib"), run: list("/run"),
}));`;

describe("maintenance worker (#1648)", () => {
  test("credential-free: configuration inputs and the host are read-only, and nothing of the server's secrets or network reaches it", async () => {
    if (!supported) return;
    const f = fixture();
    const r = await inWorker(f.brain, PROBE(f), { credentials: false });
    expect(r.brainWrite, "CONFIG_VIEW_READ_ONLY").toBe("EROFS");
    expect(existsSync(join(f.brain, "notes/written.md"))).toBe(false);
    expect(r.hostWrite, "HOST_READ_ONLY").toBe("EROFS");
    expect(existsSync(join(f.host, "escaped"))).toBe(false);
    expect(r.env, "the brain's .env cannot be opened").toBe("EACCES");
    expect(r.dotenv, "and Bun loaded none of it").toBeNull();
    expect(r.secret, "only plain settings are passed").toBeNull();
    expect(r.home).toBe(MAINTENANCE_HOME);
    expect(r.homeWritable, "a private, writable home").toBe("ok");
    expect(r.links, "a private network namespace with only loopback").toEqual(["lo"]);
    for (const dir of ["root", "srv", "varLib"] as const) if (Array.isArray(r[dir])) expect(r[dir], `${dir} is an empty mask`).toEqual([]);
  });

  test("credentialed: the brain's .env and the passed credentials reach the command, inside the worker", async () => {
    if (!supported) return;
    const f = fixture();
    const r = await inWorker(f.brain, PROBE(f), { credentials: true });
    expect(r.brainWrite).toBe("EROFS");
    expect(r.hostWrite).toBe("EROFS");
    expect(r.env).toBe("BRAIN_DOTENV_MARK=from-the-brain\n");
    expect(r.dotenv).toBe("from-the-brain");
    expect(r.secret).toBe("only-for-credentialed");
  });

  test("no host Unix socket below a masked directory is reachable", async () => {
    if (!supported) return;
    const f = fixture();
    const socketDir = mkdtempSync("/var/tmp/brain-maintenance-socket-");
    roots.push(socketDir);
    const socket = join(socketDir, "host.sock");
    const server = createServer(connection => connection.end("host-secret"));
    servers.push(server);
    await new Promise<void>(done => server.listen(socket, done));
    const program = `const net = require("net");
      const c = net.connect(${JSON.stringify(socket)});
      c.on("data", d => { console.log(JSON.stringify({ reached: String(d) })); process.exit(0); });
      c.on("error", e => { console.log(JSON.stringify({ refused: e.code })); process.exit(0); });`;
    // The control: unmasked, the socket answers from inside a worker.
    expect(await inWorker(f.brain, program, { credentials: false })).toEqual({ reached: "host-secret" });
    expect(await inWorker(f.brain, program, { credentials: false, maskPaths: [socketDir] }), "SOCKET_MASKED").toEqual({ refused: "ENOENT" });
  });

  test("the masks are the runtime and home directories, the brain is bound read-write over them, and the server's Bun is bound back", () => {
    if (!supported) return;
    const f = fixture();
    const argv = workerCommand(maintenanceLaunch({ brainPath: f.brain, command: ["/bin/true"], env: {}, credentials: false }));
    const tmpfs = argv.flatMap((arg, i) => arg === "--tmpfs" ? [argv[i + 1]!] : []);
    for (const mask of ["/run", "/var/lib", "/home", "/root", "/mnt", "/media", "/srv"]) {
      if (existsSync(mask) && realpathSync(mask) === mask) expect(tmpfs, `${mask} is masked`).toContain(mask);
    }
    const brain = realpathSync(f.brain);
    expect(argv.join("\0"), "the brain is read-write").toContain(["--bind", brain, brain].join("\0"));
    const bun = realpathSync(process.execPath);
    if (masked(bun)) expect(argv.join("\0"), "Bun below a masked home is bound back").toContain(["--ro-bind", bun, bun].join("\0"));
    expect(argv, "a credential-free worker has no network").toContain("--unshare-net");
    expect(argv.join("\0")).toContain(["--ro-bind", "/dev/null", join(brain, ".env")].join("\0"));
  });

  test("a writable file outside the brain is the only host file a job appends to", async () => {
    if (!supported) return;
    const f = fixture();
    const sink = join(f.host, "sink.jsonl");
    writeFileSync(sink, "");
    const program = `require("fs").appendFileSync(${JSON.stringify(sink)}, "span\\n"); console.log(JSON.stringify({ ok: true }));`;
    expect(await inWorker(f.brain, program, { credentials: false, writeFiles: [sink] })).toEqual({ ok: true });
    expect(readFileSync(sink, "utf8")).toBe("span\n");
  });

  test("a credentialed worker reads the server's home and never changes it", async () => {
    if (!supported) return;
    const f = fixture();
    const home = join(f.root, "home");
    mkdirSync(home);
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Penelope\n");
    const program = `const fs = require("fs");
      // Overlaid where the host can (writes vanish), read-only where it cannot (bubblewrap before 0.11).
      try { fs.writeFileSync(process.env.HOME + "/left-behind", "x"); } catch (e) { if (e.code !== "EROFS") throw e; }
      console.log(JSON.stringify({ config: fs.readFileSync(process.env.HOME + "/.gitconfig", "utf8") }));`;
    const result = await runMaintenanceWorker({ brainPath: f.brain, command: [process.execPath, "-e", program],
      env: { PATH: "/usr/bin:/bin", HOME: home }, credentials: true, home, timeoutMs: 30_000 });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).config).toContain("Penelope");
    expect(existsSync(join(home, "left-behind")), "the host home is unchanged").toBe(false);
  });

  test("a masked directory inside the server's home stays masked when the home is shown", async () => {
    if (!supported) return;
    const f = fixture();
    const home = join(f.root, "home");
    mkdirSync(join(home, "db"), { recursive: true });
    writeFileSync(join(home, "db/brain-ui.db"), "sessions");
    const program = `const fs = require("fs"); let db; try { db = fs.readFileSync(process.env.HOME + "/db/brain-ui.db", "utf8"); } catch (e) { db = e.code; }
      console.log(JSON.stringify({ db }));`;
    for (const overlay of [true, false]) {
      const launch = maintenanceLaunch({ brainPath: f.brain, command: [process.execPath, "-e", program], env: { PATH: "/usr/bin:/bin", HOME: home },
        credentials: true, home, maskPaths: [join(home, "db")] });
      launch.maintenance!.home!.overlay = overlay && launch.maintenance!.home!.overlay;
      const result = Bun.spawnSync(workerCommand(launch), { stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(JSON.parse(result.stdout.toString()), "DB_STAYS_MASKED").toEqual({ db: "ENOENT" });
    }
  });

  test("git against the brain runs in a worker once the boundary is proven: it never reads a masked host file", () => {
    if (!supported) return;
    const f = fixture();
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: f.brain }).exitCode).toBe(0);
    // An exclude file outside the brain, below a masked directory, that ignores scratch.
    const excludes = join(f.root, "excludes");
    writeFileSync(excludes, ".brain/scratch\n");
    expect(Bun.spawnSync(["git", "config", "core.excludesFile", excludes], { cwd: f.brain }).exitCode).toBe(0);
    mkdirSync(join(f.brain, ".brain/scratch"), { recursive: true });
    const query = ["check-ignore", "-q", "--no-index", "--", ".brain/scratch"];
    // The control: host git reads the exclude file.
    expect(Bun.spawnSync(["git", ...query], { cwd: f.brain }).exitCode).toBe(0);
    if (masked(realpathSync(excludes))) {
      expect(brainGitSync(f.brain, query), "GIT_IN_WORKER: the masked exclude file is out of reach").toBe(1);
    }
    writeFileSync(join(f.brain, ".gitignore"), ".brain/scratch/\n");
    expect(brainGitSync(f.brain, query), "the brain's own ignore file answers in the worker").toBe(0);
    // Outside any repository, the question goes through a fresh empty one inside the worker.
    rmSync(join(f.brain, ".git"), { recursive: true, force: true });
    expect(brainGitSync(f.brain, query, { emptyRepository: true })).toBe(0);
  });
});

describe("maintenance launch refusals", () => {
  test("a mask inside the brain, a home inside the brain and a writable file inside the brain are refused", () => {
    if (!supported) return;
    const f = fixture();
    const base = { brainPath: f.brain, command: ["/bin/true"], env: {} };
    expect(() => workerCommand(maintenanceLaunch({ ...base, credentials: false, maskPaths: [join(f.brain, "notes")] }))).toThrow("cannot mask");
    expect(() => workerCommand(maintenanceLaunch({ ...base, credentials: true, home: join(f.brain, "notes") }))).toThrow("outside the brain");
    const inside = join(f.brain, "notes/harbor.md");
    chmodSync(inside, 0o644);
    expect(() => workerCommand(maintenanceLaunch({ ...base, credentials: false, writeFiles: [inside] }))).toThrow("outside the brain");
  });
});

async function runMaintenanceWorker(input: Parameters<typeof realRunMaintenanceWorker>[0]) {
  const maintenance = createFixtureMaintenanceHost(input.brainPath);
  try { return await realRunMaintenanceWorker({ ...input, ...maintenance }); }
  finally { maintenance.cleanup(); }
}
function brainGitSync(brain: string, args: readonly string[], options: Parameters<typeof realBrainGitSync>[2] = {}) {
  const maintenance = createFixtureMaintenanceHost(brain, options);
  try { return realBrainGitSync(brain, args, { ...options, ...maintenance }); }
  finally { maintenance.cleanup(); }
}
