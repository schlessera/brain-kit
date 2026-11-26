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
import { createGoogleStateWrites } from "../src/google/state-writes.js";
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
  const dir = mkdtempSync(resolve("tmp/google-reversible-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = openGoogleLedger(resolve(dir, "ledger.db")); cleanups.push(() => ledger.close());
  const fake = createFakeGog(writesScenario()); cleanups.push(() => fake.dispose());
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
      isDraftLocked: () => false, preparedWrites: createGmailWriteFactories({ db, credential, brainId: "brain" }) } });
  cleanups.push(() => host.close?.());
  return { db, fake, transport, turn, cards, ledger, owner, policy, state, call: (call: GoogleToolCall) => host.call(turn, call),
    answer: (next: typeof answer) => { answer = next; },
    change: (kind: string) => { if (kind === "taint") tainted = true; if (kind === "untaint") tainted = false; if (kind === "routing") routing = "recipient_restricted";
      if (kind === "policy") current = googlePolicy(mode === "ask" ? "allow" : "ask"); if (kind === "safety") safety = { ...safety, recordingAvailable: false }; } };
}
const archive: GoogleToolCall = { tool: "brain_google_gmail_modify", input: { message_ids: [FIRST, SECOND], remove_label_ids: ["INBOX"] } };
const create: GoogleToolCall = { tool: "brain_google_gmail_draft", input: { action: "create", to: ["penelope@example.com"], subject: "Ithaca", body: "The ship is ready." } };
const update = (body = "The ship is ready."): GoogleToolCall => ({ tool: "brain_google_gmail_draft", input: { action: "update", draft_id: DRAFT, body } });

test("google production modify records the exact inverse before the real fake-process spawn", async () => {
  const f = fixture();
  const spawn = Bun.spawn;
  const observed: unknown[] = [];
  const spy = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
    const argv = args[0];
    if (Array.isArray(argv) && argv.includes("--enable-commands-exact=gmail.batch.modify")) {
      const row = f.db.query("SELECT state,inverse_json FROM google_inverses").get() as { state: string; inverse_json: string };
      observed.push(row);
    }
    return Reflect.apply(spawn, Bun, args);
  }) as typeof Bun.spawn); cleanups.push(() => spy.mockRestore());
  const result = await f.call(archive);
  expect(observed, "REAL_FACTORY_INVERSE_BEFORE_DISPATCH").toEqual([{ state: "prepared", inverse_json: expect.any(String) }]);
  expect(JSON.parse((observed[0] as { inverse_json: string }).inverse_json).changes).toEqual([{ message_id: FIRST, add_label_ids: ["INBOX"], remove_label_ids: [] }]);
  expect(result).toMatchObject({ ok: true, admission: "policy", result: { message_ids: [FIRST] } }); expect(f.cards).toHaveLength(0);
  expect(f.db.query("SELECT state,account_identity FROM google_inverses").get()).toEqual({ state: "confirmed", account_identity: "odysseus@example.com" });
});

test("google read taints the production modify; hidden and item limits refuse without dispatch", async () => {
  const f = fixture();
  expect(await f.call({ tool: "brain_google_gmail_read", input: { target: "message", id: FIRST, view: "content" } })).toMatchObject({ ok: true });
  expect(await f.call(archive)).toMatchObject({ ok: true, admission: "card" }); expect(f.cards).toHaveLength(1);
  for (const options of [{ hidden: ["Label_12"] }, { items: 1 }]) {
    const refused = fixture("allow", options);
    expect(await refused.call(archive), "REAL_FACTORY_HIDDEN_OR_LIMIT").toMatchObject({ ok: false, error: "hidden" in options ? { code: "not_found", reason: null } : { code: "policy_denied", reason: "items_per_call" } });
    expect(refused.fake.callsOf("gmail.batch.modify")).toHaveLength(0); expect(refused.cards).toHaveLength(0);
  }
  const limited = fixture("allow", { turn: 2 });
  expect(await limited.call(archive)).toMatchObject({ ok: true, admission: "policy" });
  expect(await limited.call(archive), "REAL_FACTORY_TURN_LIMIT").toMatchObject({ ok: true, admission: "card" });
});

test("google reply approval shows host-composed recipients and full quoted text", async () => {
  const f = fixture("ask"); f.answer(async () => ({ behavior: "deny", message: "Keep the draft" }));
  expect(await f.call({ tool: "brain_google_gmail_draft", input: { action: "reply", message_id: FIRST, body: "Homeward." } })).toMatchObject({ ok: false, error: { code: "approval_declined" } });
  expect(f.cards[0]!.input, "REPLY_CARD_COMPOSED").toMatchObject({ payload: { action: "reply", thread_id: FIRST,
    message: { to: [{ address: "penelope@example.com" }], subject: "Re: Suitors at the hall", body_text: expect.stringContaining("Homeward.\n\n> ") } } });
  expect(f.fake.callsOf("gmail.drafts.create")).toHaveLength(0);
});

test("google draft foreign and changed updates ask; unchanged owned update follows policy and snapshots", async () => {
  const foreign = fixture();
  expect(await foreign.call(update()), "FOREIGN_UPDATE_ASKS").toMatchObject({ ok: true, effect: "irreversible", admission: "card" });
  expect(await foreign.call(update()), "FOREIGN_MATCHING_FINGERPRINT_STILL_ASKS").toMatchObject({ ok: true, effect: "irreversible", admission: "card" });
  expect(foreign.db.query("SELECT snapshot FROM google_inverses").get(), "FOREIGN_UPDATE_SNAPSHOT").toMatchObject({ snapshot: expect.any(Uint8Array) });
  const f = fixture();
  expect(await f.call(create)).toMatchObject({ ok: true, admission: "policy" });
  expect(await f.call(update()), "OWNED_UNCHANGED_POLICY").toMatchObject({ ok: true, effect: "reversible", admission: "policy" });
  f.fake.setScenario({ ...writesScenario(), [`gmail.drafts.get ${DRAFT}`]: { stdout: rawDraft("Keep weaving.") } });
  expect(await f.call(update("Keep weaving.")), "OWNED_CHANGED_ASKS").toMatchObject({ ok: true, effect: "irreversible", admission: "card" });
  const rows = f.db.query("SELECT state,snapshot FROM google_inverses ORDER BY decision_event_id").all() as { state: string; snapshot: Uint8Array | null }[];
  expect(rows.map(r => r.state)).toEqual(["confirmed", "confirmed", "confirmed"]);
  expect(rows[1]!.snapshot).toEqual(Buffer.from(rawDraft().draft.message.raw, "base64url"));
});

test("google write recording failure refuses only this call and recovers after storage repair", async () => {
  const f = fixture(); f.db.exec("CREATE TRIGGER refuse_inverse BEFORE INSERT ON google_inverses BEGIN SELECT RAISE(ABORT,'Ithaca storage unavailable'); END");
  expect(await f.call(archive), "INVERSE_RECORDING_REQUIRED").toMatchObject({ ok: false, error: { reason: "recording_unavailable" } });
  expect(f.fake.callsOf("gmail.batch.modify")).toHaveLength(0);
  f.db.exec("DROP TRIGGER refuse_inverse");
  expect(await f.call(archive)).toMatchObject({ ok: true });
});

for (const kind of ["taint", "routing", "policy", "safety"]) test(`google remembered modify rechecks ${kind} at transport dispatch`, async () => {
  const f = fixture("ask");
  f.ledger.remember({ principal_id: f.owner.id, brain_id: "brain", account_identity: "odysseus@example.com" }, "gmail.modify", ["archive"], Date.now());
  expect(await f.call(archive), "REMEMBERED_POSITIVE_CONTROL").toMatchObject({ ok: true, admission: "remembered_approval" });
  expect(f.cards, "REMEMBERED_CARDLESS_CONTROL").toHaveLength(0);
  const execute = f.transport.execute.bind(f.transport);
  f.transport.execute = (async (operation, input, execution) => {
    if (operation === "gmail.modify") { await Promise.resolve(); f.change(kind); }
    return execute(operation, input, execution);
  }) as typeof f.transport.execute;
  expect(await f.call(archive), "REMEMBERED_FINAL_RECHECK").toMatchObject({ ok: false });
  expect(f.fake.callsOf("gmail.batch.modify"), "REMEMBERED_NO_SPAWN").toHaveLength(1);
  expect(f.cards, "REMEMBERED_NO_FALLBACK_CARD").toHaveLength(0);
  expect(f.db.query("SELECT state FROM google_inverses").all()).toEqual([{ state: "confirmed" }]);
});

test("google oversize composed draft refuses even under allow without a card or write", async () => {
  const f = fixture();
  expect(await f.call({ tool: "brain_google_gmail_draft", input: { action: "reply", message_id: FIRST, body: "H".repeat(32_768) } }), "COMPOSED_CARD_BOUND")
    .toMatchObject({ ok: false, error: { code: "draft_not_displayable", reason: "composed_body_too_large" } });
  expect(f.cards).toHaveLength(0); expect(f.fake.callsOf("gmail.drafts.create")).toHaveLength(0);
});

test("google complete update card byte budget is enforced before asking", async () => {
  const f = fixture();
  const refs = Array.from({ length: 65 }, (_, i) => `<${"o".repeat(1890)}${i}@example.com>`).join(" ");
  const raw = rawDraft();
  raw.draft.message.raw = Buffer.from(`From: odysseus@example.com\r\nTo: penelope@example.com\r\nSubject: Ithaca\r\nIn-Reply-To: ${refs}\r\nReferences: ${refs}\r\nContent-Type: text/plain\r\n\r\nHome`).toString("base64url");
  f.fake.setScenario({ ...writesScenario(), [`gmail.drafts.get ${DRAFT}`]: { stdout: raw } });
  expect(await f.call(update("O".repeat(32_768))), "COMPLETE_CARD_BYTE_BUDGET").toMatchObject({ ok: false, error: { code: "draft_not_displayable", reason: "card_too_large" } });
  expect(f.cards).toHaveLength(0); expect(f.fake.callsOf("gmail.drafts.update")).toHaveLength(0);
});

for (const column of ["session_id", "principal_id", "brain_id", "account_identity", "expires_at"]) test(`google draft provenance isolates ${column}`, async () => {
  const f = fixture();
  expect(await f.call(create)).toMatchObject({ ok: true, admission: "policy" });
  expect(await f.call(update()), "PROVENANCE_MATCHING_CONTROL").toMatchObject({ ok: true, admission: "policy", effect: "reversible" });
  f.db.query("INSERT INTO sessions(id,created_at,last_active_at) VALUES ('aeaea',1,1)").run();
  if (column === "expires_at") f.db.exec("UPDATE google_inverses SET created_at=1,expires_at=2");
  else f.db.query(`UPDATE google_inverses SET ${column}=?`).run(column === "account_identity" ? "penelope@example.com" : "aeaea");
  expect(await f.call(update()), `PROVENANCE_${column.toUpperCase()}_ISOLATED`).toMatchObject({ ok: true, admission: "card", effect: "irreversible" });
  expect(f.cards).toHaveLength(1);
});

for (const kind of ["taint", "safety"]) test(`google session allowance concrete modify rechecks ${kind} at dispatch`, async () => {
  const f = fixture("ask"); f.change("taint");
  const at = Date.now();
  f.db.query(`INSERT INTO google_session_allowances
    (session_id,principal_id,brain_id,account_identity,operation,entity,host_epoch,policy_hash,granted_card_id,granted_at,expires_at,remaining_items)
    VALUES ('ithaca',?,'brain','odysseus@example.com','gmail.modify','archive','ithaca-epoch','ithaca','voyage',?,?,100)`)
    .run(f.owner.id, at, at + 60_000);
  expect(await f.call(archive), "CHAT_ALLOWANCE_POSITIVE_CONTROL").toMatchObject({ ok: true, admission: "session_allowance" });
  expect(f.cards, "CHAT_ALLOWANCE_CARDLESS_CONTROL").toHaveLength(0);
  const execute = f.transport.execute.bind(f.transport);
  f.transport.execute = (async (operation, input, execution) => {
    if (operation === "gmail.modify") { await Promise.resolve(); f.change(kind === "taint" ? "untaint" : "safety"); }
    return execute(operation, input, execution);
  }) as typeof f.transport.execute;
  expect(await f.call(archive), "CHAT_ALLOWANCE_FINAL_RECHECK").toMatchObject({ ok: false });
  expect(f.fake.callsOf("gmail.batch.modify"), "CHAT_ALLOWANCE_NO_SECOND_SPAWN").toHaveLength(1);
  expect(f.cards).toHaveLength(0);
  expect(f.db.query("SELECT state FROM google_inverses").all()).toEqual([{ state: "confirmed" }]);
});

test("google hosted blank body refuses before an admitted decision", async () => {
  const f = fixture();
  expect(await f.call({ tool: "brain_google_gmail_draft", input: { action: "create", to: ["penelope@example.com"], subject: "Ithaca", body: " \n" } }), "HOST_BLANK_BODY")
    .toMatchObject({ ok: false, error: { code: "invalid_input", reason: "draft_body_blank" } });
  expect(f.db.query("SELECT * FROM google_inverses").all()).toEqual([]);
  expect(f.cards).toHaveLength(0); expect(f.fake.callsOf("gmail.drafts.create")).toHaveLength(0);
});

test("google hidden and nonexistent label deltas refuse before admission with identical evidence", async () => {
  const answers: unknown[] = [];
  for (const id of ["Label_12", "Label_77"]) {
    const f = fixture("allow", { hidden: ["Label_12"] });
    const execute = f.transport.execute.bind(f.transport);
    f.transport.execute = (async (operation, input, execution) => {
      if (operation === "gmail.labels.list") expect(f.db.query("SELECT * FROM governance_events").all(), "LABEL_CHECK_BEFORE_DECISION").toEqual([]);
      return execute(operation, input, execution);
    }) as typeof f.transport.execute;
    answers.push(await f.call({ tool: "brain_google_gmail_modify", input: { message_ids: [FIRST], add_label_ids: [id] } }));
    expect(f.fake.callsOf("gmail.labels.list"), "LABEL_REFUSAL_SAME_READ_BOUNDARY").toHaveLength(1);
    expect(f.fake.callsOf("gmail.get")).toHaveLength(0);
    expect(f.db.query("SELECT json_extract(payload,'$.decision') decision FROM governance_events").all()).toEqual([{ decision: "refused" }]);
    expect(f.db.query("SELECT * FROM google_inverses").all()).toEqual([]);
  }
  expect(answers[0], "LABEL_HIDDEN_NOT_FOUND").toMatchObject({ ok: false, error: { code: "not_found", reason: null } });
  expect(answers[1], "LABEL_MISSING_MATCHES_HIDDEN").toEqual(answers[0]);
});
