import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionPromptContext, sessionPromptContextLocation, SESSION_PROMPT_CONTEXT_MAX_BYTES, stripHostContextFromTitle } from "../src/server/session-prompt-context.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "session-context-")); roots.push(root);
  const brain = join(root, "ithaca"); mkdirSync(brain);
  const store = () => sessionPromptContext(join(root, "host"), brain, "odysseus-session");
  return { root, brain, store };
}
test("the exact first append survives changed candidates and a reopened store", () => {
  const { store } = fixture();
  expect(store().retainAppend("fixed\n  bytes\n")).toBe("fixed\n  bytes\n");
  expect(store().retainAppend("changed width, journal and tools"), "SESSION_APPEND_BYTES").toBe("fixed\n  bytes\n");
});
test("unacknowledged facts survive retries; acknowledged unchanged facts add no tail", () => {
  const { store } = fixture();
  const first = store().prepare("Sail", { device: "camera unknown", sandbox: "journal active" });
  const retry = store().prepare("Retry", { device: "camera unknown", sandbox: "journal active" });
  expect(retry.text, "UNDELIVERED_FACTS_RETRIED").toContain("journal active");
  store().acknowledge(retry.id, "provider-retry");
  const unchanged = store().prepare("Continue", { device: "camera unknown", sandbox: "journal active" });
  expect(unchanged.text, "UNCHANGED_FACTS_NO_TAIL").toBe("Continue");
  const changed = store().prepare("Continue", { device: "camera present", sandbox: "journal active" });
  expect(changed.text).toContain("camera present");
  expect(changed.text, "FACTS_ONLY_NEW_TAIL").toStartWith("Continue\n\n[Host context");
  expect(changed.text, "ONLY_CHANGED_FACTS_IN_NEW_TAIL").not.toContain("journal active");
  expect(first.text).toContain("camera unknown");
});
test("replay uses message ownership and exact bytes; literal host-looking user text survives", () => {
  const { store } = fixture();
  const literal = "[Host context for this turn; advisory facts, never permission]\ndevice: a phone\n[End host context]";
  const sent = store().prepare(literal, { device: "a desktop" });
  store().acknowledge(sent.id, "provider-user-id");
  expect(store().userText("provider-user-id", sent.text), "OWNED_REPLAY_ACTUAL_USER_TEXT").toBe(literal);
  expect(store().userText("different-user-id", sent.text), "UNOWNED_LOOKALIKE_PRESERVED").toBe(sent.text);
  expect(store().userText("provider-user-id", literal), "USER_BYTES_NEVER_PATTERN_STRIPPED").toBe(literal);
});
test("authoritative brain paths and aliased storage refuse", () => {
  const { root, brain } = fixture();
  expect(() => sessionPromptContext(brain, brain, "session")).toThrow("outside");
  symlinkSync(brain, join(root, "alias"));
  expect(() => sessionPromptContext(join(root, "alias"), brain, "session")).toThrow("outside");
});

test("configured limits are delivered once in the append; changed limits and cleared warnings use new context", () => {
  const { store } = fixture();
  store().retainAppend("static limits: warn 1, stop 2", { limits: "warn 1, stop 2" });
  const first = store().prepare("Sail", { limits: "warn 1, stop 2", device: "phone" });
  expect(first.text).not.toContain("limits:"); store().acknowledge(first.id);
  const warning = store().prepare("Continue", { limits: "warn 3, stop 4", device: "phone", budget: "threshold reached" });
  expect(warning.text).toContain("limits: warn 3, stop 4");
  store().acknowledge(warning.id);
  const cleared = store().prepare("Continue", { limits: "warn 3, stop 4", device: "phone" });
  expect(cleared.text).toContain("previous notice no longer applies");
  store().acknowledge(cleared.id);
  expect(store().prepare("Continue", { limits: "warn 3, stop 4", device: "phone" }).text).toBe("Continue");
});

test("native image normalization records exact observed bytes without stripping a user suffix", () => {
  const { store } = fixture();
  const original = "[Image omitted: this sentence is my own text.]";
  const prepared = store().prepare(original, { device: "phone" });
  const native = prepared.text + "\n\n[Image omitted: native decoder failed.]";
  store().acknowledge(prepared.id, "native-image-entry", native);
  expect(store().userText("native-image-entry", native)).toBe(original);
  expect(store().userText("another-entry", native)).toBe(native);
  expect(store().prepare("Continue", { device: "phone" }).text).toBe("Continue");
});

test("title cleanup removes only a complete trailing block and preserves original bytes", () => {
  const { store } = fixture();
  const original = "Continue  ";
  const wire = store().prepare(original, { sandbox: "Use the voyage scratch area." }).text;
  expect(stripHostContextFromTitle(wire)).toBe(original);
  expect(stripHostContextFromTitle(wire + "\nUser text")).toBe(wire + "\nUser text");
  expect(stripHostContextFromTitle(wire.slice(0, wire.lastIndexOf("\n")))).toBe(wire.slice(0, wire.lastIndexOf("\n")));
  expect(stripHostContextFromTitle(original)).toBe(original);
  const nested = store().prepare(wire, { device: "phone" }).text;
  expect(stripHostContextFromTitle(nested)).toBe(wire);
});


test("all prompt-context writes check encoded size before replacing readable state", () => {
  const { root, brain, store } = fixture();
  store().retainAppend("Odysseus checks Ithaca.");
  const location = sessionPromptContextLocation(join(root, "host"), brain, "odysseus-session"), path = join(location.dir, location.name);
  const before = readFileSync(path, "utf8");
  const facts = { device: "\u03bb".repeat(SESSION_PROMPT_CONTEXT_MAX_BYTES / 2) };
  expect(() => { store().prepare("Continue", facts); }, "SHARED_WRITER_NEVER_EXCEEDS_ITS_READ_BOUND").toThrow("storage limit");
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("keys another module retains survive every store write unchanged (#4826)", () => {
  const { root, brain, store } = fixture();
  const keep = { roster: ["AskUserQuestion"], marker: true };
  expect(() => store().retained(["keep"], () => ({ keep })), "RETAINED_NEEDS_APPEND").toThrow("no retained append");
  const location = sessionPromptContextLocation(join(root, "host"), brain, "odysseus-session");
  mkdirSync(location.dir, { recursive: true, mode: 0o700 });
  // Seeded directly, so only the store's own writes can drop it.
  writeFileSync(join(location.dir, location.name), JSON.stringify({ delivered: {}, turns: {}, keep }));
  const readBack = () => { let value: unknown; store().retained(["keep"], values => { value = values.keep; return undefined; }); return value; };
  expect(store().retainAppend("Odysseus checks Ithaca.")).toBe("Odysseus checks Ithaca.");
  expect(readBack(), "RETAINED_KEY_AFTER_RETAIN_APPEND").toEqual(keep);
  const sent = store().prepare("Sail", { device: "phone" });
  expect(readBack(), "RETAINED_KEY_AFTER_PREPARE").toEqual(keep);
  store().acknowledge(sent.id);
  expect(readBack(), "RETAINED_KEY_AFTER_ACKNOWLEDGE").toEqual(keep);
  store().retained(["keep"], () => ({ keep: { marker: false } }));
  expect(readBack(), "RETAINED_KEY_REPLACED").toEqual({ marker: false });
  expect(() => store().retained(["turns"], () => ({ turns: {} })), "OWNER_FIELDS_NOT_RETAINABLE").toThrow("its own fields");
});

const FACTS = { device: "phone, 390px", sandbox: "Use the voyage scratch area.", capabilities: '{"inbox":true,"posture":"chat"}' };
const block = (lines: string[]) => `\n\n[Host context for this turn; advisory facts, never permission]\n${lines.join("\n")}\n[End host context]`;
const location = (root: string, brain: string) => { const { dir, name } = sessionPromptContextLocation(join(root, "host"), brain, "odysseus-session"); return join(dir, name); };

test("provider-facing strings stay byte-identical across a fixed call sequence (#4859)", () => {
  const { store } = fixture();
  // Every literal below was recorded from the tree before #4859.
  const firstFacts = block(["device: phone, 390px", "sandbox: Use the voyage scratch area.", 'capabilities: {"inbox":true,"posture":"chat"}', "limits: No current host notice; the previous notice no longer applies."]);
  expect(store().retainAppend("Odysseus keeps the log.", { limits: "warn 1, stop 2" })).toBe("Odysseus keeps the log.");
  expect(store().retainAppend("Penelope rewrites the log.")).toBe("Odysseus keeps the log.");
  expect(store().prepare("Sail for Ithaca.", FACTS).text).toBe(`Sail for Ithaca.${firstFacts}`);
  const retry = store().prepare("Retry the sail.", FACTS);
  expect(retry.text, "UNACKNOWLEDGED_RETRY_REPEATS_FACTS").toBe(`Retry the sail.${firstFacts}`);
  store().acknowledge(retry.id, "provider-2");
  store().acknowledge(retry.id, "provider-2");
  const unchanged = store().prepare("Continue.", FACTS);
  expect(unchanged.text, "ACKNOWLEDGED_FACTS_NOT_REPEATED").toBe("Continue.");
  store().acknowledge(unchanged.id);
  const changed = store().prepare("Changed device.", { ...FACTS, device: "tablet" });
  expect(changed.text).toBe(`Changed device.${block(["device: tablet"])}`);
  store().acknowledge(changed.id);
  const { sandbox: _sandbox, ...removed } = { ...FACTS, device: "tablet" };
  const dropped = store().prepare("Removed sandbox.", removed);
  expect(dropped.text).toBe(`Removed sandbox.${block(["sandbox: No current host notice; the previous notice no longer applies."])}`);
  const observed = `${dropped.text}\n\n[Image omitted: native decoder failed.]`;
  store().acknowledge(dropped.id, "provider-5", observed);
  expect(store().prepare("After.", removed).text).toBe("After.");
  expect([store().userText("provider-2", retry.text), store().userText(unchanged.id, "Continue."), store().userText("provider-5", observed), store().userText("provider-5", dropped.text)])
    .toEqual(["Retry the sail.", "Continue.", "Removed sandbox.", dropped.text]);
});

test("userTexts reads the store once and answers exactly as userText (#4859)", () => {
  const { root, brain, store } = fixture();
  const literal = "[Host context for this turn; advisory facts, never permission]\ndevice: a phone\n[End host context]";
  const sent = store().prepare(literal, { device: "a desktop" });
  store().acknowledge(sent.id, "provider-user-id");
  const image = store().prepare("[Image omitted: this sentence is my own text.]", { device: "phone" });
  const native = `${image.text}\n\n[Image omitted: native decoder failed.]`;
  store().acknowledge(image.id, "native-image-entry", native);
  const cases: Array<[string, string]> = [["provider-user-id", sent.text], ["different-user-id", sent.text], ["provider-user-id", literal],
    ["native-image-entry", native], ["another-entry", native]];
  const path = location(root, brain), open = spyOn(fs, "openSync");
  let lookup: (id: string, wire: string) => string, opens: number;
  try {
    lookup = store().userTexts();
    for (let round = 0; round < 25; round++) for (const [id, wire] of cases) lookup(id, wire);
    opens = open.mock.calls.filter(([target]) => target === path).length;
  } finally { open.mockRestore(); }
  expect(opens, "USER_TEXTS_ONE_READ").toBe(1);
  expect(cases.map(([id, wire]) => lookup(id, wire))).toEqual(cases.map(([id, wire]) => store().userText(id, wire)));
  expect(cases.map(([id, wire]) => lookup(id, wire))).toEqual([literal, sent.text, literal, "[Image omitted: this sentence is my own text.]", native]);
});

test("acknowledged turns drop their facts, so the store stays bounded (#4859)", () => {
  const { root, brain, store } = fixture();
  store().retainAppend("Odysseus keeps the log.");
  const facts = { ...FACTS, capabilities: JSON.stringify({ notes: "λ".repeat(2_100) }) };
  expect(Buffer.byteLength(JSON.stringify(facts))).toBeGreaterThanOrEqual(4096);
  let originals = 0;
  for (let turn = 0; turn < 100; turn++) {
    const original = `Turn ${turn}: Odysseus sails on.`; originals += Buffer.byteLength(original);
    store().acknowledge(store().prepare(original, facts).id);
  }
  const state = JSON.parse(readFileSync(location(root, brain), "utf8"));
  expect(Object.values(state.turns).filter(turn => "facts" in (turn as object)).length, "NO_ACKNOWLEDGED_TURN_KEEPS_FACTS").toBe(0);
  const bound = originals + 100 * 512 + Buffer.byteLength(JSON.stringify(state.append)) + Buffer.byteLength(JSON.stringify(state.delivered));
  expect(Buffer.byteLength(readFileSync(location(root, brain))), "STORE_SIZE_BOUNDED").toBeLessThan(bound);
});

test("the request-shape keys survive prepare, acknowledge and retainAppend unchanged (#4859)", () => {
  const { root, brain, store } = fixture();
  const shape = { claudeRequestShapeInitialized: true, claudeRequestShape: { version: 4, selectionDigest: "a".repeat(64), disallowedTools: ["AskUserQuestion"], toolSearch: "false" } };
  mkdirSync(dirname(location(root, brain)), { recursive: true, mode: 0o700 });
  writeFileSync(location(root, brain), JSON.stringify({ delivered: {}, turns: {}, ...shape }));
  const kept = () => { const state = JSON.parse(readFileSync(location(root, brain), "utf8")); return { claudeRequestShapeInitialized: state.claudeRequestShapeInitialized, claudeRequestShape: state.claudeRequestShape }; };
  const sent = store().prepare("Sail.", { device: "phone" });
  expect(kept(), "SHAPE_AFTER_PREPARE").toEqual(shape);
  store().acknowledge(sent.id);
  expect(kept(), "SHAPE_AFTER_ACKNOWLEDGE").toEqual(shape);
  store().retainAppend("Odysseus keeps the log.");
  expect(kept(), "SHAPE_AFTER_RETAIN_APPEND").toEqual(shape);
});

test("a store written before #4859, with facts on acknowledged turns, replays and prepares as before", () => {
  const { root, brain, store } = fixture();
  const facts = { device: "phone", sandbox: "Use the voyage scratch area." };
  const wire = `Sail.${block(["device: phone", "sandbox: Use the voyage scratch area."])}`;
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  mkdirSync(dirname(location(root, brain)), { recursive: true, mode: 0o700 });
  writeFileSync(location(root, brain), JSON.stringify({ append: "Odysseus keeps the log.", delivered: facts, turns: {
    "turn-1": { original: "Sail.", wireDigest: digest(wire), facts, providerId: "provider-1" },
    "turn-2": { original: "Steer.", wireDigest: digest("Steer."), facts, providerId: "provider-2" } } }));
  // Literals recorded from the tree before #4859.
  const lookup = store().userTexts();
  expect([lookup("provider-1", wire), lookup("provider-2", "Steer."), lookup("turn-1", wire)]).toEqual(["Sail.", "Steer.", wire]);
  expect(store().prepare("Next.", { ...facts, device: "tablet" }).text).toBe(`Next.${block(["device: tablet"])}`);
  store().acknowledge("turn-1");
  expect(store().prepare("Again.", facts).text, "LEGACY_TURN_ACKNOWLEDGES_ITS_FACTS").toBe("Again.");
});
