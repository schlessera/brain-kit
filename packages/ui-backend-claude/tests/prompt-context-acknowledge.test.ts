/** #4857: acknowledgement walks the saved transcript from the end and parses only lines naming the owned id. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTestHome } from "../../../scripts/test-home.js";
import { acknowledgeClaudeContext, claudePromptContext } from "../src/prompt-context.js";

let home: ReturnType<typeof installTestHome>, brain: string;
beforeEach(() => { home = installTestHome(); brain = mkdtempSync(join(tmpdir(), "ithaca-acknowledge-")); });
afterEach(() => { rmSync(brain, { recursive: true, force: true }); home.dispose(); });

const facts = { device: "phone", sandbox: "Use the voyage scratch area." };
/** The transcript root comes from `env`, the store from the default environment: keep both on the test home. */
const env = () => ({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, HOME: process.env.HOME });
function fixture() {
  const session = crypto.randomUUID(), store = claudePromptContext(brain, session);
  store.retainAppend("Odysseus keeps the ship's log.");
  const sent = store.prepare("Sail for Ithaca.", facts);
  const dir = join(process.env.CLAUDE_CONFIG_DIR!, "projects", realpathSync(brain).replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, `${session}.jsonl`);
  const user = (uuid: string, text: string, parentUuid?: string) => JSON.stringify({ type: "user", uuid, parentUuid, sessionId: session, message: { role: "user", content: [{ type: "text", text }] } });
  const reply = (uuid: string, parentUuid: string) => JSON.stringify({ type: "assistant", uuid, parentUuid, sessionId: session, message: { role: "assistant", content: [{ type: "text", text: "Penelope weaves." }] } });
  const write = (lines: string[]) => writeFileSync(transcript, lines.join("\n") + "\n");
  const run = () => acknowledgeClaudeContext(brain, session, sent, env());
  const acknowledge = (lines: string[]) => { write(lines); run(); };
  const acknowledged = () => claudePromptContext(brain, session).prepare("Sail for Ithaca.", facts).text === "Sail for Ithaca.";
  return { session, sent, transcript, user, reply, write, run, acknowledge, acknowledged };
}

test("a damaged earlier line does not prevent acknowledging the owned entry", () => {
  const { sent, user, acknowledge, acknowledged } = fixture();
  acknowledge(["{not json", user(crypto.randomUUID(), "Earlier voyage."), user(sent.id, sent.text)]);
  expect(acknowledged(), "DAMAGED_EARLIER_LINE_STILL_ACKNOWLEDGES").toBe(true);
});

test("only lines naming the owned id are parsed", () => {
  const { session, sent, user, reply, acknowledge, acknowledged } = fixture();
  const lines = Array.from({ length: 10_000 }, (_, index) => user(crypto.randomUUID(), `Line ${index}.`));
  lines[4_999] = user(sent.id, sent.text);
  lines[7_500] = reply(crypto.randomUUID(), sent.id);
  const parse = spyOn(JSON, "parse");
  try {
    acknowledge(lines);
    const transcriptParses = parse.mock.calls.filter(([text]) => typeof text === "string" && text.includes(`"sessionId":"${session}"`)).length;
    expect(transcriptParses, "ONLY_OWNED_ID_LINES_PARSED").toBeLessThanOrEqual(2);
  } finally { parse.mockRestore(); }
  expect(acknowledged()).toBe(true);
});

test("a torn candidate line is skipped and nothing is acknowledged without a valid match", () => {
  const { sent, user, acknowledge, acknowledged } = fixture();
  const torn = user(sent.id, sent.text).slice(0, -12);
  expect(() => acknowledge([user(crypto.randomUUID(), "Earlier voyage."), torn]), "TORN_CANDIDATE_DOES_NOT_THROW").not.toThrow();
  expect(acknowledged(), "TORN_CANDIDATE_NOT_ACKNOWLEDGED").toBe(false);
});

test("the owned id with other text, and the owned text under another id, are not acknowledged", () => {
  const otherText = fixture();
  otherText.acknowledge([otherText.user(otherText.sent.id, "A different message.")]);
  expect(otherText.acknowledged(), "TEXT_MUST_MATCH").toBe(false);
  const otherId = fixture();
  // A later user entry naming the owned id as its parent, with the owned text.
  otherId.acknowledge([otherId.user(crypto.randomUUID(), otherId.sent.text, otherId.sent.id)]);
  expect(otherId.acknowledged(), "UUID_MUST_MATCH").toBe(false);
});

test("acknowledgement leaves the transcript's bytes and modification time unchanged", () => {
  const { sent, transcript, user, write, run, acknowledged } = fixture();
  write(["{not json", user(crypto.randomUUID(), "Earlier voyage."), user(sent.id, sent.text)]);
  const before = { bytes: readFileSync(transcript), mtime: statSync(transcript).mtimeMs };
  run();
  expect(acknowledged()).toBe(true);
  expect(readFileSync(transcript).equals(before.bytes), "TRANSCRIPT_BYTES_UNCHANGED").toBe(true);
  expect(statSync(transcript).mtimeMs, "TRANSCRIPT_MTIME_UNCHANGED").toBe(before.mtime);
});
