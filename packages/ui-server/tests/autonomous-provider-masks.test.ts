/**
 * Autonomous (restricted) turns apply the same provider folder masks as
 * hosted turns (#2691): the envelope's brain view hides each masked folder,
 * `.brain-index/` is a private index built from the masked view, the host
 * bridge refuses masked paths (#2690), and unsupported selectors refuse by
 * name before any worker starts. Real bubblewrap restricted workers.
 */
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createKeyedLock, type AgentBackend, type StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { launchAgentWorker, prepareWorkerSandbox, restrictedReadPaths } from "../../ui-sdk/src/server/worker-launcher";
import * as startup from "../../ui-sdk/src/server/worker-startup-view.js";
import { retainWorkerStartupView } from "../../ui-sdk/src/server/worker-startup-view.js";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal } from "../src/db/principals.js";
import { createActivityStore } from "../src/activity/store.js";
import { createInboxBudget } from "../src/inbox/budget.js";
import { createInboxIntake } from "../src/inbox/intake.js";
import { runAutonomousTurn } from "../src/inbox/autonomous-turn.js";
import { queryGovernanceEvents } from "../src/governance/events.js";
import { governancePolicyReaderFor } from "../src/brain/governance-policy.js";
import { createGovernedManifests } from "../src/brain/governed-manifest.js";
import { protectedPaths } from "@schlessera/brain-common/internal/protected-paths";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

const REPO = resolve(import.meta.dir, "../../..");
const CORPUS = join(REPO, "packages/core/fixtures/corpus");
const CLI = [process.execPath, join(REPO, "packages/core/src/cli/brain.ts")];
const PATH = `${resolve(process.execPath, "..")}:/usr/bin:/bin`;
/** A word only the masked folder contains. */
const SENTINEL = "Zakynthosmarker";
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });

async function text(stream: unknown): Promise<string> {
  let out = "";
  for await (const chunk of stream as AsyncIterable<Uint8Array>) out += new TextDecoder().decode(chunk);
  return out;
}

function search(brain: string, query: string): string[] {
  const run = Bun.spawnSync([...CLI, "search", query, "--json", "--limit", "50"], { cwd: brain,
    env: { PATH, BRAIN_ROOT: brain, HOME: tmpdir(), NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  const parsed = JSON.parse(run.stdout.toString()) as { results?: { path: string }[] } | { path: string }[];
  return (Array.isArray(parsed) ? parsed : parsed.results ?? []).map(result => result.path);
}

async function fixture(providers = "[{ paths: [me/**], allow: [anthropic] }]") {
  // Inside the repository: the corpus config imports @schlessera/brain, which
  // resolves through the workspace install the restricted envelope restores.
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  const root = mkdtempSync(join(REPO, "tmp", "odysseus-autonomous-masks-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain");
  cpSync(CORPUS, brain, { recursive: true });
  rmSync(join(brain, ".brain-index"), { recursive: true, force: true });
  mkdirSync(join(brain, "context/policies"), { recursive: true });
  writeFileSync(join(brain, "context/policies/governance.md"),
    `---\nschema_version: 1\nproviders: ${providers}\n---\nOnly Anthropic may read Odysseus's own folder.\n`);
  mkdirSync(join(brain, ".git")); writeFileSync(join(brain, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(brain, "me/oath.md"), `---\ntype: note\ntitle: "Odysseus's private oath"\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [note]\n---\n\n${SENTINEL} is the word Odysseus keeps to himself.\n`);
  // The real index, built on the host from every document, me/ included.
  const index = Bun.spawnSync([...CLI, "index", "--json"], { cwd: brain, env: { PATH, BRAIN_ROOT: brain, HOME: root, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  expect(index.exitCode, index.stderr.toString()).toBe(0);
  const native = createNativeJournalFixture(brain, root);
  cleanup.push(() => native.close());
  const db = createUiDb(":memory:");
  cleanup.push(() => db.close());
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const input = { turnId: "autonomous-masked", principalId: principal.id, prompt: "Odysseus reviews his notes", allowedTools: ["read"],
    systemPromptAppend: "Server selected instructions", signal: new AbortController().signal, application: {} };
  const now = Date.now();
  // A person's arrival through authenticated intake: provenance the masked turn can admit (#2741).
  const intake = createInboxIntake(db, brain);
  const { itemId } = await intake.person({ text: "Odysseus asks for a review of his notes.", files: [] }, "odysseus", principal);
  await intake.close();
  createInboxBudget(db, { config: { spendUsd: 5, turns: 100, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 },
    pricing: { resolve: () => ({ input: 0.003, output: 0.003, cacheRead: 0.003, cacheWrite: 0.003, estimate: false, source: "snapshot" }) } })
    .claim(itemId, { runId: input.turnId, principalId: principal.id, model: "fixture", billingMode: "subscription", purpose: "execute" }, now + 600_000);
  return { root, brain, db, input, deps: { db, store: createActivityStore(db, { writer: "autonomous-masks" }), brainPath: brain, nativeManager: native.client,
    privateIndex: { maskPaths: [], command: CLI }, applicationPlanner: { planAdd: async () => { throw new Error("NO_PLANNING"); }, index: async () => {} },
    checkpoint() {} } };
}

/** A fixture backend that launches its worker the way both real backends prepare the restricted envelope. */
function restrictedBackend(brainPath: string, script: (request: StartTurnRequest, run: (shell: string) => Promise<string>) => Promise<void>): AgentBackend {
  return { id: "claude", capabilities: { autonomous: true, restrictedAutonomous: true, resume: false, permissions: true, thinking: false, attachments: false,
    askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
    brainApplicationPolicy: () => ({ available: ["write", "edit", "add", "update", "archive", "staged"], autoAllowed: [], lock: createKeyedLock() }),
    startTurn: async request => {
      const relay = mkdtempSync(join(tmpdir(), "odysseus-autonomous-relay-")); chmodSync(relay, 0o700);
      const server = Bun.serve({ unix: join(relay, "relay.sock"), fetch: () => new Response("ithaca") }); chmodSync(join(relay, "relay.sock"), 0o600);
      try {
        await script(request, async shell => {
          const sandbox = { ...prepareWorkerSandbox(brainPath, { restricted: true }), ...(request.workerProviderMasks ? { providerMasks: request.workerProviderMasks } : {}) };
          // Each child holds its own reference to the turn's immutable input.
          const worker = launchAgentWorker({ brainPath, startupView: retainWorkerStartupView(request.workerStartupView!), sandbox,
            restricted: { readPaths: restrictedReadPaths([CLI[1]!]), inferenceDir: relay },
            env: { PATH, BRAIN_ROOT: brainPath, HOME: "/tmp", NO_COLOR: "1" }, command: ["/bin/sh", "-c", shell, "sh", ...CLI] });
          const [stdout, stderr, code] = await Promise.all([text(worker.stdout), text(worker.stderr), worker.exited]);
          expect(code, stderr).toBe(0);
          return stdout;
        });
      } finally { server.stop(true); rmSync(relay, { recursive: true, force: true }); }
      request.bridge.emit({ type: "result", sessionId: "runtime", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
    }, listProfiles: () => [], listSessions: async () => [], getHistory: async () => [] };
}

test("a restricted autonomous worker reads a masked folder as empty and searches a private index without it", async () => {
  const f = await fixture();
  expect(search(f.brain, SENTINEL), "REAL_INDEX_HOLDS_THE_MASKED_DOCUMENT").toContain("me/oath.md");
  let shell = "", results: string[] = [], index: string | undefined, read: unknown, write: Record<string, unknown> | undefined;
  const backend = restrictedBackend(f.brain, async (request, run) => {
    index = request.workerProviderMasks?.index;
    expect(request.workerProviderMasks?.folders, "AUTONOMOUS_TURN_ADMITTED_WITH_PROVIDER_MASKS").toEqual(["me"]);
    shell = await run(`
      printf 'me=%s\\n' "$(ls -A me | wc -l)"
      cat me/oath.md 2>/dev/null && printf 'READ_MASKED\\n'
      printf 'git=%s\\n' "$(ls -A .git 2>/dev/null | wc -l)"
      if printf x > me/new.md 2>/dev/null; then printf 'WROTE_MASKED\\n'; fi
      grep -c ${SENTINEL} .brain-index/brain.db 2>/dev/null || true
    `);
    const parsed = JSON.parse(await run(`exec "$@" search ${SENTINEL} --json --limit 50`)) as { results?: { path: string }[] } | { path: string }[];
    results = (Array.isArray(parsed) ? parsed : parsed.results ?? []).map(result => result.path);
    try { await request.bridge.readBrainBase!("me/oath.md"); } catch (error) { read = error; }
    write = await request.bridge.applyBrain!({ operation: "write", path: "me/new.md", expectedBaseHash: null, content: "Odysseus writes.\n" }) as unknown as Record<string, unknown>;
  });
  const result = await runAutonomousTurn({ ...f.deps, backend }, f.input);
  expect(shell, "BASH_CANNOT_READ_MASKED_FOLDER_OR_HISTORY").toBe("me=0\ngit=0\n0\n");
  expect(results.filter(path => path.startsWith("me/")), "PRIVATE_INDEX_LACKS_MASKED_DOCUMENTS").toEqual([]);
  expect(String((read as Error | undefined)?.message), "AUTONOMOUS_BRIDGE_READ_REFUSED").toContain("provider_masked: me/oath.md");
  expect({ ok: write?.ok, code: write?.code }, "AUTONOMOUS_BRIDGE_WRITE_REFUSED").toEqual({ ok: false, code: "provider_masked" });
  expect(existsSync(join(f.brain, "me/new.md"))).toBe(false);
  expect(result.outcome).toBe("success");
  expect(queryGovernanceEvents(f.db, { kinds: ["provider_mask_refusal"], limit: 10 }).map(event => ({ actor: event.actor, profile: event.profile, ...event.payload })))
    .toEqual([["mcp__brain-ui__brain_read_base", "me/oath.md"], ["mcp__brain-ui__write_file", "me/new.md"]].map(([tool, path]) => ({ actor: "autonomous", profile: "restricted",
      tool, path, rule: { list: "providers", index: 0, pattern: "me/**" }, policyHash: expect.any(String) })));
  // The real index keeps the masked document, and the private one is gone.
  expect(search(f.brain, SENTINEL), "REAL_INDEX_STILL_HOLDS_THE_MASKED_DOCUMENT").toContain("me/oath.md");
  expect(index && existsSync(index), "PRIVATE_INDEX_REMOVED_AFTER_THE_TURN").toBe(false);
}, 120_000);

test("an autonomous turn under a selector that cannot map onto folders refuses by name before any worker starts", async () => {
  const f = await fixture("[{ paths: [me/*.md], allow: [anthropic] }]");
  let started = 0;
  const acquisitions = (startup.prepareNativeWorkerStartupView as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
  const backend = restrictedBackend(f.brain, async () => { started++; });
  let refusal: unknown;
  try { await runAutonomousTurn({ ...f.deps, backend }, f.input); } catch (error) { refusal = error; }
  expect((refusal as Error | undefined)?.name, "AUTONOMOUS_UNSUPPORTED_SELECTOR_REFUSED").toBe("ProviderPolicyRefusedError");
  expect(String((refusal as Error).message)).toContain("me/*.md");
  expect(started).toBe(0);
  expect((startup.prepareNativeWorkerStartupView as unknown as { mock: { calls: unknown[] } }).mock.calls.length, "NO_WORKER_INPUT_PREPARED").toBe(acquisitions);
}, 60_000);

test("an autonomous turn translates a type selector as hosted turns do: a mapping type masks its folder, the inbox type refuses", async () => {
  // `identity` (dir: me) maps exactly onto me/ in the Odysseus corpus (#2694).
  const mapped = await fixture("[{ types: [identity], allow: [anthropic] }]");
  let shell = "", folders: readonly string[] | undefined, results: string[] = [], read: unknown;
  await runAutonomousTurn({ ...mapped.deps, backend: restrictedBackend(mapped.brain, async (request, run) => {
    folders = request.workerProviderMasks?.folders;
    shell = await run(`printf 'me=%s\\n' "$(ls -A me | wc -l)"; grep -c ${SENTINEL} .brain-index/brain.db 2>/dev/null || true`);
    const parsed = JSON.parse(await run(`exec "$@" search ${SENTINEL} --json --limit 50`)) as { results?: { path: string }[] } | { path: string }[];
    results = (Array.isArray(parsed) ? parsed : parsed.results ?? []).map(result => result.path);
    try { await request.bridge.readBrainBase!("me/identity.md"); } catch (error) { read = error; }
  }) }, mapped.input);
  expect(folders, "AUTONOMOUS_TYPE_TRANSLATED_TO_ITS_FOLDER").toEqual(["me"]);
  expect(shell, "AUTONOMOUS_TYPE_FOLDER_READS_EMPTY").toBe("me=0\n0\n");
  expect(results.filter(path => path.startsWith("me/")), "AUTONOMOUS_TYPE_PRIVATE_INDEX_LACKS_ITS_FOLDER").toEqual([]);
  expect(String((read as Error | undefined)?.message), "AUTONOMOUS_TYPE_BRIDGE_READ_REFUSED").toContain("provider_masked: me/identity.md");
  expect(queryGovernanceEvents(mapped.db, { kinds: ["provider_mask_refusal"], limit: 10 }).map(event => event.payload.rule), "AUTONOMOUS_REFUSAL_NAMES_THE_TYPE")
    .toEqual([{ list: "providers", index: 0, pattern: "type identity" }]);
  // `note` is the inbox type, which covers every path outside the others.
  const inbox = await fixture("[{ types: [note], allow: [anthropic] }]");
  let started = 0, refusal: unknown;
  try { await runAutonomousTurn({ ...inbox.deps, backend: restrictedBackend(inbox.brain, async () => { started++; }) }, inbox.input); } catch (error) { refusal = error; }
  expect((refusal as Error | undefined)?.name, "AUTONOMOUS_UNTRANSLATABLE_TYPE_REFUSED").toBe("ProviderPolicyRefusedError");
  expect(String((refusal as Error).message)).toContain("type note");
  expect(started).toBe(0);
}, 180_000);

test("an autonomous turn refuses a type selector whose taxonomy loads code outside the protected paths, before its worker starts (#2699)", async () => {
  // A helper a governed turn could rewrite decides where identity lives.
  const helped = async (extra = "") => {
    const f = await fixture("[{ types: [identity], allow: [anthropic] }]");
    mkdirSync(join(f.brain, "lib"));
    writeFileSync(join(f.brain, "lib/identity-dir.ts"), `export const identityDir = "me";\n`);
    const config = join(f.brain, "brain.config.ts");
    writeFileSync(config, `import { identityDir } from "./lib/identity-dir.ts";\nvoid identityDir;\n${readFileSync(config, "utf8")}`);
    if (extra) writeFileSync(join(f.brain, "context/policies/governance.md"),
      `---\nschema_version: 1\nproviders: [{ types: [identity], allow: [anthropic] }]\n${extra}\n---\nOnly Anthropic may read Odysseus's own folder.\n`);
    return f;
  };
  const f = await helped();
  let started = 0, refusal: unknown;
  try { await runAutonomousTurn({ ...f.deps, backend: restrictedBackend(f.brain, async () => { started++; }) }, f.input); } catch (error) { refusal = error; }
  expect((refusal as Error | undefined)?.name, `AUTONOMOUS_UNPROTECTED_TAXONOMY_REFUSED: ${String(refusal)}`).toBe("ProviderPolicyRefusedError");
  expect(String((refusal as Error).message), "AUTONOMOUS_REFUSAL_NAMES_THE_HELPER").toContain("lib/identity-dir.ts");
  expect(started, "NO_AUTONOMOUS_WORKER_STARTED").toBe(0);
  // Protected, the same configuration translates.
  const p = await helped("protect: [lib]");
  let folders: readonly string[] | undefined;
  await runAutonomousTurn({ ...p.deps, backend: restrictedBackend(p.brain, async request => { folders = request.workerProviderMasks?.folders; }) }, p.input);
  expect(folders, "AUTONOMOUS_PROTECTED_HELPER_TRANSLATES").toEqual(["me"]);
}, 180_000);

test("an autonomous turn refuses a type selector while a protected name a running governed turn created is unreconciled (#2699)", async () => {
  const f = await fixture("[{ types: [identity], allow: [anthropic] }]");
  // The owner configures the brain with JSON; brain.config.ts is a protected name that is absent.
  rmSync(join(f.brain, "brain.config.ts")); writeFileSync(join(f.brain, "brain.config.json"), "{}\n");
  const manifests = createGovernedManifests(f.db, { brainPath: f.brain, quarantineDir: join(f.root, "quarantine") });
  manifests.begin("running-governed", protectedPaths());
  // What that turn wrote, as its worker could: a configuration the CLI prefers.
  writeFileSync(join(f.brain, "brain.config.ts"), `export default {};\n`);
  let started = 0, refusal: unknown;
  try { await runAutonomousTurn({ ...f.deps, backend: restrictedBackend(f.brain, async () => { started++; }) }, f.input); } catch (error) { refusal = error; }
  expect((refusal as Error | undefined)?.name, `AUTONOMOUS_APPEARED_NAME_REFUSED: ${String(refusal)}`).toBe("ProviderPolicyRefusedError");
  expect(String((refusal as Error).message)).toContain("brain.config.ts appeared during a governed turn and is not yet reconciled");
  expect(started, "NO_AUTONOMOUS_WORKER_STARTED").toBe(0);
}, 120_000);

test("an autonomous turn under a provider folder rule refuses without the host's private index masks", async () => {
  const f = await fixture();
  let started = 0;
  const { privateIndex: _privateIndex, ...deps } = f.deps;
  await expect(runAutonomousTurn({ ...deps, backend: restrictedBackend(f.brain, async () => { started++; }) }, f.input), "UNCONFIGURED_PRIVATE_INDEX_FAILS_CLOSED")
    .rejects.toThrow("private index masks");
  expect(started).toBe(0);
}, 60_000);

test("an autonomous turn on a brain without an index directory still mounts its private index", async () => {
  const f = await fixture();
  // A brain whose index was never built: the host creates the empty directory the private index is mounted over.
  rmSync(join(f.brain, ".brain-index"), { recursive: true, force: true });
  let shell = "";
  const backend = restrictedBackend(f.brain, async (_request, run) => { shell = await run(`printf 'me=%s\\n' "$(ls -A me | wc -l)"`); });
  await runAutonomousTurn({ ...f.deps, backend }, f.input);
  expect(shell, "INDEX_DIRECTORY_CREATED_FOR_THE_MASK").toBe("me=0\n");
}, 120_000);

test("an invalid policy edit keeps the hosted turns' last-valid masks for an autonomous turn on any spelling of the brain", async () => {
  const f = await fixture();
  // Hosted admission read the valid policy through an alias that is gone by
  // the time an edit breaks the policy.
  const alias = join(f.root, "brain-alias"); symlinkSync(f.brain, alias);
  expect(governancePolicyReaderFor(`${alias}/.`).load().source).toBe("policy");
  rmSync(alias);
  writeFileSync(join(f.brain, "context/policies/governance.md"), "---\nschema_version: 1\nproviders: [{ allow: [anthropic] }]\nunknown_key: true\n---\nA broken edit.\n");
  let folders: readonly string[] | undefined;
  const backend = restrictedBackend(f.brain, async request => { folders = request.workerProviderMasks?.folders; });
  await runAutonomousTurn({ ...f.deps, backend }, f.input);
  expect(folders, "LAST_VALID_MASKS_SURVIVE_AN_INVALID_EDIT").toEqual(["me"]);
}, 120_000);

test("an autonomous turn refuses a hardlink out of a masked folder before its worker starts", async () => {
  const f = await fixture();
  // A mask hides names, not inodes (#2700): the same file under another name.
  linkSync(join(f.brain, "me/oath.md"), join(f.brain, "notes/oath-copy.txt"));
  let started = 0, refusal: unknown;
  try { await runAutonomousTurn({ ...f.deps, backend: restrictedBackend(f.brain, async () => { started++; }) }, f.input); } catch (error) { refusal = error; }
  expect((refusal as Error | undefined)?.name, "AUTONOMOUS_HARDLINK_REFUSED").toBe("ProviderPolicyRefusedError");
  expect(String((refusal as Error).message)).toContain("notes/oath-copy.txt is a hardlink to me/oath.md");
  expect(started).toBe(0);
}, 120_000);

test("a restricted autonomous worker reads the committed generated-text caches as empty", async () => {
  const f = await fixture();
  writeFileSync(join(f.brain, ".context-cache.jsonl"), `${JSON.stringify({ key: "oath", context: `${SENTINEL} context of me/oath.md` })}\n`);
  writeFileSync(join(f.brain, ".asset-cache.jsonl"), `${JSON.stringify({ key: "avatar", description: `${SENTINEL} description of me/avatar.png` })}\n`);
  let shell = "";
  await runAutonomousTurn({ ...f.deps, backend: restrictedBackend(f.brain, async (_request, run) => {
    shell = await run(`for cache in .context-cache.jsonl .asset-cache.jsonl; do test -c "$cache" && printf '%s=masked\\n' "$cache"; printf '%s\\n' "$(cat "$cache" | grep -c ${SENTINEL})"; done`);
  }) }, f.input);
  expect(shell, "RESTRICTED_BASH_CANNOT_READ_CACHED_MASKED_TEXT").toBe(".context-cache.jsonl=masked\n0\n.asset-cache.jsonl=masked\n0\n");
}, 120_000);
