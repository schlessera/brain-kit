/**
 * The integrated media review flow (#2783, epic #1777): one Odysseus brain
 * with a bare remote, the real offline core CLI, and the real review server
 * (`tests/fixtures/media-flow-server.ts`) as a child process that can be
 * stopped, killed and booted again on the same SQLite, journal and Markdown
 * state. Shared by the Bun suite and the browser fixture. Nothing reaches the
 * network: Git talks to a local bare repository, and the server listens on
 * loopback only.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const REPO = resolve(import.meta.dir, "../../../..");
const CORE_CLI = join(REPO, "packages/core/src/cli/brain.ts");
const SERVER = join(REPO, "packages/ui-server/tests/fixtures/media-flow-server.ts");
const PRELOAD = join(REPO, "scripts/test-network-child-preload.ts");

/** Odysseus's media: what each file is for in the flow. */
export const LOOM = "photos/penelope-loom.png";
export const SHIELD = "photos/achilles-shield.png";
export const SKETCH = "inbox/cyclops-sketch.png";
export const ARGUS = "photos/argus-waiting.png";
export const HARBOUR = ".brain/scratch/2026-07-12/harbour-dawn.png";
export const NOTE = "notes/the-return.md";
export const CONFIG = "brain.config.json";
export const PINS = ".brain/scratch-pins/pins.json";
export const KEPT = "context/hygiene/kept.md";
/** Where Move and Keep a permanent copy put their files. */
export const LOOM_TO = "places/ithaca/penelope-loom.png";
export const HARBOUR_TO = "places/ithaca/harbour-dawn.png";
/** The counted content media; the pinned scratch file is review-only. */
export const COUNTED = [LOOM, SHIELD, SKETCH, ARGUS] as const;

export const CONFIG_TEXT = '{ "media": { "ignore": [".brain/scratch/**"] } }\n';
/**
 * Notes are edited today, so a Move's rewrite of one is never a silent edit
 * that review would select before the media; they were written on Odysseus's
 * date.
 */
const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
export const NOTE_TEXT = "---\ntitle: The return\ntype: note\ncreated: 2026-07-12\nupdated: " + TODAY + "\ntags: [voyage]\n---\n# The return\n\nPenelope's loom, as she left it:\n\n![loom](../photos/penelope-loom.png)\n";
export const PINS_TEXT = JSON.stringify({ version: 1, ready: true, sessions: { [JSON.stringify(["pi", "voyage-home"])]: [HARBOUR] } });

const CRC = Uint32Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  let c = 0xffffffff; for (const b of body) c = CRC[(c ^ b) & 255]! ^ (c >>> 8);
  const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}
/** A valid one-colour PNG, so each file has its own bytes and the browser can render it. */
export function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
/** A PNG of seeded noise: deflate cannot shrink it, so its bytes are about `side² × 3`. */
export function noisePng(side: number, seed = 12): Buffer {
  let x = seed >>> 0;
  const header = Buffer.alloc(13); header.writeUInt32BE(side, 0); header.writeUInt32BE(side, 4); header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(side * (side * 3 + 1));
  for (let i = 0; i < raw.length; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; raw[i] = i % (side * 3 + 1) === 0 ? 0 : x >>> 24; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
}
export const MEDIA_BYTES: Record<string, Buffer> = {
  [LOOM]: png(24, 16, [176, 112, 64]),
  [SHIELD]: png(20, 20, [200, 168, 40]),
  [SKETCH]: png(16, 12, [96, 96, 96]),
  [ARGUS]: png(18, 12, [120, 80, 48]),
  [HARBOUR]: png(32, 18, [40, 96, 160]),
};
export const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * The native proof container runs this suite as root, where a worker cannot
 * map its user namespace. There, as for the hosted app, the server, the CLI
 * and Git run as the unprivileged app UID it names, and own the flow's files.
 */
const APP_UID = process.env.BRAIN_MEDIA_FLOW_UID;
if (APP_UID !== undefined && !/^[1-9][0-9]{0,5}$/.test(APP_UID)) throw new Error("BRAIN_MEDIA_FLOW_UID must name an unprivileged UID");
const asApp = (argv: string[]) => APP_UID ? ["/usr/bin/setpriv", `--reuid=${APP_UID}`, `--regid=${APP_UID}`, "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", ...argv] : argv;
function own(directory: string) {
  if (!APP_UID) return;
  const r = Bun.spawnSync(["chown", "-R", `${APP_UID}:${APP_UID}`, directory]);
  if (r.exitCode !== 0) throw new Error(`chown ${directory}: ${r.stderr.toString()}`);
}

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(asApp(["git", "-C", cwd, ...args]), { env: gitEnv(cwd) });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
function gitEnv(home: string) { return { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" }; }
function put(root: string, path: string, bytes: string | Buffer) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); }

export interface Parity {
  /** `brain sync --json` in the brain: the count it reports and its one media line. */
  sync: { pending: number; setAside: { dismissed: number; snoozed: number; kept: number }; report: string; agent: unknown; status: string } | null;
  /** The server's review read: its media counts, pending card and deferrals. */
  server: { media: { awaitingReview: number; setAside: number; kept: number } | null; status: string; findingId: string | null; path: string | null; deferred: string[] };
  /** `brain hygiene next`, with the server's deferrals: the CLI's selection and counts. */
  cli: { media: { awaitingReview: number; setAside: number; kept: number }; findingId: string | null; path: string | null };
  /** Whether the CLI finds the server's pending card's finding eligible, at its fingerprint. */
  eligible: boolean | null;
}

export type Principal = "owner" | "penelope" | "agent";

/** One flow: its brain, remote and server state, removed by `close()`. */
export function createMediaFlow(options: { directory?: string; media?: readonly string[]; config?: string; bytes?: Record<string, Buffer> } = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "brain-media-flow-"));
  const root = join(directory, "brain"), remote = join(directory, "remote.git"), state = join(directory, "server");
  mkdirSync(root); mkdirSync(state);
  own(directory);
  Bun.spawnSync(asApp(["git", "init", "-q", "--bare", "-b", "main", remote]), { env: gitEnv(directory) });
  git(root, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "Odysseus"], ["user.email", "odysseus@example.test"], ["commit.gpgsign", "false"]]) git(root, "config", k!, v!);
  put(root, ".gitignore", ".brain/\nbrain.db\nbrain.db-*\n.brain-index/\nnode_modules\n");
  put(root, CONFIG, options.config ?? CONFIG_TEXT);
  // The vendored CLI entry the server's brain client runs (`scripts/brain-cli.ts`).
  put(root, "scripts/brain-cli.ts", `await import(${JSON.stringify(CORE_CLI)});\n`);
  put(root, "notes/ithaca.md", "---\ntitle: Ithaca\ntype: note\ncreated: 2026-07-12\nupdated: " + TODAY + "\ntags: [voyage]\n---\n# Ithaca\n\nThe island Odysseus sails home to.\n");
  put(root, NOTE, NOTE_TEXT);
  own(directory);
  git(root, "add", "-A"); git(root, "commit", "-qm", "Odysseus's brain");
  git(root, "remote", "add", "origin", remote); git(root, "push", "-q", "-u", "origin", "main");
  const present = options.media ?? Object.keys(MEDIA_BYTES);
  for (const path of present) put(root, path, options.bytes?.[path] ?? MEDIA_BYTES[path]!);
  // The conversation that linked the scratch file pins it; the pins exist with or without it.
  put(root, PINS, PINS_TEXT);
  const home = join(directory, "home"); mkdirSync(home);
  own(directory);

  let child: ChildProcess | undefined, url = "", stderr = "", hostExecution = "", governed: unknown = null;
  const env = { PATH: process.env.PATH ?? "", HOME: home, BRAIN_ROOT: root, GIT_CONFIG_NOSYSTEM: "1", TMPDIR: process.env.TMPDIR ?? tmpdir() };

  function cliRun(args: string[]) {
    const r = Bun.spawnSync(asApp([process.execPath, "--preload", PRELOAD, CORE_CLI, ...args]), { cwd: root, env });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  }
  /** The real offline CLI; exits 0 and 1 carry JSON. */
  function cli(...args: string[]): any {
    const r = cliRun(args);
    if (![0, 1].includes(r.code)) throw new Error(`brain ${args.join(" ")} exited ${r.code}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }
  /** One ordinary `brain sync`, as a person or cron runs it. */
  function sync(): any { return cli("sync", "--json"); }

  async function boot(boot: { port?: number; capBytes?: number; interrupt?: string; execution?: "host" | "worker" } = {}) {
    if (child) throw new Error("server already running");
    if (boot.interrupt) writeFileSync(join(state, "interrupt.txt"), boot.interrupt); else rmSync(join(state, "interrupt.txt"), { force: true });
    rmSync(join(state, "interrupted.flag"), { force: true });
    stderr = "";
    const [command, ...argv] = asApp([process.execPath, "--preload", PRELOAD, SERVER, root, state, String(boot.port ?? 0), String(boot.capBytes ?? 0), boot.execution ?? "host"]);
    const proc = spawn(command!, argv, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
    child = proc;
    proc.stderr!.on("data", b => { stderr += String(b); });
    const ready = await new Promise<{ url: string; hostExecution: string; governed: unknown }>((res, reject) => {
      let out = "";
      const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error(`media flow server did not start: ${stderr}`)); }, 20_000);
      proc.once("exit", code => { clearTimeout(timer); reject(new Error(`media flow server exited ${code}: ${stderr}`)); });
      proc.stdout!.on("data", b => { out += String(b); if (out.includes("\n")) { clearTimeout(timer); try { res(JSON.parse(out.split("\n")[0]!)); } catch (e) { reject(e); } } });
    });
    url = ready.url; hostExecution = ready.hostExecution; governed = ready.governed;
    return url;
  }
  /** SIGTERM: the server closes its stream, journal and database. */
  async function stop() {
    const proc = child; child = undefined;
    if (!proc || proc.exitCode !== null) return;
    const ended = once(proc, "exit"); proc.kill("SIGTERM"); const [code] = await ended;
    if (code !== 0) throw new Error(`media flow server stopped with ${code}: ${stderr}`);
  }
  /** SIGKILL: as if the host died, with nothing closed or committed. */
  async function kill() {
    const proc = child; child = undefined;
    if (!proc || proc.exitCode !== null) return;
    const ended = once(proc, "exit"); proc.kill("SIGKILL"); await ended;
  }
  const headers = (as: Principal) => ({ "content-type": "application/json", "x-media-flow-principal": as });
  async function request(path: string, init: { method?: string; body?: unknown; as?: Principal } = {}) {
    const r = await fetch(`${url}${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers: headers(init.as ?? "owner"), ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }
  const read = async (as: Principal = "owner") => (await request("/api/hygiene/review", { as })).body;
  const command = (operation: string, as: Principal = "owner") => request("/api/hygiene/review", { body: { operation }, as });
  const preview = (body: { itemId: string; optionId: string; expectedVersion: number; input: unknown; requestId?: string }, as: Principal = "owner") => request("/api/hygiene/review/preview", { body, as });
  const undo = (journalId: string, as: Principal = "owner") => request("/api/hygiene/review", { body: { operation: "undo-media", journalId }, as });

  /** One device on the review's socket: decisions go out as `inbox_resolve`, as from the browser. */
  async function device(as: Principal = "owner") {
    const frames: any[] = [];
    const ws = new WebSocket(`${url.replace("http:", "ws:")}/ws?as=${as}`);
    ws.addEventListener("message", e => frames.push(JSON.parse(String(e.data))));
    await new Promise<void>((res, reject) => { ws.addEventListener("open", () => res()); ws.addEventListener("error", () => reject(new Error("socket failed"))); });
    ws.send(JSON.stringify({ type: "inbox_subscribe", view: "actions" }));
    return {
      frames, ws,
      resolve(itemId: string, optionId: string, extra: Record<string, unknown> = {}) {
        ws.send(JSON.stringify({ type: "inbox_resolve", itemId, optionId, ...extra }));
      },
      /** The latest replicated state of one item, as this device's stream holds it. */
      item(id: string): any {
        let latest: any = null;
        for (const f of frames) {
          if (f.type === "inbox_snapshot") latest = f.items.find((i: any) => i.id === id) ?? latest;
          if (f.type === "inbox_delta" && f.change.kind === "upsert_item" && f.change.itemId === id) latest = f.change.item;
        }
        return latest;
      },
      async close() { if (ws.readyState === WebSocket.OPEN) { const closed = new Promise(r => ws.addEventListener("close", r)); ws.close(); await closed; } },
    };
  }

  /** Wait until the review read satisfies `check`; the review settles after the socket acknowledges. */
  async function until(check: (read: any) => boolean, what: string, deadlineMs = 20_000) {
    const end = Date.now() + deadlineMs;
    let last: any;
    while (Date.now() < end) {
      last = await read();
      if (check(last)) return last;
      await Bun.sleep(25);
    }
    throw new Error(`media flow: ${what} never held; last read ${JSON.stringify(last).slice(0, 2000)}`);
  }

  /**
   * Count and selection from the server and the offline CLI, at one instant.
   * With `sync`, an ordinary `brain sync` runs too, and commits and pushes
   * whatever the brain's rules track: use it where the flow has settled.
   */
  async function parity(options: { sync?: boolean; eligibility?: boolean } = {}): Promise<Parity> {
    const r = await read();
    const deferred = (r.review.deferred ?? []) as Array<{ findingId: string; fingerprint: string }>;
    const next = cli("hygiene", "--json", "next", ...(deferred.length ? ["--defer", deferred.map(d => `${d.findingId}=${d.fingerprint}`).join(",")] : []));
    const synced = options.sync === false ? null : sync();
    const finding = r.action?.status === "pending" ? r.action.hygiene.finding : null;
    // Only a card an Undo did not replace needs it: one more CLI read.
    const selected = finding && options.eligibility ? cli("hygiene", "--json", "next", "--finding", finding.id, "--dry-run") : null;
    return {
      eligible: selected ? selected.finding?.id === finding.id && selected.finding.fingerprint === finding.fingerprint : null,
      sync: synced ? { pending: synced.run.leftovers.mediaPending, setAside: synced.run.leftovers.mediaSetAside, report: synced.run.report, agent: synced.agent, status: synced.run.status } : null,
      server: { media: r.review.media ?? null, status: r.review.status, findingId: finding?.id ?? null, path: finding?.path ?? null, deferred: deferred.map(d => d.findingId) },
      cli: { media: { awaitingReview: next.media.awaitingReview, setAside: next.media.setAside, kept: next.media.kept }, findingId: next.finding?.id ?? null, path: next.finding?.path ?? null },
    };
  }

  /** Every byte the flow can change: media, config, the referencing note, pins and the kept log. */
  function bytes(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const path of [...Object.keys(MEDIA_BYTES), LOOM_TO, HARBOUR_TO, CONFIG, NOTE, PINS, KEPT])
      out[path] = existsSync(join(root, path)) ? sha(readFileSync(join(root, path))) : null;
    return out;
  }
  const text = (path: string) => existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
  /** What Git holds on the remote's main after a sync pushed. */
  const remoteFiles = () => git(root, "ls-tree", "-r", "--name-only", "origin/main").split("\n").filter(Boolean);
  const interrupted = () => existsSync(join(state, "interrupted.flag"));

  async function close() {
    await kill();
    rmSync(directory, { recursive: true, force: true });
  }
  return { directory, root, remote, state, get url() { return url; }, get stderr() { return stderr; }, get hostExecution() { return hostExecution; }, get governed() { return governed; },
    cli, cliRun, sync, git: (...args: string[]) => git(root, ...args), boot, stop, kill, request, read, command, preview, undo, device, until, parity, bytes, text, remoteFiles, interrupted, close };
}
export type MediaFlow = ReturnType<typeof createMediaFlow>;

/** The bytes the flow starts with, by path; files the flow creates start absent. */
export function initialBytes(media: readonly string[] = Object.keys(MEDIA_BYTES)): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [path, bytes] of Object.entries(MEDIA_BYTES)) out[path] = media.includes(path) ? sha(bytes) : null;
  return { ...out, [LOOM_TO]: null, [HARBOUR_TO]: null, [CONFIG]: sha(CONFIG_TEXT), [NOTE]: sha(NOTE_TEXT), [PINS]: sha(PINS_TEXT), [KEPT]: null };
}
