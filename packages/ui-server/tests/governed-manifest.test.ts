/**
 * #1648: the durable protected-path manifest and its quarantine. A protected
 * name absent when a governed turn started and present after it, a new
 * `.env*` name, or an ancestor swapped for a link is moved out of the brain
 * into a host-private quarantine, byte for byte, without following a link.
 * A turn whose server still runs is never reconciled under it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client";
import { appearedSince, assertReconciled, createGovernedManifests, takeManifest } from "../src/brain/governed-manifest";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function world() {
  const root = mkdtempSync(join(tmpdir(), "governed-manifest-"));
  dirs.push(root);
  const brain = join(root, "brain"), outside = join(root, "outside"), quarantine = join(root, "quarantine");
  mkdirSync(join(brain, ".claude"), { recursive: true });
  mkdirSync(join(brain, "context/policies"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(brain, "context/policies/governance.md"), "---\nschema_version: 1\n---\nAthena reviews.\n");
  writeFileSync(join(brain, "package.json"), "{}\n");
  writeFileSync(join(brain, ".env"), "KEY=kept\n");
  const db = createUiDb(join(root, "brain-ui.db"));
  const manifests = createGovernedManifests(db, { brainPath: brain, quarantineDir: quarantine });
  return { root, brain, outside, quarantine, db, manifests };
}

describe("governed manifests", () => {
  test("what appeared during the turn is quarantined, byte for byte; what existed stays", () => {
    const w = world();
    try {
      w.manifests.begin("turn-1");
      writeFileSync(join(w.brain, "brain.config.ts"), "import './helper.ts';\n");
      writeFileSync(join(w.brain, ".env.local"), "STOLEN=1\n");
      writeFileSync(join(w.brain, ".mcp.json"), "{\"mcpServers\":{}}\n");
      writeFileSync(join(w.brain, "notes.md"), "Ordinary work stays.\n");
      const result = w.manifests.end("turn-1");
      expect(result.quarantined.map(q => q.path).sort()).toEqual([".env.local", ".mcp.json", "brain.config.ts"]);
      expect(result.changed).toEqual([]);
      for (const name of [".env.local", ".mcp.json", "brain.config.ts"]) expect(existsSync(join(w.brain, name))).toBe(false);
      expect(readFileSync(join(w.quarantine, "turn-1", "brain.config.ts"), "utf8")).toBe("import './helper.ts';\n");
      expect(readFileSync(join(w.brain, ".env"), "utf8"), "an .env that existed at the start is the user's").toBe("KEY=kept\n");
      expect(readFileSync(join(w.brain, "notes.md"), "utf8")).toBe("Ordinary work stays.\n");
      expect(() => w.manifests.end("turn-1"), "a turn closes once").toThrow("no open governed manifest");
    } finally { w.db.close(); }
  });

  test("an ancestor swapped for a link is itself quarantined, never followed", () => {
    const w = world();
    try {
      w.manifests.begin("turn-2");
      // The redirected settings file lives outside the brain and must survive untouched.
      mkdirSync(join(w.outside, "claude"));
      writeFileSync(join(w.outside, "claude/settings.json"), "{\"permissions\":{\"allow\":[\"Bash\"]}}\n");
      rmSync(join(w.brain, ".claude"), { recursive: true });
      symlinkSync(join(w.outside, "claude"), join(w.brain, ".claude"));
      const result = w.manifests.end("turn-2");
      expect(result.quarantined.map(q => q.path)).toEqual([".claude"]);
      expect(existsSync(join(w.brain, ".claude"))).toBe(false);
      const moved = join(w.quarantine, "turn-2", ".claude");
      expect(lstatSync(moved).isSymbolicLink(), "the link itself moved").toBe(true);
      expect(readlinkSync(moved)).toBe(join(w.outside, "claude"));
      expect(readFileSync(join(w.outside, "claude/settings.json"), "utf8")).toContain("Bash");
    } finally { w.db.close(); }
  });

  test("a protected file that existed and changed is reported, not moved", () => {
    const w = world();
    try {
      w.manifests.begin("turn-3");
      writeFileSync(join(w.brain, "package.json"), "{\"scripts\":{}}\n");
      const result = w.manifests.end("turn-3");
      expect(result.quarantined).toEqual([]);
      expect(result.changed).toEqual(["package.json"]);
      expect(existsSync(join(w.brain, "package.json"))).toBe(true);
    } finally { w.db.close(); }
  });

  test("a running turn's manifest masks what appeared for other launches, and is never reconciled while its server lives", () => {
    const w = world();
    try {
      w.manifests.begin("turn-live");
      writeFileSync(join(w.brain, "bunfig.toml"), "preload = [\"./x.ts\"]\n");
      expect(w.manifests.appearedDuringActiveTurns()).toEqual(["bunfig.toml"]);
      expect(w.manifests.reconcileAbandoned(), "this process is alive").toEqual([]);
      expect(existsSync(join(w.brain, "bunfig.toml"))).toBe(true);
      expect(w.manifests.hasHistory()).toBe(true);
    } finally { w.db.close(); }
  });

  test("a path that cannot be quarantined keeps the turn open and refuses until it is gone", () => {
    const w = world();
    try {
      w.manifests.begin("turn-stuck");
      writeFileSync(join(w.brain, "bunfig.toml"), "preload = [\"./x.ts\"]\n");
      // The quarantine cannot be written.
      mkdirSync(w.quarantine, { mode: 0o500 });
      const result = w.manifests.end("turn-stuck");
      expect(result.failed.map(f => f.path)).toEqual(["bunfig.toml"]);
      expect(existsSync(join(w.brain, "bunfig.toml"))).toBe(true);
      expect(() => assertReconciled([result]), "FAIL_CLOSED").toThrow("could not be quarantined: bunfig.toml");
      const row = w.db.query("SELECT ended_at FROM governed_turn_manifests WHERE turn_id = 'turn-stuck'").get() as { ended_at: number | null };
      expect(row.ended_at, "the record stays open for the next reconciliation").toBeNull();
      // Another process (the cron runner) refuses it too, though this server still lives.
      const cron = createGovernedManifests(w.db, { brainPath: w.brain, quarantineDir: w.quarantine });
      expect(() => assertReconciled(cron.reconcileAbandoned()), "FAILED_REFUSED_ACROSS_PROCESSES").toThrow("bunfig.toml");
      // Once the quarantine is writable again, the same turn reconciles.
      chmodSync(w.quarantine, 0o700);
      expect(w.manifests.end("turn-stuck").quarantined.map(q => q.path)).toEqual(["bunfig.toml"]);
    } finally { chmodSync(w.quarantine, 0o700); w.db.close(); }
  });

  test("the manifest records identity and bytes, and appearedSince ignores what was present", () => {
    const w = world();
    try {
      const start = takeManifest(w.brain);
      const policy = start.entries.find(e => e.path === "context/policies")!;
      expect(policy).toMatchObject({ exists: true, type: "directory" });
      expect(start.entries.find(e => e.path === "package.json")!.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(start.env).toEqual([".env"]);
      expect(appearedSince(w.brain, start)).toEqual({ appeared: [], changed: [] });
    } finally { w.db.close(); }
  });
});
