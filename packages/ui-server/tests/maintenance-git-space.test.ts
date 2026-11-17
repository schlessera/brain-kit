/**
 * Hosted `brain maintain` packs git inside the maintenance worker's private
 * output stage, which `BRAIN_UI_OUTPUT_STAGING_BYTES` bounds (#3357). A pack
 * larger than that allowance fails with git's own out-of-disk line; the `git`
 * step must name the limit, its size, the setting and the starting headroom.
 * Runs under real bubblewrap through the managed native app fixture.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { createHostBoundary } from "../src/brain/host-boundary.js";
import { createNativeAppFixture } from "./helpers/native-app-fixture.js";

const ROOT = resolve(import.meta.dir, "../../..");
const BRAIN_CLI = join(ROOT, "packages/core/src/cli/brain.ts");
const SETTING = "BRAIN_UI_OUTPUT_STAGING_BYTES";
// Incompressible loose blobs: their pack is about this size, whatever zlib does.
const LOOSE_BLOBS = 24, BLOB_BYTES = 256 * 1024;
const BELOW_PACK = 4 * 1024 * 1024, ABOVE_PACK = 64 * 1024 * 1024;

let root: string, brain: string;
const cleanup: Array<() => Promise<void>> = [];
const saved = Object.getOwnPropertyDescriptor(process.env, SETTING);

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", brain, ...args], { stdout: "pipe", stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Penelope", GIT_AUTHOR_EMAIL: "penelope@ithaca.example",
      GIT_COMMITTER_NAME: "Penelope", GIT_COMMITTER_EMAIL: "penelope@ithaca.example", GIT_AUTHOR_DATE: "2026-07-12T09:00:00Z", GIT_COMMITTER_DATE: "2026-07-12T09:00:00Z" } });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

beforeAll(async () => {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  root = mkdtempSync(join(ROOT, "tmp/maintenance-git-space-"));
  brain = join(root, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, "notes/ithaca.md"), "---\ntype: note\ntitle: Ithaca harbour\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n"
    + "Odysseus checks the harbour at Ithaca before the fleet sails.\n");
  writeFileSync(join(brain, "brain.config.json"), "{}\n");
  writeFileSync(join(brain, ".gitignore"), ".brain/\n");
  git("init", "--quiet", "--initial-branch=main");
  git("config", "gc.auto", "0");
  git("add", "-A");
  git("commit", "--quiet", "-m", "Chart the harbour");
  // A brain with history already has a pack; git before 2.47 refuses an incremental repack without one.
  git("repack", "-d", "--quiet");
  // Loose objects a content repo collects: large binaries git's gc never counts.
  for (let index = 0; index < LOOSE_BLOBS; index++) {
    const file = join(root, `chart-${index}.bin`);
    writeFileSync(file, randomBytes(BLOB_BYTES));
    git("hash-object", "-w", file);
    rmSync(file);
  }
  const index = Bun.spawn([process.execPath, BRAIN_CLI, "index", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", HOME: root, BRAIN_ROOT: brain, BUN_OPTIONS: "--no-env-file" } });
  const [code, stderr] = await Promise.all([index.exited, new Response(index.stderr).text()]);
  if (code !== 0) throw new Error(`brain index failed: ${stderr}`);
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  if (saved) Object.defineProperty(process.env, SETTING, saved); else delete process.env[SETTING];
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

async function maintain(allowance: number) {
  process.env[SETTING] = String(allowance);
  const state = mkdtempSync(join(root, "state-"));
  const native = createNativeAppFixture(brain); cleanup.push(native.close);
  const host = createHostBoundary({ brainPath: brain, dbPath: join(state, "ui.db"), exec: {},
    nativeManager: createNativeBrainManagerClient(native.nativeBrain) });
  const result = await host.run({ argv: [process.execPath, BRAIN_CLI, "maintain", "--json"],
    env: { PATH: "/usr/bin:/bin", BRAIN_ROOT: brain }, credentials: true, gate: "exclusive", purpose: "Odysseus maintenance cron", publish: false });
  const report = JSON.parse(result.stdout) as Array<{ step: string; result: string }>;
  return { result, git: report.find(step => step.step === "git")?.result ?? "" };
}

test("a pack over the output-staging allowance names the limit, its setting and the headroom", async () => {
  const { result, git } = await maintain(BELOW_PACK);
  expect(result.exitCode, result.stderr).toBe(2);
  expect(git, "MAINTAIN_GIT_NO_SPACE_NAMED").toStartWith("FAILED — no space:");
  expect(git, "MAINTAIN_GIT_NO_SPACE_STAGE").toContain("maintenance worker's output stage");
  expect(git, "MAINTAIN_GIT_NO_SPACE_ALLOWANCE").toContain(`allowance ${BELOW_PACK} bytes`);
  expect(git, "MAINTAIN_GIT_NO_SPACE_SETTING").toContain(SETTING);
  expect(git, "MAINTAIN_GIT_NO_SPACE_HEADROOM").toMatch(/; \d+ bytes available when the step started/);
});

test("the same pack inside the allowance packs every loose object", async () => {
  const { result, git } = await maintain(ABOVE_PACK);
  // The host's frozen attributes tree is one more loose object beside the blobs.
  expect(git, result.stderr).toMatch(/^ok — packed \d+ loose object\(s\)$/);
  expect(Number(/packed (\d+)/.exec(git)?.[1])).toBeGreaterThanOrEqual(LOOSE_BLOBS);
});
