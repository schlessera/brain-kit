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
  }), () => blocked);
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
  fake.setScenario({ [`gmail.thread.get ${FIRST}`]: { stdout: thread } });
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
  fake.setScenario({ ...writesScenario(), [`gmail.drafts.get ${DRAFT}`]: { stdout: rawDraft(p.payload.message.body_text, "Re: Suitors at the hall") } });
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
  const first = ctx.transport.invoke("gmail.modify", invocation);
  let blocked = false, checked = 0;
  const second = ctx.transport.invoke("gmail.modify", invocation, () => {
    checked++;
    return blocked ? { code: "policy_denied", reason: "safety_changed", message: "Safety changed." } : null;
  });
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
  fake.setScenario({ [`gmail.get ${FIRST}`]: { exit: 5 } });
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
