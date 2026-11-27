import { afterEach, expect, test } from "bun:test";
import { createGogTransportInternals } from "../src/google/gog/transport.js";
import { GOG_WRITE_CODECS } from "../src/google/gog/write-codecs.js";
import { prepareGmailDelete, prepareGmailTrash } from "../src/google/gog/irreversible.js";
import { FIRST, SECOND, DRAFT, fixture, writesScenario } from "./support/gmail-write-fixtures.js";
import { createFakeGog, type FakeGog } from "./support/fake-gog.js";

const fakes: FakeGog[] = [];
afterEach(() => { for (const fake of fakes.splice(0)) fake.dispose(); });
function setup() {
  const fake = createFakeGog(writesScenario()); fakes.push(fake);
  const transport = createGogTransportInternals({ binary: fake.binary, account: "ithaca", environment: fake.environment });
  return { fake, transport, ctx: { transport, accountIdentity: "odysseus@example.com", hiddenLabels: [] } };
}
const cases = [
  ["gmail.draft.send", "gmail.send", { raw: new TextEncoder().encode("From: odysseus@example.com\r\n\r\nHome"), thread_id: FIRST }, { from: "odysseus@example.com", messageId: SECOND, threadId: FIRST }, { message_id: SECOND, thread_id: FIRST }],
  ["gmail.draft.delete", "gmail.drafts.delete", { draft_id: DRAFT }, { deleted: true, draftId: DRAFT }, { draft_id: DRAFT }],
  ["gmail.trash", "gmail.trash", { message_ids: [FIRST, SECOND] }, { action: "trashed", count: 2, addedLabels: ["TRASH"], removedLabels: ["INBOX"] }, { count: 2 }],
] as const;
for (const [operation, command, input, response, value] of cases) {
  test(`google ${operation} strict codec and discipline`, async () => {
    const { fake, transport } = setup();
    const execution = { accountIdentity: "odysseus@example.com", finalAdmission: () => null };
    expect(await transport.execute(operation, input as never, execution), "IRREVERSIBLE_CODEC_SUCCESS").toEqual({ ok: true, value });
    const call = fake.callsOf(command)[0]!;
    expect(call.argv).toContain(`--enable-commands-exact=${command}`);
    expect(call.argv).toContain("--account=odysseus@example.com");
    expect(call.argv).not.toContain("--readonly");
    expect(call.argv.includes("--gmail-no-send"), "ONLY_SEND_CAN_SEND").toBe(operation !== "gmail.draft.send");
    if (operation === "gmail.draft.send") {
      expect(call.argv).toContain("--raw-file=-"); expect(call.argv).toContain(`--thread-id=${FIRST}`);
      expect(Buffer.from(call.stdin_base64, "base64")).toEqual(Buffer.from(input.raw));
    }
    if (operation === "gmail.draft.delete") expect(call.argv).toContain("--force");
    expect(() => GOG_WRITE_CODECS[operation]({ ...response, extra: true }), "IRREVERSIBLE_CODEC_UNKNOWN_KEY").toThrow();
    fake.setScenario({ [command]: { stdout: { ...response, extra: true } } });
    expect(await transport.execute(operation, input as never, execution), "IRREVERSIBLE_BAD_RESPONSE_UNKNOWN").toMatchObject({ ok: false, error: { code: "outcome_unknown" } });
  });
  test(`google ${operation} never retries and requires final admission`, async () => {
    const { fake, transport } = setup(); fake.setScenario({ [command]: { exit: 8 } });
    expect(await transport.execute(operation, input as never), "IRREVERSIBLE_ADMISSION_REQUIRED").toMatchObject({ ok: false, error: { reason: "missing_admission" } });
    expect(fake.calls()).toHaveLength(0);
    const refused = { code: "policy_denied" as const, reason: "cancelled", message: "The turn ended." };
    expect(await transport.execute(operation, input as never, { accountIdentity: "odysseus@example.com", finalAdmission: () => refused })).toEqual({ ok: false, error: refused });
    expect(fake.calls()).toHaveLength(0);
    expect(await transport.execute(operation, input as never, { accountIdentity: "odysseus@example.com", finalAdmission: () => null })).toMatchObject({ ok: false });
    expect(fake.callsOf(command), "IRREVERSIBLE_NO_RETRY").toHaveLength(1);
  });
}

test("google irreversible codecs refuse misleading successes", () => {
  for (const value of [{ deleted: false, draftId: DRAFT }, { deleted: true, draftId: "not-an-id" }])
    expect(() => GOG_WRITE_CODECS["gmail.draft.delete"](value), "DELETE_STRICT_RESULT").toThrow();
  for (const value of [{ from: "odysseus@example.com", messageId: "not-an-id", threadId: FIRST }, { messageId: FIRST, threadId: "not-an-id" }])
    expect(() => GOG_WRITE_CODECS["gmail.draft.send"](value), "SEND_STRICT_RESULT").toThrow();
  for (const fields of [{ count: 0 }, { count: 26 }, { action: "archived" }, { addedLabels: [] }, { removedLabels: [] }])
    expect(() => GOG_WRITE_CODECS["gmail.trash"]({ ...cases[2][3], ...fields }), "TRASH_STRICT_RESULT").toThrow();
});

test("google delete and trash cannot confirm a different target or count", async () => {
  const { ctx, fake } = setup();
  const deletion = await prepareGmailDelete(ctx, DRAFT);
  fake.setScenario({ ...writesScenario(), "gmail.drafts.delete": { stdout: { deleted: true, draftId: "r-987654321" } } });
  expect(await deletion.execute(() => null), "DELETE_TARGET_BOUND").toMatchObject({ ok: false, error: { code: "outcome_unknown" } });
  const trash = await prepareGmailTrash(ctx, { message_ids: [FIRST] });
  expect(await trash.execute(() => null), "TRASH_COUNT_BOUND").toMatchObject({ ok: false, error: { code: "outcome_unknown" } });
});

test("google trash resolves a bounded exact message set despite user label names matching system ids", async () => {
  const { ctx, fake } = setup();
  const trash = await prepareGmailTrash(ctx, { thread_ids: [FIRST] });
  expect(trash.payload.message_ids, "TRASH_RESOLVES_THREAD").toEqual([FIRST, SECOND]);
  expect(await trash.execute(() => null)).toMatchObject({ ok: true, result: { message_ids: [FIRST, SECOND] } });
  const labels = fixture("labels-list"); labels.labels.push({ id: "Label_77", name: "trash", type: "user" });
  fake.setScenario({ ...writesScenario(), "gmail.labels.list": { stdout: labels } });
  await expect(prepareGmailTrash(ctx, { message_ids: [FIRST] }), "TRASH_SYSTEM_IDS_UNAMBIGUOUS").resolves.toMatchObject({ payload: { message_ids: [FIRST] } });
  const thread = fixture("thread-hall"); thread.thread.messages = Array.from({ length: 26 }, (_, i) => ({ ...thread.thread.messages[0], id: (0x19a0c3d2e4f50600n + BigInt(i)).toString(16) }));
  fake.setScenario({ ...writesScenario(), [`gmail.thread.get ${FIRST}`]: { stdout: thread } });
  await expect(prepareGmailTrash(ctx, { thread_ids: [FIRST] }), "TRASH_BOUND").rejects.toMatchObject({ error: { reason: "items_per_call" } });
});
