/**
 * Host bridge tools run on the server, outside a turn's worker mounts. While a
 * provider folder rule masks a folder for the turn (#1668), `brain_read_base`,
 * the application tools and image masks refuse every path at or below it,
 * with a named refusal and one governance event per call (#2690). Production
 * admission and the real bridge, driven through Claude's and Pi's own tool
 * registrations.
 */
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKeyedLock, type BackendBridge, type StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { createClaudeBackend } from "../../ui-backend-claude/src/backend";
import { createClaudeSdkTurn } from "../../ui-backend-claude/src/sdk-options";
import { DEFAULT_ALLOWED_TOOLS } from "../../ui-backend-claude/src/tool-policy";
import { createPiBackend } from "../../ui-backend-pi/src/backend";
import { createBrainTools, toolLockFromKeyed } from "../../ui-backend-pi/src/tools";
import { createBrainAccess } from "../../ui-backend-pi/src/brain-access";
import { createTurnContext } from "../../ui-backend-pi/src/turn-context";
import { createUiDb } from "../src/db/client";
import { createHostExecution } from "../src/brain/host-execution";
import { createGovernedTurns } from "../src/brain/governed-turn";
import { contentHash } from "../src/brain/application";
import { queryGovernanceEvents } from "../src/governance/events";
import { WsHost } from "../src/ws/host";
import { runSession } from "../src/ws/run-session";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { handleClientMessage } from "../src/ws/dispatch";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";
import { createPrincipal, isUsablePrincipal, resolvePrincipal } from "../src/db/principals";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

const IDENTITY = "---\ntype: note\ntitle: Odysseus identity\n---\nOdysseus keeps the name Nobody for the Cyclops.\n";
const RAFT = "---\ntype: note\ntitle: Raft\n---\nOdysseus lashes the raft.\n";
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

/** Every file under a folder with its exact bytes, so "unchanged" means byte-identical. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path.slice(dir.length + 1)] = readFileSync(path).toString("base64");
  }
  return out;
}

/** The backend's own registration of the bridge tools, called as its agent would. */
async function registration(kind: "claude" | "pi", brain: string, bridge: BackendBridge, closes: (() => Promise<unknown>)[]) {
  const name = (tool: string) => kind === "claude" ? `mcp__brain-ui__${tool}` : tool;
  if (kind === "claude") {
    const { options } = createClaudeSdkTurn({ backend: { brainPath: brain }, req: { prompt: "Odysseus reads", signal: new AbortController().signal, bridge },
      profile: { requiredEnvKeys: [], buildEnv: () => ({}) } as never, abortController: new AbortController(), allowedTools: DEFAULT_ALLOWED_TOOLS,
      confirmPatterns: [], turnLock: { acquire: () => {}, release: () => {} } as never, log: () => {} });
    const client = new Client({ name: "provider-mask-bridge", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = options.mcpServers!["brain-ui"] as { instance: { connect(t: unknown): Promise<void> } };
    await server.instance.connect(serverTransport); await client.connect(clientTransport); closes.push(() => client.close());
    return { name, call: async (tool: string, input: Record<string, unknown>) => {
      const result = await client.callTool({ name: tool, arguments: input });
      const text = (result.content as { text: string }[])[0]!.text;
      try { return { isError: result.isError === true, ...JSON.parse(text) as Record<string, any> }; }
      catch { return { isError: result.isError === true, message: text } as Record<string, any>; }
    } };
  }
  const turn = createTurnContext(); turn.bridge = bridge;
  const tools = createBrainTools({ turn, brain: createBrainAccess(brain), lock: toolLockFromKeyed(createKeyedLock()) });
  return { name, call: async (tool: string, input: Record<string, unknown>) => {
    try {
      const result = await tools.find(t => t.name === tool)!.execute(`call-${tool}`, input, undefined, undefined, {} as never);
      return { isError: false, ...JSON.parse((result.content[0] as { text: string }).text) as Record<string, any> };
    } catch (error) {
      const message = (error as Error).message;
      try { return { isError: true, ...JSON.parse(message) as Record<string, any> }; } catch { return { isError: true, message } as Record<string, any>; }
    }
  } };
}

async function maskedTurn(kind: "claude" | "pi", script: (bridge: BackendBridge, brain: string, request: StartTurnRequest) => Promise<void>,
  options: { folders?: readonly string[]; setup?: (brain: string) => Partial<ConstructorParameters<typeof WsHost>[0]> | void;
    host?: Partial<ConstructorParameters<typeof WsHost>[0]>; check?: (brain: string) => void } = {}) {
  const folders = options.folders ?? ["me"];
  const root = mkdtempSync(join(tmpdir(), "odysseus-provider-mask-bridge-"));
  const brain = join(root, "brain");
  for (const dir of ["context/policies", "me", "notes"]) mkdirSync(join(brain, dir), { recursive: true });
  writeFileSync(join(brain, "context/policies/governance.md"),
    `---\nschema_version: 1\nproviders: [{ paths: [${folders.map(root => `${root}/**`).join(", ")}], allow: [anthropic] }]\n---\nOnly Anthropic may read Odysseus's own folders.\n`);
  writeFileSync(join(brain, "me/identity.md"), IDENTITY);
  writeFileSync(join(brain, "me/avatar.png"), PNG);
  writeFileSync(join(brain, "notes/raft.md"), RAFT);
  const extraHost = options.setup?.(brain) ?? {};
  const dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const authorization = testAuthorization(principal.id);
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  // The private index's content is not under test here; its build is a no-op worker.
  const turns = createGovernedTurns({ nativeManager: createNativeJournalFixture(brain, root).client, brainPath: brain, execution, profile: "governed",
    maskPaths: [], index: async () => {}, report() {}, privateIndexCommand: ["/bin/true"] });
  const firstParty = kind === "claude" ? createClaudeBackend({ brainPath: brain }) : createPiBackend({ brainPath: brain, loadExtensions: false });
  let failure: unknown, masks: readonly string[] | undefined;
  const backend = { ...makeFakeBackend({ id: kind, startTurn: async request => {
    masks = request.workerSandbox?.providerMasks?.folders;
    try { await script(request.bridge, brain, request); } catch (error) { failure = error; }
    request.bridge.emit({ type: "session_info", sessionId: `masked-${kind}`, isNew: true });
    request.bridge.emit({ type: "result", sessionId: `masked-${kind}`, durationMs: 1, numTurns: 1, isError: false });
  } }), brainApplicationPolicy: firstParty.brainApplicationPolicy };
  const host = new WsHost({ brainPath: brain, governedTurns: turns, registry: createStaticBackendRegistry([backend], kind), catalog: createSessionCatalog(() => db),
    isPrincipalAuthorized: id => { const found = resolvePrincipal(db, id); return found !== null && isUsablePrincipal(found, Date.now()); },
    ...options.host, ...extraHost,
    applicationPlanner: { index: async () => {}, planAdd: async (_root, input, read) => {
      // A capture the planner files under the masked folder, as a type's directory would.
      if (input.title === "Planned") return { path: "me/planned.md", content: IDENTITY, baseContent: null, outcome: {} };
      // Classification matched a masked document and planning reads it to append.
      if (input.title === "Classified") {
        const masked = read("me/identity.md");
        return { path: "notes/classified.md", content: masked ?? "Odysseus remembers Ithaca.\n", baseContent: masked, outcome: {} };
      }
      throw new Error("NO_PLANNING_FOR_A_MASKED_TARGET");
    } } });
  const ws = { send(data: string) {
    const frame = JSON.parse(data);
    if (frame.type === "mask_request") void handleClientMessage(host, ws, { type: "mask_response", requestId: frame.requestId, turnId: frame.turnId,
      maskPng: Buffer.from([...PNG, 1]).toString("base64") }, { principal, authorization, protocolRev: 3 });
  } };
  host.clients.add(ws, principal.id);
  const before = snapshot(join(brain, "me"));
  try {
    await runSession(host, { authorization, text: "Odysseus works beside his own folder.", attachments: [] });
    if (failure) throw failure;
    expect(masks, "TURN_ADMITTED_WITH_PROVIDER_MASKS").toEqual([...folders].sort());
    expect(snapshot(join(brain, "me")), "MASKED_FOLDER_BYTE_IDENTICAL").toEqual(before);
    options.check?.(brain);
    return { events: queryGovernanceEvents(db, { kinds: ["provider_mask_refusal"], limit: 100 }) };
  } finally { host.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
}

for (const kind of ["claude", "pi"] as const) {
  test(`${kind} brain_read_base and applications refuse a masked provider folder, and permitted paths still work`, async () => {
    const closes: (() => Promise<unknown>)[] = [];
    let permitted: string | undefined;
    const { events } = await maskedTurn(kind, async (bridge, brain) => {
      const tools = await registration(kind, brain, bridge, closes);
      try {
        const read = await tools.call("brain_read_base", { path: "me/identity.md" });
        expect(JSON.stringify(read), "MASKED_READ_RETURNS_NO_CONTENT").not.toContain("Nobody");
        expect(read.isError).toBe(true);
        expect(read.message, "MASKED_READ_NAMED_REFUSAL").toContain("provider_masked: me/identity.md");
        // Other spellings of the same document resolve to the masked root.
        for (const path of ["notes/../me/identity.md", "./me/identity.md"]) {
          const alias = await tools.call("brain_read_base", { path });
          expect(JSON.stringify(alias), `NONCANONICAL_READ_REFUSED ${path}`).not.toContain("Nobody");
          expect(alias.message).toContain("provider_masked");
        }
        const write = await tools.call("write_file", { path: "me/new.md", expectedBaseHash: null, content: "Odysseus writes into his folder.\n" });
        expect({ ok: write.ok, code: write.code }, "MASKED_WRITE_REFUSED").toEqual({ ok: false, code: "provider_masked" });
        const add = await tools.call("brain_add", { content: "Odysseus remembers Ithaca.", type: "note", title: "Ithaca", target: "me/new.md" });
        expect({ ok: add.ok, code: add.code }, "MASKED_CAPTURE_REFUSED_BEFORE_PLANNING").toEqual({ ok: false, code: "provider_masked" });
        const planned = await tools.call("brain_add", { content: "Odysseus remembers Ithaca.", type: "note", title: "Planned" });
        expect({ ok: planned.ok, code: planned.code }, "MASKED_PLANNED_DESTINATION_REFUSED").toEqual({ ok: false, code: "provider_masked" });
        const classified = await tools.call("brain_add", { content: "Odysseus remembers Ithaca.", type: "note", title: "Classified" });
        // Planning sees the masked document as absent and files a new one.
        expect(classified.ok, `PLANNING_SEES_A_MASKED_DOCUMENT_AS_ABSENT ${JSON.stringify(classified)}`).toBe(true);
        expect(readFileSync(join(brain, "notes/classified.md"), "utf8"), "PLANNING_CANNOT_READ_A_MASKED_DOCUMENT").not.toContain("Nobody");
        const update = await tools.call("brain_update", { path: "me/identity.md", expectedBaseHash: contentHash(IDENTITY), append_content: "Athena." });
        expect({ ok: update.ok, code: update.code }, "MASKED_UPDATE_REFUSED").toEqual({ ok: false, code: "provider_masked" });
        const archive = await tools.call("brain_archive", { path: "me/identity.md", expectedBaseHash: contentHash(IDENTITY) });
        expect({ ok: archive.ok, code: archive.code }, "MASKED_ARCHIVE_REFUSED").toEqual({ ok: false, code: "provider_masked" });
        const edit = await tools.call("edit_file", { path: "me/identity.md", expectedBaseHash: contentHash(IDENTITY), old_string: "Nobody", new_string: "Odysseus" });
        expect({ ok: edit.ok, code: edit.code }, "MASKED_EDIT_REFUSED").toEqual({ ok: false, code: "provider_masked" });
        const staged = await tools.call("apply_staged_changes", { files: [{ path: "notes/staged.md", expectedBaseHash: null, content: "Penelope weaves.\n" },
          { path: "me/staged.md", expectedBaseHash: null, content: "Odysseus hides.\n" }] });
        expect({ ok: staged.ok, code: staged.code }, "MASKED_STAGED_REFUSED_WHOLE").toEqual({ ok: false, code: "provider_masked" });
        // Permitted paths are unaffected.
        const raft = await tools.call("brain_read_base", { path: "notes/raft.md" });
        expect(raft.content, "PERMITTED_READ").toBe(RAFT);
        const note = await tools.call("write_file", { path: "notes/hosted-raft.md", expectedBaseHash: null, content: "Odysseus sails.\n" });
        expect(note.ok, "PERMITTED_WRITE").toBe(true);
        permitted = readFileSync(join(brain, "notes/hosted-raft.md"), "utf8");
      } finally { for (const close of closes) await close(); }
    });
    expect(permitted).toBe("Odysseus sails.\n");
    const tool = (name: string) => kind === "claude" ? `mcp__brain-ui__${name}` : name;
    const rule = { list: "providers", index: 0, pattern: "me/**" };
    expect(events.map(event => ({ actor: event.actor, profile: event.profile, ...event.payload })), "ONE_GOVERNANCE_EVENT_PER_REFUSED_CALL").toEqual([
      ["brain_read_base", "me/identity.md"], ["brain_read_base", "notes/../me/identity.md"], ["brain_read_base", "./me/identity.md"],
      ["write_file", "me/new.md"], ["brain_add", "me/new.md"], ["brain_add", "me/planned.md"], ["brain_update", "me/identity.md"], ["brain_archive", "me/identity.md"], ["edit_file", "me/identity.md"], ["apply_staged_changes", "me/staged.md"],
    ].map(([name, path]) => ({ actor: "interactive", profile: "governed", tool: tool(name!), path, rule, policyHash: expect.any(String) })));
  }, 60_000);
}

for (const kind of ["claude", "pi"] as const) {
  test(`${kind} symlink and hardlink aliases of a masked document return no content`, async () => {
    const closes: (() => Promise<unknown>)[] = [];
    await maskedTurn(kind, async (bridge, brain) => {
      // Aliases appear after admission, as a peer or the user could make them.
      symlinkSync("../me/identity.md", join(brain, "notes/alias.md"));
      symlinkSync("../me", join(brain, "notes/me-link"));
      linkSync(join(brain, "me/identity.md"), join(brain, "notes/hardlink.md"));
      const tools = await registration(kind, brain, bridge, closes);
      try {
        for (const path of ["notes/alias.md", "notes/me-link/identity.md", "notes/hardlink.md"]) {
          const read = await tools.call("brain_read_base", { path });
          expect(JSON.stringify(read), `ALIAS_READ_RETURNS_NO_CONTENT ${path}`).not.toContain("Nobody");
          expect(read.isError, path).toBe(true);
          const write = await tools.call("write_file", { path, expectedBaseHash: contentHash(IDENTITY), content: "Overwritten.\n" });
          expect(write.ok, `ALIAS_WRITE_REFUSED ${path}`).toBe(false);
        }
      } finally { for (const close of closes) await close(); }
    });
  }, 60_000);

  test(`${kind} an image mask over a masked folder refuses before reading the image`, async () => {
    let requested: unknown, applied: Record<string, unknown> | undefined;
    const { events } = await maskedTurn(kind, async bridge => {
      try { await bridge.requestMask!("me/avatar.png", "Mark the shield."); } catch (error) { requested = error; }
      applied = await bridge.applyImageMask!({ imagePath: "me/avatar.png", maskPath: kind === "pi" ? "me/avatar.mask.png" : "me/avatar-mask.png", png: PNG }) as unknown as Record<string, unknown>;
    });
    expect(String((requested as Error | undefined)?.message), "MASK_REQUEST_REFUSED").toContain("provider_masked: me/avatar.png");
    expect({ ok: applied?.ok, code: applied?.code, changes: applied?.changes }, "MASK_APPLICATION_REFUSED").toEqual({ ok: false, code: "provider_masked", changes: [] });
    expect(events.map(event => event.payload.path)).toEqual(["me/avatar.png", "me/avatar.png"]);
  }, 60_000);
}

test("share completion and a policy proposal receive the turn's mask refusal", async () => {
  const completions: unknown[] = [];
  let proposed = 0, added = 0, completion: unknown, proposal: unknown, intake: unknown;
  // Stand-ins for the share service and policy writer record what the bridge hands them.
  const shares = { start() {}, end() {}, apply: async (..._args: unknown[]) => { throw new Error("unused"); },
    complete: async (...args: unknown[]) => { const assertVisible = args[7] as ((paths: string[]) => void) | undefined;
      completions.push(Boolean(assertVisible)); assertVisible?.(["me/new.md"]); return { itemId: "item-ithaca", status: "done" as const, replay: false }; } };
  const { events } = await maskedTurn("claude", async bridge => {
    try { await bridge.completeShare!({ receiptIds: ["receipt-ithaca"], files: [] }); } catch (error) { completion = error; }
    try { await bridge.proposePolicyChange!("policy-ithaca", {} as never); } catch (error) { proposal = error; }
    try { await bridge.inboxAdd!({} as never); } catch (error) { intake = error; }
  }, { folders: ["context", "me", ".brain-ui/inbox"], host: {
    inboxTools: { forTurn: () => ({ inboxAdd: async () => { added++; return { created: true, threadId: "t", itemId: "i" }; } }), shares } as never,
    policyProposals: { propose: async () => { proposed++; throw new Error("UNREACHED"); } } as never,
  } });
  expect(completions, "COMPLETION_RECEIVES_THE_TURN_GUARD").toEqual([true]);
  expect(String((completion as Error | undefined)?.message), "MASKED_COMPLETION_REFUSED").toContain("provider_masked: me/new.md");
  expect(String((proposal as Error | undefined)?.message), "MASKED_POLICY_PROPOSAL_REFUSED").toContain("provider_masked: context/policies/governance.md");
  expect(proposed, "NO_PROPOSAL_REACHES_THE_POLICY_WRITER").toBe(0);
  expect(String((intake as Error | undefined)?.message), "MASKED_INBOX_STAGING_REFUSED").toContain("provider_masked: .brain-ui/inbox/new");
  expect(added, "NO_ITEM_STAGED").toBe(0);
  expect(events.map(event => [event.payload.tool, event.payload.path, (event.payload.rule as { pattern: string }).pattern])).toEqual([
    ["mcp__brain-ui__complete_share", "me/new.md", "me/**"], ["mcp__brain-ui__propose_policy_change", "context/policies/governance.md", "context/**"],
    ["mcp__brain-ui__inbox_add", ".brain-ui/inbox/new", ".brain-ui/inbox/**"]]);
}, 60_000);

test("an archive into a masked folder refuses before approval, dry run included", async () => {
  const closes: (() => Promise<unknown>)[] = [];
  let permissions = 0;
  const { events } = await maskedTurn("claude", async (bridge, brain) => {
    // An approval card would be the first effect of an unrefused archive; deny it at once.
    bridge.requestPermission = async () => { permissions++; return { behavior: "deny", message: "Fixture denial." }; };
    const tools = await registration("claude", brain, bridge, closes);
    try {
      for (const dry_run of [true, false]) {
        const archive = await tools.call("brain_archive", { path: "projects/active/raft.md", expectedBaseHash: contentHash(RAFT), dry_run });
        expect({ ok: archive.ok, code: archive.code }, `MASKED_ARCHIVE_DESTINATION_REFUSED dry_run=${dry_run}`).toEqual({ ok: false, code: "provider_masked" });
      }
    } finally { for (const close of closes) await close(); }
  }, { folders: ["me", "projects/archive"], setup: brain => {
    mkdirSync(join(brain, "projects/active"), { recursive: true }); mkdirSync(join(brain, "projects/archive"));
    writeFileSync(join(brain, "projects/active/raft.md"), RAFT);
  } });
  expect(permissions, "NO_APPROVAL_FOR_A_MASKED_DESTINATION").toBe(0);
  expect(events.map(event => event.payload.path)).toEqual(["projects/archive/raft.md", "projects/archive/raft.md"]);
}, 60_000);

test("the scratch prune after an image mask keeps a masked folder's files", async () => {
  let applied: Record<string, unknown> | undefined;
  const { events } = await maskedTurn("claude", async bridge => {
    const response = await bridge.requestMask!(".brain/scratch/public/raft.png", "Mark the sail.");
    applied = await bridge.applyImageMask!({ imagePath: ".brain/scratch/public/raft.png", maskPath: ".brain/scratch/public/raft-mask.png", png: response }) as unknown as Record<string, unknown>;
  }, { folders: ["me", ".brain/scratch/private"], setup: brain => {
    for (const dir of [".brain/scratch/public", ".brain/scratch/private"]) mkdirSync(join(brain, dir), { recursive: true });
    writeFileSync(join(brain, ".gitignore"), ".brain/scratch/\n");
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: brain }).exitCode).toBe(0);
    writeFileSync(join(brain, ".brain/scratch/public/raft.png"), PNG);
    writeFileSync(join(brain, ".brain/scratch/private/old.png"), PNG);
    utimesSync(join(brain, ".brain/scratch/private/old.png"), new Date(0), new Date(0));
    const view = createFixtureWorkerStartupView(brain);
    return { maintenance: { startupView: view, tempDomain: { statePath: join(view.storage.root, "maintenance-state.db") } } } as never;
  }, check: brain => {
    expect(existsSync(join(brain, ".brain/scratch/private/old.png")), "PRUNE_KEEPS_MASKED_FOLDER_FILES").toBe(true);
  } });
  expect(applied?.ok, JSON.stringify(applied)).toBe(true);
  expect(events).toEqual([]);
}, 60_000);

for (const variant of ["inside", "alias"] as const) test(`inbox_add refuses when the staging directory holds or resolves into a masked folder (${variant})`, async () => {
  let added = 0, intake: unknown;
  const { events } = await maskedTurn("claude", async bridge => {
    try { await bridge.inboxAdd!({} as never); } catch (error) { intake = error; }
  }, { folders: variant === "inside" ? ["me", ".brain-ui/inbox/ithaca"] : ["me"], setup: brain => {
    if (variant === "alias") { mkdirSync(join(brain, "me/inbox"), { recursive: true }); mkdirSync(join(brain, ".brain-ui"), { recursive: true }); symlinkSync("../me/inbox", join(brain, ".brain-ui/inbox")); }
  }, host: { inboxTools: { forTurn: () => ({ inboxAdd: async () => { added++; return { created: true, threadId: "t", itemId: "i" }; } }) } as never } });
  expect(String((intake as Error | undefined)?.message), "MASKED_INBOX_STAGING_REFUSED").toContain(variant === "inside" ? "provider_masked: .brain-ui/inbox/ithaca" : "provider_masked: me/inbox/new");
  expect(added, "NO_ITEM_STAGED").toBe(0);
  expect(events).toHaveLength(1);
}, 60_000);
