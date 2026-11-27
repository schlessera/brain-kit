/**
 * The host side of the media review effects over real files and the real core
 * CLI (#2781, #4845): one brain in a temporary repository, the change journal,
 * the writer gate, `createMediaEffects` and the hygiene review, wired to a
 * `cli` that answers `brain hygiene --json …`.
 *
 * How `cli` reaches core is the caller's choice: `inProcessHygiene` runs the
 * command inside the test process (hygiene-media-effects.test.ts), and
 * `spawnedHygiene` starts the bin for every call, which is the process
 * boundary (hygiene-media-effects-process.test.ts). Both pass the same
 * environment keys.
 */
import { afterEach, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { hygieneMediaPlanSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { HygieneMediaPlan } from "@schlessera/brain-ui-sdk/protocol";
import { runCliInProcess } from "../../../core/tests/cli-in-process-runner";
import { createUiDb } from "../../src/db/client.js";
import { createTurnJournal } from "../../src/brain/turn-journal.js";
import { createWriterGate } from "../../src/brain/writer-gate.js";
import { createMediaEffects } from "../../src/inbox/media-effects.js";
import { createHygieneReview } from "../../src/inbox/hygiene-review.js";
import { createPrincipal } from "../../src/db/principals.js";
import type { BrainClient } from "../../src/brain/client.js";
import { createNativeJournalFixture } from "./native-journal-fixture.js";

export const CORE_CLI = resolve(import.meta.dir, "../../../core/src/cli/brain.ts");
export const LOOM = "photos/penelope-loom.png", NOTE = "journeys/return.md", SCRATCH = ".brain/scratch/2026-07-12/harbour-dawn.jpg";
export const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** The environment every core call gets, spawned or in process. */
const cliEnv = (cwd: string) => ({ HOME: cwd, BRAIN_ROOT: cwd, GIT_CONFIG_NOSYSTEM: "1" });

export function run(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(args, { cwd, env: { PATH: process.env.PATH ?? "", ...cliEnv(cwd) } });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}
export function put(root: string, path: string, text: string) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
export const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

/** `brain hygiene --json <args>` in `root`: its exit code, stdout and stderr. */
export type HygieneCli = (root: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Each call starts the bin: the process boundary. */
export const spawnedHygiene: HygieneCli = async (root, args) => run(root, process.execPath, CORE_CLI, "hygiene", "--json", ...args);

/** Each call runs the command inside this process; calls must not overlap. */
export const inProcessHygiene: HygieneCli = (root, args) => runCliInProcess(root, ["hygiene", "--json", ...args], cliEnv(root));

export type Real = (args: string[]) => Promise<unknown>;
export interface SetupOptions { capBytes?: number; wrap?: (args: string[], real: Real, signal?: AbortSignal) => unknown }

/** Register the teardown for this file and return its `setup`. Call once, at the top level of a test file. */
export function mediaEffectsHost(hygiene: HygieneCli) {
  const clean: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });

  return async function setup(options: SetupOptions = {}) {
    const directory = mkdtempSync(join(tmpdir(), "brain-media-effects-host-"));
    const root = join(directory, "brain"); mkdirSync(root);
    run(root, "git", "init", "-q", "-b", "main");
    put(root, ".gitignore", ".brain/\nbrain.db*\n.brain-index/\n.bun/\n");
    put(root, "brain.config.json", "{}\n");
    put(root, "places/ithaca.md", "# Ithaca\n");
    run(root, "git", "add", "-A");
    run(root, "git", "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.test", "commit", "-qm", "fixture");
    put(root, LOOM, "loom bytes");
    put(root, NOTE, "# Return\n\n![loom](../photos/penelope-loom.png)\n");
    const real: Real = async (args) => {
      const r = await hygiene(root, args);
      if (![0, 1].includes(r.code ?? -1)) throw new Error(`brain hygiene ${args.join(" ")} exited ${r.code}: ${r.stderr}`);
      return JSON.parse(r.stdout);
    };
    const cli = async (args: string[], signal?: AbortSignal) => options.wrap ? options.wrap(args, real, signal) : real(args);
    const dbPath = join(directory, "ui.sqlite"), db = createUiDb(dbPath), native = createNativeJournalFixture(root, directory);
    const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: root, dbPath, objectsRoot: join(directory, "objects"), ...(options.capBytes ? { capBytes: options.capBytes } : {}) });
    await journal.ready;
    const gate = createWriterGate(db, root, { pollMs: 1 });
    let authorized = true;
    const reviewer = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 86400 });
    const effects = createMediaEffects(db, { brainPath: root, journal, gate, lock: createKeyedLock(), cli, authorized: id => authorized && (id === "odysseus" || id === reviewer.id) });
    const brain = { hygiene: async (args: readonly string[], opts?: { signal?: AbortSignal }) => cli([...args], opts?.signal) } as unknown as BrainClient;
    const review = createHygieneReview(db, { brain, media: effects });
    clean.push(async () => { await journal.close(); await native.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
    let n = 0;
    type Entries = { entries: Array<{ id: string; path: string; fingerprint: string }> };
    async function plan(path: string, action: HygieneMediaPlan["action"], to?: string) {
      const finding = ((await real(["list"])) as Entries).entries.find(e => e.path === path)
        ?? (await real(["reconcile"]), ((await real(["list"])) as Entries).entries.find(e => e.path === path))!;
      const raw = await real(["media", action, finding.id, "--expect-fingerprint", finding.fingerprint, ...(to ? ["--to", to] : []), "--dry-run"]);
      return { finding, plan: hygieneMediaPlanSchema.parse(raw) };
    }
    async function apply(path: string, action: HygieneMediaPlan["action"], to?: string) {
      const { finding, plan: p } = await plan(path, action, to);
      expect(p.refusals).toEqual([]);
      return effects.apply({ id: `odysseus-media-${String(++n).padStart(4, "0")}`, principalId: "odysseus", findingId: finding.id, fingerprint: finding.fingerprint, plan: p });
    }
    return { root, directory, db, journal, effects, plan, apply, review, reviewer, brain, revoke() { authorized = false; }, undo: (sourceId: string) => effects.undo({ id: `${sourceId}-undo`, principalId: "odysseus", sourceId }) };
  };
}

export type MediaEffectsHost = Awaited<ReturnType<ReturnType<typeof mediaEffectsHost>>>;
