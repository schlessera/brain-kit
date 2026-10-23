/**
 * A proven allowed recipient's turn sees its provider folders (#2695). Only
 * the exact origin of the turn's host inference relay names the recipient,
 * on managed storage; a denied, unknown or unproven recipient keeps the
 * masks. A conversation that showed folders to one recipient refuses a later
 * turn, or a handoff's first turn, whose recipient may not see them. Real
 * bubblewrap workers from production admission; the private index is built
 * by the real CLI inside a masked worker.
 */
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { afterEach, expect, spyOn, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchAgentWorker, workerCommand } from "../../ui-sdk/src/server/worker-launcher";
import * as startup from "../../ui-sdk/src/server/worker-startup-view";
import { createUiDb } from "../src/db/client";
import { createHostExecution } from "../src/brain/host-execution";
import { createGovernedTurns, type GovernedTurnRoute } from "../src/brain/governed-turn";
import { createProviderExposures } from "../src/brain/provider-exposure";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

const REPO = resolve(import.meta.dir, "../../..");
const CORPUS = join(REPO, "packages/core/fixtures/corpus");
const CLI = [process.execPath, join(REPO, "packages/core/src/cli/brain.ts")];
const PATH = `${resolve(process.execPath, "..")}:/usr/bin:/bin`;
/** Words only the provider folders contain. */
const SENTINEL = "Zakynthosmarker";
const KNEE = "Kneecapmarker";
const ANTHROPIC = "https://api.anthropic.com";
const GOOGLE = "https://generativelanguage.googleapis.com";
const GATEWAY = "https://gateway.ithaca.invalid";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const remove of cleanup.splice(0).reverse()) remove(); });

function fixture(providers: string, recipientOrigins?: ReadonlyMap<string, string>) {
  // Inside the repository: the corpus config imports @schlessera/brain, and a
  // governed brain may not link node_modules, so resolution walks up to the
  // workspace install, which the worker's runtime read paths restore.
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  const root = mkdtempSync(join(REPO, "tmp", "odysseus-allowed-route-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain");
  cpSync(CORPUS, brain, { recursive: true });
  rmSync(join(brain, ".brain-index"), { recursive: true, force: true });
  mkdirSync(join(brain, "context/policies"), { recursive: true });
  const policy = (rules: string) => writeFileSync(join(brain, "context/policies/governance.md"),
    `---\nschema_version: 1\nproviders: ${rules}\n---\nOdysseus decides which provider reads which folder.\n`);
  policy(providers);
  mkdirSync(join(brain, ".git")); writeFileSync(join(brain, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(brain, "me/oath.md"), `---\ntype: note\ntitle: "Odysseus's private oath"\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [note]\n---\n\n${SENTINEL} is the word Odysseus keeps to himself.\n`);
  writeFileSync(join(brain, "health/knee-injury.md"), `${readFileSync(join(brain, "health/knee-injury.md"), "utf8")}\nThe healer's word is ${KNEE}.\n`);
  // The real index, built on the host from every document.
  const index = Bun.spawnSync([...CLI, "index", "--json"], { cwd: brain, env: { PATH, BRAIN_ROOT: brain, HOME: root, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  expect(index.exitCode, index.stderr.toString()).toBe(0);
  const dbPath = join(root, "state/ui.db"); mkdirSync(join(root, "state"));
  const db = createUiDb(dbPath); cleanup.push(() => db.close());
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const turns = createGovernedTurns({ nativeManager: createNativeJournalFixture(brain, root).client, brainPath: brain, execution,
    profile: "governed", maskPaths: [], index: async () => {}, report() {}, privateIndexCommand: CLI,
    exposures: createProviderExposures(db), ...(recipientOrigins ? { recipientOrigins } : {}) });
  // The copied fixture brain has no manager-acquired view; stand in for one where a case needs it.
  const managed = spyOn(startup, "isManagedWorkerStartupView").mockReturnValue(true);
  cleanup.push(() => managed.mockRestore());
  const begin = (turnId: string, route: GovernedTurnRoute) => turns.begin(turnId, new AbortController().signal, "interactive", undefined, route);
  return { brain, turns, begin, managed, policy };
}

function search(brain: string, sandbox: Parameters<typeof workerCommand>[0]["sandbox"], query: string): string[] {
  const run = Bun.spawnSync(workerCommand({ brainPath: brain, sandbox, env: { PATH, BRAIN_ROOT: brain, HOME: "/tmp", NO_COLOR: "1" },
    command: [...CLI, "search", query, "--json", "--limit", "50"] }), { env: {}, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode, `SEARCH_RAN: ${run.stderr.toString()}`).toBe(0);
  const parsed = JSON.parse(run.stdout.toString()) as { results?: { path: string }[] } | { path: string }[];
  return (Array.isArray(parsed) ? parsed : parsed.results ?? []).map(result => result.path);
}

/** What a worker reads: Read is a plain file read in the worker, Bash a shell. */
function reads(brain: string, sandbox: Parameters<typeof workerCommand>[0]["sandbox"], folder: string, file: string, word: string): string {
  const shell = Bun.spawnSync(workerCommand({ brainPath: brain, sandbox, env: { PATH }, command: ["/bin/sh", "-c", `
    printf 'read=%s\\n' "$(/usr/bin/head -n 1 ${folder}/${file} 2>/dev/null)"
    printf 'bash=%s\\n' "$(grep -rl ${word} ${folder} 2>/dev/null)"
    printf 'git=%s\\n' "$(cat .git/HEAD 2>/dev/null)"
  `] }), { env: {}, stdout: "pipe", stderr: "pipe" });
  expect(shell.exitCode, shell.stderr.toString()).toBe(0);
  return shell.stdout.toString();
}

const SHOWN_ME = `read=---\nbash=me/oath.md\ngit=ref: refs/heads/main\n`;
const HIDDEN = "read=\nbash=\ngit=\n";

test("a turn whose proven recipient a provider rule allows sees the folder, its history and the real index; another, unknown or unproven one does not", async () => {
  const f = fixture("[{ paths: [me/**], allow: [anthropic] }]");
  const hold = await f.begin("allowed", { inferenceOrigin: ANTHROPIC });
  try {
    expect(hold.sandbox.profile, hold.sandbox.fallbackReason).toBe("governed");
    expect(reads(f.brain, hold.sandbox, "me", "identity.md", SENTINEL), "ALLOWED_ROUTE_READS_FOLDER_AND_HISTORY").toBe(SHOWN_ME);
    expect(hold.sandbox.inferenceRecipient, "ALLOWED_ROUTE_RECIPIENT_PROVEN").toEqual({ name: "anthropic", origin: ANTHROPIC });
    // Empty masks, so what every provider-rule turn hides regardless of recipient still applies.
    expect(hold.sandbox.providerMasks, "ALLOWED_ROUTE_HAS_NO_FOLDER_MASK_OR_PRIVATE_INDEX").toEqual({ folders: [] });
    expect(search(f.brain, hold.sandbox, SENTINEL), "ALLOWED_ROUTE_SEARCHES_THE_REAL_INDEX").toContain("me/oath.md");
    // The launcher qualifies the unmasked retained folders before the payload starts.
    const worker = launchAgentWorker({ brainPath: f.brain, sandbox: hold.sandbox, env: { PATH }, command: ["/bin/true"] });
    expect(await worker.exited, "ALLOWED_ROUTE_QUALIFIED_BEFORE_PAYLOAD").toBe(0);
  } finally { await hold.end(); }

  for (const [label, route] of [["another provider", { inferenceOrigin: GOOGLE }], ["a custom gateway", { inferenceOrigin: GATEWAY }],
    ["no origin", {}]] as const) {
    const denied = await f.begin(`denied ${label}`, route);
    try {
      expect(denied.sandbox.inferenceRecipient?.name === "anthropic", `DENIED_ROUTE_NOT_ANTHROPIC ${label}`).toBe(false);
      expect(denied.sandbox.providerMasks?.folders, `DENIED_ROUTE_MASKS_THE_FOLDER ${label}`).toEqual(["me"]);
      expect(reads(f.brain, denied.sandbox, "me", "identity.md", SENTINEL), `DENIED_ROUTE_CANNOT_READ ${label}`).toBe(HIDDEN);
      expect(search(f.brain, denied.sandbox, SENTINEL).filter(path => path.startsWith("me/")), `DENIED_ROUTE_PRIVATE_INDEX ${label}`).toEqual([]);
    } finally { await denied.end(); }
  }

  // The relay that would prove the origin runs only on managed native storage.
  f.managed.mockReturnValue(false);
  const unmanaged = await f.begin("unmanaged", { inferenceOrigin: ANTHROPIC });
  try {
    expect(unmanaged.sandbox.inferenceRecipient, "UNMANAGED_STORAGE_PROVES_NO_RECIPIENT").toBeUndefined();
    expect(reads(f.brain, unmanaged.sandbox, "me", "identity.md", SENTINEL), "UNMANAGED_STORAGE_CANNOT_READ").toBe(HIDDEN);
  } finally { await unmanaged.end(); }
});

test("an operator-named gateway origin is the recipient it names", async () => {
  const f = fixture("[{ paths: [me/**], allow: [anthropic] }]", new Map([[GATEWAY, "anthropic"]]));
  const hold = await f.begin("gateway", { inferenceOrigin: GATEWAY });
  try {
    expect(hold.sandbox.inferenceRecipient, "OPERATOR_GATEWAY_RECIPIENT").toEqual({ name: "anthropic", origin: GATEWAY });
    expect(reads(f.brain, hold.sandbox, "me", "identity.md", SENTINEL), "OPERATOR_GATEWAY_READS_FOLDER").toBe(SHOWN_ME);
  } finally { await hold.end(); }
});

test("a turn allowed some provider folders masks the rest and its private index lacks only their documents", async () => {
  const f = fixture("[{ paths: [me/**], allow: [anthropic] }, { paths: [health/**], allow: [google] }]");
  expect(search(f.brain, undefined, KNEE), "REAL_INDEX_HOLDS_THE_HEALTH_DOCUMENT").toContain("health/knee-injury.md");
  const hold = await f.begin("anthropic", { inferenceOrigin: ANTHROPIC });
  try {
    expect(hold.sandbox.providerMasks?.folders, "PARTIAL_ROUTE_MASKS_ONLY_THE_DENIED_FOLDER").toEqual(["health"]);
    expect(hold.sandbox.providerMasks?.index, "PARTIAL_ROUTE_HAS_A_PRIVATE_INDEX").toBeDefined();
    expect(reads(f.brain, hold.sandbox, "me", "identity.md", SENTINEL), "PARTIAL_ROUTE_READS_ITS_FOLDER").toBe("read=---\nbash=me/oath.md\ngit=\n");
    expect(reads(f.brain, hold.sandbox, "health", "knee-injury.md", KNEE), "PARTIAL_ROUTE_CANNOT_READ_THE_OTHER").toBe(HIDDEN);
    expect(search(f.brain, hold.sandbox, SENTINEL), "PARTIAL_PRIVATE_INDEX_KEEPS_THE_ALLOWED_FOLDER").toContain("me/oath.md");
    expect(search(f.brain, hold.sandbox, KNEE).filter(path => path.startsWith("health/")), "PARTIAL_PRIVATE_INDEX_LACKS_THE_DENIED_FOLDER").toEqual([]);
    expect(search(f.brain, hold.sandbox, "eagle"), "PARTIAL_PRIVATE_INDEX_KEEPS_PERMITTED_DOCUMENTS").toContain("notes/quick-note-eagle.md");
  } finally { await hold.end(); }
  const google = await f.begin("google", { inferenceOrigin: GOOGLE });
  try {
    expect(google.sandbox.providerMasks?.folders, "OTHER_RECIPIENT_MASKS_THE_OTHER_FOLDER").toEqual(["me"]);
    expect(reads(f.brain, google.sandbox, "health", "knee-injury.md", KNEE), "OTHER_RECIPIENT_READS_ITS_FOLDER").toBe("read=---\nbash=health/knee-injury.md\ngit=\n");
  } finally { await google.end(); }
});

test("a conversation that showed a folder to one recipient refuses a later turn, or a handoff, whose recipient may not see it", async () => {
  const f = fixture("[{ paths: [me/**], allow: [anthropic] }, { paths: [health/**], allow: [google] }]");
  const refusal = async (turnId: string, route: GovernedTurnRoute) => {
    try { await (await f.begin(turnId, route)).end(); } catch (error) { return error as Error; }
    return undefined;
  };
  // A new conversation is named after admission; its rows bind then.
  await (await f.begin("first", { inferenceOrigin: ANTHROPIC })).end();
  f.turns.bindSession("first", "voyage");
  expect(f.turns.exposures(["voyage"]), "EXPOSURE_RECORDED_FOR_THE_SESSION").toEqual([{ recipient: "anthropic", visible: ["health", "me"], hidden: ["health"] }]);

  await (await f.begin("same recipient", { inferenceOrigin: ANTHROPIC, sessionId: "voyage" })).end();
  for (const [label, route, named] of [
    ["a dropped pin to another provider", { inferenceOrigin: GOOGLE, sessionId: "voyage" }, "this turn's recipient, google,"],
    ["an unknown gateway", { inferenceOrigin: GATEWAY, sessionId: "voyage" }, "this turn's unproven recipient"],
    ["a handoff to another provider", { inferenceOrigin: GOOGLE, inherit: ["voyage"] }, "this turn's recipient, google,"],
  ] as const) {
    const error = await refusal(`later ${label}`, route);
    expect(error?.name, `LATER_TURN_REFUSED ${label}`).toBe("ProviderRecipientRefusedError");
    // The folder hidden from the earlier turn is not in its history.
    expect(error!.message, `LATER_TURN_NAMES_THE_FOLDER ${label}`).toContain("showed `me/` to anthropic, and");
    expect(error!.message).toContain(named);
  }
  f.managed.mockReturnValue(false);
  expect((await refusal("unmanaged", { inferenceOrigin: ANTHROPIC, sessionId: "voyage" }))?.name, "UNPROVEN_LATER_TURN_REFUSED").toBe("ProviderRecipientRefusedError");
  f.managed.mockReturnValue(true);

  // A handoff's destination carries its source's exposure into its own history.
  await (await f.begin("handoff", { inferenceOrigin: ANTHROPIC, inherit: ["voyage"] })).end();
  f.turns.bindSession("handoff", "voyage-continued");
  expect((await refusal("after handoff", { inferenceOrigin: GOOGLE, sessionId: "voyage-continued" }))?.name, "HANDOFF_DESTINATION_KEEPS_THE_EXPOSURE")
    .toBe("ProviderRecipientRefusedError");

  // A new conversation has no history; a changed policy is judged afresh.
  await (await f.begin("fresh", { inferenceOrigin: GOOGLE })).end();
  f.policy("[{ paths: [me/**], allow: [anthropic, google] }, { paths: [health/**], allow: [google] }]");
  await (await f.begin("policy widened", { inferenceOrigin: GOOGLE, sessionId: "voyage" })).end();
});
