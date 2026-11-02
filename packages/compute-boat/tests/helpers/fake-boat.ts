/**
 * An in-process Boat: a `fetch` the tests hand to the provider through
 * `ComputeContext.fetch`. No socket is opened. It answers the API origin
 * (`https://boat.dev/api/v1`) and its own signed file URLs, keeps sandboxes,
 * idempotency keys, stops and deletions as state, and interprets the few
 * commands the harness and the adapter send. Every request is recorded, and
 * faults can be queued per route.
 *
 * Shapes follow Boat's OpenAPI description (/sandboxes, /commands,
 * /files/upload-url, /stops, /deletion-operations, /usage, /limits), not
 * measured behaviour.
 */

export type Route =
  | "limits"
  | "list"
  | "create"
  | "get"
  | "delete"
  | "deletion-op"
  | "stop"
  | "get-stop"
  | "resume"
  | "upload-url"
  | "signed-put"
  | "exec"
  | "command-status"
  | "command-kill"
  | "file-info"
  | "artifact"
  | "usage";

/** A queued answer: an HTTP error, a failure before any effect, or an effect whose answer is lost. */
export type Fault =
  | { status: number; code?: string; extra?: Record<string, unknown>; details?: Record<string, unknown>; headers?: Record<string, string> }
  | "network"
  | "lose-response"
  /** A connection failure whose message echoes the request URL, as some runtimes' errors do. */
  | { network: (url: string) => string };

export interface RecordedRequest {
  method: string;
  url: string;
  route: Route | "unknown";
  headers: Record<string, string>;
  body: string;
}

interface Proc {
  pid: number;
  commandId: string;
  command: string;
  argv: string[];
  env: Record<string, string>;
  status: "running" | "exited" | "lost";
  exitCode: number | null;
  signal: string | null;
  oomKilled: boolean;
  stdout: string;
  stderr: string;
  sleepUntil?: number;
}

export interface FakeSandbox {
  id: string;
  labels: Record<string, string>;
  state: string;
  setupStatus: string | null;
  type: string;
  ttlSeconds: number | null;
  noEnv: boolean;
  environment: string | null;
  snapshots: boolean;
  from: string | null;
  org: string | null;
  createdAt: number;
  stoppedAt: number | null;
  deleted: boolean;
  dataExpiredAt: number | null;
  gets: number;
  files: Map<string, Uint8Array>;
  procs: Map<number, Proc>;
  stop: { id: string; status: string; error: string | null; requestedAt: number; endedAt: number | null } | null;
  createBody: Record<string, unknown>;
}

export interface FakeBoatOptions {
  apiKey: string;
  now?: () => number;
  /** GETs of a new sandbox before it reads `ready`; `Infinity` keeps it provisioning. */
  readyAfterGets?: number;
  /** The `setupStatus` each new sandbox reports, independent of its state. */
  setupStatus?: string | null;
  /** Usage pricing the fake reports; the adapter must take the dollars from the answer. */
  secondsPerDollar?: number;
  /** `/limits` answers 403 `api_key_action_forbidden`, as for a key without `account.read`. */
  limitsForbidden?: boolean;
  /** Every deletion operation reports `blocked`. */
  deletionBlocked?: boolean;
  /** Every stop reports `failing`. */
  stopFailing?: boolean;
  /** A new sandbox is missing from lists until it is first read by id, as one still being minted can be. */
  listLag?: boolean;
}

const API = "https://boat.dev/api/v1";
const FILES = "https://files.boat.test";
const HOME = "/home/user";
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
/** What a sandbox attached to the owner's environment would carry. */
export const OWNER_ENV: Record<string, string> = {
  GITHUB_TOKEN: "ghp_odysseus_owner_token",
  ANTHROPIC_API_KEY: "sk-ant-odysseus-owner",
  BOAT_CLI_TOKEN: "boat_owner_cli_token_ithaca",
};
/** Boat documents this per-sandbox token as staying even with `noEnv`; it can only host ports. */
const BASE_ENV: Record<string, string> = { HOME, PATH: "/usr/local/bin:/usr/bin:/bin", ASCII_TOKEN: "host-ports-only" };

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function envelope(status: number, code: string, details?: Record<string, unknown>, extra?: Record<string, unknown>) {
  return {
    ok: false,
    type: "sandbox.error",
    status,
    code,
    message: (details?.message as string | undefined) ?? code,
    error: { code, message: (details?.message as string | undefined) ?? code, status, ...(details ? { details } : {}) },
    requestId: "req_odysseus",
    ...extra,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Tokens of `'quoted'` shell words separated by spaces. */
export function shellWords(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === " ") {
      i++;
      continue;
    }
    let word = "";
    while (i < text.length && text[i] !== " ") {
      if (text[i] === "'") {
        const end = text.indexOf("'", i + 1);
        word += text.slice(i + 1, end);
        i = end + 1;
      } else if (text.startsWith("\\'", i)) {
        word += "'";
        i += 2;
      } else {
        word += text[i];
        i++;
      }
    }
    out.push(word);
  }
  return out;
}

function readTar(bytes: Uint8Array): { path: string; data: Uint8Array }[] {
  const out: { path: string; data: Uint8Array }[] = [];
  const dec = new TextDecoder();
  const str = (o: number, l: number) => dec.decode(bytes.subarray(o, o + l)).replace(/\u0000.*$/s, "");
  for (let offset = 0; offset + 512 <= bytes.byteLength; ) {
    const name = str(offset, 100);
    if (name === "") break;
    const prefix = str(offset + 345, 155);
    const size = parseInt(str(offset + 124, 12), 8);
    out.push({ path: prefix ? `${prefix}/${name}` : name, data: bytes.slice(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const sha256 = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

export function fakeBoat(opts: FakeBoatOptions) {
  const now = opts.now ?? (() => Date.now());
  const readyAfter = opts.readyAfterGets ?? 2;
  const sandboxes = new Map<string, FakeSandbox>();
  const idempotency = new Map<string, { bodyHash: string; id: string }>();
  const deletions = new Map<string, { id: string; targetId: string; status: string; requestedAt: number }>();
  const signed = new Map<string, { sandboxId: string; path: string }>();
  const requests: RecordedRequest[] = [];
  const faults = new Map<Route, Fault[]>();
  let sequence = 0;
  let pids = 100;

  const nextId = () => {
    let v = sequence++;
    let id = "";
    for (let i = 0; i < 8; i++) {
      id = ALPHABET[v % ALPHABET.length] + id;
      v = Math.floor(v / ALPHABET.length);
    }
    return `bx_${id}`;
  };
  const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const abs = (path: string) => (path.startsWith("/") ? path : `${HOME}/${path}`);

  function view(s: FakeSandbox) {
    return {
      id: s.id,
      name: `Sandbox ${s.id}`,
      state: s.state,
      labels: s.labels,
      type: s.type,
      ttlSeconds: s.ttlSeconds,
      setupStatus: s.setupStatus,
      environment: s.environment,
      hydrated: true,
      stoppedAt: iso(s.stoppedAt),
      dataExpiredAt: iso(s.dataExpiredAt),
      desktopAvailable: false,
      snapshotAvailable: s.state === "archived",
      createdAt: iso(s.createdAt),
      stop: s.stop ? { ...s.stop, requestedAt: iso(s.stop.requestedAt), endedAt: iso(s.stop.endedAt), lastAttemptAt: null } : null,
    };
  }

  function refresh(p: Proc) {
    if (p.status === "running" && p.sleepUntil !== undefined && now() >= p.sleepUntil) {
      p.status = "exited";
      p.exitCode = 0;
    }
  }

  /** Run one command line; the sandbox is ready. */
  function interpret(s: FakeSandbox, command: string): Proc {
    const proc: Proc = { pid: pids++, commandId: `cmd_${hex(6)}`, command, argv: [], env: {}, status: "exited", exitCode: 0, signal: null, oomKilled: false, stdout: "", stderr: "" };
    const stage = /^set -e; mkdir -p work; tar -xf '([^']+)' -C work; cd work; sha256sum -c --quiet '([^']+)'; rm -f '[^']+' '[^']+'$/.exec(command);
    if (stage) {
      const tar = s.files.get(stage[1]!);
      if (!tar) return { ...proc, exitCode: 2, stderr: "tar: cannot open" };
      for (const entry of readTar(tar)) s.files.set(`${HOME}/work/${entry.path}`, entry.data);
      const manifest = new TextDecoder().decode(s.files.get(`${HOME}/work/${stage[2]!}`) ?? new Uint8Array());
      for (const line of manifest.split("\n").filter(Boolean)) {
        const [sum, path] = [line.slice(0, 64), line.slice(66)];
        const data = s.files.get(`${HOME}/work/${path}`);
        if (!data || sha256(data) !== sum) return { ...proc, exitCode: 1, stderr: `${path}: FAILED` };
      }
      s.files.delete(`${HOME}/work/${stage[2]!}`);
      s.files.delete(stage[1]!);
      return proc;
    }
    const run = /^mkdir -p work && cd ('(?:[^']|'\\'')*') && exec env -- (.*)$/.exec(command);
    if (!run) return { ...proc, exitCode: 127, stderr: "fake boat: unrecognised command" };
    const cwd = `${HOME}/${shellWords(run[1]!)[0]}`;
    const words = shellWords(run[2]!);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) {
      const w = words.shift()!;
      proc.env[w.slice(0, w.indexOf("="))] = w.slice(w.indexOf("=") + 1);
    }
    proc.argv = words;
    const [verb, ...args] = words;
    switch (verb) {
      case "exit":
        proc.exitCode = Number(args[0]);
        break;
      case "sleep":
        proc.status = "running";
        proc.exitCode = null;
        proc.sleepUntil = now() + Number(args[0]) * 1000;
        break;
      case "write":
        s.files.set(`${cwd}/${args[0]}`, new TextEncoder().encode(args[1] ?? ""));
        break;
      case "printenv": {
        const env = { ...BASE_ENV, ...(s.noEnv ? {} : OWNER_ENV), ...proc.env };
        proc.stdout = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
        break;
      }
      case "oom":
        proc.exitCode = 137;
        proc.oomKilled = true;
        break;
      case "signal":
        proc.exitCode = null;
        proc.signal = args[0] ?? "SIGSEGV";
        break;
      default:
        proc.exitCode = 127;
        proc.stderr = `${verb}: command not found`;
    }
    return proc;
  }

  function procView(p: Proc) {
    refresh(p);
    return {
      ok: true,
      type: "command.status",
      success: true,
      processId: p.pid,
      pid: p.pid,
      status: p.status,
      known: true,
      running: p.status === "running",
      exitCode: p.exitCode,
      signal: p.signal,
      oomKilled: p.oomKilled,
      command: p.command,
      stdout: p.stdout,
      stderr: p.stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }

  function route(method: string, url: URL): { route: Route | "unknown"; params: string[] } {
    if (url.origin === FILES) return { route: method === "PUT" ? "signed-put" : "unknown", params: [url.pathname.split("/").pop() ?? ""] };
    const path = url.href.startsWith(API) ? url.pathname.slice("/api/v1".length) : "";
    const m = (re: RegExp) => re.exec(path)?.slice(1);
    const table: [string, RegExp, Route][] = [
      ["GET", /^\/limits$/, "limits"],
      ["GET", /^\/sandboxes$/, "list"],
      ["POST", /^\/sandboxes$/, "create"],
      ["GET", /^\/sandboxes\/([^/]+)$/, "get"],
      ["DELETE", /^\/sandboxes\/([^/]+)$/, "delete"],
      ["GET", /^\/deletion-operations\/([^/]+)$/, "deletion-op"],
      ["POST", /^\/sandboxes\/([^/]+)\/stop$/, "stop"],
      ["GET", /^\/sandboxes\/([^/]+)\/stops\/([^/]+)$/, "get-stop"],
      ["POST", /^\/sandboxes\/([^/]+)\/resume$/, "resume"],
      ["POST", /^\/sandboxes\/([^/]+)\/files\/upload-url$/, "upload-url"],
      ["POST", /^\/sandboxes\/([^/]+)\/commands$/, "exec"],
      ["GET", /^\/sandboxes\/([^/]+)\/commands\/([^/]+)$/, "command-status"],
      ["DELETE", /^\/sandboxes\/([^/]+)\/commands\/([^/]+)$/, "command-kill"],
      ["GET", /^\/sandboxes\/([^/]+)\/files\/info$/, "file-info"],
      ["GET", /^\/sandboxes\/([^/]+)\/artifacts$/, "artifact"],
      ["GET", /^\/sandboxes\/([^/]+)\/usage$/, "usage"],
    ];
    for (const [verb, re, name] of table) {
      const params = verb === method ? m(re) : undefined;
      if (params) return { route: name, params: params.map(decodeURIComponent) };
    }
    return { route: "unknown", params: [] };
  }

  function live(id: string): FakeSandbox | undefined {
    const s = sandboxes.get(id);
    return s && !s.deleted ? s : undefined;
  }

  function handle(name: Route | "unknown", params: string[], url: URL, req: { method: string; headers: Headers; text: string; bytes: Uint8Array }): Response {
    if (name === "signed-put") {
      const target = signed.get(params[0]!);
      const s = target && live(target.sandboxId);
      if (!target || !s || !url.searchParams.get("sig")) return json(403, envelope(403, "invalid_signature"));
      s.files.set(target.path, req.bytes);
      return new Response(null, { status: 200 });
    }
    if (req.headers.get("authorization") !== `Bearer ${opts.apiKey}`) return json(401, envelope(401, "unauthorized"));
    const body = (() => {
      try {
        return req.text ? (JSON.parse(req.text) as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    })();
    switch (name) {
      case "limits":
        if (opts.limitsForbidden) return json(403, envelope(403, "api_key_action_forbidden"));
        return json(200, { ok: true, type: "limits.info", canStart: true, activeSandboxes: [...sandboxes.values()].filter((s) => !s.deleted).length });
      case "list": {
        const wanted = url.searchParams.getAll("label");
        const list = [...sandboxes.values()].filter((s) => !s.deleted && !(opts.listLag && s.gets === 0) && wanted.every((l) => s.labels[l.slice(0, l.indexOf("="))] === l.slice(l.indexOf("=") + 1)));
        return json(200, { ok: true, type: "sandbox.list", sandboxes: list.slice(0, Number(url.searchParams.get("limit") ?? 100)).map(view) });
      }
      case "create": {
        const key = req.headers.get("idempotency-key");
        const hash = sha256(new TextEncoder().encode(req.text));
        if (key) {
          const prior = idempotency.get(key);
          if (prior && prior.bodyHash !== hash) return json(409, envelope(409, "idempotency_key_reused"));
          if (prior) return json(202, { ok: true, type: "sandbox.created", status: "provisioning", ttlSeconds: sandboxes.get(prior.id)!.ttlSeconds, sandbox: view(sandboxes.get(prior.id)!) });
        }
        const id = nextId();
        const s: FakeSandbox = {
          id,
          labels: (body.labels as Record<string, string>) ?? {},
          state: readyAfter === 0 ? "ready" : "provisioning",
          setupStatus: opts.setupStatus ?? null,
          type: (body.type as string) ?? "default",
          ttlSeconds: (body.ttlSeconds as number | null | undefined) === undefined ? 3600 : (body.ttlSeconds as number | null),
          noEnv: body.noEnv === true,
          environment: body.noEnv === true ? null : ((body.environment as string) ?? "base"),
          snapshots: body.snapshots !== false,
          from: (body.from as string) ?? null,
          org: (body.org as string) ?? null,
          createdAt: now(),
          stoppedAt: null,
          deleted: false,
          dataExpiredAt: null,
          gets: 0,
          files: new Map(),
          procs: new Map(),
          stop: null,
          createBody: body,
        };
        sandboxes.set(id, s);
        if (key) idempotency.set(key, { bodyHash: hash, id });
        return json(202, { ok: true, type: "sandbox.created", status: "provisioning", ttlSeconds: s.ttlSeconds, sandbox: view(s) });
      }
      case "get": {
        const s = live(params[0]!);
        if (!s) return json(404, envelope(404, "not_found"));
        s.gets += 1;
        if ((s.state === "provisioning" || s.state === "provisioned") && s.gets >= readyAfter) s.state = "ready";
        else if (s.state === "provisioning") s.state = "provisioned";
        return json(200, { ok: true, type: "sandbox.info", sandbox: view(s) });
      }
      case "delete": {
        const s = live(params[0]!);
        if (!s) return json(404, envelope(404, "not_found"));
        if (req.headers.get("x-ascii-confirm-delete") !== s.id) return json(409, envelope(409, "confirmation_required"));
        s.deleted = true;
        const op = { id: `bdop_${hex(16)}`, targetId: s.id, status: "pending", requestedAt: now() };
        deletions.set(op.id, op);
        return json(202, { ok: true, type: "sandbox.deleting", operation: { ...op, kind: "sandbox", reason: "explicit", attemptCount: 0, requestedAt: iso(op.requestedAt), completedAt: null } });
      }
      case "deletion-op": {
        const op = deletions.get(params[0]!);
        if (!op) return json(404, envelope(404, "not_found"));
        op.status = opts.deletionBlocked ? "blocked" : "completed";
        return json(200, { ok: true, type: "deletion.operation", operation: { ...op, kind: "sandbox", reason: "explicit", attemptCount: 1, requestedAt: iso(op.requestedAt), completedAt: op.status === "completed" ? iso(now()) : null } });
      }
      case "stop": {
        const s = live(params[0]!);
        if (!s) return json(404, envelope(404, "not_found"));
        if (!s.stop || s.stop.status === "superseded") {
          s.stop = { id: `stop_${hex(8)}`, status: opts.stopFailing ? "failing" : "pending", error: opts.stopFailing ? "snapshot upload failed" : null, requestedAt: now(), endedAt: null };
          if (!opts.stopFailing) {
            s.state = "archiving";
            for (const p of s.procs.values()) if (refresh(p), p.status === "running") p.status = "lost";
          }
        }
        return json(202, { ok: true, type: "sandbox.stopping", id: s.id, status: "archiving", stop: view(s).stop, sandbox: view(s) });
      }
      case "get-stop": {
        const s = sandboxes.get(params[0]!);
        if (!s || !s.stop || s.stop.id !== params[1]) return json(404, envelope(404, "not_found"));
        if (s.stop.status === "pending") {
          s.stop.status = "completed";
          s.stop.endedAt = now();
          s.state = "archived";
          s.stoppedAt = now();
        }
        return json(200, { ok: true, type: "stop.status", id: s.stop.id, stop: view(s).stop });
      }
      case "resume":
        return json(202, { ok: true, type: "sandbox.resuming", id: params[0], status: "resuming" });
      case "upload-url": {
        const s = live(params[0]!);
        if (!s) return json(404, envelope(404, "not_found"));
        const token = hex(8);
        const path = abs(String(body.path));
        signed.set(token, { sandboxId: s.id, path });
        return json(200, { ok: true, type: "file.upload_url", url: `${FILES}/u/${token}?sig=${hex(12)}`, method: "PUT", path, expiresAt: iso(now() + 300_000) });
      }
      case "exec": {
        const s = live(params[0]!);
        if (!s) return json(404, envelope(404, "not_found"));
        if (s.state === "archived" || s.state === "archiving") return json(409, envelope(409, "sandbox_not_ready", { retryable: false }));
        if (s.state !== "ready" && s.state !== "idle" && s.state !== "running") return json(409, envelope(409, "boat_starting", { retryable: true }));
        const p = interpret(s, String(body.command));
        if (body.detached === true) {
          s.procs.set(p.pid, p);
          return json(200, { ok: true, type: "command.started", success: true, processId: p.pid, pid: p.pid, commandId: p.commandId, command: p.command, startedAt: iso(now()) });
        }
        return json(200, { ok: true, type: "command.finished", success: p.exitCode === 0, commandId: p.commandId, exitCode: p.exitCode, signal: p.signal, stdout: p.stdout, stderr: p.stderr, timedOut: false });
      }
      case "command-status": {
        const s = live(params[0]!);
        if (!s) return json(404, envelope(404, "not_found"));
        if (s.state === "archived" || s.state === "archiving") return json(409, envelope(409, "machine_not_running", { retryable: false }));
        const p = s.procs.get(Number(params[1]));
        if (!p) return json(404, envelope(404, "not_found"));
        return json(200, procView(p));
      }
      case "command-kill": {
        const s = live(params[0]!);
        if (!s) return json(404, envelope(404, "not_found"));
        const p = s.procs.get(Number(params[1]));
        if (!p) return json(404, envelope(404, "not_found"));
        refresh(p);
        const signaled = p.status === "running";
        if (signaled) {
          p.status = "exited";
          p.exitCode = null;
          p.signal = "SIGTERM";
        }
        return json(200, { ok: true, type: "command.stopped", processId: p.pid, running: false, signaled, command: null });
      }
      case "file-info": {
        const s = live(params[0]!);
        if (!s) return json(404, envelope(404, "not_found"));
        const path = abs(url.searchParams.get("path") ?? "");
        const data = s.files.get(path);
        if (data) return json(200, { ok: true, type: "file.info", name: path.split("/").pop(), path, isDir: false, isSymlink: false, size: data.byteLength, mode: "0644", modifiedAt: iso(now()) });
        if ([...s.files.keys()].some((k) => k.startsWith(`${path}/`))) return json(200, { ok: true, type: "file.info", name: path.split("/").pop(), path, isDir: true, isSymlink: false, size: 4096, mode: "0755", modifiedAt: iso(now()) });
        return json(404, envelope(404, "not_found"));
      }
      case "artifact": {
        const s = live(params[0]!);
        if (!s) return json(404, envelope(404, "not_found"));
        const data = s.files.get(abs(url.searchParams.get("path") ?? ""));
        if (!data) return json(404, envelope(404, "not_found"));
        return new Response(new Blob([data as Uint8Array<ArrayBuffer>]), { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
      case "usage": {
        const s = live(params[0]!);
        if (!s) return json(404, envelope(404, "not_found"));
        const multiplier = { small: 0.5, default: 1, large: 2, xlarge: 50 / 9 }[s.type] ?? 1;
        const seconds = Math.floor((((s.stoppedAt ?? now()) - s.createdAt) / 1000) * multiplier);
        const perDollar = opts.secondsPerDollar ?? 1;
        return json(200, { ok: true, type: "sandbox.usage", sandboxId: s.id, sandboxType: s.type, billingMultiplier: multiplier, seconds, dollars: Math.round((seconds / perDollar) * 1e6) / 1e6, secondsPerDollar: perDollar, running: s.state !== "archived" });
      }
      default:
        return json(404, envelope(404, "not_found"));
    }
  }

  async function fetchFn(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    let bytes = new Uint8Array();
    if (init.body !== undefined && init.body !== null) bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    const { route: name, params } = route(method, url);
    requests.push({ method, url: url.href, route: name, headers: Object.fromEntries(headers.entries()), body: text });
    if (init.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const fault = name === "unknown" ? undefined : faults.get(name)?.shift();
    if (fault === "network") throw new TypeError(`fake boat: connection reset during ${name}`);
    if (fault && typeof fault === "object" && "network" in fault) throw new TypeError(fault.network(url.href));
    if (fault && fault !== "lose-response") {
      return json(fault.status, envelope(fault.status, fault.code ?? `http_${fault.status}`, fault.details, fault.extra), fault.headers);
    }
    const response = handle(name, params, url, { method, headers, text, bytes });
    if (fault === "lose-response") throw new TypeError(`fake boat: the answer to ${name} was lost`);
    return response;
  }

  return {
    fetch: fetchFn as typeof fetch,
    sandboxes,
    requests,
    /** Queue `fault` for the next `times` requests to `route`. */
    failNext(route: Route, fault: Fault, times = 1) {
      const queue = faults.get(route) ?? [];
      for (let i = 0; i < times; i++) queue.push(fault);
      faults.set(route, queue);
    },
    /** Sandboxes neither deleted nor stopped. */
    liveSandboxes: () => [...sandboxes.values()].filter((s) => !s.deleted && s.state !== "archived" && s.state !== "cancelled").length,
    /** Every sandbox ever created, deleted or not. */
    created: () => sandboxes.size,
    routes: () => requests.map((r) => r.route),
    /** Boat keeps idempotency keys 24 hours; this is that window passing. */
    forgetIdempotencyKeys: () => idempotency.clear(),
  };
}

export type FakeBoat = ReturnType<typeof fakeBoat>;

/** argv the fake's sandbox understands, for the shared contract harness. */
export const boatCommands = {
  exit: (code: number) => ["exit", String(code)],
  sleep: (seconds: number) => ["sleep", String(seconds)],
  write: (path: string, text: string) => ["write", path, text],
  printEnv: () => ["printenv"],
};
