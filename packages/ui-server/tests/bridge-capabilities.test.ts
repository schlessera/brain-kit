/**
 * Each bridge capability factory, driven directly without a backend turn
 * (#2516). The composed bridge keeps its turn-level suites
 * (`ws-claude-effects`, `provider-mask-bridge`, `inbox-bridge-tools`).
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyedLock, type BackendBridge, type PermissionDecision } from "@schlessera/brain-ui-sdk/server";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import { WsHost } from "../src/ws/host.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import type { RunningTurn } from "../src/ws/turns.js";
import { applyIndexReads, applyLiveAuthority, settleTurnIndex } from "../src/ws/bridge.js";
import { createBridgeContext, type BridgeContext, type MakeBridgeOptions } from "../src/ws/bridge-capabilities/context.js";
import { createEmission, createTurnTranscript } from "../src/ws/bridge-capabilities/emission.js";
import { createActivity, guardMaskedRecords, openInbox } from "../src/ws/bridge-capabilities/activity.js";
import { ProviderRecordsRefusedError } from "../src/brain/provider-mask-refusal.js";
import { createPermissions } from "../src/ws/bridge-capabilities/permissions.js";
import { createAsks } from "../src/ws/bridge-capabilities/asks.js";
import { createLocationAndMask, createMaskApplicationSlice } from "../src/ws/bridge-capabilities/location-mask.js";
import { createPolicyProposal } from "../src/ws/bridge-capabilities/policy-proposal.js";
import { createApplication } from "../src/ws/bridge-capabilities/application.js";
import { createScratch } from "../src/ws/bridge-capabilities/scratch.js";
import { createAttachmentRead } from "../src/ws/bridge-capabilities/attachments.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";

interface Fixture {
  host: WsHost;
  turn: RunningTurn;
  ctx: BridgeContext;
  root: string;
  frames: ServerMessage[];
  revoke(): void;
  cleanup(): void;
}

function fixture(options: { voice?: boolean; clients?: boolean; backendId?: string; bridge?: Partial<MakeBridgeOptions>; host?: Record<string, unknown> } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "bridge-capabilities-")); const db = createUiDb(":memory:");
  const backendId = options.backendId ?? "claude";
  let authorized = true;
  const frames: ServerMessage[] = [];
  const host = new WsHost({ brainPath: root, registry: createStaticBackendRegistry([makeFakeBackend({ id: backendId })], backendId),
    catalog: createSessionCatalog(() => db), isPrincipalAuthorized: () => authorized, ...options.host });
  if (options.clients !== false) host.clients.add({ send: text => { frames.push(JSON.parse(text)); } }, "odysseus");
  const authorization = host.coordinator.openAuthorization({ principalId: "odysseus", valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
  const turn = { turnId: "raft-turn", requestId: "raft-request", principalId: "odysseus", authorization, startedAt: 1, sessionId: null,
    abortController: new AbortController(), queue: [], ...(options.voice ? { work: { posture: "voice", observe() {} } } : {}) } as unknown as RunningTurn;
  const ctx = createBridgeContext(host, turn, { promptText: "Odysseus builds a raft", backendId, ...options.bridge });
  return { host, turn, ctx, root, frames, revoke: () => { authorized = false; },
    cleanup() { authorization.release(); host.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

/** The promise's state after every already-queued settlement has run. */
async function settled<T>(promise: Promise<T>): Promise<"pending" | "resolved" | "rejected"> {
  const pending = Symbol("pending");
  const outcome = await Promise.race([promise.then(() => "resolved" as const, () => "rejected" as const),
    new Promise<typeof pending>(resolve => setTimeout(() => resolve(pending), 0))]);
  return outcome === pending ? "pending" : outcome;
}

test("context: authority follows the turn's identity, principal and cancellation", () => {
  const f = fixture();
  try {
    expect(f.ctx.principalIsAuthorized()).toBe(true);
    expect(f.ctx.toolName("inbox_add")).toBe("mcp__brain-ui__inbox_add");
    f.turn.turnId = "next-turn";
    expect(f.ctx.principalIsAuthorized(), "a re-minted slot turn id is a different turn").toBe(false);
    f.turn.turnId = "raft-turn";
    f.revoke();
    expect(f.ctx.principalIsAuthorized()).toBe(false);
    expect(() => f.ctx.assertAuthority()).toThrow("current principal authority");
  } finally { f.cleanup(); }
});

test("emission: session_info binds the turn once, stamps identity and names the session", () => {
  const named: string[] = [];
  const f = fixture({ bridge: { onSessionNamed: sid => named.push(sid) } });
  try {
    const { emit } = createEmission(f.ctx, createTurnTranscript(f.ctx), { promptText: "Odysseus builds a raft", onSessionNamed: sid => named.push(sid) });
    emit({ type: "session_info", sessionId: "ithaca" } as ServerMessage);
    emit({ type: "session_info", sessionId: "ithaca" } as ServerMessage);
    expect(f.turn.sessionId).toBe("ithaca");
    expect(named, "ON_SESSION_NAMED_ONCE").toEqual(["ithaca"]);
    expect(f.frames[0]).toMatchObject({ type: "session_info", sessionId: "ithaca", backendId: "claude", requestId: "raft-request", turnId: "raft-turn" });
    emit({ type: "error", code: "agent_error", message: "storm" } as ServerMessage);
    expect(f.frames[2], "ERROR_CARRIES_REQUEST_ID").toMatchObject({ type: "error", requestId: "raft-request", sessionId: "ithaca" });
    emit({ type: "result", sessionId: "ithaca", outcome: "success", isError: false } as unknown as ServerMessage);
    expect(f.turn.lastResult).toBe("success");
    f.turn.turnId = "next-turn";
    emit({ type: "result", sessionId: "ithaca", outcome: "error", isError: true } as unknown as ServerMessage);
    expect(f.turn.lastResult, "A_LATE_RESULT_NEVER_RELABELS_THE_NEXT_TURN").toBe("success");
  } finally { f.cleanup(); }
});

test("permissions: an approval card parks, a duplicate id is denied, a policy checkpoint needs proposals", async () => {
  const f = fixture();
  try {
    const bridge = {} as BackendBridge;
    const { requestPermission } = createPermissions(f.ctx, () => bridge);
    const first = requestPermission({ toolUseId: "raft", toolName: "Write", input: {} });
    expect(f.frames.map(frame => frame.type)).toEqual(["tool_approval_request", "status"]);
    expect(f.host.coordinator.pendingApprovals.get("raft")?.turnId).toBe("raft-turn");
    const other = { ...f.turn, turnId: "suitor-turn" } as RunningTurn;
    const suitor = createPermissions({ ...f.ctx, turn: other, turnId: "suitor-turn" }, () => bridge);
    expect(await suitor.requestPermission({ toolUseId: "raft", toolName: "Write", input: {} })).toEqual({ behavior: "deny", message: "Duplicate tool-approval id" });
    expect(await settled(first)).toBe("pending");
    expect(await requestPermission({ toolUseId: "policy", toolName: "propose_policy_change", input: {} }))
      .toEqual({ behavior: "deny", message: "Policy proposals are unavailable in this turn." });
  } finally { f.cleanup(); }
});

test("asks: one id space across all four kinds; a collision rejects and sends nothing", async () => {
  const f = fixture();
  try {
    const asks = createAsks(f.ctx);
    const first = asks.askUser!("raft", []);
    first.catch(() => { /* Shutdown rejects what is still pending. */ });
    expect(f.frames.map(frame => frame.type)).toEqual(["ask_user_request", "status"]);
    for (const [kind, ask] of [
      ["askUserList", () => asks.askUserList!("raft", { title: "Crew", items: [] } as never)],
      ["askUserRank", () => asks.askUserRank!("raft", { prompt: "Rank the perils", items: [{ id: "scylla", label: "Scylla" }, { id: "charybdis", label: "Charybdis" }] })],
      ["askUserForm", () => asks.askUserForm!("raft", { prompt: "Choose a course",
        nodes: [{ id: "course", kind: "single", prompt: "Which?", options: [{ label: "Sea" }, { label: "Land" }] }] })],
    ] as const) {
      const duplicate: Promise<unknown> = ask();
      expect(f.frames.length, `ASK_COLLISION_SENDS_NOTHING ${kind}`).toBe(2);
      expect(await settled(duplicate), `ASK_COLLISION_REJECTS ${kind}`).toBe("rejected");
      await expect(duplicate).rejects.toThrow("Duplicate ask-user request id");
    }
    expect(await settled(first)).toBe("pending");
    expect(asks.askUserFormLimits).toBe(f.host.askUserFormLimits);
  } finally { f.cleanup(); }
});

test("location and mask: refused without a client, otherwise requested from it", async () => {
  const absent = fixture({ clients: false });
  try {
    const slice = createLocationAndMask(absent.ctx);
    await expect(slice.getLocation!({})).rejects.toThrow("client is connected to read the location");
    await expect(slice.requestMask!("assets/raft.png", "the sail")).rejects.toThrow("client is connected to paint a mask");
  } finally { absent.cleanup(); }
  const f = fixture();
  try {
    const slice = createLocationAndMask(f.ctx);
    const location = slice.getLocation!({});
    const mask = slice.requestMask!("assets/raft.png", "the sail");
    for (const pending of [location, mask]) pending.catch(() => { /* Shutdown rejects what is still pending. */ });
    expect(f.frames.map(frame => frame.type)).toEqual(["location_request", "status", "mask_request", "status"]);
    expect(await settled(location)).toBe("pending");
    expect(await settled(mask)).toBe("pending");
  } finally { f.cleanup(); }
});

test("mask application: only this turn's exact browser submission may be applied", async () => {
  const f = fixture();
  try {
    const recorded: unknown[] = [];
    const ctx = { ...f.ctx, recorder: { recordApplication: (result: unknown) => recorded.push(result) } } as unknown as BridgeContext;
    const slice = createMaskApplicationSlice(ctx, f.root, { lock: createKeyedLock(), available: [], autoAllowed: [] },
      async () => new Uint8Array([1]), {});
    const result = await slice.applyImageMask!({ imagePath: "assets/raft.png", maskPath: "assets/raft-mask.png", png: new Uint8Array([1]) });
    expect(result).toMatchObject({ ok: false, code: "permission_denied" });
    expect(recorded).toEqual([result]);
  } finally { f.cleanup(); }
});

test("activity: model binding, Claude usage evidence and the activity query", async () => {
  const bound: string[] = [];
  const f = fixture({ bridge: { mainModel: { current: () => null, bind: model => { bound.push(model); } } },
    host: { activity: { query: () => ({ spans: ["raft"] }) } } });
  try {
    const transcript = createTurnTranscript(f.ctx);
    const slice = createActivity(f.ctx, transcript, {});
    slice.activity!({ kind: "main_model", model: "a-model" } as never);
    expect(bound, "NO_BINDING_BEFORE_THE_BACKEND_STARTS").toEqual([]);
    f.turn.backendStarted = true;
    slice.activity!({ kind: "main_model", model: "a-model" } as never);
    expect(bound).toEqual(["a-model"]);
    slice.activity!({ kind: "claude_session_usage", completed: { inputTokens: 3 } } as never);
    expect(transcript.claudeUsage).toEqual({ completed: { inputTokens: 3 } } as never);
    expect(await slice.queryActivity!({} as never)).toEqual({ spans: ["raft"] } as never);
  } finally { f.cleanup(); }
});

test("activity/inbox: the inbox opens with the turn's membership; masked records are refused whole", async () => {
  let opened: Record<string, unknown> | undefined;
  const f = fixture({ voice: true, host: { inboxTools: { forTurn: (input: Record<string, unknown>) => { opened = input; return { inboxList: async () => [] }; } } } });
  try {
    const inbox = openInbox(f.ctx, ["governance/policy.md"]);
    expect(opened).toMatchObject({ principalId: "odysseus", turnId: "raft-turn", membership: "voice", protectedPaths: ["governance/policy.md"] });
    const bridge = { ...inbox, queryActivity: async () => ({}) } as unknown as BackendBridge;
    guardMaskedRecords(f.ctx, bridge);
    expect(await bridge.inboxList!({} as never), "UNMASKED_TURN_KEEPS_ITS_RECORDS").toEqual([] as never);
    const guard = { folders: ["me"], assert() {} };
    guardMaskedRecords({ ...f.ctx, maskGuard: guard }, bridge);
    await expect(bridge.inboxList!({} as never)).rejects.toBeInstanceOf(ProviderRecordsRefusedError);
    await expect(bridge.queryActivity!({} as never)).rejects.toBeInstanceOf(ProviderRecordsRefusedError);
  } finally { f.cleanup(); }
});

test("policy proposal: absent in voice; approval goes through the composed bridge's current requestPermission", async () => {
  const proposals = { propose: async (input: { approve(review: { message: string }): Promise<boolean> }) =>
    ({ state: await input.approve({ message: "Mask me/" }) ? "updated" : "declined" }) };
  const voice = fixture({ voice: true, host: { policyProposals: proposals } });
  try { expect(createPolicyProposal(voice.ctx, () => ({}) as BackendBridge)).toEqual({}); } finally { voice.cleanup(); }
  const f = fixture({ host: { policyProposals: proposals } });
  try {
    const asked: string[] = [];
    let bridge = { requestPermission: async () => ({ behavior: "deny" }) as PermissionDecision } as unknown as BackendBridge;
    const slice = createPolicyProposal(f.ctx, () => bridge);
    bridge = { requestPermission: async (req: { toolName: string }) => { asked.push(req.toolName); return { behavior: "allow" } as PermissionDecision; } } as unknown as BackendBridge;
    expect(await slice.proposePolicyChange!("policy-1", {} as never)).toEqual({ state: "updated" } as never);
    expect(asked, "READS_THE_BRIDGE_AT_CALL_TIME").toEqual(["mcp__brain-ui__propose_policy_change"]);
  } finally { f.cleanup(); }
});

test("application: base reads stop with the turn's authority", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "notes"), { recursive: true });
    writeFileSync(join(f.root, "notes/raft.md"), "---\ntype: note\ntitle: Raft\n---\nThe raft holds.\n");
    const { slice, indexBatch } = createApplication(f.ctx, () => ({}) as BackendBridge, f.root,
      { lock: createKeyedLock(), available: ["write"], autoAllowed: ["write"] }, {});
    expect(indexBatch).toBeDefined();
    expect(slice.completeShare, "NO_SHARE_COMPLETION_WITHOUT_SHARES").toBeUndefined();
    expect((await slice.readBrainBase!("notes/raft.md")).content).toContain("The raft holds.");
    f.revoke();
    await expect(slice.readBrainBase!("notes/raft.md")).rejects.toThrow("current principal authority");
  } finally { f.cleanup(); }
});

test("scratch: the host's prune pass, when there is one", () => {
  const prune = async () => {};
  const f = fixture({ host: { scratchPrune: prune } });
  try { expect(createScratch(f.ctx)).toEqual({ pruneScratch: prune }); } finally { f.cleanup(); }
  const none = fixture();
  try { expect(createScratch(none.ctx)).toEqual({}); } finally { none.cleanup(); }
});

test("attachments: a reader for a first-party backend with a draft store, nothing otherwise", () => {
  const drafts = {} as never;
  for (const backendId of ["claude", "pi"]) {
    const f = fixture({ backendId, host: { drafts } });
    try { expect(typeof createAttachmentRead(f.ctx, { collectedSessionId: null }).readAttachment).toBe("function"); } finally { f.cleanup(); }
  }
  const other = fixture({ backendId: "ithaca", host: { drafts } });
  try { expect(createAttachmentRead(other.ctx, { collectedSessionId: null })).toEqual({}); } finally { other.cleanup(); }
  const none = fixture();
  try { expect(createAttachmentRead(none.ctx, { collectedSessionId: null })).toEqual({}); } finally { none.cleanup(); }
});

test("index reads: a turn tree gates only index readers, and the turn's own batch settles at the end", async () => {
  const f = fixture();
  try {
    const barriers: string[] = [];
    const tree = { barrier: async () => { barriers.push("tree"); } };
    const bridge = {} as BackendBridge;
    let pending = true;
    const turnIndex = { pending: () => pending, barrier: async () => { barriers.push("turn"); pending = false; } };
    applyIndexReads(f.ctx, bridge, turnIndex as never, { tree: tree as never });
    await bridge.awaitIndex!("Write", {});
    await bridge.awaitIndex!("mcp__brain__search", {});
    expect(barriers).toEqual(["tree"]);
    await settleTurnIndex(bridge);
    await settleTurnIndex(bridge);
    expect(barriers, "SETTLES_ONLY_WHAT_IS_PENDING").toEqual(["tree", "turn"]);
  } finally { f.cleanup(); }
});

test("live authority: voice never grants, and a revoked turn's effect never runs", async () => {
  const voice = fixture({ voice: true });
  try {
    let ran = 0;
    const bridge = { requestPermission: async () => { ran++; return { behavior: "allow" }; }, askUser: async () => { ran++; return {}; } } as unknown as BackendBridge;
    applyLiveAuthority(voice.ctx, bridge);
    expect(await bridge.requestPermission({ toolUseId: "raft", toolName: "Write", input: {} })).toEqual({ behavior: "deny", message: "Voice cannot grant tools." });
    voice.revoke();
    await expect(bridge.askUser!("raft", [])).rejects.toThrow("current principal authority");
    expect(ran).toBe(0);
  } finally { voice.cleanup(); }
});

test("live authority: a revoked turn's attachment read never runs", async () => {
  const f = fixture();
  try {
    let ran = 0;
    const bridge = { readAttachment: async () => { ran++; return {}; } } as unknown as BackendBridge;
    applyLiveAuthority(f.ctx, bridge);
    f.revoke();
    await expect(bridge.readAttachment!({ file: "raft.pdf" } as never)).rejects.toThrow("current principal authority");
    expect(ran).toBe(0);
  } finally { f.cleanup(); }
});
