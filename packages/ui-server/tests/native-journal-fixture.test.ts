import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeJournalCapture } from "../src/brain/native-journal-capture.js";
import { createJournalObjects } from "../src/brain/journal-objects.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

test("copied checkpoint deltas retain actual bytes across a live overwrite", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-copy-race-")), brain = join(root, "brain");
  const relative = "notes/journal.md", note = join(brain, relative);
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(note, "Ithaca\r\n");
  let interleave = false, copied: string | undefined;
  const native = createNativeJournalFixture(brain, root, (source, destination) => {
    // An async overwrite can truncate after the old live inventory but before
    // cpSync reads. Finish the live write after the copy, leaving it unchanged.
    if (interleave) writeFileSync(note, "");
    cpSync(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
    if (interleave) {
      copied = readFileSync(join(destination, relative), "utf8");
      writeFileSync(note, "Penelope\r\n");
      interleave = false;
    }
  });
  const objects = createJournalObjects(join(root, "objects"), { reserve() { return { finish() {}, cancel() {} }; } });
  const capture = createNativeJournalCapture(native.manager, (fd, size, signal) => objects.putFileAsync(fd, size, signal),
    {}, undefined, { steering: false, index: false });
  try {
    await capture.initialize();
    const policies = new Map([["turn", await capture.policy()]]);
    writeFileSync(note, "Athena\r\n");
    const first = await capture.observe(policies); await first.commit();
    interleave = true;
    const truncated = await capture.observe(policies); await truncated.commit();
    // Run real before-version retention before checking the delta: the old
    // order must fail here on expected size 8 / actual 0, not an earlier predicate.
    const finished = await capture.observe(policies); await finished.commit();
    const versions = (observation: typeof first) => observation.changes.get("turn")!
      .filter(change => change.path === relative)
      .map(change => ({ before: objects.read(change.before!.hash!, 1024).toString(), after: objects.read(change.after!.hash!, 1024).toString() }));
    expect(copied, "CONTROL_RETAINED_TRUNCATION").toBe("");
    expect(readFileSync(note, "utf8"), "CONTROL_LIVE_OVERWRITE_FINISHED").toBe("Penelope\r\n");
    expect(versions(first), "INITIAL_RETAINED_BYTES").toEqual([{ before: "Ithaca\r\n", after: "Athena\r\n" }]);
    expect(versions(truncated), "DELTA_DESCRIBES_COPIED_BYTES").toEqual([{ before: "Athena\r\n", after: "" }]);
    expect(versions(finished), "LATER_BEFORE_VERSION_MATCHES_COPY").toEqual([{ before: "", after: "Penelope\r\n" }]);
  } finally {
    await capture.close(); await native.close(); objects.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("an inspect-only capture never retains checkout bytes while notes keep exact before and after versions", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-inspect-capture-")), brain = join(root, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true }); mkdirSync(join(brain, "workspaces/ithaca"), { recursive: true });
  writeFileSync(join(brain, "notes/voyage.md"), "Odysseus");
  writeFileSync(join(brain, "workspaces/ithaca/source.ts"), "checkout before");
  const native = createNativeJournalFixture(brain, root);
  const retained: string[] = [];
  const capture = createNativeJournalCapture(native.manager, async fd => {
    retained.push(readFileSync(fd, "utf8")); return String(retained.length);
  });
  try {
    await capture.initialize();
    const policy = await capture.policy([], { workspaces: false });
    writeFileSync(join(brain, "notes/voyage.md"), "Athena");
    writeFileSync(join(brain, "workspaces/ithaca/source.ts"), "checkout after");
    const observation = await capture.observe(new Map([["inspect", policy]]));
    expect(observation.changes.get("inspect")!.map(change => change.path), "INSPECT_CAPTURE_HAS_NO_CHECKOUT_ROWS").toEqual(["notes/voyage.md"]);
    expect(retained, "INSPECT_RETAINS_ONLY_EXACT_NOTE_BYTES").toEqual(["Odysseus", "Athena"]);
    await observation.commit();
  } finally { await capture.close(); await native.close(); rmSync(root, { recursive: true, force: true }); }
});
