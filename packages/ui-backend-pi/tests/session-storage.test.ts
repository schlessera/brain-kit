import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { appendPiSession, piSessionDirectory, savePiSession, syncPiAuth } from "../src/session-storage";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-worker-storage-")); roots.push(root);
  const brain = join(root, "brain"), state = join(root, "state");
  mkdirSync(brain); mkdirSync(state);
  const policy = join(brain, "policy.md"); writeFileSync(policy, "Athena owns policy.\n");
  return { root, brain, state, policy };
}
test("session storage refuses brain descendants, ancestors and symlink aliases before creating state", () => {
  const f = fixture();
  symlinkSync(f.brain, join(f.root, "brain-alias"));
  for (const path of [f.brain, join(f.brain, "sessions"), f.root, join(f.root, "brain-alias/sessions")]) {
    expect(() => piSessionDirectory(f.brain, path)).toThrow("outside the brain");
  }
  expect(piSessionDirectory(f.brain, f.state)).toBe(f.state);
  expect(readFileSync(f.policy, "utf8")).toBe("Athena owns policy.\n");
});
test("session storage refuses a filesystem-root brain before creating state directories", () => {
  const f = fixture(), dir = join(f.state, "new-state");
  let failure: Error | undefined;
  try { piSessionDirectory("/", dir); } catch (error) { failure = error as Error; }
  expect(existsSync(dir), "a filesystem-root brain has no external state directory").toBe(false);
  expect(failure?.message).toContain("outside the brain");
});
// The refusal names the alias guard that fired, so an earlier refusal cannot stand in for it.
const ALIAS_REFUSAL = { symlink: /ELOOP/, hardlink: /must be an unaliased regular file/ } as const;
test.each(["symlink", "hardlink"] as const)("transcript %s alias cannot truncate policy bytes", kind => {
  const f = fixture(), id = randomUUID();
  (kind === "symlink" ? symlinkSync : linkSync)(f.policy, join(f.state, `${id}.jsonl`));
  expect(() => savePiSession(f.state, id, [{ type: "session", id }])).toThrow(ALIAS_REFUSAL[kind]);
  expect(readFileSync(f.policy, "utf8")).toBe("Athena owns policy.\n");
});
test.each(["symlink", "hardlink"] as const)("a transcript append through a %s alias is refused before any byte is written", kind => {
  const f = fixture(), id = randomUUID();
  (kind === "symlink" ? symlinkSync : linkSync)(f.policy, join(f.state, `${id}.jsonl`));
  // The size matches the target's, so only the alias refusal can stop the append.
  const size = Buffer.byteLength("Athena owns policy.\n");
  expect(() => appendPiSession(f.state, id, size, [{ type: "message", id: "e1" }])).toThrow(ALIAS_REFUSAL[kind]);
  expect(readFileSync(f.policy, "utf8")).toBe("Athena owns policy.\n");
});
const serialized = (entries: unknown[]) => entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
test("a transcript append writes the serialization rule's lines only onto the size last saved", () => {
  const f = fixture(), id = randomUUID(), path = join(f.state, `${id}.jsonl`);
  const first = [{ type: "session", id }, { type: "message", id: "e1", message: { role: "user", content: "Ithaca" } }];
  const added = [{ type: "message", id: "e2", message: { content: "Πηνελόπη", role: "assistant" } }, { type: "custom", id: "e3" }];
  const saved = savePiSession(f.state, id, first);
  expect(saved).toBe(Buffer.byteLength(serialized(first)));
  expect(appendPiSession(f.state, id, saved + 1, added), "a size that differs leaves the rewrite to the caller").toBeUndefined();
  expect(readFileSync(path, "utf8")).toBe(serialized(first));
  expect(appendPiSession(f.state, id, saved, added)).toBe(Buffer.byteLength(serialized([...first, ...added])));
  expect(readFileSync(path, "utf8")).toBe(serialized([...first, ...added]));
});
test("a failed transcript append leaves the bytes saved before it", () => {
  const f = fixture(), id = randomUUID(), path = join(f.state, `${id}.jsonl`);
  const first = [{ type: "session", id }, { type: "message", id: "e1" }], added = [{ type: "message", id: "e2", text: "Scylla and Charybdis" }];
  const saved = savePiSession(f.state, id, first);
  const original = fs.writeSync;
  // Writes half of the line, then fails, like a full disk.
  const write = spyOn(fs, "writeSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    original(fd, buffer, offset, Math.floor(length / 2), position);
    throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  }) as unknown as typeof fs.writeSync);
  try { expect(() => appendPiSession(f.state, id, saved, added)).toThrow("ENOSPC"); }
  finally { write.mockRestore(); }
  expect(readFileSync(path, "utf8"), "PI_APPEND_TRUNCATES_BACK_ON_FAILURE").toBe(serialized(first));
  expect(appendPiSession(f.state, id, saved, added)).toBe(Buffer.byteLength(serialized([...first, ...added])));
  expect(readFileSync(path, "utf8")).toBe(serialized([...first, ...added]));
});
test.each(["symlink", "hardlink"] as const)("native credential %s alias cannot write policy bytes", kind => {
  const f = fixture();
  (kind === "symlink" ? symlinkSync : linkSync)(f.policy, join(f.state, "auth.json"));
  expect(() => syncPiAuth(f.state, "Athena owns policy.\n", "{}")).toThrow(ALIAS_REFUSAL[kind]);
  expect(readFileSync(f.policy, "utf8")).toBe("Athena owns policy.\n");
});
test("native credential synchronization refuses stale input and stores exact refreshed bytes", () => {
  const f = fixture(), path = join(f.state, "auth.json");
  writeFileSync(path, '{"fixture":"current"}');
  expect(() => syncPiAuth(f.state, '{"fixture":"old"}', "{}")).toThrow("changed concurrently");
  expect(readFileSync(path, "utf8")).toBe('{"fixture":"current"}');
  syncPiAuth(f.state, '{"fixture":"current"}', "{}");
  expect(readFileSync(path, "utf8")).toBe("{}");
});
