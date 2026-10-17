/** Real turn runner and an explicitly prepared transport; no live provider calls. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const home = join(root, "home"), config = join(home, ".claude");
for (const path of [...(managed ? [] : [brainPath]), home, config]) mkdirSync(path, { mode: 0o700 });
const tokens = ["odysseus-first", "odysseus-changed", "odysseus-refreshed"];
function save(index: number, expired = false) {
  writeFileSync(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: tokens[index], refreshToken: "odysseus-refresh", expiresAt: expired ? 1 : Date.now() + 3600000,
    scopes: ["user:inference", "user:profile"], subscriptionType: "max", rateLimitTier: "default_claude_max_5x",
  } }), { mode: 0o600 });
}
save(0);
const mode = process.argv.find(arg => ["three", "project-aba", "project-custom", "managed-aba", "managed-custom", "recorder-failure", "cleanup-failure"].includes(arg)) ?? "three";
if (mode === "managed-custom") {
  mkdirSync("/etc/claude-code");
  writeFileSync("/etc/claude-code/managed-settings.json", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ithaca.invalid" } }));
}
if (mode === "project-custom") {
  mkdirSync(join(brainPath, ".claude"));
  writeFileSync(join(brainPath, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ithaca.invalid" } }));
}

const requests: Array<{ credential: number; model: string; history: number }> = [];
let refreshes = 0;
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (new URL(request.url).pathname === "/v1/oauth/token") {
    refreshes++; return Response.json({ access_token: tokens[2], refresh_token: "odysseus-rotated", expires_in: 3600,
      scope: "user:inference user:profile" });
  }
  const body = await request.json() as { model: string; messages: unknown[] };
  requests.push({ credential: tokens.indexOf(request.headers.get("authorization")?.replace("Bearer ", "") ?? ""), model: body.model, history: body.messages.length });
  return nativeModelReply();
} });
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const target = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (!((target.origin === "https://api.anthropic.com" && target.pathname === "/v1/messages")
    || (target.origin === "https://platform.claude.com" && target.pathname === "/v1/oauth/token"))) throw Error("UNEXPECTED_HOST_INFERENCE_AUTHORITY");
  const local = new URL(provider.url); local.pathname = target.pathname; return nativeFetch(local, init);
}) as typeof fetch;
const db = new Database(join(root, "observations.db"));
// Fixture-owned persistence, not a new server observations event contract.
db.exec("CREATE TABLE observations (session_id TEXT, model TEXT, record TEXT)");
const frames: ServerMessage[] = [];
const environment = { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: "/usr/bin:/bin", LANG: "C.UTF-8",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
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
} }, resolveProfiles: () => [{ id: "claude", label: "Claude",
  billing: "subscription", requiredEnvKeys: [], model, buildEnv: () => environment }],
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
        workerSandbox: { brain: brainPath, restricted: false, profile: managed ? "strict" : "governed", areas: [], scratchAliasesRemoved: [], protection: { paths: [], ancestors: [] }, egress: proxy },
        workerStarted: worker => { const state = worker as { state?: { root: string } };
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
  console.log(JSON.stringify({ requests, refreshes, sessionId, projectedCredentials, recordingFailure, cleanupFailures, releaseFailures,
    results: frames.filter(frame => frame.type === "result" || frame.type === "error"),
    observations: (db.query("SELECT session_id, model, record FROM observations").all() as Array<{ session_id: string; model: string; record: string }>).map(row => ({ sessionId: row.session_id, model: row.model, payload: JSON.parse(row.record) })),
  }));
} finally { globalThis.fetch = nativeFetch; provider.stop(true); db.close(); rmSync(root, { recursive: true, force: true }); }
