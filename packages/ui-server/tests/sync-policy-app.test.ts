/**
 * End to end through `createApp` and a real hosted sync (#4256): an upstream
 * commit adds a governance policy, a UI sync pauses with a review of it, the
 * owner approves through the decide route, the real journal records the write
 * as a `user` `policy` change with a `policy_change` governance event, the
 * next turn's policy facts carry the adopted policy, and the following sync
 * completes. The brain is the Odysseus fixture corpus; the remote is a local
 * bare repository outside it.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNativeAppFixture, createFixtureApp as createApp } from "./helpers/native-app-fixture.js";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createRecordingObservability } from "../src/observability";
import { resolveServerConfig } from "../src/config/env";
import { makeFakeBackend } from "./helpers/fake-backend";
import { journalDatabasePath } from "../src/db/journal-database";

const ROOT = resolve(import.meta.dir, "../../..");
const POLICY = "---\nschema_version: 1\noutward:\n  github:\n    repositories: [ithaca/*]\n---\nOdysseus decides what leaves Ithaca.\n";
const roots: string[] = [];
const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["/usr/bin/git", ...args], { cwd, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-sync-policy-app-")); roots.push(root);
  const brain = join(root, "brain"), remote = join(root, "remote.git"), other = join(root, "other");
  cpSync(join(ROOT, "packages/core/fixtures/corpus"), brain, { recursive: true });
  writeFileSync(join(brain, ".gitignore"), "node_modules/\n.brain/\nbrain.db*\n");
  const config = readFileSync(join(brain, "brain.config.ts"), "utf8");
  writeFileSync(join(brain, "brain.config.ts"), config.replace('"@schlessera/brain"', JSON.stringify(join(ROOT, "packages/core/src/index.ts")))
    .replace("profile: {", 'agentRunner: "fixture-unavailable",\n  profile: {'));
  mkdirSync(remote); git(remote, "init", "--bare", "-b", "main");
  git(brain, "init", "-b", "main"); git(brain, "config", "user.name", "Odysseus"); git(brain, "config", "user.email", "odysseus@ithaca.example");
  git(brain, "add", "."); git(brain, "commit", "-m", "Harbor notebook");
  git(brain, "remote", "add", "origin", remote); git(brain, "push", "origin", "main");
  git(root, "clone", remote, other);
  git(other, "config", "user.name", "Penelope"); git(other, "config", "user.email", "penelope@ithaca.example");
  mkdirSync(join(other, "context/policies"), { recursive: true });
  writeFileSync(join(other, "context/policies/governance.md"), POLICY);
  git(other, "add", "."); git(other, "commit", "-m", "Open GitHub writes to Ithaca"); git(other, "push", "origin", "main");
  mkdirSync(join(brain, "node_modules/.bin"), { recursive: true });
  const cli = join(brain, "node_modules/.bin/brain");
  writeFileSync(cli, `#!/usr/bin/env bun\nawait import(${JSON.stringify(join(ROOT, "packages/core/src/cli/brain.ts"))});\n`); chmodSync(cli, 0o755);
  const serverConfig = resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", DB_PATH: join(root, "ui.db"), BRAIN_PATH: brain, BRAIN_UI_PRICING_DISCOVERY: "0" });
  const native = createNativeAppFixture(brain); closers.push(native.close);
  serverConfig.nativeBrain = native.nativeBrain;
  return { root, brain, remote, config: serverConfig };
}

const frames = async (response: Response) => (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
const post = (path: string, body?: unknown) => new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

test("an upstream policy commit is reviewed, approved through the real journal, adopted for the next turn, and the next sync completes", async () => {
  const f = fixture();
  const app = await createApp({ config: f.config, observability: createRecordingObservability(), registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]) });
  closers.push(() => app.close());
  const paused = await frames(await app.fetch(post("/api/brain/sync")));
  const review = paused.find(frame => frame.type === "policy_review") as { turn_id: string; request_id: string; review: { rationale: string } } | undefined;
  expect(review, `APP_SYNC_REVIEWS: ${JSON.stringify(paused.slice(-3))}`).toBeDefined();
  expect(review!.review.rationale, "APP_REVIEW_NAMES_UPSTREAM").toContain(git(f.remote, "rev-parse", "main").slice(0, 12));
  expect(paused.at(-1)).toMatchObject({ type: "done", reason: "policy_review" });

  const decided = await app.fetch(post(`/api/brain/sync/policy/${review!.turn_id}/${review!.request_id}`, { approve: true }));
  expect(decided.status).toBe(200);
  expect((await decided.json()).state, "APP_APPROVAL_WRITES").toBe("updated");
  expect(readFileSync(join(f.brain, "context/policies/governance.md"), "utf8"), "APP_INCOMING_BYTES_ADOPTED").toBe(POLICY);

  const journal = new Database(journalDatabasePath(f.config.dbPath), { readonly: true });
  try {
    const change = journal.query("SELECT class, actor FROM turn_journal_changes WHERE turn_id = ? AND path = 'context/policies/governance.md'").get(review!.turn_id);
    expect(change, "APP_JOURNAL_USER_POLICY").toEqual({ class: "policy", actor: "user" });
  } finally { journal.close(); }
  const db = new Database(f.config.dbPath, { readonly: true });
  try {
    const event = db.query("SELECT kind, actor FROM governance_events WHERE turn_id = ? AND kind = 'policy_change'").get(review!.turn_id);
    expect(event, "APP_POLICY_CHANGE_EVENT").toEqual({ kind: "policy_change", actor: "user" });
  } finally { db.close(); }

  // The policy facts the next admitted turn reads carry the adopted policy.
  const facts = await (await app.fetch(new Request("http://localhost/api/agent-policy"))).json() as { source: string; hash: string | null; errors: string[] };
  expect(facts.errors, "APP_NEXT_TURN_POLICY_VALID").toEqual([]);
  expect(facts.source, "APP_NEXT_TURN_POLICY_ADOPTED").toBe("policy");
  expect(facts.hash, "APP_NEXT_TURN_POLICY_HASH").toBe(new Bun.CryptoHasher("sha256").update(POLICY).digest("hex"));

  const completed = await frames(await app.fetch(post("/api/brain/sync")));
  expect(completed.at(-1), `APP_FOLLOWING_SYNC_COMPLETES: ${JSON.stringify(completed.slice(-4))}`).toMatchObject({ type: "done", success: true });
}, 240_000);
