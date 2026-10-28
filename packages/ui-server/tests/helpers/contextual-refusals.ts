/** Real adapter + host refusal lifecycle, driven only through loopback frames. */
import { expect } from "bun:test";
import type { LiveConversationProvider, LiveConversationSession, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { CONVERSATION_LIMITS } from "@schlessera/brain-ui-sdk/protocol";
import { createStaticBackendRegistry } from "../../src/agent/backend";
import { createUiDb } from "../../src/db/client";
import { createWsHandlers } from "../../src/ws/connection";
import type { WSContext } from "../../src/ws/clients";
import { WsHost } from "../../src/ws/host";
import { createSessionCatalog } from "../../src/ws/session-catalog";
import { makeFakeBackend } from "./fake-backend";
import { testPrincipal } from "./principal";

export async function contextualRefusals(provider: "gemini" | "gpt", mode: "missing" | "duplicate" | "queue" | "aged" | "no-audio" | "storage" | "request-identity" | "binding" | "submission" | "authorization", f: {
  provider: LiveConversationProvider; emit: (frame: any) => void; sent: any[];
}, registerCleanup: (cleanup: () => void) => void) {
  const until = async (check: () => boolean) => {
    const end = Date.now() + 2000;
    while (!check()) { if (Date.now() > end) throw new Error("refusal lifecycle barrier timed out"); await Bun.sleep(1); }
  };
  const db = createUiDb(":memory:");
  const turns: StartTurnRequest[] = [], releases: (() => void)[] = [];
  const backend = makeFakeBackend({ id: "fake", startTurn: async req => {
    turns.push(req);
    req.bridge.emit({ type: "session_info", sessionId: "sess-ithaca", isNew: false });
    await new Promise<void>(resolve => releases.push(resolve));
    req.bridge.emit({ type: "text_delta", text: "The signal is a bronze owl." });
    req.bridge.emit({ type: "result", sessionId: "sess-ithaca", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
  } });
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], "fake"), catalog: createSessionCatalog(() => db), conversationProvider: f.provider });
  let rejectAdmission = mode === "storage";
  const save = host.catalog.saveConversationTask!.bind(host.catalog);
  Object.defineProperty(host.catalog, "saveConversationTask", { value: (principal: string, receipt: Parameters<typeof save>[1]) =>
    rejectAdmission && receipt.state === "queued" ? Promise.reject(new Error("Fixture admission storage failure")) : save(principal, receipt) });
  registerCleanup(() => { for (const release of releases) release(); host.coordinator.reset(); host.close(); db.close(); });
  const frames: any[] = [];
  const ws = { send: (data: string) => frames.push(JSON.parse(data)) } as WSContext;
  const handlers = createWsHandlers(host, testPrincipal());
  await handlers.onOpen(undefined as never, ws);
  const send = (frame: unknown) => handlers.onMessage({ data: JSON.stringify(frame) } as MessageEvent, ws);
  send({ type: "conversation_start", contextualTasks: true });
  await until(() => frames.some(f => f.type === "conversation_opened"));
  const { conversationId, epoch } = frames.find(f => f.type === "conversation_opened");
  // Seed the consumed-id boundary without executing thousands of unrelated turns.
  const state = (host.conversations as unknown as { conversations: Map<string, { usedRequestIds: Set<string>; epoch: { session: LiveConversationSession }; connection: { authorization: { valid: boolean } } }> }).conversations.get(conversationId)!;
  if (mode === "request-identity") for (let i = 0; i < 4096; i++) state.usedRequestIds.add(`historical-${i}`);
  const capture = async () => {
    send({ type: "conversation_audio", conversationId, epoch, utteranceId: "capture", sequence: 0, rate: provider === "gemini" ? 16000 : 24000, pcm: "AAA=" });
    await until(() => f.sent.some(f => f.realtimeInput?.audio || f.type === "session.input_audio.append"));
  };
  if (mode !== "no-audio") await capture();
  let sequence = 0;
  const recognize = async () => {
    const text = `Find Ithaca note ${sequence++}.`;
    f.emit(provider === "gemini" ? { serverContent: { inputTranscription: { text } } }
      : { type: "session.input_transcript.delta", event_id: `input-${sequence}`, delta: text, start_ms: sequence * 100, end_ms: sequence * 100 + 50 });
    await until(() => frames.some(f => f.event?.text === text));
  };
  const request = async (id: string) => {
    f.emit(provider === "gemini" ? { toolCall: { functionCalls: [{ id, name: "host_task" }] } }
      : { type: "session.delegation.created", event_id: `event-${id}`, offset_ms: 20, delegation: { id, type: "delegation", target: "client" } });
    await until(() => frames.some(f => f.nativeHandle === id) || frames.some(f => f.type === "conversation_closed"));
    if (mode !== "binding" && mode !== "submission") expect(frames.filter(f => f.type === "conversation_closed")).toHaveLength(0);
  };
  if (mode === "binding" || mode === "submission") {
    const method = mode === "binding" ? "bindContextualWork" : "refuseContextualWork";
    state.epoch.session[method] = () => { throw new Error("Fixture exact native operation unavailable"); };
    if (mode === "binding") await recognize();
    await request("unavailable-native-operation");
    await until(() => frames.some(f => f.type === "conversation_closed"));
    expect(turns).toHaveLength(0);
    expect(frames.find(f => f.type === "conversation_closed")).toMatchObject({ reason: "provider_error" });
    await host.catalog.settled!();
    expect((await host.catalog.loadConversation!(conversationId, testPrincipal().id))?.receipts.at(-1)).toMatchObject({ state: "refused", nativeHandle: "unavailable-native-operation" });
    return;
  }
  const accepted = mode === "duplicate" ? 1 : mode === "queue" ? CONVERSATION_LIMITS.maxQueuedWork : 0;
  for (let i = 0; i < accepted; i++) { await recognize(); await request(`accepted-${i}`); }
  if (accepted) await until(() => turns.length === 1);
  for (let i = 0; i < CONVERSATION_LIMITS.maxPendingNativeRequests + 3; i++) {
    if (mode === "queue" || mode === "storage" || mode === "request-identity" || mode === "authorization") await recognize();
    if (mode === "aged" || mode === "no-audio") await recognize();
    if (mode === "authorization") state.connection.authorization.valid = false;
    const now = Date.now;
    try {
      if (mode === "aged") Date.now = () => now() + 31_000;
      await request(`refused-${i}`);
    } finally { Date.now = now; if (mode === "authorization") state.connection.authorization.valid = true; }
    await until(() => frames.some(f => f.nativeHandle === `refused-${i}` && f.state === "refused"));
    expect(frames.filter(f => f.nativeHandle === `refused-${i}`).at(-1)).toMatchObject({ state: "refused", delivery: "discarded" });
    // Terminating a refusal must not require executing a backend turn.
    await until(() => f.sent.some(f => provider === "gemini" ? f.toolResponse?.functionResponses.some((r: any) => r.id === `refused-${i}`) : f.delegation_id === `refused-${i}`));
  }
  expect(turns).toHaveLength(accepted ? 1 : 0);
  for (let i = 0; i < accepted; i++) { await until(() => releases.length > i); releases[i]!(); }
  await until(() => !host.coordinator.isTurnActive());
  rejectAdmission = false;
  if (mode === "request-identity") state.usedRequestIds.clear();
  if (mode === "no-audio") await capture();
  await recognize(); await request("valid-after-refusals");
  await until(() => turns.length === accepted + 1);
  releases.at(-1)!();
  await until(() => f.sent.some(f => provider === "gemini" ? f.toolResponse?.functionResponses.some((r: any) => r.id === "valid-after-refusals") : f.delegation_id === "valid-after-refusals"));
  await host.catalog.settled!();
  const stored = await host.catalog.loadConversation!(conversationId, testPrincipal().id);
  expect(stored?.receipts.filter(r => r.state === "refused")).toHaveLength(CONVERSATION_LIMITS.maxPendingNativeRequests + 3);
  expect(stored?.receipts.filter(r => r.state === "refused").every(r => !("turnId" in r))).toBe(true);
  for (const receipt of stored!.receipts) expect(stored!.requestIds).toContain(receipt.requestId);
  const returned = f.sent.flatMap(f => provider === "gemini" ? f.toolResponse?.functionResponses ?? [] : f.type === "session.commentary.append" || f.type === "session.thinking.append" ? [f] : []);
  expect(returned.filter((f: any) => (provider === "gemini" ? f.response.output : f.content).includes("bronze owl"))).toHaveLength(accepted + 1);
  expect(returned.filter((f: any) => (provider === "gemini" ? f.response.output : f.content).includes("bronze owl")).map((f: any) => provider === "gemini" ? f.id : f.delegation_id)).toEqual([...Array.from({ length: accepted }, (_, i) => `accepted-${i}`), "valid-after-refusals"]);
  // A tombstoned refusal cannot acquire a different binding or execute later.
  const count = returned.length;
  await request("refused-0");
  await Bun.sleep(10);
  expect(turns).toHaveLength(accepted + 1);
  expect(f.sent.flatMap(f => provider === "gemini" ? f.toolResponse?.functionResponses ?? [] : f.delegation_id ? [f] : [])).toHaveLength(count);
}
