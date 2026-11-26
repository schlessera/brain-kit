import { afterEach, expect, test } from "bun:test";
import { createGogTransportInternals } from "../src/google/gog/transport.ts";
import { gogInvocation } from "../src/google/gog/argv.ts";
import { createFakeGog, type FakeGog } from "./support/fake-gog.ts";

const fakes: FakeGog[] = [];
afterEach(() => { for (const fake of fakes.splice(0)) fake.dispose(); });

test("google write final admission refuses at the spawn boundary", async () => {
  const fake = createFakeGog({ "gmail.batch.modify": { stdout: {} } }); fakes.push(fake);
  const transport = createGogTransportInternals({ binary: fake.binary, account: "ithaca", environment: fake.environment });
  const blocked = { code: "policy_denied" as const, reason: "safety_changed", message: "Safety changed." };
  const result = await transport.invoke("gmail.modify", gogInvocation("gmail.modify", {
    message_ids: ["19a0c3d2e4f50601"], remove_label_ids: ["INBOX"],
  }), () => blocked, "odysseus@example.com");
  expect(fake.callsOf("gmail.batch.modify"), "FINAL_ADMISSION_NO_SPAWN").toHaveLength(0);
  expect(result).toEqual({ ok: false, error: blocked });
});

import { prepareGmailModify, prepareGmailDraft, GooglePreparationError } from "../src/google/gog/reversible.ts";
import { GOG_WRITE_CODECS } from "../src/google/gog/write-codecs.ts";
import { FIRST, SECOND, DRAFT, fixture, rawDraft, writesScenario } from "./support/gmail-write-fixtures.ts";

function setup(hiddenLabels: string[] = []) {
  const fake = createFakeGog(writesScenario()); fakes.push(fake);
  const transport = createGogTransportInternals({ binary: fake.binary, account: "ithaca", environment: fake.environment, retryDelayMs: 0 });
  return { fake, ctx: { transport, accountIdentity: "odysseus@example.com", hiddenLabels } };
}
const archive = { message_ids: [FIRST, SECOND], remove_label_ids: ["INBOX"] };
test("google modify inverse includes only the changed subset with exact opposite deltas", async () => {
  const { fake, ctx } = setup();
  const p = await prepareGmailModify(ctx, archive);
  expect(p.inverse.inverse, "MODIFY_EXACT_INVERSE").toEqual({ kind: "gmail.modify", changes: [{ message_id: FIRST, add_label_ids: ["INBOX"], remove_label_ids: [] }] });
  expect(p.inverse.precondition.after).toEqual([{ message_id: FIRST, label_ids: [] }]);
  expect(await p.execute(() => null)).toEqual({ ok: true, result: { message_ids: [FIRST], add_label_ids: [], remove_label_ids: ["INBOX"] } });
  expect(fake.callsOf("gmail.batch.modify")).toHaveLength(1);
  expect(fake.calls().every(c => c.argv.includes("--account=odysseus@example.com")), "RESOLVED_ACCOUNT_ARGV").toBe(true);
});

test("google hidden sibling and hidden delta refuse before any write", async () => {
  const { ctx, fake } = setup(["Label_12"]);
  await expect(prepareGmailModify(ctx, archive)).rejects.toMatchObject({ error: { code: "not_found", reason: null } });
  await expect(prepareGmailModify({ ...ctx, hiddenLabels: ["Label_99"] }, { message_ids: [FIRST], add_label_ids: ["Label_99"] }))
    .rejects.toMatchObject({ error: { code: "not_found", reason: null } });
  expect(fake.callsOf("gmail.batch.modify")).toHaveLength(0);
  expect(await prepareGmailModify({ ...ctx, hiddenLabels: [] }, archive)).toBeDefined();
});

test("google modify refuses unsupported system labels and too many resolved messages", async () => {
  const { ctx, fake } = setup();
  await expect(prepareGmailModify(ctx, { message_ids: [FIRST], add_label_ids: ["TRASH"] })).rejects.toMatchObject({ error: { reason: "unsupported_label" } });
  const thread = fixture("thread-hall"); thread.thread.messages = Array.from({ length: 26 }, (_, i) => ({ ...thread.thread.messages[0], id: (0x19a0c3d2e4f50600n + BigInt(i)).toString(16) }));
  fake.setScenario({ ...writesScenario(), [`gmail.thread.get ${FIRST}`]: { stdout: thread } });
  await expect(prepareGmailModify(ctx, { thread_ids: [FIRST], remove_label_ids: ["INBOX"] })).rejects.toMatchObject({ error: { reason: "items_per_call" } });
  expect(fake.callsOf("gmail.batch.modify")).toHaveLength(0);
});

test("google write codecs reject unexpected keys, invalid ids and inconsistent counts", () => {
  expect(GOG_WRITE_CODECS["gmail.modify"](fixture("modify"))).toEqual({ message_ids: [FIRST, SECOND], add_label_ids: [], remove_label_ids: ["INBOX"] });
  expect(GOG_WRITE_CODECS["gmail.draft.save"](fixture("draft-save"))).toEqual({ draft_id: DRAFT, message_id: "19a0c3d2e4f50800", thread_id: FIRST });
  for (const value of [{ ...fixture("modify"), count: 1 }, { ...fixture("modify"), extra: "Ithaca" }, { ...fixture("modify"), modified: ["bad"] }])
    expect(() => GOG_WRITE_CODECS["gmail.modify"](value)).toThrow();
  for (const value of [{ ...fixture("draft-save"), attachments: [] }, { ...fixture("draft-save"), message: null }, { ...fixture("draft-save"), draftId: "bad" },
    { ...fixture("draft-save"), message: { ...fixture("draft-save").message, unexpected: "Ithaca" } }])
    expect(() => GOG_WRITE_CODECS["gmail.draft.save"](value)).toThrow();
});

test("google reply composes recipients and quoted text on the host and sends only stdin text", async () => {
  const { fake, ctx } = setup();
  const p = await prepareGmailDraft(ctx, { action: "reply", message_id: FIRST, body: "The ship is ready.", reply_all: true }, { createdByBrainKit: false, fingerprint: null });
  expect(p.payload.message.to.map(m => m.address), "HOST_REPLY_RECIPIENTS").toEqual(["penelope@example.com"]);
  expect(p.payload.message.body_text, "HOST_REPLY_QUOTE").toContain("> ");
  fake.setScenario({ ...writesScenario(), [`gmail.drafts.get ${DRAFT}`]: { stdout: rawDraft(p.payload.message.body_text, "Re: Suitors at the hall", "penelope@example.com", p.payload.message) } });
  expect(await p.execute(() => null)).toMatchObject({ ok: true, result: { draft_id: DRAFT, fingerprint: expect.any(String) } });
  const call = fake.callsOf("gmail.drafts.create")[0]!;
  expect(call.argv.join(" ")).not.toMatch(/--reply-all|--quote/);
  expect(call.argv).toContain(`--to=penelope@example.com`);
  expect(call.argv).toContain("--body-file=-");
  expect(Buffer.from(call.stdin_base64, "base64").toString()).toBe(p.payload.message.body_text);
});

test("google draft update takes a raw snapshot and uses current and recorded fingerprints", async () => {
  const { ctx } = setup();
  const p = await prepareGmailDraft(ctx, { action: "update", draft_id: DRAFT, subject: "Home" }, { createdByBrainKit: true, fingerprint: "a".repeat(64) });
  expect(p.inverse.snapshot, "UPDATE_SNAPSHOT").toEqual(Buffer.from(rawDraft().draft.message.raw, "base64url"));
  expect(p.classificationFacts.gmail!.draft).toMatchObject({ created_by_brain_kit: true, current_fingerprint: expect.any(String), recorded_fingerprint: "a".repeat(64) });
  expect(p.classificationFacts.gmail!.draft!.current_fingerprint).not.toBe("a".repeat(64));
  expect(p.payload.message).toMatchObject({ subject: "Home", body_text: "The ship is ready.\n" });
});

test("google draft refuses unrenderable snapshots and unconfirmed post-write contents", async () => {
  const { fake, ctx } = setup();
  const bad = rawDraft(); bad.draft.message.raw = Buffer.from("From: odysseus@example.com\r\nTo: penelope@example.com\r\nSubject: Ithaca\r\nContent-Type: multipart/alternative; boundary=ithaca\r\n\r\n--ithaca\r\nContent-Type: text/plain\r\n\r\nHome\r\n--ithaca\r\nContent-Type: text/html\r\n\r\n<p>Ithaca</p>\r\n--ithaca--\r\n").toString("base64url");
  fake.setScenario({ ...writesScenario(), [`gmail.drafts.get ${DRAFT}`]: { stdout: bad } });
  await expect(prepareGmailDraft(ctx, { action: "update", draft_id: DRAFT, body: "Home" }, { createdByBrainKit: false, fingerprint: null })).rejects.toBeInstanceOf(GooglePreparationError);
  expect(fake.callsOf("gmail.drafts.update")).toHaveLength(0);
  fake.setScenario(writesScenario());
  const p = await prepareGmailDraft(ctx, { action: "create", to: ["penelope@example.com"], subject: "Ithaca", body: "A different message." }, { createdByBrainKit: false, fingerprint: null });
  expect(await p.execute(() => null), "POSTWRITE_MISMATCH_UNKNOWN").toMatchObject({ ok: false, error: { code: "outcome_unknown" } });
  expect(fake.callsOf("gmail.drafts.create")).toHaveLength(1);
});

test("google queued write rechecks admission after its semaphore wait", async () => {
  const { fake, ctx } = setup();
  fake.setScenario({ "gmail.batch.modify": { stdout: fixture("modify"), wait_for: fake.path("open") } });
  const invocation = gogInvocation("gmail.modify", archive);
  const first = ctx.transport.invoke("gmail.modify", invocation, () => null, ctx.accountIdentity);
  let blocked = false, checked = 0;
  const second = ctx.transport.invoke("gmail.modify", invocation, () => {
    checked++;
    return blocked ? { code: "policy_denied", reason: "safety_changed", message: "Safety changed." } : null;
  }, ctx.accountIdentity);
  try {
    const deadline = Date.now() + watchdogMs(10_000);
    while (!fake.callsOf("gmail.batch.modify").length && Date.now() < deadline) await Bun.sleep(5);
    expect(fake.callsOf("gmail.batch.modify")).toHaveLength(1);
    expect(checked, "ADMISSION_NOT_BEFORE_WAIT").toBe(0);
    blocked = true;
  } finally { await Bun.write(fake.path("open"), ""); }
  await first;
  expect(await second, "ADMISSION_AFTER_WAIT").toMatchObject({ ok: false, error: { reason: "safety_changed" } });
  expect(fake.callsOf("gmail.batch.modify")).toHaveLength(1);
});

test("google failed pre-read refuses one call and does not poison later calls", async () => {
  const { fake, ctx } = setup();
  fake.setScenario({ ...writesScenario(), [`gmail.get ${FIRST}`]: { exit: 5 } });
  await expect(prepareGmailModify(ctx, { message_ids: [FIRST], remove_label_ids: ["INBOX"] })).rejects.toMatchObject({ error: { code: "not_found" } });
  expect(fake.callsOf("gmail.batch.modify")).toHaveLength(0);
  fake.setScenario(writesScenario());
  const p = await prepareGmailModify(ctx, archive);
  expect(await p.execute(() => null)).toMatchObject({ ok: true });
});

test("google malformed write responses remain unknown and are never retried", async () => {
  const { fake, ctx } = setup();
  const p = await prepareGmailModify(ctx, archive);
  fake.setScenario({ "gmail.batch.modify": { stdout: { ...fixture("modify"), count: 1 } } });
  expect(await p.execute(() => null), "WRITE_SHAPE_UNKNOWN").toMatchObject({ ok: false, error: { code: "outcome_unknown" } });
  expect(fake.callsOf("gmail.batch.modify")).toHaveLength(1);
});

import { watchdogMs } from "../../../scripts/test-deadlines.js";

// Round 2: failures retain their cause, label names cannot redirect ids, and
// only a fully described draft may reach admission.
test("google hidden policy preserves target-independent rate limit", async () => {
  const { ctx, fake } = setup(["Label_12"]);
  fake.setScenario({ ...writesScenario(), [`gmail.get ${FIRST}`]: { exit: 7 } });
  await expect(prepareGmailModify(ctx, archive), "PREREAD_RATE_LIMIT_CAUSE").rejects.toMatchObject({ error: { code: "rate_limited", reason: null } });
});

test("google user labels missing hidden and name-colliding refuse at the same preparation boundary", async () => {
  const attempts: { error: unknown; calls: string[][] }[] = [];
  for (const id of ["Label_12", "Label_77"]) {
    const { ctx, fake } = setup(["Label_12"]);
    let error: unknown;
    try { await prepareGmailModify(ctx, { message_ids: [FIRST], add_label_ids: [id] }); }
    catch (e) { error = (e as GooglePreparationError).error; }
    attempts.push({ error, calls: fake.calls().map(c => c.argv) });
    expect(fake.callsOf("gmail.labels.list"), "LABEL_DIRECTORY_BEFORE_REFUSAL").toHaveLength(1);
    expect(fake.callsOf("gmail.get")).toHaveLength(0);
  }
  expect(attempts[0]!.error, "HIDDEN_MISSING_IDENTICAL").toMatchObject({ code: "not_found", reason: null });
  expect(attempts[1], "HIDDEN_MISSING_IDENTICAL").toEqual(attempts[0]);
  const { ctx, fake } = setup();
  const labels = fixture("labels-list"); labels.labels.push({ id: "Label_77", name: "lAbEl_12", type: "user" });
  fake.setScenario({ ...writesScenario(), "gmail.labels.list": { stdout: labels } });
  await expect(prepareGmailModify(ctx, { message_ids: [FIRST], add_label_ids: ["Label_12"] }), "LABEL_NAME_COLLISION").rejects.toMatchObject({ error: { code: "not_found", reason: null } });
  fake.setScenario(writesScenario());
  const before = await prepareGmailModify(ctx, { message_ids: [FIRST], add_label_ids: ["Label_12"] });
  labels.labels.pop(); labels.labels.find((l: { id: string }) => l.id === "Label_12").name = "Ithaca/Weaving";
  fake.setScenario({ ...writesScenario(), "gmail.labels.list": { stdout: labels } });
  const after = await prepareGmailModify(ctx, { message_ids: [FIRST], add_label_ids: ["Label_12"] });
  expect(after.inverse.precondition, "LABEL_DIRECTORY_PRECONDITION").not.toEqual(before.inverse.precondition);
});

test("google update preserves omitted recipients and rejects blank subject before dispatch", async () => {
  const { ctx, fake } = setup();
  fake.setScenario({ ...writesScenario(), [`gmail.drafts.get ${DRAFT}`]: { stdout: rawDraft("Home", "Ithaca", "") } });
  const p = await prepareGmailDraft(ctx, { action: "update", draft_id: DRAFT, body: "Home" }, { createdByBrainKit: false, fingerprint: null });
  expect(p.payload.message.to, "UPDATE_OMITTED_EMPTY_TO").toEqual([]);
  expect(await p.execute(() => null)).toMatchObject({ ok: true });
  const argv = fake.callsOf("gmail.drafts.update")[0]!.argv;
  expect(argv.some(a => /^--(to|cc|bcc)=/.test(a)), "UPDATE_OMITTED_RECIPIENT_ARGV").toBe(false);
  // Upstream validate() requires --subject even for a body-only update.
  expect(argv, "UPDATE_CARRIED_SUBJECT").toContain("--subject=Ithaca");
  fake.setScenario({ ...writesScenario(), [`gmail.drafts.get ${DRAFT}`]: { stdout: rawDraft("Home", " ") } });
  await expect(prepareGmailDraft(ctx, { action: "update", draft_id: DRAFT, body: "Home" }, { createdByBrainKit: false, fingerprint: null }), "BLANK_SUBJECT_BEFORE_ADMISSION")
    .rejects.toMatchObject({ error: { code: "invalid_input", reason: "draft_subject_blank" } });
});

for (const body of ["", " \n\t"]) test(`google draft blank body refuses before admission ${JSON.stringify(body)}`, async () => {
  const { ctx, fake } = setup();
  await expect(prepareGmailDraft(ctx, { action: "create", to: ["penelope@example.com"], subject: "Ithaca", body }, { createdByBrainKit: false, fingerprint: null }), "BLANK_BODY_BEFORE_ADMISSION")
    .rejects.toMatchObject({ error: { code: "invalid_input", reason: "draft_body_blank" } });
  expect(fake.calls()).toHaveLength(0);
});

test("google reply threading is composed and verified from source headers", async () => {
  const { ctx, fake } = setup();
  const thread = fixture("thread-hall");
  thread.thread.messages[0].payload.headers.push({ name: "References", value: "<raft@example.com>" });
  fake.setScenario({ ...writesScenario(), [`gmail.thread.get ${FIRST}`]: { stdout: thread } });
  const p = await prepareGmailDraft(ctx, { action: "reply", message_id: FIRST, body: "Home" }, { createdByBrainKit: false, fingerprint: null });
  expect(p.payload.message, "REPLY_THREADING_CARD").toMatchObject({ in_reply_to: ["<loom-0712@example.com>"], references: ["<raft@example.com>", "<loom-0712@example.com>"] });
  const after = rawDraft(p.payload.message.body_text, p.payload.message.subject!);
  fake.setScenario({ ...writesScenario(), [`gmail.drafts.get ${DRAFT}`]: { stdout: after } });
  expect(await p.execute(() => null), "REPLY_THREADING_MISMATCH").toMatchObject({ ok: false, error: { code: "outcome_unknown" } });
  after.draft.message.raw = Buffer.from(Buffer.from(after.draft.message.raw, "base64url").toString().replace("MIME-Version:", "In-Reply-To: <loom-0712@example.com>\r\nReferences: <raft@example.com> <loom-0712@example.com>\r\nMIME-Version:")).toString("base64url");
  fake.setScenario({ ...writesScenario(), [`gmail.drafts.get ${DRAFT}`]: { stdout: after } });
  expect(await p.execute(() => null), "REPLY_THREADING_CONFIRMED").toMatchObject({ ok: true });
});

test("google reply empty recipient and oversized quote have precise reasons", async () => {
  const { ctx, fake } = setup();
  const thread = fixture("thread-hall");
  thread.thread.messages[0].payload.headers.find((h: { name: string }) => h.name === "From").value = "odysseus@example.com";
  fake.setScenario({ ...writesScenario(), [`gmail.thread.get ${FIRST}`]: { stdout: thread } });
  await expect(prepareGmailDraft(ctx, { action: "reply", message_id: FIRST, body: "Home" }, { createdByBrainKit: false, fingerprint: null }), "REPLY_NO_RECIPIENT_REASON")
    .rejects.toMatchObject({ error: { code: "invalid_input", reason: "reply_no_recipient" } });
  fake.setScenario(writesScenario());
  for (const input of [{ action: "reply" as const, message_id: FIRST, body: "H".repeat(32768) }, { action: "create" as const, to: ["penelope@example.com"], subject: "Ithaca", quote_message_id: FIRST, body: "H".repeat(32768) }])
    await expect(prepareGmailDraft(ctx, input, { createdByBrainKit: false, fingerprint: null }), "COMPOSED_BODY_LIMIT_REASON")
      .rejects.toMatchObject({ error: { code: "draft_not_displayable", reason: "composed_body_too_large" } });
});

test("google invoke requires both final admission and real account for writes", async () => {
  const { ctx, fake } = setup();
  const transport = ctx.transport as ReturnType<typeof createGogTransportInternals>;
  const call = gogInvocation("gmail.modify", archive);
  expect(await transport.invoke("gmail.modify", call, undefined, ctx.accountIdentity), "INVOKE_REQUIRES_ADMISSION").toMatchObject({ ok: false, error: { reason: "missing_admission" } });
  expect(await transport.invoke("gmail.modify", call, () => null), "INVOKE_REQUIRES_ACCOUNT").toMatchObject({ ok: false, error: { reason: "missing_admission" } });
  expect(fake.calls()).toHaveLength(0);
});

for (const kind of ["missing_id", "bad_references", "unsent"]) test(`google reply refuses unrepresentable threading ${kind}`, async () => {
  const { ctx, fake } = setup(); const thread = fixture("thread-hall"); const source = thread.thread.messages[0];
  if (kind === "missing_id") source.payload.headers = source.payload.headers.filter((h: { name: string }) => h.name !== "Message-ID");
  if (kind === "bad_references") source.payload.headers.push({ name: "References", value: "not-a-message-id" });
  if (kind === "unsent") source.labelIds.push("DRAFT");
  fake.setScenario({ ...writesScenario(), [`gmail.thread.get ${FIRST}`]: { stdout: thread } });
  await expect(prepareGmailDraft(ctx, { action: "reply", message_id: FIRST, body: "Home" }, { createdByBrainKit: false, fingerprint: null }), `REPLY_THREADING_${kind.toUpperCase()}`)
    .rejects.toMatchObject({ error: { reason: "reply_threading_unreadable" } });
  expect(fake.callsOf("gmail.drafts.create")).toHaveLength(0);
});
