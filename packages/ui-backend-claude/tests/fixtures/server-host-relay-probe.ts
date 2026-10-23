/** Real turn runner and an explicitly prepared transport; no live provider calls. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { createKeyedLock, type ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createClaudeTurnRunner } from "../../src/turn-runner.js";
import { nativeModelReply } from "../helpers/native-model-reply.js";
import { startEgressProxy, prepareNativeWorkerStartupView } from "@schlessera/brain-ui-sdk/internal";
import { createNativeBrainManagerClient } from "../../../ui-sdk/src/server/native-brain-manager-client.js";
import { Database } from "bun:sqlite";


const root = mkdtempSync(join(tmpdir(), "odysseus-server-inference-"));
const managed = process.argv.includes("--managed");
const brainPath = managed ? "/brain-fixture/brain" : join(root, "brain");
// outside-masks: the host's Claude config sits where no host mask hides it (the caller mounts /opt).
const home = process.argv.includes("outside-masks") ? "/opt/odysseus-home" : join(root, "home"), config = join(home, ".claude");
for (const path of [...(managed ? [] : [brainPath]), home, config]) mkdirSync(path, { mode: 0o700 });
// A readable control beside the masked login: the worker view must observe this one.
writeFileSync(join(config, "visible.json"), "{}");
const tokens = ["odysseus-first", "odysseus-changed", "odysseus-refreshed"];
function save(index: number, expired = false) {
  writeFileSync(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: tokens[index], refreshToken: "odysseus-refresh", expiresAt: expired ? 1 : Date.now() + 3600000,
    scopes: ["user:inference", "user:profile"], subscriptionType: "max", rateLimitTier: "default_claude_max_5x",
  } }), { mode: 0o600 });
}
save(0);
// The config directory stays outside the brain, but its login file is linked into it.
if (process.argv.includes("login-in-brain")) {
  renameSync(join(config, ".credentials.json"), join(brainPath, ".odysseus-login.json"));
  symlinkSync(join(brainPath, ".odysseus-login.json"), join(config, ".credentials.json"));
}
const mode = process.argv.find(arg => ["three", "project-aba", "project-custom", "managed-aba", "managed-custom", "recorder-failure", "cleanup-failure",
  "server-custom-unlisted", "server-custom-listed", "server-custom-other-port", "server-custom-project-same", "server-custom-project-other",
  "api-key", "api-token", "api-key-project-custom", "api-key-project-credential", "outside-masks", "login-in-brain",
  "recipient-admitted", "recipient-other"].includes(arg)) ?? "three";
// Provider folders admitted for a recipient at one origin (#2695): the relay may reach only that origin.
const inferenceRecipient = mode === "recipient-admitted" ? { name: "anthropic", origin: "https://api.anthropic.com" }
  : mode === "recipient-other" ? { name: "anthropic", origin: "https://gateway.ithaca.invalid" } : undefined;
// An API-billed profile: its key is read from the host environment by name.
const apiBilled = mode.startsWith("api-");
const apiSecret = "odysseus-api-secret-for-ithaca", hostLogin = "odysseus-ambient-host-login";
const ambientBearer = "odysseus-ambient-bearer", ambientRouter = "odysseus-ambient-router-key";
// Keys only the brain CLI's own providers read (#1666).
const cliGemini = "odysseus-ambient-cli-gemini-key", cliTypesafe = "odysseus-ambient-cli-typesafe-key";
// Ambient credentials the profile does not declare: none may reach the worker or the profile's route.
if (apiBilled) Object.assign(process.env, { ODYSSEUS_ANTHROPIC_KEY: apiSecret, CLAUDE_CODE_OAUTH_TOKEN: hostLogin,
  OPENROUTER_API_KEY: ambientRouter, GEMINI_API_KEY: cliGemini, TYPESAFE_API_KEY: cliTypesafe,
  ...(mode === "api-token" ? {} : { ANTHROPIC_AUTH_TOKEN: ambientBearer }) });
// The server's own route: a custom gateway with a base path, selected by trusted host configuration.
const gateway = mode.startsWith("server-custom-") ? "https://gateway.ithaca.invalid/anthropic" : undefined;
if (["server-custom-listed", "server-custom-project-same", "server-custom-project-other"].includes(mode)) process.env.BRAIN_UI_CLAUDE_OAUTH_ORIGINS = "https://other.ithaca.invalid, https://gateway.ithaca.invalid";
// Project settings may repeat the server's route in another spelling, never move it.
if (mode === "server-custom-project-same" || mode === "server-custom-project-other") {
  mkdirSync(join(brainPath, ".claude"));
  writeFileSync(join(brainPath, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL:
    mode === "server-custom-project-same" ? "https://GATEWAY.ithaca.invalid:443/anthropic/" : "https://gateway.ithaca.invalid/other-tenant" } }));
}
if (mode === "server-custom-other-port") process.env.BRAIN_UI_CLAUDE_OAUTH_ORIGINS = "https://gateway.ithaca.invalid:8443";
if (mode === "managed-custom") {
  mkdirSync("/etc/claude-code");
  writeFileSync("/etc/claude-code/managed-settings.json", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ithaca.invalid" } }));
}
if (mode === "api-key-project-credential") {
  mkdirSync(join(brainPath, ".claude"));
  writeFileSync(join(brainPath, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "odysseus-project-key" } }));
}
if (mode === "project-custom" || mode === "api-key-project-custom") {
  mkdirSync(join(brainPath, ".claude"));
  writeFileSync(join(brainPath, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ithaca.invalid" } }));
}

const requests: Array<{ credential: number; model: string; history: number }> = [];
const apiRequests: Array<{ apiKey: string | null; authorization: string | null }> = [];
const nativeEnvironments: string[] = [];
let liveWorker: { pid: number; state?: { root: string } } | undefined;
let stateFiles = "";
/** Whether a process in the worker's own mount namespace could open the host login file. */
let hostLoginVisible: boolean | null = null, controlVisible = false;
function workerViewOfHostLogin(): void {
  const pending = [liveWorker?.pid ?? 0];
  hostLoginVisible ??= false;
  for (let count = 0; pending.length && count < 100; count++) {
    const pid = pending.shift()!;
    try {
      if (readlinkSync(`/proc/${pid}/ns/mnt`) !== readlinkSync("/proc/self/ns/mnt")) {
        try { readFileSync(`/proc/${pid}/root${config}/.credentials.json`); hostLoginVisible = true; } catch { /* masked */ }
        try { readFileSync(`/proc/${pid}/root${config}/visible.json`); controlVisible = true; } catch { /* not this process */ }
      }
    } catch { /* exited */ }
    try { pending.push(...readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number)); } catch { /* No children. */ }
  }
}
function nativeEnvironment(): void {
  const pending = [liveWorker?.pid ?? 0];
  for (let count = 0; pending.length && count < 100; count++) {
    const pid = pending.shift()!;
    try { if (readlinkSync(`/proc/${pid}/exe`).endsWith("/claude")) { nativeEnvironments.push(readFileSync(`/proc/${pid}/environ`, "utf8")); return; } } catch { /* An exited wrapper is not the native process. */ }
    try { pending.push(...readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number)); } catch { /* No children. */ }
  }
}
function files(path: string): string {
  try {
    return readdirSync(path, { withFileTypes: true }).map(entry => entry.isDirectory() ? files(join(path, entry.name))
      : entry.isFile() ? readFileSync(join(path, entry.name), "utf8") : "").join("\n");
  } catch { return ""; }
}
let refreshes = 0;
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (new URL(request.url).pathname === "/v1/oauth/token") {
    refreshes++; return Response.json({ access_token: tokens[2], refresh_token: "odysseus-rotated", expires_in: 3600,
      scope: "user:inference user:profile" });
  }
  const body = await request.json() as { model: string; messages: unknown[] };
  if (mode === "outside-masks") workerViewOfHostLogin();
  if (apiBilled) {
    nativeEnvironment(); if (liveWorker?.state) stateFiles += files(liveWorker.state.root);
    apiRequests.push({ apiKey: request.headers.get("x-api-key"), authorization: request.headers.get("authorization") });
  }
  requests.push({ credential: tokens.indexOf(request.headers.get("authorization")?.replace("Bearer ", "") ?? ""), model: body.model, history: body.messages.length });
  return nativeModelReply();
} });
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const target = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (!((target.origin === "https://api.anthropic.com" && target.pathname === "/v1/messages")
    || (gateway && target.href.startsWith(`${gateway}/v1/messages`))
    || (target.origin === "https://platform.claude.com" && target.pathname === "/v1/oauth/token"))) throw Error("UNEXPECTED_HOST_INFERENCE_AUTHORITY");
  const local = new URL(provider.url); local.pathname = target.pathname; return nativeFetch(local, init);
}) as typeof fetch;
const db = new Database(join(root, "observations.db"));
// Fixture-owned persistence, not a new server observations event contract.
db.exec("CREATE TABLE observations (session_id TEXT, model TEXT, record TEXT)");
const frames: ServerMessage[] = [];
const environment = { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: "/usr/bin:/bin", LANG: "C.UTF-8",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", ...(gateway ? { ANTHROPIC_BASE_URL: gateway } : {}) };
let model = "claude-haiku-4-5";
let activeView: Awaited<ReturnType<typeof prepareNativeWorkerStartupView>> | undefined;
let releaseFailures = 0;
const cleanupFailures: string[] = [];
const actualManager = managed ? createNativeBrainManagerClient({ socketPath: mode === "cleanup-failure" ? "/native-runtime/prepared-consumer-cleanup-manager.sock" : "/native-runtime/prepared-consumer-manager.sock" }) : undefined;
const manager = actualManager ? { ...actualManager, async release(...args: Parameters<typeof actualManager.release>) {
  const result = await actualManager.release(...args);
  if (mode === "cleanup-failure" && releaseFailures++ === 0) throw Error("ODYSSEUS_NATIVE_RELEASE_REPLY_UNAVAILABLE");
  return result;
} } : undefined;
const runner = createClaudeTurnRunner({ backend: { brainPath, queryFn: input => {
  const native = query(input);
  if (mode === "project-aba" || mode === "managed-aba" || mode === "cleanup-failure") {
    const control = native as typeof native & { getSettings(): Promise<unknown> };
    const getSettings = control.getSettings.bind(control);
    control.getSettings = async () => {
      const report = await getSettings();
      if (mode === "cleanup-failure") { await activeView?.cleanup(); return report; }
      const directory = mode === "managed-aba" ? "/etc/claude-code" : join(brainPath, ".claude");
      mkdirSync(directory);
      writeFileSync(join(directory, mode === "managed-aba" ? "managed-settings.json" : "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ithaca.invalid" } }));
      rmSync(directory, { recursive: true });
      return report;
    };
  }
  return native;
} }, resolveProfiles: () => [apiBilled ? { id: "claude", label: "Claude", billing: "api" as const, requiredEnvKeys: ["ODYSSEUS_ANTHROPIC_KEY"], model,
  buildEnv: () => ({ ...environment, ...(mode === "api-token" ? { ANTHROPIC_AUTH_TOKEN: apiSecret, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" } : { ANTHROPIC_API_KEY: apiSecret }) }) }
  : { id: "claude", label: "Claude", billing: "subscription" as const, requiredEnvKeys: [], model, buildEnv: () => environment }],
  confirmPatterns: [], writeLock: createKeyedLock(), lockWaitMs: 1000, log(_level, message, attrs) { if (message === "host inference checkpoint") console.error(JSON.stringify(attrs)); },
});
let sessionId: string | undefined;
let projectedCredentials: boolean | null = managed ? null : false;
let recordingFailure = false;
try {
  for (let turn = 0; turn < (mode === "three" ? 3 : mode === "cleanup-failure" ? 2 : 1); turn++) {
    if (turn === 1) { save(1); model = "claude-sonnet-4-6"; }
    if (turn === 2) { save(1, true); model = "claude-haiku-4-5"; }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    const turnId = `turn-ithaca-${turn}`;
    const tracked = new Set<EventListenerOrEventListenerObject>();
    const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: any) => { if (type === "abort") tracked.add(listener); return add(type, listener, options); }) as typeof controller.signal.addEventListener;
    controller.signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: any) => { if (type === "abort") tracked.delete(listener); return remove(type, listener, options); }) as typeof controller.signal.removeEventListener;
    const bridge = { emit(frame: ServerMessage) { frames.push(frame); if (frame.type === "session_info") {
      sessionId = frame.sessionId;

    } },
      async requestPermission() { return { behavior: "deny" as const, message: "No outward grants in this fixture." }; } };
    const proxy = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: Number.MAX_SAFE_INTEGER,
      signal: controller.signal, observe(record) {
        try {
          if (mode === "recorder-failure") throw Error("FICTIONAL_RECORDER_UNAVAILABLE");
          db.query("INSERT INTO observations VALUES (?, ?, ?)").run(sessionId ?? null, model, JSON.stringify(record));
        } catch { recordingFailure = true; controller.abort(Error("Fixture observation persistence unavailable")); }
      },
    });
    const view = activeView = manager ? await prepareNativeWorkerStartupView(brainPath, manager) : undefined;
    const beforeRunnerListeners = new Set(tracked);
    const relayDirectories = readdirSync(tmpdir()).filter(name => name.startsWith("brain-inference-"));
    try {
      await runner.startTurn({ prompt: turn ? "Continue the Ithaca plan." : "Plan the return to Ithaca.",
        sessionId, profileId: "claude", signal: controller.signal, bridge,
        ...(view ? { workerStartupView: view } : {}),
        workerSandbox: { brain: brainPath, restricted: false, profile: managed ? "strict" : "governed", areas: [], scratchAliasesRemoved: [], protection: { paths: [], ancestors: [] }, egress: proxy,
          ...(inferenceRecipient ? { inferenceRecipient } : {}) },
        workerStarted: worker => { const state = worker as unknown as { pid: number; state?: { root: string } }; liveWorker = state;
          if (state.state && !managed) { try { readFileSync(join(state.state.root, ".credentials.json")); projectedCredentials = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
        },
      });
    } catch (error) {
      if (mode !== "cleanup-failure" || turn !== 0) throw error;
      cleanupFailures.push(String(error));
      expect(String(error), "ACTUAL_NATIVE_RELEASE_FAILURE_PROPAGATED").toContain("Claude turn cleanup did not complete");
    } finally {
      if (mode === "cleanup-failure") {
        expect(existsSync(join(proxy.dir, "inference.sock")), "NATIVE_RELEASE_FAILURE_RELAY_LINK_REMOVED").toBe(false);
        expect(readdirSync(tmpdir()).filter(name => name.startsWith("brain-inference-")), "NATIVE_RELEASE_FAILURE_RELAY_DIRECTORY_REMOVED").toEqual(relayDirectories);
        expect([...tracked], "NATIVE_RELEASE_FAILURE_HOST_LISTENER_REMOVED").toEqual([...beforeRunnerListeners]);
      }
      clearTimeout(timer); controller.abort(); proxy.stop(); await view?.cleanup();
    }
  }
  const observed = JSON.stringify({ nativeEnvironments, stateFiles });
  console.log(JSON.stringify({ requests, refreshes, apiRequests, nativeEnvironmentCount: nativeEnvironments.length, hostLoginVisible, controlVisible,
    secretInWorker: [apiSecret, hostLogin, ambientBearer, ambientRouter, cliGemini, cliTypesafe].some(secret => observed.includes(secret)),
    withheldKeys: nativeEnvironments.map(value => /(?:^|\0)BRAIN_WITHHELD_KEYS=([^\0]*)/.exec(value)?.[1] ?? null),
    workerPlaceholders: nativeEnvironments.map(value => ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ODYSSEUS_ANTHROPIC_KEY"]
      .map(name => new RegExp(`(?:^|\0)${name}=([^\0]*)`).exec(value)?.[1] ?? null)), sessionId, projectedCredentials, recordingFailure, cleanupFailures, releaseFailures,
    results: frames.filter(frame => frame.type === "result" || frame.type === "error"),
    observations: (db.query("SELECT session_id, model, record FROM observations").all() as Array<{ session_id: string; model: string; record: string }>).map(row => ({ sessionId: row.session_id, model: row.model, payload: JSON.parse(row.record) })),
  }));
} finally { globalThis.fetch = nativeFetch; provider.stop(true); db.close(); rmSync(root, { recursive: true, force: true }); }
