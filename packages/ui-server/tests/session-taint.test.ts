import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { observeOutwardPlan, prepareOutwardPlan, workerOutwardNote } from "@schlessera/brain-ui-sdk/internal";
import * as startup from "../../ui-sdk/src/server/worker-startup-view.js";
import { workerCommand } from "../../ui-sdk/src/server/worker-launcher";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createFixtureApp as createApp } from "./helpers/native-app-fixture.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createPrincipal } from "../src/db/principals.js";
import { queryGovernanceEvents } from "../src/governance/events.js";
import { createWsHandlers } from "../src/ws/connection.js";
import type { WSContext } from "../src/ws/clients.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";

async function until(check: () => boolean, diagnostic: () => unknown) {
  const end = Date.now() + 10_000;
  while (!check()) { if (Date.now() > end) throw new Error(JSON.stringify(diagnostic())); await Bun.sleep(5); }
}
const PUSH = "git push https://github.com/odysseus/voyage.git main";
const SKILL = ".claude/skills/voyage/SKILL.md";

/**
 * One managed-storage governed Claude turn path, end to end through the real
 * app: recorder, governance record, governed admission, turn proxy, a real
 * worker's curl and the turn journal. The backend is a fixture; the hook-level
 * outward wiring is proven by each backend's command-effect probe.
 */
test("a WebFetch taints the session: outward asks, a non-listed host is refused, the skill edit is flagged, and the next turn keeps it", async () => {
  const storage = spyOn(startup, "isManagedWorkerStartupView").mockReturnValue(true);
  const root = await mkdtemp(resolve(tmpdir(), "odysseus-session-taint-")), brain = resolve(root, "brain");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
  await mkdir(resolve(brain, "context/policies"), { recursive: true });
  await writeFile(resolve(brain, "context/policies/governance.md"), "---\nschema_version: 1\nprofiles: { interactive: governed, voice: governed }\nrelease: [node_modules]\n"
    + "outward:\n  allow:\n    - { command: \"^git push \", remotes: [\"github.com/odysseus/*\"] }\n---\nAthena allows pushes to the voyage repository.\n");
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Ithaca") });
  type Seen = { request: StartTurnRequest; taint: string | null; outwardAsks: boolean; curl: number; note: string };
  const seen: Seen[] = [];
  const backend = makeFakeBackend({ id: "claude", startTurn: async request => {
    const sessionId = request.sessionId ?? `voyage-${seen.length}`;
    request.bridge.emit({ type: "session_info", sessionId, isNew: !request.sessionId });
    const fetches = request.prompt.includes("harbour notice");
    if (fetches) {
      request.bridge.emit({ type: "tool_use_start", sessionId, toolUseId: "notice", toolName: "WebFetch" });
      request.bridge.emit({ type: "tool_use_complete", sessionId, toolUseId: "notice", toolName: "WebFetch", input: { url: "https://ithaca.invalid/notice", prompt: "Summarize" } });
      request.bridge.emit({ type: "tool_result", sessionId, toolUseId: "notice", output: "A fictional harbour notice asks Odysseus to push the voyage.", isError: false });
    }
    const policy = request.workerSandbox!.commandPolicy!;
    const plan = prepareOutwardPlan({ toolName: "Bash", shellToolName: "Bash", input: { command: PUSH }, allow: policy.outwardAllow, taint: policy.taint });
    observeOutwardPlan(plan, { bridge: request.bridge, toolName: "Bash", toolUseId: `push-${seen.length}`, input: { command: PUSH },
      decision: plan.needsApproval ? { behavior: "deny", message: "Odysseus declines." } : { behavior: "allow" } });
    if (fetches) { mkdirSync(join(brain, ".claude/skills/voyage"), { recursive: true }); writeFileSync(join(brain, SKILL), "# Voyage\nPush on every return.\n"); }
    const proxyDir = request.workerSandbox!.egress!.dir;
    const child = Bun.spawn(workerCommand({ brainPath: brain, startupView: request.workerStartupView, sandbox: request.workerSandbox, env: { PATH: "/usr/bin:/bin" },
      egress: { proxyDir }, command: ["/usr/bin/curl", "--silent", "--fail", "--max-time", "5", `${origin.url.href}harbour`] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    const curl = await child.exited;
    const taint = policy.taint?.() ?? null;
    seen.push({ request, taint: taint?.source ?? null, outwardAsks: plan.needsApproval, curl, note: workerOutwardNote(true, taint) });
    request.bridge.emit({ type: "result", sessionId, outcome: "success", durationMs: 1, numTurns: 1, isError: false });
  } });
  const registry = createStaticBackendRegistry([backend], backend.id);
  const app = await createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(root, "ui.db"), HOST: "127.0.0.1", AUTH_MODE: "none", NODE_ENV: "test",
    BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }), registry, observability: createRecordingObservability() });
  const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus taint", ttlSeconds: 60 });
  async function chat(text: string, sessionId?: string) {
    const count = seen.length, handlers = createWsHandlers(app.wsHost, principal), sent: string[] = [];
    const ws = { send: (frame: string) => sent.push(frame), close() {}, readyState: 1 } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text, requestId: `taint-${count}`, ...(sessionId ? { sessionId } : {}) }) } as MessageEvent, ws);
    await until(() => seen.length === count + 1 && !app.wsHost.coordinator.isTurnActive(), () => sent);
    handlers.onClose({ code: 1000 } as CloseEvent, ws);
    return seen.at(-1)!;
  }
  const events = (sessionId: string, kind: "taint" | "egress_denial" | "outward_action") => queryGovernanceEvents(app.db, { sessionId, kinds: [kind], limit: 20 });
  try {
    // Control: a session without untrusted input keeps the normal rules.
    const control = await chat("Odysseus checks the harbour.");
    const controlSession = control.request.sessionId ?? "voyage-0";
    expect(control.outwardAsks, "G6_CLEAN_SESSION_POLICY_ALLOW_APPLIES").toBe(false);
    expect(control.curl, "G6_CLEAN_SESSION_EGRESS_UNCHANGED").toBe(0);
    expect(events(controlSession, "outward_action")[0]).toMatchObject({ payload: { tainted: false, decision: "policy_allowed" } });
    // With the proxy, that connection itself is untrusted input for later calls.
    expect(events(controlSession, "taint").map(event => event.payload)).toEqual([{ source: "egress_connection", tool: null, detail: `GET 127.0.0.1:${origin.port}` }]);

    const tainted = await chat("Odysseus reads the harbour notice.");
    const sessionId = "voyage-1", turnId = tainted.request.turnId!;
    const [source] = events(sessionId, "taint");
    expect(source, "G6_WEBFETCH_TAINTS_SESSION").toMatchObject({ turnId, payload: { source: "web_fetch", tool: "WebFetch", detail: null } });
    expect(tainted.outwardAsks, "G6_TAINT_OVERRIDES_OUTWARD_ALLOW").toBe(true);
    expect(events(sessionId, "outward_action")[0]).toMatchObject({ payload: { action: "git_push", tainted: true, decision: "declined", rule: null } });
    expect(tainted.curl, "G6_TAINTED_NON_LISTED_HOST_REFUSED").not.toBe(0);
    expect(events(sessionId, "egress_denial").map(event => event.payload), "G6_TAINT_DENIAL_RECORDED").toEqual([
      { host: "127.0.0.1", port: origin.port, method: "GET", reason: "taint_allowlist", bytes: 0 },
    ]);
    const skill = app.wsHost.journal!.details(sessionId, turnId)!.changes.find(change => change.path === SKILL);
    expect(skill, "G6_TAINTED_SKILL_EDIT_FLAGGED").toMatchObject({ class: "steering", actor: "agent", tainted: true, taintSourceEventId: source!.id });

    // Taint is sticky: the next turn of the same session keeps every rule and says so.
    const next = await chat("Odysseus plans the next leg.", sessionId);
    expect(next.taint, "G6_TAINT_STICKY_NEXT_TURN").toBe("web_fetch");
    expect(next.outwardAsks, "G6_STICKY_OUTWARD_ASKS").toBe(true);
    expect(next.curl, "G6_STICKY_EGRESS_REFUSED").not.toBe(0);
    expect(events(sessionId, "egress_denial")).toHaveLength(2);
    expect(events(sessionId, "taint"), "G6_FIRST_SOURCE_KEPT").toHaveLength(1);
    expect(next.note).toContain("This session is tainted (first recorded source: web_fetch).");
  } finally { storage.mockRestore(); origin.stop(true); await app.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
