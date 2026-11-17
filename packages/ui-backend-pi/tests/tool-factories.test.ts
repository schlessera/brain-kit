/**
 * Direct tests of each curated tool factory (#2517), over a stub BrainAccess
 * and a temporary repository: every factory runs alone, without the roster.
 * The roster itself stays pinned by tool-roster-snapshot.test.ts.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createKeyedLock, type BackendBridge } from "@schlessera/brain-ui-sdk/server";

import { brainReadBaseTool, routedApplicationTool, routedApplicationTools } from "../src/application-tools";
import type { BrainAccess } from "../src/brain-access";
import { brainAddTool, brainArchiveTool, brainContextTool, brainGraphTool, brainListTool, brainReadTool, brainSearchTool, brainUpdateTool } from "../src/brain-tools";
import { bashTool, editFileTool, grepTool, readFileTool, writeFileTool } from "../src/file-tools";
import { createBrainToolKit, type BrainToolKit } from "../src/tool-kit";
import { toolLockFromKeyed, type BrainToolDeps } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { resultText } from "./helpers";
import { makeMockBridge } from "./mock-bridge";

const CTX = {} as never;
let root: string;
let calls: unknown[][];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-tool-factories-"));
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "notes/ithaca.md"), "# Ithaca\n\nOdysseus sails home.\n");
  calls = [];
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function stubBrain(): BrainAccess {
  const record = (name: string, result: unknown) => async (...args: unknown[]) => { calls.push([name, ...args]); return result; };
  return {
    root, dbPath: join(root, "brain.db"),
    resolveInRepo: (rel: string) => { const abs = resolve(root, rel); return abs === root || abs.startsWith(root + "/") ? abs : null; },
    search: record("search", { results: [{ path: "notes/ithaca.md", title: "Ithaca", type: "note", snippet: "sails home" }], warnings: ["keyless"] }),
    context: record("context", "Ithaca, home of Odysseus."),
    add: record("add", { action: "created", path: "notes/penelope.md", indexed: true }),
    list: record("list", [{ path: "notes/ithaca.md", title: "Ithaca" }]),
    graph: record("graph", { edges: [{ source: "notes/ithaca.md", target: "notes/troy.md", resolved: true }], nodes: [{ path: "notes/ithaca.md" }, { path: "notes/troy.md" }] }),
    update: record("update", { path: "notes/ithaca.md", changed: ["summary"] }),
    archive: record("archive", { path: "notes/ithaca.md", archived: true }),
  } as unknown as BrainAccess;
}

function kit(deps: Partial<BrainToolDeps> = {}, bridge?: Partial<BackendBridge>): BrainToolKit {
  const turn = createTurnContext();
  if (bridge) turn.bridge = { ...makeMockBridge({}).bridge, ...bridge };
  return createBrainToolKit({ brain: stubBrain(), turn, lock: toolLockFromKeyed(createKeyedLock()), ...deps });
}

const run = (tool: ToolDefinition, params: Record<string, unknown>) => tool.execute("call-1", params as never, undefined, undefined, CTX);

test("createBrainToolKit contains paths and keeps a same-turn base only for a server route", () => {
  const plain = kit();
  expect(() => plain.resolveOrThrow("../outside.md")).toThrow("escapes the brain repository");
  plain.rememberHash("notes/ithaca.md", "a".repeat(64));
  const routed = kit({}, { applyBrain: async () => ({ ok: true }) as never });
  routed.rememberHash("notes/ithaca.md", "b".repeat(64));
  expect(routed.bases.get(routed.turn.bridge!)?.get("notes/ithaca.md")).toBe("b".repeat(64));
});

test("readFileTool reads one contained file and returns its base on a routed turn", async () => {
  const tools = kit({}, { applyBrain: async () => ({ ok: true }) as never });
  const result = await run(readFileTool(tools), { path: "notes/ithaca.md" });
  expect(resultText(result)).toBe("# Ithaca\n\nOdysseus sails home.\n");
  expect((result.details as { expectedBaseHash?: string }).expectedBaseHash).toMatch(/^[a-f0-9]{64}$/);
  await expect(run(readFileTool(kit()), { path: "../etc/passwd" })).rejects.toThrow("escapes the brain repository");
});

test("grepTool searches the repository and names each match", async () => {
  const result = await run(grepTool(kit({ exec: {} })), { pattern: "Odysseus" });
  expect(resultText(result)).toBe("./notes/ithaca.md:3:Odysseus sails home.");
  expect(resultText(await run(grepTool(kit({ exec: {} })), { pattern: "Cyclops" }))).toBe("No matches.");
});

test("writeFileTool creates a file under its path lock", async () => {
  const result = await run(writeFileTool(kit()), { path: "notes/penelope.md", content: "Weaving." });
  expect(resultText(result)).toBe("Wrote 8 bytes to notes/penelope.md.");
  expect(readFileSync(join(root, "notes/penelope.md"), "utf8")).toBe("Weaving.");
});

test("editFileTool replaces one unique string and refuses an ambiguous one", async () => {
  await run(editFileTool(kit()), { path: "notes/ithaca.md", old_string: "sails home", new_string: "is home" });
  expect(readFileSync(join(root, "notes/ithaca.md"), "utf8")).toBe("# Ithaca\n\nOdysseus is home.\n");
  await expect(run(editFileTool(kit()), { path: "notes/ithaca.md", old_string: "a", new_string: "b" })).rejects.toThrow("is not unique");
});

test("bashTool runs one command in the repository and keeps a nonzero exit", async () => {
  const tools = kit({ exec: {} });
  expect(resultText(await run(bashTool(tools), { command: "echo Odysseus" }))).toBe("Odysseus");
  expect(resultText(await run(bashTool(tools), { command: "echo Polyphemus; exit 3" }))).toBe("Polyphemus\n[exit 3]");
  expect(bashTool(kit({ shellCwd: "/worker/scratch" })).description).toStartWith("Run a bash command in writable worker scratch.");
});

test("brainSearchTool maps its date filters and refuses a malformed date", async () => {
  const result = await run(brainSearchTool(kit()), { query: "home", upcoming: true });
  expect(resultText(result)).toBe("> keyless\n- notes/ithaca.md — Ithaca [note]\n    sails home");
  expect(calls[0]![1]).toMatchObject({ query: "home", limit: 10, sort: "deadline" });
  await expect(run(brainSearchTool(kit()), { query: "home", deadline_from: "12 July" })).rejects.toThrow("deadline_from must be a date written YYYY-MM-DD");
});

test("brainContextTool assembles context with its default budget", async () => {
  expect(resultText(await run(brainContextTool(kit()), { query: "Ithaca" }))).toBe("Ithaca, home of Odysseus.");
  expect(calls).toEqual([["context", "Ithaca", 4000]]);
});

test("brainReadTool reads one section of a document", async () => {
  expect(resultText(await run(brainReadTool(kit()), { path: "notes/ithaca.md", section: "Ithaca" }))).toContain("Odysseus sails home.");
});

test("brainListTool returns its rows as compact JSON", async () => {
  const result = await run(brainListTool(kit()), { type: "note" });
  expect(JSON.parse(resultText(result))).toEqual({ documents: [{ path: "notes/ithaca.md", title: "Ithaca" }] });
  expect(calls).toEqual([["list", { type: "note" }]]);
});

test("brainGraphTool traverses both directions unless one is named", async () => {
  const result = await run(brainGraphTool(kit()), { path: "notes/ithaca.md", direction: "sideways" });
  expect(JSON.parse(resultText(result)).edges).toHaveLength(1);
  expect(calls).toEqual([["graph", { path: "notes/ithaca.md", depth: undefined, direction: "both" }]]);
});

test("brainAddTool captures content under the brain-docs lock", async () => {
  expect(resultText(await run(brainAddTool(kit()), { content: "Penelope weaves." }))).toBe("created: notes/penelope.md");
  expect(calls).toEqual([["add", { content: "Penelope weaves.", type: undefined, title: undefined, tags: undefined }]]);
});

test("brainUpdateTool refuses an unknown status before writing", async () => {
  await expect(run(brainUpdateTool(kit()), { path: "notes/ithaca.md", status: "lost" })).rejects.toThrow("Invalid status \"lost\"");
  expect(calls).toEqual([]);
  await run(brainUpdateTool(kit()), { path: "notes/ithaca.md", summary: "Home." });
  expect(calls[0]![1]).toMatchObject({ path: "notes/ithaca.md", summary: "Home." });
});

test("brainArchiveTool archives for real unless asked to preview", async () => {
  await run(brainArchiveTool(kit()), { path: "notes/ithaca.md" });
  expect(calls).toEqual([["archive", "notes/ithaca.md", false]]);
});

test("routedApplicationTools route every operation, except write and edit on a direct-write roster", () => {
  expect(routedApplicationTools(kit(), []).map(tool => tool.name))
    .toEqual(["write_file", "edit_file", "apply_staged_changes", "brain_add", "brain_update", "brain_archive"]);
  expect(routedApplicationTools(kit({ directWrites: true }), []).map(tool => tool.name))
    .toEqual(["apply_staged_changes", "brain_add", "brain_update", "brain_archive"]);
});

test("routedApplicationTool sends its input to the server with the same-turn base, and falls back without a route", async () => {
  const inputs: unknown[] = [];
  const tools = kit({}, { applyBrain: async input => { inputs.push(input); return { ok: true, path: "notes/ithaca.md" } as never; } });
  const edit = routedApplicationTools(tools, []).find(tool => tool.name === "edit_file")!;
  await expect(run(edit, { path: "notes/ithaca.md", old_string: "sails", new_string: "is" })).rejects.toThrow("Read brain_read_base or read_file first");
  tools.rememberHash("notes/ithaca.md", "c".repeat(64));
  await run(edit, { path: "notes/ithaca.md", old_string: "sails", new_string: "is" });
  expect(inputs).toEqual([{ path: "notes/ithaca.md", old_string: "sails", new_string: "is", operation: "edit", expectedBaseHash: "c".repeat(64) }]);
  const plain = kit();
  const legacy = brainAddTool(plain);
  const add = routedApplicationTools(plain, [legacy]).find(tool => tool.name === "brain_add")!;
  expect(add.label).toBe(legacy.label);
  expect(resultText(await run(add, { content: "Penelope weaves." }))).toBe("created: notes/penelope.md");
  const staged = routedApplicationTool(plain, (await import("@schlessera/brain-ui-sdk/server")).brainApplicationInput.options[2], []);
  await expect(run(staged, { files: [] })).rejects.toThrow("No authoritative server application route");
});

test("brainReadBaseTool reads the server base and remembers its whole-document hash", async () => {
  await expect(run(brainReadBaseTool(kit()), { path: "notes/ithaca.md" })).rejects.toThrow("No server document-base reader");
  const tools = kit({}, {
    applyBrain: async () => ({ ok: true }) as never,
    readBrainBase: async () => ({ content: "# Ithaca\n\nOdysseus sails home.\n", expectedBaseHash: "d".repeat(64) }) as never,
  });
  const result = await run(brainReadBaseTool(tools), { path: "notes/ithaca.md" });
  expect(JSON.parse(resultText(result))).toMatchObject({ expectedBaseHash: "d".repeat(64) });
  expect(tools.bases.get(tools.turn.bridge!)?.get("notes/ithaca.md")).toBe("d".repeat(64));
});
