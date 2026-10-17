import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionPromptContext } from "../src/server/session-prompt-context.js";

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
  expect(changed.text.startsWith("Continue\n\n[Host context"), "FACTS_ONLY_NEW_TAIL").toBe(true);
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
