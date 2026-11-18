/**
 * `brain config media <add|remove>-<track|ignore> <pattern>` (#2781, rev 4
 * §7): one media list change, previewed with its current matches and applied
 * only against the config bytes and the approval the preview gave. The
 * config's actual bytes are inspected after every apply and refusal.
 * Real Git and files, offline; Odysseus's cast, the day 2026-07-12.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_MEDIA_POLICY, type MediaPolicy } from "../src/lib/media";
import { planMediaPolicyEdit, readMediaPolicyLists } from "../src/lib/media-config-edit";
import { applyMediaConfigChange, planMediaConfigChange, type MediaConfigOp, type MediaConfigPlan } from "../src/lib/media-config";
import { cleanup, runCli } from "./cli-harness";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  // Command-scoped, so neither a global nor an environment-scoped commit.gpgsign reaches the fixture commit.
  const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-C", cwd, ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}
function put(root: string, path: string, bytes: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

/** A brain with three maps sync sees now: one at the root, two in folders. */
function brain(config = "{}\n"): string {
  const root = mkdtempSync(join(tmpdir(), "brain-media-config-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  put(root, ".gitignore", ".brain/\n");
  put(root, "brain.config.json", config);
  put(root, "places/ithaca.md", "# Ithaca\n");
  git(root, "add", "-A");
  git(root, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.test", "commit", "-qm", "fixture");
  put(root, "map.png", "x".repeat(2400));
  put(root, "places/map.png", "x".repeat(1100));
  put(root, "trips/map.png", "x".repeat(800));
  put(root, "trips/troy.png", "x".repeat(300));
  return root;
}
const policyOf = (root: string): MediaPolicy => ({ ...DEFAULT_MEDIA_POLICY, ...readMediaPolicyLists(read(root, "brain.config.json"), "json") });
const ctx = (root: string) => ({ root, policy: policyOf(root), configPath: "brain.config.json" });
const preview = (root: string, op: MediaConfigOp, pattern: string) => planMediaConfigChange(ctx(root), op, pattern) as MediaConfigPlan;

describe("brain config media: preview", () => {
  test("a basename rule lists every current match in any folder, largest first, and names the future scope", () => {
    const root = brain();
    const plan = preview(root, "add-track", "map.png");
    expect(plan.scope, "CONFIG_BASENAME_IS_BROADER").toBe("pattern");
    expect(plan.configDiff).toEqual({ path: "brain.config.json", track: { before: [], after: ["map.png"] }, ignore: { before: [], after: [] } });
    expect(plan.matches, "CONFIG_MATCHES").toMatchObject({ pattern: "map.png", anyFolder: true, count: 3, bytes: 4300, changed: 3, ignoredStill: 0, sensitive: 0 });
    expect(plan.matches.largest.map((m) => [m.path, m.bytes, m.before, m.after])).toEqual([
      ["map.png", 2400, null, "TRACK"], ["places/map.png", 1100, null, "TRACK"], ["trips/map.png", 800, null, "TRACK"],
    ]);
    expect(plan.config.sha256).toBe(sha(read(root, "brain.config.json")));
    expect(read(root, "brain.config.json"), "CONFIG_PREVIEW_WRITES_NOTHING").toBe("{}\n");
  });

  test("an exact path is exact; an ignore entry that still wins and a secret-shaped name are counted", () => {
    const root = brain('{ "media": { "ignore": ["trips/*"] } }\n');
    put(root, "trips/.env", "SECRET=1\n");
    expect(preview(root, "add-track", "places/map.png").scope).toBe("exact");
    const broad = preview(root, "add-track", "trips/*");
    expect(broad.matches, "CONFIG_IGNORE_STILL_WINS").toMatchObject({ count: 3, ignoredStill: 2, sensitive: 1, changed: 0 });
  });

  test("refusals name the reason and write nothing", () => {
    const root = brain('{ "media": { "track": ["places/map.png"] } }\n');
    const codes = (op: MediaConfigOp, pattern: string) => (planMediaConfigChange(ctx(root), op, pattern) as { refusals: Array<{ code: string }> }).refusals.map((r) => r.code);
    expect(codes("add-track", "places/map.png"), "CONFIG_ALREADY_LISTED").toEqual(["already-listed"]);
    expect(codes("remove-ignore", "trips/*"), "CONFIG_NOT_LISTED").toEqual(["not-listed"]);
    expect(codes("add-track", "!map.png"), "CONFIG_NO_NEGATION").toEqual(["not-expressible"]);
    expect(codes("add-track", "../outside.png")).toEqual(["invalid-pattern"]);
    expect(codes("add-track", "/abs.png")).toEqual(["invalid-pattern"]);
    const ts = brain();
    rmSync(join(ts, "brain.config.json"));
    put(ts, "brain.config.ts", "const media = { track: [] };\nexport default { media };\n");
    expect(planMediaConfigChange({ root: ts, policy: DEFAULT_MEDIA_POLICY, configPath: "brain.config.ts" }, "add-track", "map.png").refusals.map((r) => r.code), "CONFIG_NOT_LITERAL")
      .toEqual(["config-not-literal"]);
    expect(read(ts, "brain.config.ts")).toBe("const media = { track: [] };\nexport default { media };\n");
  });
});

describe("brain config media: apply", () => {
  test("each of the four edits is a minimal splice that reads back as the intended lists", () => {
    const root = brain('{\n  "title": "Ithaca",\n  "media": { "track": ["places/**"], "ignore": ["trips/*", "*.psd"] }\n}\n');
    const step = (op: MediaConfigOp, pattern: string) => {
      const plan = preview(root, op, pattern);
      const result = applyMediaConfigChange(ctx(root), op, pattern, { sha256: plan.config.sha256, approval: plan.approvalDigest });
      expect(result.status, `${op} ${pattern}`).toBe("applied");
      return read(root, "brain.config.json");
    };
    expect(step("add-track", "map.png"), "CONFIG_ADD_TRACK_BYTES").toBe('{\n  "title": "Ithaca",\n  "media": { "track": ["places/**", "map.png"], "ignore": ["trips/*", "*.psd"] }\n}\n');
    expect(step("remove-ignore", "trips/*"), "CONFIG_REMOVE_IGNORE_BYTES").toBe('{\n  "title": "Ithaca",\n  "media": { "track": ["places/**", "map.png"], "ignore": ["*.psd"] }\n}\n');
    expect(step("add-ignore", "trips/troy.png"), "CONFIG_ADD_IGNORE_BYTES").toBe('{\n  "title": "Ithaca",\n  "media": { "track": ["places/**", "map.png"], "ignore": ["*.psd", "trips/troy.png"] }\n}\n');
    expect(step("remove-track", "places/**"), "CONFIG_REMOVE_TRACK_BYTES").toBe('{\n  "title": "Ithaca",\n  "media": { "track": ["map.png"], "ignore": ["*.psd", "trips/troy.png"] }\n}\n');
  });

  test("a TypeScript defineConfig literal keeps every comment and byte around the splice", () => {
    const source = 'import { defineConfig } from "@schlessera/brain";\n\nexport default defineConfig({\n  media: {\n    ignore: ["assets/renders/*"], // generated\n  },\n});\n';
    expect(planMediaPolicyEdit(source, "ts", { addTrack: "places/map.png" }).text, "CONFIG_TS_ADD_LIST")
      .toBe('import { defineConfig } from "@schlessera/brain";\n\nexport default defineConfig({\n  media: {\n    ignore: ["assets/renders/*"], "track": ["places/map.png"], // generated\n  },\n});\n');
    expect(() => planMediaPolicyEdit(source, "ts", { addTrack: "a/b.png", addIgnore: "a/c.png" }), "CONFIG_ONE_ADD").toThrow();
  });

  test("a config edited after the preview is stale, and a different match inventory is a stale approval; nothing is written", () => {
    const root = brain();
    const plan = preview(root, "add-track", "map.png");
    put(root, "brain.config.json", '{ "title": "Ithaca" }\n');
    expect(applyMediaConfigChange(ctx(root), "add-track", "map.png", { sha256: plan.config.sha256 }), "CONFIG_STALE_SHA").toMatchObject({ status: "stale", reason: "stale" });
    expect(read(root, "brain.config.json")).toBe('{ "title": "Ithaca" }\n');

    const again = preview(root, "add-track", "map.png");
    put(root, "harbour/map.png", "a fourth map");
    const stale = applyMediaConfigChange(ctx(root), "add-track", "map.png", { sha256: again.config.sha256, approval: again.approvalDigest });
    expect(stale, "CONFIG_STALE_APPROVAL").toMatchObject({ status: "stale", reason: "stale-approval" });
    expect(read(root, "brain.config.json")).toBe('{ "title": "Ithaca" }\n');
  });

  test("the CLI previews and applies through its --json envelope", async () => {
    const root = brain();
    try {
      const dry = await runCli(root, ["config", "media", "add-track", "places/map.png", "--dry-run", "--json"]);
      expect(dry.code, dry.stderr).toBe(0);
      const plan = JSON.parse(dry.stdout);
      expect(Object.keys(plan), "CONFIG_CLI_PREVIEW_ENVELOPE").toEqual(["status", "op", "pattern", "scope", "config", "configDiff", "matches", "approvalDigest", "refusals"]);
      const refused = await runCli(root, ["config", "media", "add-track", "places/map.png", "--expect-sha", "0".repeat(64), "--json"]);
      expect(refused.code).toBe(1);
      expect(JSON.parse(refused.stdout), "CONFIG_CLI_STALE").toEqual({ status: "stale", op: "add-track", pattern: "places/map.png", reason: "stale", refusals: [{ code: "stale", path: "brain.config.json" }] });
      const applied = await runCli(root, ["config", "media", "add-track", "places/map.png", "--expect-sha", plan.config.sha256, "--expect-approval", plan.approvalDigest, "--json"]);
      expect(applied.code, applied.stderr).toBe(0);
      expect(JSON.parse(applied.stdout), "CONFIG_CLI_APPLIED").toMatchObject({ status: "applied", config: { path: "brain.config.json", before: plan.config.sha256 } });
      expect(read(root, "brain.config.json")).toBe('{ "media": { "track": ["places/map.png"] } }\n');
    } finally {
      cleanup(root);
    }
  });
});
