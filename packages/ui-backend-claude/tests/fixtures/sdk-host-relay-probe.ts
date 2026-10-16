/** Actual ordinary Claude spawn/state path; copied storage fixture, not Btrfs qualification. */
import { query, type AccountInfo } from "@anthropic-ai/claude-agent-sdk";
import { startInferenceRelay, ANTHROPIC_INFERENCE_ROUTES, INFERENCE_PLACEHOLDER, acquireHostCredentialExclusion, startEgressProxy, type EgressRecord } from "@schlessera/brain-ui-sdk/internal";
import { resolveClaudeHostOAuth } from "../../src/host-oauth.js";
import { nativeModelReply } from "../helpers/native-model-reply.js";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createTurnLockBinding } from "../../src/turn-lock.js";
import { createClaudeSdkTurn } from "../../src/sdk-options.js";
import { settingsRefusal, subscriptionVerdict, type CliSettingsReport } from "../../src/subscription.js";
import { processStateLedger } from "../../src/worker-state-budget.js";
import { createFixtureWorkerStartupView } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import type { LaunchedWorker, WorkerSandbox } from "@schlessera/brain-ui-sdk/internal";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync, linkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const profile = process.argv[2] === "strict" ? "strict" : "governed";
const ledger = processStateLedger();
let observedLedgerHeld = 0;
const inspectProof = process.argv[3] === "inspect";
const permissionProof = process.argv[3] === "permission";
const settingsProof = process.argv[3] === "managed" || process.argv[3] === "project";
let withheldForSettings = false;
let permissionRequests = 0;
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
if (process.argv[3] === "managed") {
  mkdirSync("/etc/claude-code", { recursive: true });
  writeFileSync("/etc/claude-code/managed-settings.json", JSON.stringify({ env: { ANTHROPIC_UNIX_SOCKET: "/run/odysseus-unapproved.sock" } }));
}
if (process.argv[3] === "project") {
  mkdirSync(join(brain, ".claude"));
  writeFileSync(join(brain, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "odysseus-project-api-key" } }));
}
const requests: Array<{ credentialIndex: number; apiKey: string | null; model: string; priorMessages: number; toolNames: string[]; contextPreparedProxy: boolean; systemPresent: boolean }> = [];
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
  const body = await request.json() as { model: string; messages: unknown[]; tools?: Array<{ name: string }>; system?: unknown };
  requests.push({ credentialIndex: access.indexOf(request.headers.get("authorization")?.replace("Bearer ", "") ?? ""),
    apiKey: request.headers.get("x-api-key"), model: body.model, priorMessages: body.messages.length,
    toolNames: (body.tools ?? []).map(tool => tool.name),
    contextPreparedProxy: JSON.stringify(body.messages).includes("host-prepared egress proxy"),
    systemPresent: Array.isArray(body.system) && body.system.length > 0,
  });
  return nativeModelReply(permissionProof && requests.length === 1 ? {
    name: "Bash", id: "tool_ithaca_denied", input: { command: `printf odysseus > ${join(brain, "should-not-exist")}` },
  } : undefined);
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
linkSync(relay.socketPath, join(egress.dir, "inference.sock"));
const env = { HOME: worker, CLAUDE_CONFIG_DIR: host, PATH: "/usr/bin:/bin", LANG: "C.UTF-8",
  CLAUDE_CODE_OAUTH_TOKEN: "odysseus-inherited-host-oauth", ANTHROPIC_API_KEY: "odysseus-inherited-api-key", ANTHROPIC_AUTH_TOKEN: "odysseus-inherited-auth-token",
  ANTHROPIC_UNIX_SOCKET: "/run/brain-egress/inference.sock", ANTHROPIC_BASE_URL: "http://localhost",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
const workers: LaunchedWorker[] = [];
const spawners: Array<{ finish(): Promise<void> }> = [];
let workerCredentialFile = false;
function nativePid(root: number): number {
  const pending = [root];
  for (let count = 0; pending.length && count < 100; count++) {
    const pid = pending.shift()!;
    try { if (readlinkSync(`/proc/${pid}/exe`) === expectedExecutable) return pid; } catch { /* An exited wrapper is not a native process. */ }
    try { pending.push(...readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number)); } catch { /* An exited process has no children. */ }
  }
  throw new Error("The ordinary worker did not contain the selected native executable.");
}
function files(path: string): string {
  if (!existsSync(path)) return "";
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
  for (let turn = 0; turn < (inspectProof || permissionProof || settingsProof ? 1 : 4); turn++) {
    if (turn === 1) save(access[1]!);
    if (turn === 2) save(access[1]!, 1);
    if (turn === 3) { save(access[1]!, 1); holdRefresh = true; }
    const before = readFileSync(join(host, ".credentials.json"));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let live: LaunchedWorker | undefined;
    const startupView = profile === "strict" ? createFixtureWorkerStartupView(brain) : undefined;
    const sandbox: WorkerSandbox = { brain, restricted: false, profile, areas: [], scratchAliasesRemoved: [],
      ...(profile === "governed" ? { protection: { paths: [], ancestors: [] } } : {}) };
    const turnLock = createTurnLockBinding({ turn: { pendingReleases: new Map(), ended: false },
      writeLock: createKeyedLock(), lockWaitMs: 1000, log() {}, admission: { signal: abort.signal } });
    const sdkTurn = createClaudeSdkTurn({
      backend: { brainPath: brain },
      req: { prompt: turn ? "Continue the Ithaca plan." : "Plan the return to Ithaca.",
        signal: abort.signal, sessionId: session, workerSandbox: sandbox, workerStartupView: startupView,
        bridge: { emit() {}, requestPermission: async () => {
          permissionRequests++;
          return { behavior: "deny" as const, message: "The fictional user refused this command." };
        } },
        workerStarted: started => {
          live = started as LaunchedWorker; workers.push(live);
          observedLedgerHeld = Math.max(observedLedgerHeld, ledger.held);
          workerCredentialFile ||= existsSync(join(live.state!.root, ".credentials.json"));
        },
      },
      hostInference: { proxyDir: egress.dir }, turnEnvironment: env,
      profile: { id: "claude", label: "Claude", billing: "subscription", requiredEnvKeys: [], buildEnv: () => ({}),
        model: turn === 1 ? "claude-sonnet-4-6" : "claude-haiku-4-5" },
      abortController: abort, allowedTools: permissionProof ? ["Bash"] : [], confirmPatterns: permissionProof ? [/^printf /] : [],
      turnLock, log() {},
    });
    const spawner = { finish: () => sdkTurn.finishWorker() }; spawners.push(spawner);
    const runtime = query({ prompt: (async function* () {
      await held;
      if (abort.signal.aborted) return;
      if (typeof sdkTurn.prompt === "string") yield { type: "user" as const, parent_tool_use_id: null, session_id: session ?? "", message: { role: "user" as const, content: sdkTurn.prompt } };
      else yield* sdkTurn.prompt;
    })(), options: { ...sdkTurn.options, maxTurns: permissionProof ? 2 : 1, stderr: text => { stderr.push(text); } } });
    try {
      const account = (await runtime.initializationResult()).account;
      accounts.push(account);
      const settings = await (runtime as unknown as { getSettings(): Promise<CliSettingsReport> }).getSettings();
      if (!subscriptionVerdict(account).ok || settingsRefusal(settings, sdkTurn.pinnedSettingsEnv)) {
        if (!settingsProof) throw new Error("Prepared SDK subscription handshake refused.");
        withheldForSettings = true;
        abort.abort(); runtime.close();
      }
      if (withheldForSettings) continue;
      if (!live) throw new Error("The ordinary native worker did not start.");
      const pid = nativePid(live.pid);
      nativeBinaryMatches &&= readlinkSync(`/proc/${pid}/exe`) === expectedExecutable;
      nativeEnvironments.push(readFileSync(`/proc/${pid}/environ`, "utf8"));
      if (inspectProof) continue;
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
    } finally {
      abort.abort(); release(); runtime.close(); clearTimeout(timer);
      try { await spawner.finish(); } finally { turnLock.close(); await startupView?.cleanup(); }
    }
    if (turn === 2) hostAfterRefresh = JSON.parse(readFileSync(join(host, ".credentials.json"), "utf8")).claudeAiOauth.accessToken === access[2];
    if (turn === 3) {
      try { await bounded(refreshEnded); }
      catch { closeRefresh?.(); } // The parent requires refreshCancelled=true.
      cancellationRetainedHostBytes = readFileSync(join(host, ".credentials.json")).equals(before);
      const lock = await acquireHostCredentialExclusion({ domain: { directory }, timeoutMs: 1000 });
      lock.release(); cancellationReleasedLock = true;
    }
  }
  const observed = JSON.stringify({ nativeEnvironments, accounts, stderr, files: files(join(host, "projects")) });
  console.log(JSON.stringify({ namespace: readlinkSync("/proc/self/ns/net"), sessionRetained: Boolean(session),
    profile, withheldForSettings, permissionRequests, deniedFileExists: existsSync(join(brain, "should-not-exist")), ledgerHeld: ledger.held, observedLedgerHeld, requests, authorities, refreshes, accounts, nativeBinaryMatches, egressRecords, egressBytes: egress.usedBytes(), workerCredentialFile,
    hostAfterRefresh, refreshCancelled, cancellationRetainedHostBytes, cancellationReleasedLock,
    secretsInNativeObservation: [...access, refresh, "odysseus-rotated-refresh", "odysseus-inherited-host-oauth", "odysseus-inherited-api-key", "odysseus-inherited-auth-token"].some(secret => observed.includes(secret)),
    nativePlaceholder: nativeEnvironments.length === 4 && nativeEnvironments.every(value => value.includes(`CLAUDE_CODE_OAUTH_TOKEN=${INFERENCE_PLACEHOLDER}\0`)),
    stderr,
  }));
} finally {
  for (const worker of workers) worker.kill("SIGKILL");
  await Promise.allSettled(spawners.map(spawner => spawner.finish()));
  relay.stop(); egress.stop(); globalThis.fetch = originalFetch; provider.stop(true); rmSync(root, { recursive: true, force: true });
}
