import { describe, expect, test } from "bun:test";
import type {
  ChatImageAttachment,
  ClientEnvironment,
  ServerMessage,
} from "@schlessera/brain-ui-sdk/protocol";
import {
  BackendBusyError,
  type AgentBackend,
  type PermissionDecision,
  type StartTurnRequest,
} from "@schlessera/brain-ui-sdk/server";

import { createStaticBackendRegistry } from "../src/agent/backend";
import { createRecordingObservability } from "../src/observability/index";
import type { WSContext } from "../src/ws/clients";
import {
  MAX_SESSION_QUEUE,
  QUEUE_MAX_BYTES,
  QUEUE_WARN_BYTES,
  WsHost,
} from "../src/ws/host";
import {
  handleChatMessage as handleAuthorizedChatMessage,
  runSession as runAuthorizedSession,
} from "../src/ws/run-session";
import type { SessionCatalog } from "../src/ws/session-catalog";
import type { QueuedFollowUp, RunningTurn } from "../src/ws/turns";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";

const AUTHORIZATION = testAuthorization();

function runSession(
  host: WsHost,
  initial: Omit<Parameters<typeof runAuthorizedSession>[1], "authorization">
) {
  return runAuthorizedSession(host, { authorization: AUTHORIZATION, ...initial });
}

function handleChatMessage(
  host: WsHost,
  ws: WSContext,
  msg: Omit<Parameters<typeof handleAuthorizedChatMessage>[2], "authorization">
) {
  return handleAuthorizedChatMessage(host, ws, { authorization: AUTHORIZATION, ...msg });
}

interface FakeCatalog extends SessionCatalog {
  storedProviderId: string | null;
  storedBackendId: string | null;
}

function fakeCatalog(options: {
  providerId?: string | null;
  backendId?: string | null;
} = {}): FakeCatalog {
  return {
    storedProviderId: options.providerId ?? null,
    storedBackendId: options.backendId ?? null,
    getStoredProviderId() {
      return this.storedProviderId;
    },
    getStoredBackendId() {
      return this.storedBackendId;
    },
    persistSessionStub() {},
    persistSession() {},
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

function setupHost(
  backend: AgentBackend,
  options: {
    catalog?: SessionCatalog;
    maxConcurrentSessions?: number;
    turnTimeoutMs?: number;
  } = {}
) {
  const sent: ServerMessage[] = [];
  const ws: WSContext = {
    send(data) {
      sent.push(JSON.parse(data) as ServerMessage);
    },
  };
  const observability = createRecordingObservability();
  const host = new WsHost({
    registry: createStaticBackendRegistry([backend], backend.id),
    catalog: options.catalog ?? fakeCatalog(),
    observability,
    ...(options.maxConcurrentSessions !== undefined
      ? { maxConcurrentSessions: () => options.maxConcurrentSessions! }
      : {}),
    turnTimeoutMs: options.turnTimeoutMs ?? 5_000,
  });
  host.clients.add(ws, AUTHORIZATION.principalId, AUTHORIZATION);
  return { host, observability, sent, ws };
}

type StatusMessage = Extract<ServerMessage, { type: "status" }>;
type ErrorMessage = Extract<ServerMessage, { type: "error" }>;

function statusMessages(messages: ServerMessage[]): StatusMessage[] {
  return messages.filter((message): message is StatusMessage => message.type === "status");
}

function queuedStatuses(messages: ServerMessage[]): StatusMessage[] {
  return statusMessages(messages).filter((message) => message.status === "queued");
}

function queueErrors(messages: ServerMessage[]): ErrorMessage[] {
  return messages.filter(
    (message): message is ErrorMessage =>
      message.type === "error" && message.code === "SESSION_QUEUE_FULL"
  );
}

function parkedTurn(backend: AgentBackend, queue: QueuedFollowUp[] = []): RunningTurn {
  const timeoutHandle = setTimeout(() => {}, 0);
  clearTimeout(timeoutHandle);
  return {
    principalId: AUTHORIZATION.principalId,
    authorization: AUTHORIZATION,
    sessionId: "session-1",
    turnId: "turn-1",
    draftId: null,
    providerId: "default",
    backend,
    abortController: new AbortController(),
    timeoutHandle,
    queue,
    cancelled: false,
    lastResult: null,
  };
}

function queuedFollowUp(
  entry: Pick<QueuedFollowUp, "text" | "attachments" | "client">
): QueuedFollowUp {
  return {
    principalId: AUTHORIZATION.principalId,
    authorization: AUTHORIZATION,
    ...entry,
  };
}

function installParkedTurn(host: WsHost, turn: RunningTurn): void {
  host.coordinator.running.add(turn);
  host.coordinator.bySession.set("session-1", turn);
}

describe("runSession", () => {
  test("a backend busy rejection is reported as SESSION_BUSY at warning level", async () => {
    const prompts: string[] = [];
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async (request) => {
        prompts.push(request.prompt);
        throw new BackendBusyError("fake", "session-1");
      },
    });
    const { host, observability, sent } = setupHost(backend);

    await runSession(host, {
      text: "busy turn",
      sessionId: "session-1",
      attachments: [],
    });

    expect(prompts).toEqual(["busy turn"]);
    expect(sent.filter((message) => message.type === "error")).toEqual([
      expect.objectContaining({
        type: "error",
        code: "SESSION_BUSY",
        message: "That session already has a running turn.",
        sessionId: "session-1",
      }),
    ]);
    expect(queuedStatuses(sent)).toHaveLength(0);
    expect(observability.metrics.value("turns.failed", { code: "SESSION_BUSY" })).toBe(1);
    expect(observability.logs.count({ severity: "WARN", body: "turn failed" })).toBe(1);
    expect(observability.logs.count({ severity: "ERROR", body: "turn failed" })).toBe(0);
    expect(host.coordinator.running.size).toBe(0);
  });

  test("queued follow-ups run in order on the same session slot with new turn ids", async () => {
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const initialAttachments = [
      { data: "initial-image", mediaType: "image/png" },
    ] satisfies ChatImageAttachment[];
    const secondAttachments = [
      { data: "second-image", mediaType: "image/jpeg" },
    ] satisfies ChatImageAttachment[];
    const thirdAttachments = [
      { data: "third-image", mediaType: "image/webp" },
    ] satisfies ChatImageAttachment[];
    const initialClient = {
      formFactor: "phone",
      touch: true,
      viewportWidth: 390,
    } satisfies ClientEnvironment;
    const secondClient = {
      formFactor: "desktop",
      viewportWidth: 1440,
    } satisfies ClientEnvironment;
    const thirdClient = {
      formFactor: "tablet",
      standalone: true,
      viewportWidth: 820,
    } satisfies ClientEnvironment;
    const prompts: string[] = [];
    const requests: StartTurnRequest[] = [];
    const slots: Array<RunningTurn | undefined> = [];
    let host!: WsHost;
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async (request) => {
        prompts.push(request.prompt);
        requests.push(request);
        slots.push(host.coordinator.bySession.get("session-1"));
        request.bridge.emit({ type: "status", status: "thinking" });
        if (request.prompt === "first") await releaseFirst.promise;
        if (request.prompt === "second") await releaseSecond.promise;
      },
    });
    const setup = setupHost(backend, { turnTimeoutMs: 12_345 });
    host = setup.host;

    const running = runSession(host, {
      text: "first",
      sessionId: "session-1",
      attachments: initialAttachments,
      client: initialClient,
    });
    await until(() => prompts.length === 1);
    const originalSlot = host.coordinator.bySession.get("session-1");

    await handleChatMessage(host, setup.ws, {
      text: "second",
      sessionId: "session-1",
      attachments: secondAttachments,
      client: secondClient,
    });
    await handleChatMessage(host, setup.ws, {
      text: "third",
      sessionId: "session-1",
      attachments: thirdAttachments,
      client: thirdClient,
    });
    expect(queuedStatuses(setup.sent)).toHaveLength(2);

    releaseFirst.resolve();
    await until(() => prompts.length === 2);
    expect(prompts).toEqual(["first", "second"]);

    releaseSecond.resolve();
    await running;

    expect(prompts).toEqual(["first", "second", "third"]);
    expect(slots).toEqual([originalSlot, originalSlot, originalSlot]);
    expect(requests.map((request) => request.sessionId)).toEqual([
      "session-1",
      "session-1",
      "session-1",
    ]);
    expect(
      requests.map(({ prompt, attachments, client, turnBudgetMs }) => ({
        prompt,
        attachments,
        client,
        turnBudgetMs,
      }))
    ).toEqual([
      {
        prompt: "first",
        attachments: initialAttachments,
        client: initialClient,
        turnBudgetMs: 12_345,
      },
      {
        prompt: "second",
        attachments: secondAttachments,
        client: secondClient,
        turnBudgetMs: 12_345,
      },
      {
        prompt: "third",
        attachments: thirdAttachments,
        client: thirdClient,
        turnBudgetMs: 12_345,
      },
    ]);
    const turnIds = statusMessages(setup.sent)
      .filter((message) => message.status === "thinking")
      .map((message) => message.turnId);
    expect(new Set(turnIds).size).toBe(3);
    expect(host.coordinator.running.size).toBe(0);
    expect(host.coordinator.bySession.has("session-1")).toBe(false);
  });

  test("abort drops a follow-up queued while the backend unwinds and permits a later turn", async () => {
    const releaseUnwind = deferred();
    const prompts: string[] = [];
    const signals: AbortSignal[] = [];
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async (request) => {
        prompts.push(request.prompt);
        signals.push(request.signal);
        if (request.prompt !== "before abort") return;
        await new Promise<void>((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => {
              request.bridge.emit({ type: "status", status: "cancelled" });
              resolve();
            },
            { once: true }
          );
        });
        await releaseUnwind.promise;
      },
    });
    const { host, sent, ws } = setupHost(backend);

    const interrupted = runSession(host, {
      text: "before abort",
      sessionId: "session-1",
      attachments: [],
    });
    await until(() => prompts.length === 1);
    const slot = host.coordinator.bySession.get("session-1");
    expect(slot).toBeDefined();

    host.coordinator.cancelTurn(slot!, "host shutdown");
    await until(() => signals[0]!.aborted);
    await handleChatMessage(host, ws, {
      text: "must be dropped",
      sessionId: "session-1",
      attachments: [],
    });
    expect(queuedStatuses(sent)).toHaveLength(1);

    releaseUnwind.resolve();
    await interrupted;

    expect(signals[0]!.aborted).toBe(true);
    expect(
      sent.some((message) => message.type === "status" && message.status === "cancelled")
    ).toBe(true);
    expect(host.coordinator.running.size).toBe(0);
    expect(host.coordinator.bySession.has("session-1")).toBe(false);
    expect(prompts).toEqual(["before abort"]);

    await runSession(host, {
      text: "after abort",
      sessionId: "session-1",
      attachments: [],
    });
    expect(prompts).toEqual(["before abort", "after abort"]);
  });

  test("session_info identities carry forward to the next queued turn", async () => {
    const releaseFirst = deferred();
    const requests: Array<{ prompt: string; sessionId?: string; profileId?: string }> = [];
    const backend = makeFakeBackend({
      id: "fake",
      profiles: [{ id: "default-profile", label: "Default" }],
      startTurn: async (request) => {
        requests.push({
          prompt: request.prompt,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          ...(request.profileId ? { profileId: request.profileId } : {}),
        });
        if (request.prompt === "first") {
          request.bridge.emit({
            type: "session_info",
            sessionId: "resolved-session",
            isNew: true,
            providerId: "resolved-profile",
          });
          await releaseFirst.promise;
        }
      },
    });
    const { host, ws } = setupHost(backend);

    const running = runSession(host, {
      text: "first",
      attachments: [],
      draftId: "draft-1",
    });
    await until(() => host.coordinator.bySession.has("resolved-session"));
    await handleChatMessage(host, ws, {
      text: "second",
      sessionId: "resolved-session",
      attachments: [],
    });

    releaseFirst.resolve();
    await running;

    expect(requests).toEqual([
      { prompt: "first", profileId: "default-profile" },
      {
        prompt: "second",
        sessionId: "resolved-session",
        profileId: "resolved-profile",
      },
    ]);
  });

  test("an error result fails its turn and is cleared before the next queued turn", async () => {
    const releaseFirst = deferred();
    const prompts: string[] = [];
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async (request) => {
        prompts.push(request.prompt);
        if (request.prompt === "first") {
          request.bridge.emit({
            type: "result",
            sessionId: "session-1",
            outcome: "error",
            durationMs: 1,
            numTurns: 1,
            isError: true,
          });
          await releaseFirst.promise;
        }
      },
    });
    const { host, observability, ws } = setupHost(backend);

    const running = runSession(host, {
      text: "first",
      sessionId: "session-1",
      attachments: [],
    });
    await until(() => prompts.length === 1);
    await handleChatMessage(host, ws, {
      text: "second",
      sessionId: "session-1",
      attachments: [],
    });

    releaseFirst.resolve();
    await running;

    expect(prompts).toEqual(["first", "second"]);
    expect(observability.metrics.value("turns.failed", { code: "BACKEND_RESULT_ERROR" })).toBe(1);
    expect(observability.metrics.value("turns.completed")).toBe(1);
  });

  test("a dropped stored profile is warned, explained, and run through the backend default", async () => {
    const requests: StartTurnRequest[] = [];
    const backend = makeFakeBackend({
      id: "fake",
      profiles: [{ id: "default", label: "Default" }],
      startTurn: async (request) => {
        requests.push(request);
      },
    });
    const catalog = fakeCatalog({ providerId: "retired-profile", backendId: "fake" });
    const { host, observability, sent } = setupHost(backend, { catalog });

    await runSession(host, {
      text: "resume",
      sessionId: "session-1",
      attachments: [],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.profileId).toBeUndefined();
    expect(
      sent.some(
        (message) =>
          message.type === "status" &&
          message.status === "thinking" &&
          message.detail ===
            'Pinned model "retired-profile" is unavailable — running on the default.'
      )
    ).toBe(true);
    const warnings = observability.logs.find({
      severity: "WARN",
      body: "pinned profile unavailable",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.attributes).toMatchObject({
      "session.id": "session-1",
      profile: "retired-profile",
    });
  });

  test("routing failure emits one error and releases the starting reservation", async () => {
    const backend = makeFakeBackend({ id: "fake" });
    backend.listProfiles = () => {
      throw new Error("profile roster unavailable");
    };
    const { host, observability, sent } = setupHost(backend);

    await runSession(host, {
      text: "resume",
      sessionId: "session-1",
      attachments: [],
    });

    expect(host.coordinator.startingSessions).toBe(0);
    expect(host.coordinator.running.size).toBe(0);
    expect(sent).toContainEqual({
      type: "error",
      code: "BACKEND_ERROR",
      message: "profile roster unavailable",
      sessionId: "session-1",
    });
    expect(observability.metrics.value("turns.failed", { code: "BACKEND_ERROR" })).toBe(1);
  });

  test("host timeout denies a pending permission request and releases the slot", async () => {
    let signal!: AbortSignal;
    let decision!: PermissionDecision;
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async (request) => {
        signal = request.signal;
        decision = await request.bridge.requestPermission({
          toolUseId: "approval-timeout",
          toolName: "brain_write",
          input: { path: "notes/example.md" },
        });
      },
    });
    const { host, observability } = setupHost(backend, { turnTimeoutMs: 5 });

    await runSession(host, {
      text: "slow turn",
      sessionId: "session-1",
      attachments: [],
    });

    expect(signal.aborted).toBe(true);
    expect(decision).toEqual({ behavior: "deny", message: "Turn timed out" });
    expect(host.coordinator.pendingApprovals.size).toBe(0);
    expect(host.coordinator.running.size).toBe(0);
    expect(host.coordinator.bySession.has("session-1")).toBe(false);
    expect(observability.logs.count({ severity: "WARN", body: "turn timed out" })).toBe(1);
  });

  test("final cleanup denies an outstanding permission request after the backend resolves", async () => {
    let permission!: Promise<PermissionDecision>;
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async (request) => {
        permission = request.bridge.requestPermission({
          toolUseId: "approval-after-result",
          toolName: "brain_write",
          input: { path: "notes/example.md" },
        });
      },
    });
    const { host } = setupHost(backend);

    await runSession(host, {
      text: "permission left pending",
      sessionId: "session-1",
      attachments: [],
    });

    expect(host.coordinator.pendingApprovals.size).toBe(0);
    expect(await permission).toEqual({ behavior: "deny", message: "Session ended" });
    expect(host.coordinator.running.size).toBe(0);
    expect(host.coordinator.bySession.has("session-1")).toBe(false);
  });
});

describe("handleChatMessage concurrency", () => {
  test("an admitted start reserves capacity while routing and releases it before running", async () => {
    const releaseRouting = deferred();
    const backendStarted = deferred();
    const prompts: string[] = [];
    let routingCalls = 0;
    const backend = makeFakeBackend({
      id: "fake",
      profiles: [{ id: "default", label: "Default" }],
      startTurn: async (request) => {
        prompts.push(request.prompt);
        backendStarted.resolve();
      },
    });
    backend.listProfiles = async () => {
      routingCalls += 1;
      await releaseRouting.promise;
      return [{ id: "default", label: "Default" }];
    };
    const { host, sent, ws } = setupHost(backend, { maxConcurrentSessions: 1 });

    await handleChatMessage(host, ws, {
      text: "admitted",
      sessionId: "session-1",
      attachments: [],
    });
    const reservationWhileRouting = host.coordinator.startingSessions;

    await handleChatMessage(host, ws, {
      text: "rejected",
      sessionId: "session-2",
      attachments: [],
    });
    releaseRouting.resolve();
    if (routingCalls > 0) await backendStarted.promise;
    await until(
      () =>
        host.coordinator.startingSessions === 0 && host.coordinator.running.size === 0
    );

    expect(routingCalls).toBe(1);
    expect(reservationWhileRouting).toBe(1);
    expect(prompts).toEqual(["admitted"]);
    expect(sent.filter((message) => message.type === "error")).toEqual([
      {
        type: "error",
        code: "SESSION_LIMIT",
        message: "Too many concurrent sessions (max 1). Wait for one to finish.",
        sessionId: "session-2",
      },
    ]);
    expect(host.coordinator.startingSessions).toBe(0);
  });

  test("a new session is rejected when running plus starting sessions reaches the cap", async () => {
    let starts = 0;
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async () => {
        starts += 1;
      },
    });
    const { host, sent, ws } = setupHost(backend, { maxConcurrentSessions: 2 });
    const existing = parkedTurn(backend);
    installParkedTurn(host, existing);
    host.coordinator.startingSessions = 1;

    await handleChatMessage(host, ws, {
      text: "new session",
      sessionId: "session-2",
      attachments: [],
    });

    expect(starts).toBe(0);
    expect(sent).toEqual([
      {
        type: "error",
        code: "SESSION_LIMIT",
        message: "Too many concurrent sessions (max 2). Wait for one to finish.",
        sessionId: "session-2",
      },
    ]);
    host.coordinator.reset();
  });
});

describe("runSession follow-up queue boundaries", () => {
  test("the 50th queued message is accepted and the 51st is rejected", async () => {
    const backend = makeFakeBackend({ id: "fake" });
    const { host, sent, ws } = setupHost(backend);
    const turn = parkedTurn(
      backend,
      Array.from({ length: MAX_SESSION_QUEUE - 1 }, () =>
        queuedFollowUp({ text: "x", attachments: [] })
      )
    );
    installParkedTurn(host, turn);

    await handleChatMessage(host, ws, {
      text: "accepted",
      sessionId: "session-1",
      attachments: [],
    });
    await handleChatMessage(host, ws, {
      text: "rejected",
      sessionId: "session-1",
      attachments: [],
    });

    expect(turn.queue).toHaveLength(50);
    expect(queuedStatuses(sent)).toHaveLength(1);
    expect(queueErrors(sent)).toHaveLength(1);
    expect(queueErrors(sent)[0]!.message).toContain("queue is full (50 messages)");
    host.coordinator.reset();
  });

  test("the warning starts at 20.0 MB and the message remains queued", async () => {
    const backend = makeFakeBackend({ id: "fake" });
    const { host, observability, sent, ws } = setupHost(backend);
    const halfWarning = "A".repeat(QUEUE_WARN_BYTES / 2);
    const first = queuedFollowUp({
      text: "",
      attachments: [{ data: halfWarning, mediaType: "image/jpeg" as const }],
    });
    const turn = parkedTurn(backend, [first]);
    installParkedTurn(host, turn);

    await handleChatMessage(host, ws, {
      text: "",
      sessionId: "session-1",
      attachments: [{ data: halfWarning, mediaType: "image/jpeg" }],
    });

    expect(turn.queue).toHaveLength(2);
    expect(queuedStatuses(sent)).toHaveLength(1);
    expect(queuedStatuses(sent)[0]!.detail).toBe(
      "Queue is holding 20.0 MB across 2 messages (limit 50.0 MB)."
    );
    expect(queueErrors(sent)).toHaveLength(0);
    expect(
      observability.logs.count({ severity: "WARN", body: "session follow-up queue is heavy" })
    ).toBe(1);
    host.coordinator.reset();
  });

  test("one byte below 20.0 MB has no warning or queued-status detail", async () => {
    const backend = makeFakeBackend({ id: "fake" });
    const { host, observability, sent, ws } = setupHost(backend);
    const belowWarning = "A".repeat(QUEUE_WARN_BYTES - 2);
    const turn = parkedTurn(backend, [
      queuedFollowUp({
        text: "",
        attachments: [{ data: belowWarning, mediaType: "image/jpeg" }],
      }),
    ]);
    installParkedTurn(host, turn);

    await handleChatMessage(host, ws, {
      text: "x",
      sessionId: "session-1",
      attachments: [],
    });

    expect(turn.queue).toHaveLength(2);
    expect(queuedStatuses(sent)).toEqual([
      { type: "status", status: "queued", sessionId: "session-1" },
    ]);
    expect(
      observability.logs.count({ severity: "WARN", body: "session follow-up queue is heavy" })
    ).toBe(0);
    host.coordinator.reset();
  });

  test("exactly 50.0 MB is accepted and the next byte is rejected", async () => {
    const backend = makeFakeBackend({ id: "fake" });
    const { host, sent, ws } = setupHost(backend);
    const oneFifth = "A".repeat(QUEUE_MAX_BYTES / 5);
    const entry = queuedFollowUp({
      text: "",
      attachments: [{ data: oneFifth, mediaType: "image/jpeg" as const }],
    });
    const turn = parkedTurn(backend, [entry, entry, entry, entry]);
    installParkedTurn(host, turn);

    await handleChatMessage(host, ws, {
      text: "",
      sessionId: "session-1",
      attachments: [{ data: oneFifth, mediaType: "image/jpeg" }],
    });
    await handleChatMessage(host, ws, {
      text: "x",
      sessionId: "session-1",
      attachments: [],
    });

    expect(turn.queue).toHaveLength(5);
    expect(queuedStatuses(sent)).toHaveLength(1);
    expect(queuedStatuses(sent)[0]!.detail).toContain("50.0 MB across 5 messages");
    expect(queueErrors(sent)).toHaveLength(1);
    expect(queueErrors(sent)[0]!.message).toContain("50.0 MB of 50.0 MB");
    expect(queueErrors(sent)[0]!.message).toContain("this message needs 0.0 MB");
    host.coordinator.reset();
  });
});
