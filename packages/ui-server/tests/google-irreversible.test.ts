import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createGogTransport } from "@schlessera/brain-common/internal/google-gog";
import { openGoogleLedger } from "@schlessera/brain-common/internal/google-ledger";
import type { GoogleToolCall } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { PermissionDecision, PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal } from "../src/db/principals.js";
import { createGoogleToolsHost, type GoogleToolsTurn } from "../src/google/host.js";
import { createGoogleStateWrites, isDraftSendLocked } from "../src/google/state-writes.js";
import { createGoogleAllowances } from "../src/google/allowances.js";
import { createGmailWriteFactories } from "../src/google/reversible.js";
import { createFakeGog } from "../../common/tests/support/fake-gog.js";
import { FIRST, SECOND, DRAFT, rawDraft, writesScenario } from "../../common/tests/support/gmail-write-fixtures.js";
import { GOOGLE_SAFETY, googlePolicy } from "./helpers/google-write-fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function fixture(mode: "allow" | "ask" = "allow", options: { hidden?: string[]; items?: number; turn?: number } = {}) {
  const db = createUiDb(":memory:"); cleanups.push(() => db.close());
  const owner = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  db.query("INSERT INTO sessions(id,created_at,last_active_at) VALUES ('ithaca',1,1)").run();
  mkdirSync(resolve("tmp"), { recursive: true });
  const dir = mkdtempSync(resolve("tmp/google-irreversible-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = openGoogleLedger(resolve(dir, "ledger.db")); cleanups.push(() => ledger.close());
  const fake = createFakeGog(sendScenario()); cleanups.push(() => fake.dispose());
  const transport = createGogTransport({ binary: fake.binary, account: "ithaca", environment: fake.environment, retryDelayMs: 0 });
  const credential = { transport: () => ({ ok: true as const, transport }) };
  const state = createGoogleStateWrites(db), cards: PermissionRequest[] = [];
  const policy = googlePolicy(mode);
  policy.gmail.hidden_labels = options.hidden ?? [];
  policy.limits.items_per_call = options.items ?? 25; policy.limits.reversible_per_turn = options.turn ?? 25;
  let tainted = false, routing: "allowed" | "recipient_restricted" = "allowed", safety = { ...GOOGLE_SAFETY }, current = structuredClone(policy);
  let answer: (request: PermissionRequest) => Promise<PermissionDecision> = async () => ({ behavior: "allow" });
  const turn: GoogleToolsTurn = { turnId: "turn-ithaca", principalId: owner.id, sessionId: () => "ithaca", posture: "interactive",
    policy: () => policy, routing: async () => routing === "allowed" ? null : routing, tainted: () => tainted,
    write: { signal: new AbortController().signal, toolName: name => name, isCurrent: () => true, safety: () => safety, routingNow: () => routing,
      record: (...args) => state.commitGoogleDecision(...args), requestPermission: async request => { cards.push(request); return answer(request); } } };
  const host = createGoogleToolsHost({ credential, principal: () => "owner", untrusted: async () => { tainted = true; },
    writes: { brainId: "brain", hostEpoch: "ithaca-epoch", ledger: () => ledger, allowances: createGoogleAllowances(db),
      resolveAccount: () => transport.resolveAccount(), currentPolicyHash: () => "ithaca", state, ready: () => true, currentPolicy: () => current,
      isDraftLocked: (account, draft, epoch, now) => isDraftSendLocked(db, "brain", account, draft, epoch, now), preparedWrites: createGmailWriteFactories({ db, credential, brainId: "brain", ledger: () => ledger }) } });
  cleanups.push(() => host.close?.());
  return { db, fake, transport, turn, cards, ledger, owner, policy, state, ledgerPath: resolve(dir, "ledger.db"), call: (call: GoogleToolCall) => host.call(turn, call),
    syncPolicy: () => { current = structuredClone(policy); },
    answer: (next: typeof answer) => { answer = next; },
    change: (kind: string) => { if (kind === "taint") tainted = true; if (kind === "untaint") tainted = false; if (kind === "routing") routing = "recipient_restricted";
      if (kind === "policy") current = googlePolicy(mode === "ask" ? "allow" : "ask"); if (kind === "safety") safety = { ...safety, recordingAvailable: false }; } };
}
const send: GoogleToolCall = { tool: "brain_google_gmail_send", input: { draft_id: DRAFT } };
const remove: GoogleToolCall = { tool: "brain_google_gmail_draft", input: { action: "delete", draft_id: DRAFT } };
const trash: GoogleToolCall = { tool: "brain_google_gmail_trash", input: { message_ids: [FIRST, SECOND] } };
function sendScenario() {
  return { ...writesScenario(), "gmail.send": { stdout: { from: "odysseus@example.com", messageId: SECOND, threadId: FIRST } },
    "gmail.drafts.delete": { stdout: { deleted: true, draftId: DRAFT } },
    "gmail.trash": { stdout: { action: "trashed", count: 2, addedLabels: ["TRASH"], removedLabels: ["INBOX"] } } };
}

test("google send dispatches the approved raw bytes once and deletes only after recording", async () => {
  const f = fixture();
  expect(await f.call(send), "SEND_EXACT_SUCCESS").toMatchObject({ ok: true, operation: "gmail.draft.send", admission: "card", result: { draft_id: DRAFT, message_id: SECOND, draft_deleted: true } });
  expect(f.cards).toHaveLength(1);
  expect(f.cards[0]!.input, "SEND_CARD_POLICY_MATCH").toMatchObject({ payload: { account_alias: "ithaca",
    recipient_matches: [{ field: "to", address: "penelope@example.com", entry: "*@example.com" }] } });
  const card = f.cards[0]!.input as { payload: { message: { digest: string; body_text: string } } };
  const raw = Buffer.from(rawDraft().draft.message.raw, "base64url");
  expect(card.payload.message.body_text).toBe("The ship is ready.\n");
  expect(card.payload.message.digest, "SEND_CARD_DIGEST").toBe(new Bun.CryptoHasher("sha256").update(raw).digest("hex"));
  expect(f.fake.callsOf("gmail.send")).toHaveLength(1);
  expect(Buffer.from(f.fake.callsOf("gmail.send")[0]!.stdin_base64, "base64"), "SEND_EXACT_BYTES").toEqual(raw);
  expect(f.fake.callsOf("gmail.send")[0]!.argv).toContain(`--thread-id=${FIRST}`);
  expect(f.fake.callsOf("gmail.drafts.delete")).toHaveLength(1);
  expect(await f.call(send), "SEND_DIGEST_REPLAY_REFUSED").toMatchObject({ ok: false, error: { code: "already_sent" } });
  expect(f.cards, "SEND_REPLAY_NO_CARD").toHaveLength(1);
  expect(f.fake.callsOf("gmail.send")).toHaveLength(1);
});

function setRaw(f: ReturnType<typeof fixture>, raw: string) {
  const draft = rawDraft(); draft.draft.message.raw = Buffer.from(raw).toString("base64url");
  f.fake.setScenario({ ...sendScenario(), [`gmail.drafts.get ${DRAFT}`]: { stdout: draft } });
}
const mail = (headers = "To: penelope@example.com", body = "Homeward.", content = "text/plain; charset=UTF-8") =>
  `From: odysseus@example.com\r\n${headers}\r\nSubject: Ithaca\r\nContent-Type: ${content}\r\n\r\n${body}`;

for (const [name, raw] of [
  ["html", mail("To: penelope@example.com", "--ithaca\r\nContent-Type: text/plain\r\n\r\nHome\r\n--ithaca\r\nContent-Type: text/html\r\n\r\n<p>Home</p>\r\n--ithaca--", "multipart/alternative; boundary=ithaca")],
  ["attachment", mail("To: penelope@example.com", "--ithaca\r\nContent-Type: text/plain\r\n\r\nHome\r\n--ithaca\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=voyage.txt\r\n\r\nShip\r\n--ithaca--", "multipart/mixed; boundary=ithaca")],
  ["unreadable_header", mail("To: penelope@example.com\r\nBcc: unreadable")],
  ["unreadable_body", mail("To: penelope@example.com", "Home", "text/plain; charset=unknown-ithaca")],
  ["missing_sender", mail().replace("From: odysseus@example.com\r\n", "")],
  ["oversize_body", mail("To: penelope@example.com", "O".repeat(32_769))],
]) test(`google send refuses ${name} without showing or dispatching`, async () => {
  const f = fixture(); setRaw(f, raw!);
  expect(await f.call(send), `SEND_DISPLAY_${name}`).toMatchObject({ ok: false, error: { code: "draft_not_displayable" } });
  expect(f.cards).toHaveLength(0); expect(f.fake.callsOf("gmail.send")).toHaveLength(0);
});

for (const [name, headers, max, reason] of [
  ["spoofed_name", 'To: "penelope@example.com" <suitor@elsewhere.example>', 10, "recipient_not_allowed"],
  ["bcc", "To: penelope@example.com\r\nBcc: suitor@elsewhere.example", 10, "recipient_not_allowed"],
  ["cc", "To: penelope@example.com\r\nCc: suitor@elsewhere.example", 10, "recipient_not_allowed"],
  ["count_all_headers", "To: penelope@example.com\r\nCc: telemachus@example.com\r\nBcc: eumaeus@example.com", 2, "too_many_recipients"],
  ["encoded_name", "To: =?UTF-8?Q?penelope=40example.com?= <suitor@elsewhere.example>", 10, "recipient_not_allowed"],
] as const) test(`google send checks parsed recipients ${name}`, async () => {
  const f = fixture(); f.policy.gmail.max_recipients = max;
  // Keep current policy in sync with the turn's policy for this fixture.
  f.syncPolicy(); setRaw(f, mail(headers));
  expect(await f.call(send), `SEND_RECIPIENT_${name}`).toMatchObject({ ok: false, error: { reason } });
  expect(f.cards).toHaveLength(0); expect(f.fake.callsOf("gmail.send")).toHaveLength(0);
});

test("google send accepts folded recipients and decodes encoded display names without changing bytes", async () => {
  const f = fixture();
  const raw = mail("To: =?UTF-8?Q?Penelope?= <penelope@example.com>,\r\n\tTelemachus <telemachus@example.com>\r\nBcc: eumaeus@example.com");
  setRaw(f, raw);
  expect(await f.call(send)).toMatchObject({ ok: true });
  expect(f.cards[0]!.input, "SEND_FOLDED_DISPLAY").toMatchObject({ payload: { message: {
    to: [{ address: "penelope@example.com", display_name: "Penelope" }, { address: "telemachus@example.com", display_name: "Telemachus" }], bcc: [{ address: "eumaeus@example.com" }] } } });
  expect(Buffer.from(f.fake.callsOf("gmail.send")[0]!.stdin_base64, "base64").toString(), "SEND_FOLDED_BYTES").toBe(raw);
});

test("google send edited approval and changed raw draft both refuse before dispatch", async () => {
  for (const changed of ["approval", "draft"] as const) {
    const f = fixture();
    f.answer(async request => {
      if (changed === "draft") setRaw(f, mail("To: penelope@example.com", "Changed by another client."));
      return { behavior: "allow", ...(changed === "approval" ? { updatedInput: { ...request.input, tainted: true } } : {}) };
    });
    expect(await f.call(send), `SEND_CHANGED_${changed}`).toMatchObject({ ok: false, error: { reason: changed === "approval" ? "edited" : "prepared_changed" } });
    expect(f.fake.callsOf("gmail.send")).toHaveLength(0);
  }
});

test("google pending send card refuses racing draft save and delete then releases its lock", async () => {
  const f = fixture();
  let opened!: () => void, answer!: (value: PermissionDecision) => void;
  const shown = new Promise<void>(resolve => { opened = resolve; });
  f.answer(() => {
    if (f.cards.length > 1) return Promise.resolve({ behavior: "allow" });
    opened(); return new Promise(resolve => { answer = resolve; });
  });
  const pending = f.call(send);
  await shown;
  try {
    const reads = f.fake.callsOf("gmail.drafts.get").length;
    for (const call of [{ tool: "brain_google_gmail_draft", input: { action: "update", draft_id: DRAFT, body: "Keep weaving." } } as GoogleToolCall, remove, send]) {
      expect(await f.call(call), "SEND_LOCK_REFUSES_RACE").toMatchObject({ ok: false, error: { code: "draft_locked" } });
    }
    expect(f.fake.callsOf("gmail.drafts.get"), "SEND_LOCK_BEFORE_PREREAD").toHaveLength(reads);
  } finally { answer({ behavior: "allow" }); await pending; }
  expect(await pending).toMatchObject({ ok: true });
  expect(f.db.query("SELECT * FROM google_send_locks").all()).toEqual([]);
});

for (const lost of [true, false]) test(`google send refuses a ${lost ? "lost" : "expired"} card lock`, async () => {
  const f = fixture();
  f.answer(async () => { f.db.exec(lost ? "DELETE FROM google_send_locks" : "UPDATE google_send_locks SET created_at=0,expires_at=1"); return { behavior: "allow" }; });
  expect(await f.call(send), "SEND_LOST_LOCK").toMatchObject({ ok: false, error: { reason: "card_lock_expired", message: expect.stringContaining("new request") } });
  expect(f.fake.callsOf("gmail.send")).toHaveLength(0);
  expect(await f.call(trash), "SEND_LOST_LOCK_OTHER_OPERATION_USABLE").toMatchObject({ ok: true });
});

test("google failed draft cleanup after send keeps the digest and cannot resend", async () => {
  const f = fixture(); f.fake.setScenario({ ...sendScenario(), "gmail.drafts.delete": { exit: 8 } });
  expect(await f.call(send), "SEND_CLEANUP_FAILURE_CONFIRMED").toMatchObject({ ok: true, result: { draft_deleted: null } });
  expect(await f.call(send), "SEND_CLEANUP_FAILURE_NO_REPLAY").toMatchObject({ ok: false, error: { code: "already_sent" } });
  expect(f.cards, "SEND_CLEANUP_REPLAY_NO_CARD").toHaveLength(1);
  expect(f.fake.callsOf("gmail.send")).toHaveLength(1); expect(f.fake.callsOf("gmail.drafts.delete")).toHaveLength(1);
});

test("google ambiguous send stays reserved across ledger reopen and never deletes or resends", async () => {
  const f = fixture(); f.fake.setScenario({ ...sendScenario(), "gmail.send": { stdout: { messageId: SECOND, extra: "unknown" } } });
  expect(await f.call(send), "SEND_AMBIGUOUS_RESULT").toMatchObject({ ok: false, error: { code: "outcome_unknown" } });
  expect(await f.call(send), "SEND_PENDING_NO_REPLAY").toMatchObject({ ok: false, error: { code: "outcome_unknown", reason: "digest_pending" } });
  expect(f.fake.callsOf("gmail.send")).toHaveLength(1); expect(f.fake.callsOf("gmail.drafts.delete")).toHaveLength(0);
});

test("google send reserves before spawn and confirms before deleting", async () => {
  const f = fixture(), execute = f.transport.execute.bind(f.transport), observed: string[] = [];
  const digest = new Bun.CryptoHasher("sha256").update(Buffer.from(rawDraft().draft.message.raw, "base64url")).digest("hex");
  const spawn = Bun.spawn;
  const spy = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
    if (Array.isArray(args[0]) && args[0].includes("--enable-commands-exact=gmail.send")) {
      observed.push(f.ledger.sentDigest("odysseus@example.com", digest)!);
      expect(f.db.query("SELECT json_extract(payload,'$.decision') decision FROM governance_events WHERE kind='outward_action'").all(), "SEND_DECISION_BEFORE_SPAWN").toEqual([{ decision: "approved" }]);
    }
    return Reflect.apply(spawn, Bun, args);
  }) as typeof Bun.spawn); cleanups.push(() => spy.mockRestore());
  f.transport.execute = (async (operation, input, execution) => {
    if (operation === "gmail.draft.delete") observed.push(f.ledger.sentDigest("odysseus@example.com", digest)!);
    return execute(operation, input, execution);
  }) as typeof f.transport.execute;
  const result = await f.call(send);
  expect(observed, "SEND_DURABLE_ORDER").toEqual(["pending", "sent"]);
  expect(result).toMatchObject({ ok: true });
});

for (const site of ["sentDigest", "reserveSentDigest", "confirmSentDigest"] as const) test(`google send ledger ${site} failure contains only sends`, async () => {
  const f = fixture();
  const spy = spyOn(f.ledger, site).mockImplementation(() => { throw new Error("Ithaca store unavailable"); });
  cleanups.push(() => spy.mockRestore());
  expect(await f.call(send), `SEND_STORE_${site}`).toMatchObject({ ok: false, error: { code: site === "confirmSentDigest" ? "outcome_unknown" : "unavailable" } });
  expect(f.fake.callsOf("gmail.send")).toHaveLength(site === "confirmSentDigest" ? 1 : 0);
  expect(f.fake.callsOf("gmail.drafts.delete")).toHaveLength(0);
  spy.mockRestore();
  expect(await f.call(trash), "DIGEST_STORE_OTHER_OPERATION_USABLE").toMatchObject({ ok: true });
  if (site !== "confirmSentDigest") expect(await f.call(send), "DIGEST_STORE_REPAIRED").toMatchObject({ ok: true });
  else expect(await f.call(send)).toMatchObject({ ok: false, error: { reason: "digest_pending" } });
});

for (const [call, operation, command] of [[remove, "gmail.draft.delete", "gmail.drafts.delete"], [trash, "gmail.trash", "gmail.trash"]] as const)
  test(`google ${operation} is card only without standing choices`, async () => {
    const f = fixture();
    expect(await f.call(call), "IRREVERSIBLE_CARD_ONLY").toMatchObject({ ok: true, operation, effect: "irreversible", admission: "card" });
    expect(f.cards).toHaveLength(1);
    expect(f.cards[0]!.input, "IRREVERSIBLE_NO_STANDING").toMatchObject({ offers: { allow_always: false, allow_for_session: false } });
    expect(f.fake.callsOf(command)).toHaveLength(1);
    expect(f.db.query("SELECT * FROM google_inverses").all()).toEqual([]);
    f.answer(async () => ({ behavior: "allow", always: true }));
    expect(await f.call(call), "IRREVERSIBLE_STANDING_REFUSED").toMatchObject({ ok: false, error: { reason: "standing_choice_unavailable" } });
    expect(f.fake.callsOf(command)).toHaveLength(1);
  });

for (const [call, command] of [[send, "gmail.send"], [remove, "gmail.drafts.delete"], [trash, "gmail.trash"]] as const)
  test(`google ${command} hidden target refuses before a card`, async () => {
    const f = fixture("allow", { hidden: ["Label_12"] });
    expect(await f.call(call), "IRREVERSIBLE_HIDDEN_TARGET").toMatchObject({ ok: false, error: { code: "not_found", reason: null } });
    expect(f.cards).toHaveLength(0); expect(f.fake.callsOf(command)).toHaveLength(0);
  });

test("google send cleanup refuses changed draft bytes and stale authority", async () => {
  for (const change of ["draft", "thread", "safety"] as const) {
    const f = fixture(), execute = f.transport.execute.bind(f.transport);
    f.transport.execute = (async (operation, input, execution) => {
      const answer = await execute(operation, input, execution);
      if (operation === "gmail.draft.send") {
        if (change === "draft") setRaw(f, mail("To: penelope@example.com", "Keep this new draft."));
        else if (change === "thread") {
          const draft = rawDraft(); draft.draft.message.threadId = SECOND;
          f.fake.setScenario({ ...sendScenario(), [`gmail.drafts.get ${DRAFT}`]: { stdout: draft } });
        } else f.change("safety");
      }
      return answer;
    }) as typeof f.transport.execute;
    expect(await f.call(send), `SEND_CLEANUP_${change}`).toMatchObject({ ok: true, result: { draft_deleted: false } });
    expect(f.fake.callsOf("gmail.send")).toHaveLength(1); expect(f.fake.callsOf("gmail.drafts.delete")).toHaveLength(0);
  }
});

test("google send rechecks safety after transport waits without reserving or spawning", async () => {
  const f = fixture(), execute = f.transport.execute.bind(f.transport);
  f.transport.execute = (async (operation, input, execution) => {
    if (operation === "gmail.draft.send") { await Promise.resolve(); f.change("safety"); }
    return execute(operation, input, execution);
  }) as typeof f.transport.execute;
  expect(await f.call(send), "SEND_FINAL_ADMISSION").toMatchObject({ ok: false, error: { reason: "safety_changed" } });
  expect(f.fake.callsOf("gmail.send")).toHaveLength(0);
  const digest = new Bun.CryptoHasher("sha256").update(Buffer.from(rawDraft().draft.message.raw, "base64url")).digest("hex");
  expect(f.ledger.sentDigest("odysseus@example.com", digest), "SEND_REFUSAL_NO_RESERVATION").toBeNull();
});

test("google send dispatch refuses a digest reserved by another host after approval", async () => {
  const f = fixture(), execute = f.transport.execute.bind(f.transport);
  const digest = new Bun.CryptoHasher("sha256").update(Buffer.from(rawDraft().draft.message.raw, "base64url")).digest("hex");
  f.transport.execute = (async (operation, input, execution) => {
    if (operation === "gmail.draft.send") f.ledger.reserveSentDigest("odysseus@example.com", digest, 1);
    return execute(operation, input, execution);
  }) as typeof f.transport.execute;
  const result = await f.call(send);
  expect(result, "SEND_ATOMIC_RESERVATION").toMatchObject({ ok: false, error: { code: "outcome_unknown", reason: "digest_pending", message: expect.stringContaining("Sent folder") } });
  expect(f.db.query("SELECT json_extract(payload,'$.decision') decision FROM governance_events WHERE kind='outward_action' ORDER BY id").all(), "SEND_RESERVATION_REFUSAL_RECORDED").toEqual([{ decision: "approved" }, { decision: "refused" }]);
  expect(f.fake.callsOf("gmail.send")).toHaveLength(0); expect(f.fake.callsOf("gmail.drafts.delete")).toHaveLength(0);
});

import * as decisions from "../../common/src/google/decision.js";
for (const call of [send, remove, trash]) test(`google ${call.tool} refuses an irreversible dispatch without a card`, async () => {
  const f = fixture(), original = decisions.decideGoogleCall;
  const spy = spyOn(decisions, "decideGoogleCall").mockImplementation((...args) => {
    const result = original(...args);
    return result.outcome === "needs_card" ? { ...result, outcome: "admitted", admission: "policy" } : result;
  }); cleanups.push(() => spy.mockRestore());
  expect(await f.call(call), "IRREVERSIBLE_DISPATCH_CARD_REQUIRED").toMatchObject({ ok: false, error: { reason: "card_required" } });
  expect(f.cards).toHaveLength(0);
  expect(f.fake.calls().filter(c => ["gmail.send", "gmail.trash", "gmail.drafts.delete"].includes(c.command))).toHaveLength(0);
});

test("google send refuses the complete card byte bound even with a bounded body", async () => {
  const f = fixture();
  const refs = Array.from({ length: 65 }, (_, i) => `<${"o".repeat(1890)}${i}@example.com>`).join(" ");
  setRaw(f, mail(`To: penelope@example.com\r\nIn-Reply-To: ${refs}\r\nReferences: ${refs}`, "O".repeat(32_768)));
  expect(await f.call(send), "SEND_COMPLETE_CARD_BOUND").toMatchObject({ ok: false, error: { code: "draft_not_displayable", reason: "card_too_large" } });
  expect(f.cards).toHaveLength(0); expect(f.fake.callsOf("gmail.send")).toHaveLength(0);
});


test("google delete refuses bytes changed while its card is open", async () => {
  const f = fixture();
  f.answer(async () => { setRaw(f, mail("To: penelope@example.com", "Keep this new draft.")); return { behavior: "allow" }; });
  expect(await f.call(remove), "DELETE_CARD_DIGEST_BOUND").toMatchObject({ ok: false, error: { reason: "prepared_changed" } });
  expect(f.fake.callsOf("gmail.drafts.delete")).toHaveLength(0);
});

for (const call of [{ tool: "brain_google_gmail_draft", input: { action: "update", draft_id: DRAFT, body: "Keep weaving." } } as GoogleToolCall, remove])
  test(`google ${call === remove ? "delete" : "save"} card opened before send refuses under its lock`, async () => {
    const f = fixture();
    const resolvers: Array<(d: PermissionDecision) => void> = [];
    let shown!: () => void;
    let nextCard = new Promise<void>(resolve => { shown = resolve; });
    f.answer(() => new Promise(resolve => { resolvers.push(resolve); shown(); }));
    const writing = f.call(call);
    await nextCard;
    nextCard = new Promise<void>(resolve => { shown = resolve; });
    const sending = f.call(send);
    await nextCard;
    resolvers[0]!({ behavior: "allow" });
    let written: Awaited<typeof writing>;
    try { written = await writing; } finally { resolvers[1]!({ behavior: "allow" }); }
    const sent = await sending;
    expect(written, "OLDER_CARD_LOCK_REFUSAL").toMatchObject({ ok: false, error: { code: "draft_locked" } });
    expect(f.fake.callsOf("gmail.drafts.update"), "OLDER_CARD_NO_SAVE").toHaveLength(0);
    expect(sent, "SEND_SURVIVES_OLDER_CARD").toMatchObject({ ok: true });
    expect(f.fake.callsOf("gmail.drafts.delete"), "ONLY_SEND_CLEANUP_DELETES").toHaveLength(1);
  });

for (const [exit, cause] of [[7, "rate_limited"], [2, "usage"], [4, "auth_required"], [10, "config"], [5, "not_found"], [6, "forbidden"], [null, "spawn_failed"]] as const)
  test(`google definitive send failure ${cause} permits a newly approved retry`, async () => {
    const f = fixture();
    let spawnSpy: ReturnType<typeof spyOn> | undefined;
    if (exit === null) {
      const spawn = Bun.spawn;
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
        if (Array.isArray(args[0]) && args[0].includes("--enable-commands-exact=gmail.send")) throw new Error("Ithaca fake spawn failure");
        return Reflect.apply(spawn, Bun, args);
      }) as typeof Bun.spawn);
      cleanups.push(() => spawnSpy?.mockRestore());
    } else f.fake.setScenario({ ...sendScenario(), "gmail.send": { exit } });
    expect(await f.call(send)).toMatchObject({ ok: false });
    spawnSpy?.mockRestore();
    const ledgerDb = new Database(f.ledgerPath);
    try { expect(ledgerDb.query("SELECT state,cause FROM sent_digests").all(), "SEND_FAILURE_CAUSE_DURABLE").toEqual([{ state: "pending", cause }]); }
    finally { ledgerDb.close(); }
    f.fake.setScenario(sendScenario());
    expect(await f.call(send), "SEND_DEFINITIVE_FAILURE_RETRY").toMatchObject({ ok: true });
    expect(f.cards, "SEND_RETRY_FRESH_CARD").toHaveLength(2);
    expect(f.fake.callsOf("gmail.send")).toHaveLength(exit === null ? 1 : 2);
    expect(await f.call(send)).toMatchObject({ ok: false, error: { code: "already_sent" } });
    expect(f.cards).toHaveLength(2);
  });

for (const exit of [1, 8]) test(`google ambiguous send exit ${exit} stays pending with its cause`, async () => {
  const f = fixture(); f.fake.setScenario({ ...sendScenario(), "gmail.send": { exit } });
  expect(await f.call(send)).toMatchObject({ ok: false, error: { code: "outcome_unknown" } });
  const ledgerDb = new Database(f.ledgerPath);
  try { expect(ledgerDb.query("SELECT state,cause FROM sent_digests").all()).toEqual([{ state: "pending", cause: exit === 1 ? "error" : "retryable" }]); }
  finally { ledgerDb.close(); }
  expect(await f.call(send), "SEND_AMBIGUOUS_NOT_RELEASED").toMatchObject({ ok: false, error: { reason: "digest_pending", message: expect.stringContaining("edit the draft") } });
  expect(f.cards).toHaveLength(1); expect(f.fake.callsOf("gmail.send")).toHaveLength(1);
});

test("google unavailable dispatch reservation records refusal with no dispatch claim", async () => {
  const f = fixture();
  const spy = spyOn(f.ledger, "reserveSentDigest").mockImplementation(() => { throw new Error("Ithaca store unavailable"); });
  cleanups.push(() => spy.mockRestore());
  expect(await f.call(send), "SEND_STORE_REFUSAL_MESSAGE").toMatchObject({ ok: false, error: { reason: "digest_store_unavailable", message: expect.stringContaining("nothing was sent") } });
  expect(f.db.query("SELECT json_extract(payload,'$.decision') decision FROM governance_events WHERE kind='outward_action' ORDER BY id").all(), "SEND_STORE_REFUSAL_RECORDED").toEqual([{ decision: "approved" }, { decision: "refused" }]);
  expect(f.fake.callsOf("gmail.send")).toHaveLength(0);
});

for (const [response, deleted] of [[{ exit: 6 }, false], [{ exit: 8 }, null], [{ signal: "SIGTERM" }, null], [{ stdout: { deleted: true, draftId: DRAFT, unexpected: true } }, null]] as const)
  test(`google cleanup reports ${JSON.stringify(response)} honestly`, async () => {
    const f = fixture(); f.fake.setScenario({ ...sendScenario(), "gmail.drafts.delete": response });
    expect(await f.call(send), "SEND_CLEANUP_TRI_STATE").toMatchObject({ ok: true, result: { draft_deleted: deleted } });
    expect(await f.call(send)).toMatchObject({ ok: false, error: { code: "already_sent" } });
  });

test("google oversized subject names its card schema field", async () => {
  const f = fixture(); setRaw(f, mail().replace("Subject: Ithaca", `Subject: ${"O".repeat(501)}`));
  expect(await f.call(send), "SEND_CARD_SCHEMA_REASON").toMatchObject({ ok: false, error: { reason: "card_schema", message: expect.stringContaining("subject") } });
  expect(f.cards).toHaveLength(0); expect(f.fake.callsOf("gmail.send")).toHaveLength(0);
});
