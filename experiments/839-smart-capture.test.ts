import { test, expect } from "bun:test";
import { scoreWrite } from "../evals/839-smart-capture/run";
const old = "---\ntype: project\ntitle: Raft repair\ntags: [sailing]\n---\n\nPreserve the old mast.\n";
const note = "---\ntype: note\ntitle: Observation\ntags: [sailing]\n---\n\nThe mast casts a shadow.\n";
const expected = { type: "note", target: null, tags: ["sailing"] };
test("wrong-target append remains a veto even with correct captured text", () => {
  const r = scoreWrite("The mast casts a shadow.", expected, {"projects/raft.md":old}, {"projects/raft.md":old+"\nThe mast casts a shadow.\n"});
  expect(r.wrongTarget).toBe(true);
  expect(r.contentLoss).toBe(false);
});
test("replacing an old body is content loss even if capture is preserved", () => {
  const r = scoreWrite("The mast casts a shadow.", expected, {"projects/raft.md":old}, {"projects/raft.md":note});
  expect(r.contentLoss).toBe(true);
});
test("a successful new capture has no destructive veto", () => {
  const r = scoreWrite("The mast casts a shadow.", expected, {"projects/raft.md":old}, {"projects/raft.md":old,"notes/shadow.md":note});
  expect(r.invalid).toBe(false);
  expect(r.contentLoss).toBe(false);
  expect(r.wrongTarget).toBe(false);
  expect(r.target).toBeNull();
});
test("deleting unrelated content and writing a new capture is detected", () => {
  const r = scoreWrite("The mast casts a shadow.", expected, {"projects/raft.md":old}, {"notes/shadow.md":note});
  expect(r.contentLoss).toBe(true);
  expect(r.invalid).toBe(true);
});

test("a removed routing phrase requires review without proving old-content loss", () => {
  const r = scoreWrite("Capture as note. The mast casts a shadow.", expected, {"projects/raft.md":old}, {"projects/raft.md":old,"notes/shadow.md":note});
  expect(r.literalViolation).toBe(true);
  expect(r.pendingSemanticReview).toBe(true);
  expect(r.oldContentLoss).toBe(false);
});
