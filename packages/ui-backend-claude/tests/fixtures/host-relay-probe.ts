/** Actual SDK/CLI protocol qualification, inside the caller's private network namespace. */
import { query, type AccountInfo } from "@anthropic-ai/claude-agent-sdk";
import { startInferenceRelay, ANTHROPIC_INFERENCE_ROUTES, INFERENCE_PLACEHOLDER, acquireHostCredentialExclusion, startEgressProxy, type EgressRecord } from "@schlessera/brain-ui-sdk/internal";
import { resolveClaudeHostOAuth } from "../../src/host-oauth.js";
import { nativeModelReply } from "../helpers/native-model-reply.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const root = mkdtempSync(join(tmpdir(), "odysseus-native-host-relay-"));
const host = join(root, "host"), worker = join(root, "worker"), brain = join(worker, "brain"), directory = join(root, "lock");
for (const path of [host, worker, brain, directory]) mkdirSync(path, { mode: 0o700 });
const access = ["odysseus-host-first", "odysseus-host-changed", "odysseus-host-refreshed"];
const refresh = "odysseus-host-refresh";
function save(token: string, expiresAt = Date.now() + 3_600_000) {
  writeFileSync(join(host, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: token, refreshToken: refresh, expiresAt, scopes: ["user:inference", "user:profile"],
    subscriptionType: "max", rateLimitTier: "default_claude_max_5x",
  } }), { mode: 0o600 });
}
save(access[0]!);
const requests: Array<{ credentialIndex: number; apiKey: string | null; model: string; priorMessages: number }> = [];
const authorities: string[] = [], stderr: string[] = [], nativeEnvironments: string[] = [];
const accounts: Array<AccountInfo | undefined> = [];
const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
const expectedExecutable = sdkRequire.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude");
let nativeBinaryMatches = true;
let refreshes = 0;
let holdRefresh = false, refreshCancelled = false;
let enteredRefresh!: () => void, endedRefresh!: () => void;
let closeRefresh: (() => void) | undefined;
const refreshEntered = new Promise<void>(resolve => { enteredRefresh = resolve; });
const refreshEnded = new Promise<void>(resolve => { endedRefresh = resolve; });
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const target = new URL(request.url);
  if (target.pathname === "/v1/oauth/token") {
    refreshes++;
    const body = await request.json() as { refresh_token?: string };
    if (body.refresh_token !== refresh) throw new Error("The fictional refresh token did not reach its authority.");
    if (holdRefresh) {
      enteredRefresh();
      await new Promise<void>(resolve => {
        const finish = () => { refreshCancelled = true; endedRefresh(); resolve(); };
        // A broken cancellation guard must yield a false result and release
        // its owned fixture, rather than leave a live request after failure.
        closeRefresh = resolve;
        request.signal.addEventListener("abort", finish, { once: true });
        if (request.signal.aborted) finish();
      });
      return new Response(null, { status: 499 });
    }
    return Response.json({ access_token: access[2], refresh_token: "odysseus-rotated-refresh", expires_in: 3600,
      scope: "user:inference user:profile" });
  }
  const body = await request.json() as { model: string; messages: unknown[] };
  requests.push({ credentialIndex: access.indexOf(request.headers.get("authorization")?.replace("Bearer ", "") ?? ""),
    apiKey: request.headers.get("x-api-key"), model: body.model, priorMessages: body.messages.length });
  return nativeModelReply();
} });
const originalFetch = globalThis.fetch;
// Only the host's lowest fetch method is replaced. The native CLI makes real
// HTTP requests over the real Unix socket. Both upstream exchanges reach a
// real loopback server; the surrounding private namespace denies external I/O.
globalThis.fetch = (async (input, init) => {
  const target = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  authorities.push(target.origin + target.pathname);
  if (!((target.origin === "https://api.anthropic.com" && target.pathname === "/v1/messages")
    || (target.origin === "https://platform.claude.com" && target.pathname === "/v1/oauth/token"))) {
    throw new Error("Unexpected host credential destination.");
  }
  const local = new URL(provider.url); local.pathname = target.pathname; local.search = target.search;
  return originalFetch(local, init);
}) as typeof fetch;
const egressRecords: EgressRecord[] = [];
const egress = await startEgressProxy({ mode: "allowlist", allow: ["api.anthropic.com"], deny: [], outwardHosts: [],
  maxBytes: 2 * 1024 * 1024, observe: record => egressRecords.push(record), approveOutward: async () => true });
const relay = startInferenceRelay({ egress, upstream: "https://api.anthropic.com", routes: ANTHROPIC_INFERENCE_ROUTES,
  credentials: async (signal, target) => ({ authorization: (await resolveClaudeHostOAuth(host, {}, { origin: target.origin }, signal, { directory })).authorization }) });
const env = { HOME: worker, CLAUDE_CONFIG_DIR: worker, PATH: "/usr/bin:/bin", LANG: "C.UTF-8",
  CLAUDE_CODE_OAUTH_TOKEN: INFERENCE_PLACEHOLDER, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "",
  ANTHROPIC_UNIX_SOCKET: relay.socketPath, ANTHROPIC_BASE_URL: "http://localhost",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
const children: ChildProcess[] = [];
function files(path: string): string {
  return readdirSync(path, { withFileTypes: true }).map(entry => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(child) : entry.isFile() ? readFileSync(child, "utf8") : "";
  }).join("\n");
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Native cancellation did not reach its owned boundary.")), 5000);
  })]); } finally { clearTimeout(timer); }
}
let session: string | undefined, hostAfterRefresh = false;
let cancellationRetainedHostBytes = false, cancellationReleasedLock = false;
try {
  for (let turn = 0; turn < 4; turn++) {
    if (turn === 1) save(access[1]!);
    if (turn === 2) save(access[1]!, 1);
    if (turn === 3) { save(access[1]!, 1); holdRefresh = true; }
    const before = readFileSync(join(host, ".credentials.json"));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let nativeChild: ChildProcess | undefined;
    const runtime = query({ prompt: (async function* () {
      await held;
      if (!abort.signal.aborted) yield { type: "user" as const, parent_tool_use_id: null, session_id: session ?? "", message: { role: "user" as const,
        content: turn ? "Continue the Ithaca plan." : "Plan the return to Ithaca." } };
    })(), options: { cwd: brain, env, model: turn === 1 ? "claude-sonnet-4-6" : "claude-haiku-4-5",
      ...(session ? { resume: session } : {}), settingSources: [], maxTurns: 1, abortController: abort,
      stderr: text => { stderr.push(text); },
      spawnClaudeCodeProcess(options) {
        const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env,
          stdio: ["pipe", "pipe", "pipe"], signal: options.signal });
        children.push(child); nativeChild = child;
        child.stderr.on("data", data => { stderr.push(String(data)); });
        return child;
      },
      settings: { env: { ANTHROPIC_UNIX_SOCKET: relay.socketPath, ANTHROPIC_BASE_URL: "http://localhost",
        CLAUDE_CODE_OAUTH_TOKEN: INFERENCE_PLACEHOLDER } },
    } });
    try {
      accounts.push((await runtime.initializationResult()).account);
      if (!nativeChild?.pid) throw new Error("The native CLI did not start.");
      nativeBinaryMatches &&= readlinkSync(`/proc/${nativeChild.pid}/exe`) === expectedExecutable;
      nativeEnvironments.push(readFileSync(`/proc/${nativeChild.pid}/environ`, "utf8"));
      release();
      if (turn === 3) {
        await bounded(refreshEntered);
        abort.abort(); runtime.close();
      }
      for await (const message of runtime) {
        if (message.type === "system" && message.subtype === "init") session = message.session_id;
        if (message.type === "result" && message.is_error) throw new Error("Native fictional inference failed.");
      }
    } catch (error) {
      if (turn !== 3 || !abort.signal.aborted) throw error;
    } finally { abort.abort(); release(); runtime.close(); clearTimeout(timer); }
    if (turn === 2) hostAfterRefresh = JSON.parse(readFileSync(join(host, ".credentials.json"), "utf8")).claudeAiOauth.accessToken === access[2];
    if (turn === 3) {
      if (nativeChild && nativeChild.exitCode === null && nativeChild.signalCode === null) {
        await bounded(new Promise<void>(resolve => nativeChild!.once("exit", () => resolve())));
      }
      try { await bounded(refreshEnded); }
      catch { closeRefresh?.(); } // The parent requires refreshCancelled=true.
      cancellationRetainedHostBytes = readFileSync(join(host, ".credentials.json")).equals(before);
      const lock = await acquireHostCredentialExclusion({ domain: { directory }, timeoutMs: 1000 });
      lock.release(); cancellationReleasedLock = true;
    }
  }
  const observed = JSON.stringify({ nativeEnvironments, accounts, stderr, files: files(worker) });
  console.log(JSON.stringify({ namespace: readlinkSync("/proc/self/ns/net"), sessionRetained: Boolean(session),
    requests, authorities, refreshes, accounts, nativeBinaryMatches, egressRecords, egressBytes: egress.usedBytes(), workerCredentialFile: existsSync(join(worker, ".credentials.json")),
    hostAfterRefresh, refreshCancelled, cancellationRetainedHostBytes, cancellationReleasedLock,
    secretsInNativeObservation: [...access, refresh, "odysseus-rotated-refresh"].some(secret => observed.includes(secret)),
    nativePlaceholder: nativeEnvironments.length === 4 && nativeEnvironments.every(value => value.includes(`CLAUDE_CODE_OAUTH_TOKEN=${INFERENCE_PLACEHOLDER}\0`)),
    stderr,
  }));
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once("exit", () => resolve()));
  }
  relay.stop(); egress.stop(); globalThis.fetch = originalFetch; provider.stop(true); rmSync(root, { recursive: true, force: true });
}
