import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKeyedLock, type BackendBridge, type BrainApplicationResult } from "@schlessera/brain-ui-sdk/server";
import { createClaudeBackend } from "../../ui-backend-claude/src/backend.js";
import { createClaudeSdkTurn } from "../../ui-backend-claude/src/sdk-options.js";
import { DEFAULT_ALLOWED_TOOLS, VOICE_ALLOWED_TOOLS } from "../../ui-backend-claude/src/tool-policy.js";
import { createPiBackend } from "../../ui-backend-pi/src/backend.js";
import { createBrainTools, toolLockFromKeyed } from "../../ui-backend-pi/src/tools.js";
import { createBrainAccess } from "../../ui-backend-pi/src/brain-access.js";
import { createTurnContext } from "../../ui-backend-pi/src/turn-context.js";
import { createBrainApplication, readBrainApplicationBase } from "../src/brain/application.js";
import { openDatabase } from "@schlessera/brain/internal";

let root: string;
let closes: (() => Promise<unknown>)[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brain-hosted-adapters-"));
  cpSync(resolve("packages/core/fixtures/corpus"), root, { recursive: true });
  const config = join(root, "brain.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
  closes = [];
});
afterEach(async () => { for (const close of closes) await close(); rmSync(root, { recursive: true, force: true }); });

async function adapter(kind: "claude" | "pi", voice = false) {
  const backend = kind === "claude" ? createClaudeBackend({ brainPath: root }) : createPiBackend({ brainPath: root, loadExtensions: false });
  const policy = backend.brainApplicationPolicy!({ ...(voice ? { posture: "voice", enforceAllowedTools: true, noGrantSurface: true } : {}) });
  const approvals: unknown[] = []; const receipts: BrainApplicationResult[] = [];
  const apply = createBrainApplication({ root, principalId: "odysseus", turnId: "hosted-turn", policy, signal: new AbortController().signal,
    isAuthorized: () => true, approve: async (input) => { approvals.push(input); return !voice; }, record: r => receipts.push(r) });
  const bridge: BackendBridge = { emit: () => {}, requestPermission: async () => { throw new Error("Duplicate runtime approval"); },
    applyBrain: input => apply({ principalId: "odysseus", turnId: "hosted-turn", input }),
    readBrainBase: async path => readBrainApplicationBase(root, path) };
  if (kind === "claude") {
    const { options } = createClaudeSdkTurn({ backend: { brainPath: root }, req: { prompt: "Odysseus repairs a raft", signal: new AbortController().signal, bridge,
      ...(voice ? { posture: "voice", noGrantSurface: true, enforceAllowedTools: true } : {}) },
      profile: { requiredEnvKeys: [], buildEnv: () => ({}) } as never,
      abortController: new AbortController(), allowedTools: voice ? VOICE_ALLOWED_TOOLS : DEFAULT_ALLOWED_TOOLS,
      confirmPatterns: [], turnLock: { acquire: () => {}, release: () => {} } as never, log: () => {} });
    const client = new Client({ name: "hosted-application", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = options.mcpServers!["brain-ui"] as { instance: { connect(t: unknown): Promise<void> } };
    await server.instance.connect(serverTransport); await client.connect(clientTransport); closes.push(() => client.close());
    return { options, approvals, receipts, tools: (await client.listTools()).tools.map(t => t.name),
      call: async (name: string, input: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: input });
        const text = (result.content as { text: string }[])[0]!.text;
        try { return JSON.parse(text) as Record<string, any>; }
        catch { return { ok: false, isError: result.isError, message: text }; }
      } };
  }
  const turn = createTurnContext(); turn.bridge = bridge;
  const tools = createBrainTools({ turn, brain: createBrainAccess(root), lock: toolLockFromKeyed(createKeyedLock()) });
  return { options: undefined, approvals, receipts, tools: tools.map(t => t.name),
    call: async (name: string, input: Record<string, unknown>) => {
      const tool = tools.find(t => t.name === name)!;
      try {
        const result = await tool.execute(`call-${name}`, input, undefined, undefined, {} as never);
        return JSON.parse((result.content[0] as { text: string }).text) as Record<string, any>;
      } catch (error) { return JSON.parse((error as Error).message) as Record<string, any>; }
    } };
}

for (const kind of ["claude", "pi"] as const) {
  test(`${kind} hosted curated tools capture, append, archive and index in one step`, async () => {
    const a = await adapter(kind);
    expect(a.tools).toContain("brain_add"); expect(a.tools).toContain("brain_update"); expect(a.tools).toContain("brain_archive");
    const add = await a.call("brain_add", { content: "Odysseus reinforces the raft mast.", type: "note", title: "Raft mast application" });
    expect(add.ok).toBe(true); expect(add.indexed).toBe(true);
    const path = add.outcome.path;
    const base = await a.call("brain_read_base", { path });
    const update = await a.call("brain_update", { path, expectedBaseHash: base.expectedBaseHash, append_content: "Athena checks the rope." });
    expect(update.ok).toBe(true); expect(update.indexed).toBe(true);
    expect(readFileSync(join(root, path), "utf8")).toContain("Athena checks the rope.");
    expect(a.approvals).toHaveLength(0);
    const next = await a.call("brain_read_base", { path });
    const archive = await a.call("brain_archive", { path, expectedBaseHash: next.expectedBaseHash });
    expect(archive.ok).toBe(true); expect(archive.indexed).toBe(true); expect(a.approvals).toHaveLength(1);
    expect(readFileSync(join(root, path), "utf8")).toContain("status: archived");
    const db = openDatabase(join(root, "brain.db"));
    try { expect(db.query("SELECT status FROM documents WHERE path = ?").get(path)).toEqual({ status: "archived" }); }
    finally { db.close(); }
    expect(a.receipts).toHaveLength(3);
  });
  test(`${kind} hosted raw writes and edits add no confirmation`, async () => {
    const a = await adapter(kind);
    const path = "notes/hosted-raft.md";
    const write = await a.call("write_file", { path, expectedBaseHash: null, content: "Odysseus rows.\n" });
    expect(write.ok).toBe(true);
    const base = await a.call("brain_read_base", { path });
    const edit = await a.call("edit_file", { path, expectedBaseHash: base.expectedBaseHash, old_string: "rows", new_string: "sails" });
    expect(edit.ok).toBe(true); expect(a.approvals).toHaveLength(0);
    expect(readFileSync(join(root, path), "utf8")).toBe("Odysseus sails.\n");
  });
}

// The Claude Agent SDK passes an MCP result through untouched while its
// length / 4 stays within half its 25,000-token default (#1624).
const HARNESS_PASS_CHARS = 50_000;
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
function voyageLog(): string {
  let text = "---\ntype: note\ntitle: Voyage log\n---\n";
  for (let day = 1; text.length < 67_000; day++) text += `Day ${day}: Odysseus logs the wind, the oars and what Athena advised at dusk.\n`;
  return text;
}

for (const kind of ["claude", "pi"] as const) {
  test(`${kind} brain_read_base returns a small document whole, hash first`, async () => {
    const a = await adapter(kind);
    const path = "notes/raft-short.md"; const whole = "---\ntype: note\n---\nOdysseus rows.\n";
    writeFileSync(join(root, path), whole);
    const base = await a.call("brain_read_base", { path });
    expect(Object.keys(base)).toEqual(["expectedBaseHash", "bytes", "lines", "content"]);
    expect(base).toEqual({ expectedBaseHash: sha256(whole), bytes: Buffer.byteLength(whole), lines: 4, content: whole });
  });

  test(`${kind} brain_read_base pages a large document under the harness budget with the whole-document hash`, async () => {
    const a = await adapter(kind);
    const path = "notes/voyage-log.md"; const whole = voyageLog();
    writeFileSync(join(root, path), whole);
    const total = whole.split("\n").length - 1;
    const first = await a.call("brain_read_base", { path });
    expect(Object.keys(first)[0]).toBe("expectedBaseHash");
    expect(first.content).toBeUndefined();
    expect(first).toMatchObject({ expectedBaseHash: sha256(whole), bytes: Buffer.byteLength(whole), lines: total, offset: 1 });
    expect(first.hint).toContain(`offset: ${first.nextOffset}`);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(HARNESS_PASS_CHARS);
    let text = first.text as string; let next = first.nextOffset as number | undefined;
    while (next !== undefined) {
      const page = await a.call("brain_read_base", { path, offset: next });
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(HARNESS_PASS_CHARS);
      expect(page).toMatchObject({ expectedBaseHash: sha256(whole), lines: total, offset: next });
      expect(page.hint).toBeUndefined();
      text += page.text; next = page.nextOffset;
    }
    expect(text).toBe(whole);
    const window = await a.call("brain_read_base", { path, offset: 6, limit: 2 });
    expect(window).toEqual({ expectedBaseHash: sha256(whole), bytes: Buffer.byteLength(whole), lines: total, offset: 6, returnedLines: 2,
      text: whole.split("\n").slice(5, 7).map(line => `${line}\n`).join(""), nextOffset: 8 });
    const hashOnly = await a.call("brain_read_base", { path, limit: 0 });
    expect(hashOnly).toEqual({ expectedBaseHash: sha256(whole), bytes: Buffer.byteLength(whole), lines: total,
      offset: 1, returnedLines: 0, text: "", nextOffset: 1 });
    // A paged hash is the full base: it applies once and then goes stale.
    const edit = await a.call("edit_file", { path, expectedBaseHash: hashOnly.expectedBaseHash, old_string: "Day 3:", new_string: "Day three:" });
    expect(edit.ok).toBe(true);
    const stale = await a.call("edit_file", { path, expectedBaseHash: hashOnly.expectedBaseHash, old_string: "Day 4:", new_string: "Day four:" });
    expect(stale.ok).toBe(false);
    expect(readFileSync(join(root, path), "utf8")).toBe(whole.replace("Day 3:", "Day three:"));
  });
}

test("pi edits from a paged read's whole-document receipt", async () => {
  const a = await adapter("pi");
  const path = "notes/voyage-log.md"; const whole = voyageLog();
  writeFileSync(join(root, path), whole);
  await a.call("brain_read_base", { path, offset: 3, limit: 1 });
  const edit = await a.call("edit_file", { path, old_string: "Day 2:", new_string: "Day two:" });
  expect(edit.ok).toBe(true);
  expect(readFileSync(join(root, path), "utf8")).toBe(whole.replace("Day 2:", "Day two:"));
});

test("claude brain_read_base refuses unknown keys", async () => {
  const a = await adapter("claude");
  const refused = await a.call("brain_read_base", { path: "notes/raft.md", content: false });
  expect(refused.isError).toBe(true);
});

test("the actual Claude turn options shadow project writers and expose server writers", async () => {
  const a = await adapter("claude");
  for (const name of ["brain_add", "brain_update", "brain_archive"]) {
    expect(a.options!.disallowedTools).toContain(`mcp__brain__${name}`);
    expect(a.tools).toContain(name);
  }
  expect(a.options!.allowedTools).toContain("mcp__brain-ui__brain_add");
  expect(a.options!.allowedTools).not.toContain("mcp__brain__brain_add");
  expect(a.options!.disallowedTools).toContain("Write");
});

test("hosted voice retains capture/update and refuses archive, raw writes and grants", async () => {
  const a = await adapter("claude", true);
  const add = await a.call("brain_add", { content: "Odysseus repairs the sail.", type: "note", title: "Voice sail" });
  expect(add.ok).toBe(true);
  const path = add.outcome.path; const base = await a.call("brain_read_base", { path });
  expect((await a.call("brain_update", { path, expectedBaseHash: base.expectedBaseHash, append_content: "Athena checks it." })).ok).toBe(true);
  const next = await a.call("brain_read_base", { path });
  expect((await a.call("brain_archive", { path, expectedBaseHash: next.expectedBaseHash })).code).toBe("membership_denied");
  expect((await a.call("write_file", { path, expectedBaseHash: next.expectedBaseHash, content: "Wrong content" })).code).toBe("membership_denied");
  expect((await a.call("brain_update", { path, expectedBaseHash: next.expectedBaseHash, status: "archived" })).code).toBe("permission_denied");
  expect(a.options!.allowedTools).not.toContain("mcp__brain-ui__ask_user_form");
  expect(readFileSync(join(root, path), "utf8")).toContain("Athena checks it.");
});

for (const kind of ["claude", "pi"] as const) {
  test(`${kind} rejects command fields in staged tool arguments`, async () => {
    const a = await adapter(kind);
    const result = await a.call("apply_staged_changes", { command: "brain add raft", files: [
      { path: "notes/command-raft.md", expectedBaseHash: null, content: "Odysseus rows." },
    ] });
    expect(result.ok).toBe(false);
    expect(a.receipts.flatMap(r => r.changes)).toEqual([]);
  });
}
