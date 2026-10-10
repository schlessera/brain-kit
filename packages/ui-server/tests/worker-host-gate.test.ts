import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { workerHostBoundary } from "@schlessera/brain-ui-sdk/internal";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { createActivityStore } from "../src/activity/store";
import { createInboxBudget } from "../src/inbox/budget";
import { createInboxStore } from "../src/inbox/store";
import { runAutonomousTurn } from "../src/inbox/autonomous-turn";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { runSession } from "../src/ws/run-session";
import { prepareHandoff } from "../src/ws/handoff";
import { WsHost } from "../src/ws/host";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";
import type { ConnectionState } from "../src/ws/dispatch";

let probe: ReturnType<typeof spyOn> | undefined;
afterEach(() => { probe?.mockRestore(); probe = undefined; });
function unsupported() {
  probe = spyOn(workerHostBoundary, "probe").mockReturnValue({ ok: false, requirement: "unprivileged user namespaces are disabled" });
}

function setup() {
  const db = createUiDb(":memory:");
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const authorization = testAuthorization(principal.id);
  const store = createActivityStore(db, { writer: "worker-host-test" });
  let starts = 0;
  const backend = makeFakeBackend({ id: "claude", capabilities: { autonomous: true },
    histories: { source: [{ role: "user", content: "Odysseus fixture", toolCalls: [] }] }, startTurn: async request => {
    starts++;
    request.bridge.emit({ type: "session_info", sessionId: "should-never-exist", isNew: true });
  } });
  const catalog = createSessionCatalog(() => db);
  const frames: ServerMessage[] = [];
  const ws = { send: (data: string) => { frames.push(JSON.parse(data)); } };
  const host = new WsHost({ brainPath: process.cwd(), registry: createStaticBackendRegistry([backend], backend.id), catalog,
    activity: { store, stream: { pump() {} } as never } });
  host.clients.add(ws, principal.id);
  return { db, principal, authorization, store, backend, catalog, frames, ws, host, starts: () => starts,
    cleanup: () => { host.close(); db.close(); } };
}
function noRuntime(f: ReturnType<typeof setup>) {
  expect(f.starts()).toBe(0);
  expect(f.db.query("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  expect(f.db.query("SELECT count(*) AS n FROM activity_spans").get()).toEqual({ n: 0 });
}
function missingRequirement(message: string) {
  expect(message).toContain("unprivileged user namespaces are disabled");
  expect(message).toContain("Linux or qualifying WSL2");
  expect(message).toContain("bubblewrap");
}

describe("pre-initialization worker host gate", () => {
  test.each(["interactive", "voice"] as const)("%s refuses before startTurn, session, transcript or runtime creation", async posture => {
    const f = setup(); unsupported();
    const sources = spyOn(f.catalog, "recordMessageSource");
    const transcript = spyOn(f.backend, "getHistory");
    try {
      await runSession(f.host, { authorization: f.authorization, text: "Odysseus fixture", attachments: [],
        ...(posture === "voice" ? { source: "voice" as const, work: { posture: "voice", started() {}, settle() {} } as never } : {}) });
      noRuntime(f);
      expect(sources).not.toHaveBeenCalled(); expect(transcript).not.toHaveBeenCalled();
      const error = f.frames.find(frame => frame.type === "error");
      expect(error).toMatchObject({ type: "error", code: "BACKEND_REQUEST_ERROR", failure: { errorClass: "worker_host_unsupported" } });
      missingRequirement((error as Extract<ServerMessage, { type: "error" }>).message);
      expect(f.host.coordinator.running.size).toBe(0);
    } finally { sources.mockRestore(); transcript.mockRestore(); f.cleanup(); }
  });

  test("autonomous refuses before ownership, activity or backend initialization", async () => {
    const f = setup(); unsupported();
    try {
      // Settle the existing budget prerequisite so this cannot pass for the
      // wrong reason if the host gate is removed.
      const now = Date.now();
      createInboxStore(f.db).ingest({ threadId: "odysseus", itemId: "odysseus", dedupKey: "odysseus", stagingId: "odysseus",
        source: "share", stakes: 2, expiresAt: now + 86_400_000 });
      const budget = createInboxBudget(f.db, { config: { spendUsd: 5, turns: 100, emergencySpendUsd: 0, emergencyTurns: 0,
        timeZone: "UTC", unpricedUsdPerToken: 0.01 }, pricing: { resolve: () => ({ input: 0.003, output: 0.003,
          cacheRead: 0.003, cacheWrite: 0.003, estimate: false, source: "snapshot" }) } });
      budget.claim("odysseus", { runId: "host-refusal", principalId: f.principal.id, model: "fixture",
        billingMode: "subscription", purpose: "execute" }, now + 600_000);
      const rejection = await runAutonomousTurn({ db: f.db, brainPath: process.cwd(), backend: f.backend, store: f.store,
        checkpoint() {}, emit: frame => f.frames.push(frame) }, { turnId: "host-refusal", principalId: f.principal.id,
        prompt: "Odysseus fixture", allowedTools: [], systemPromptAppend: "No effects", signal: new AbortController().signal })
        .catch(error => error as Error);
      noRuntime(f);
      expect(rejection).toBeInstanceOf(Error);
      missingRequirement((rejection as Error).message);
      const error = f.frames.find(frame => frame.type === "error") as Extract<ServerMessage, { type: "error" }>;
      expect(error.failure?.errorClass).toBe("worker_host_unsupported"); missingRequirement(error.message);
    } finally { f.cleanup(); }
  });

  test("handoff summary refuses before history read, activity or backend initialization", async () => {
    const f = setup(); unsupported();
    // Existing source session is necessary for routing, but no new one appears.
    f.catalog.persistSessionStub("source", "Odysseus fixture", "claude", "claude");
    const history = spyOn(f.backend, "getHistory");
    try {
      await prepareHandoff(f.host, f.ws, { type: "handoff_prepare", handoffId: "handoff", sourceSessionId: "source", turns: 1 },
        { authorization: f.authorization, principal: f.principal, closed: false } as ConnectionState);
      expect(f.starts()).toBe(0); expect(history).not.toHaveBeenCalled();
      expect(f.db.query("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 1 });
      expect(f.db.query("SELECT count(*) AS n FROM activity_spans").get()).toEqual({ n: 0 });
      const draft = f.frames.find(frame => frame.type === "handoff_draft") as Extract<ServerMessage, { type: "handoff_draft" }>;
      expect(draft.state).toBe("failed"); missingRequirement(draft.message!);
      expect(f.host.coordinator.handoffPreparations.size).toBe(0);
    } finally { history.mockRestore(); f.cleanup(); }
  });
});
