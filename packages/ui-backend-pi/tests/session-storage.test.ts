import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { piSessionDirectory, savePiSession, syncPiAuth } from "../src/session-storage";

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
test.each(["symlink", "hardlink"])("transcript %s alias cannot truncate policy bytes", kind => {
  const f = fixture(), id = randomUUID();
  (kind === "symlink" ? symlinkSync : linkSync)(f.policy, join(f.state, `${id}.jsonl`));
  expect(() => savePiSession(f.state, id, [{ type: "session", id }])).toThrow();
  expect(readFileSync(f.policy, "utf8")).toBe("Athena owns policy.\n");
});
test.each(["symlink", "hardlink"])("native credential %s alias cannot write policy bytes", kind => {
  const f = fixture();
  (kind === "symlink" ? symlinkSync : linkSync)(f.policy, join(f.state, "auth.json"));
  expect(() => syncPiAuth(f.state, "Athena owns policy.\n", "{}")).toThrow();
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
