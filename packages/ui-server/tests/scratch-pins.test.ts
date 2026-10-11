import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionHistoryMessage, ChatSession } from "@schlessera/brain-ui-sdk/protocol";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createScratchPins as createRawScratchPins, scratchLinks } from "../src/cron/scratch-pins";
import { startScratchPrune } from "../src/cron/scratch-prune";
import { makeFakeBackend } from "./helpers/fake-backend";
import { makeTempBrain, cleanup, runCli } from "../../core/tests/cli-harness";
import { createRecordingObservability } from "../src/observability/index";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { FailureReplay } from "../src/ws/turn-failures";
import { createUiDb } from "../src/db/client";
let root: string;
const handles: Array<ReturnType<typeof createRawScratchPins>> = [];
const createScratchPins: typeof createRawScratchPins = (...args) => { const pins = createRawScratchPins(...args); handles.push(pins); return pins; };
beforeEach(() => { root = makeTempBrain(); });
afterEach(() => { for (const pins of handles.splice(0)) pins.close(); cleanup(root); });
const answer = (content: string): SessionHistoryMessage => ({ role: "assistant", content, toolCalls: [] });
const session = (id: string): ChatSession => ({ id, title: "Voyage", createdAt: 0, lastActiveAt: 0, totalCostUsd: 0, numTurns: 1 });
function old(name: string) {
  const path = join(root, ".brain/scratch", name); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "12345");
  const time = (Date.now() - 10 * 86400000) / 1000; utimesSync(path, time, time); return path;
}
test("retained history backfill protects ten-day-old links; deletion releases the last session pin", async () => {
  const retained = [session("odysseus"), session("penelope")];
  const backend = makeFakeBackend({ id: "fake", sessions: retained, histories: {
    odysseus: [answer("[Voyage](.brain/scratch/voyage.pdf)")], penelope: [answer(".brain/scratch/voyage.pdf")],
  } });
  const kept = old("voyage.pdf"), unlinked = old("draft.pdf");
  const pins = createScratchPins(root, createStaticBackendRegistry([backend]));
  let output = "";
  const pruner = startScratchPrune({ pins, every: () => () => {}, brain: { async scratchPrune(opts) {
    const result = await runCli(root, ["scratch", "prune", "--pins-file", opts!.pinsFile!, "--json"]);
    expect(result.code).toBe(0); output = result.stdout; return output;
  } } });
  try {
    await pruner.tick(); expect(existsSync(kept)).toBe(true); expect(existsSync(unlinked)).toBe(false);
    expect(JSON.parse(output).pinned).toEqual({ files: 1, bytes: 5 });
    retained.shift(); await pruner.tick(); expect(existsSync(kept)).toBe(true);
    retained.pop(); await pruner.tick(); expect(existsSync(kept)).toBe(false);
  } finally { await pruner.close(); }
});
test("a failed backfill suspends all prune callers and recovers on a complete scan", async () => {
  let failed = true;
  const backend = makeFakeBackend({ id: "fake", sessions: [session("odysseus")], getHistory: async () => {
    if (failed) throw new Error("unavailable transcript"); return [answer(".brain/scratch/voyage.pdf")];
  } });
  const kept = old("voyage.pdf"); const pins = createScratchPins(root, createStaticBackendRegistry([backend]));
  await expect(pins.refresh(new AbortController().signal)).rejects.toThrow("unavailable transcript");
  const result = await runCli(root, ["scratch", "prune", "--json"]); expect(result.code).toBe(2); expect(existsSync(kept)).toBe(true);
  failed = false; await pins.refresh(new AbortController().signal);
  expect(JSON.parse(readFileSync(pins.file, "utf8")).ready).toBe(true);
});
test("the completed-turn history boundary records new assistant links", async () => {
  const db = createUiDb(":memory:"); const logs = createRecordingObservability();
  const backend = makeFakeBackend({ id: "fake", histories: { odysseus: [answer(".brain/scratch/voyage.pdf")] } });
  const pins = createScratchPins(root, createStaticBackendRegistry([backend]));
  const replay = new FailureReplay(createSessionCatalog(() => db, logs.logger("db"), pins), logs.logger("turn"));
  try {
    const boundary = await replay.begin(backend, undefined, "voyage-turn", new AbortController().signal);
    await boundary.finish("odysseus");
    expect(Object.values(JSON.parse(readFileSync(pins.file, "utf8")).sessions)).toEqual([[".brain/scratch/voyage.pdf"]]);
  } finally { db.close(); }
});
test("Markdown, images, wiki, encoded API, spaces, parentheses and bare paths pin; user text does not", () => {
  const paths = scratchLinks([answer('[PDF](.brain/scratch/voyage(1).pdf) ![Map](./.brain/scratch/map.png) [[.brain/scratch/log.md|Log]] [Spaced](<.brain/scratch/voyage log.pdf>) /api/files/content?path=.brain%2Fscratch%2Fsea%20map.png&raw=1 .brain/scratch/draft.pdf.'),
    { role: "user", content: ".brain/scratch/user.pdf", toolCalls: [] }]);
  for (const path of ["voyage(1).pdf", "map.png", "log.md", "voyage log.pdf", "sea map.png", "draft.pdf"]) expect(paths).toContain(`.brain/scratch/${path}`);
  expect(paths).not.toContain(".brain/scratch/user.pdf");
  expect(scratchLinks([answer(".brain/scratch/../secret.pdf")])).toEqual([]);
});
test("over-cap pins are logged as a governance diagnostic", async () => {
  const logs = createRecordingObservability();
  const pruner = startScratchPrune({ log: logs.logger("cron"), every: () => () => {}, brain: {
    scratchPrune: async () => JSON.stringify({ overageBytes: 20, pinned: { files: 1, bytes: 100 } }),
  } });
  await pruner.tick(); expect(logs.logs.count({ scope: "cron", body: "scratch remains over its size cap" })).toBe(1); await pruner.close();
});

test("lost snapshot directory stays fail-safe through the durable managed marker", async () => {
  const kept = old("voyage.pdf"); const pins = createScratchPins(root, createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]));
  rmSync(join(pins.file, ".."), { recursive: true });
  const result = await runCli(root, ["scratch", "prune", "--json"]);
  expect(result.code).toBe(2); expect(existsSync(kept)).toBe(true);
});
test("a hung history read is bounded and coalesced across retries", async () => {
  let calls = 0;
  const backend = makeFakeBackend({ id: "fake", sessions: [session("odysseus")], getHistory: () => { calls++; return new Promise(() => {}); } });
  const pins = createScratchPins(root, createStaticBackendRegistry([backend]));
  for (let i = 0; i < 2; i++) {
    const controller = new AbortController(); const refresh = pins.refresh(controller.signal);
    const timer = setTimeout(() => controller.abort(new Error("deadline")), 20);
    try { await expect(refresh).rejects.toThrow("deadline"); } finally { clearTimeout(timer); }
  }
  expect(calls).toBe(1); expect(JSON.parse(readFileSync(pins.file, "utf8")).ready).toBe(false);
});
test("a new session recorded during enumeration is not lost to an older listing", async () => {
  let release!: (messages: SessionHistoryMessage[]) => void;
  const backend = makeFakeBackend({ id: "fake", sessions: [session("odysseus")], getHistory: () => new Promise(resolve => { release = resolve; }) });
  const pins = createScratchPins(root, createStaticBackendRegistry([backend]));
  const refresh = pins.refresh(new AbortController().signal);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  pins.record("penelope", "fake", [answer(".brain/scratch/voyage.pdf")]); release([]); await refresh;
  expect(Object.values(JSON.parse(readFileSync(pins.file, "utf8")).sessions)).toContainEqual([".brain/scratch/voyage.pdf"]);
});

test("operational pin snapshots and the managed marker stay gitignored", async () => {
  const pins = createScratchPins(root, createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]));
  const result = Bun.spawnSync(["git", "init", "-q", root]); expect(result.exitCode).toBe(0);
  for (const path of [pins.file, join(root, ".brain/scratch-pins-required/.gitignore")]) {
    expect(Bun.spawnSync(["git", "-C", root, "check-ignore", "-q", "--", path]).exitCode).toBe(0);
  }
});

test("structured inline supporting-file paths pin too", () => {
  const message = answer("Here is the voyage log.");
  message.toolCalls = [{ id: "voyage-files", name: "render_block", input: { kind: "files", files: [{ path: ".brain/scratch/voyage log.pdf" }] } }];
  expect(scratchLinks([message])).toContain(".brain/scratch/voyage log.pdf");
});

test("a replaced pin parent cannot redirect host writes outside the brain", () => {
  const pins = createScratchPins(root, createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]));
  const original = join(root, ".brain/scratch-pins"), held = join(root, ".brain/held-pins");
  const outside = mkdtempSync(join(tmpdir(), "scratch-pin-outside-"));
  try {
    writeFileSync(join(outside, "pins.json"), "sentinel");
    renameSync(original, held); symlinkSync(outside, original);
    pins.record("odysseus", "fake", [answer(".brain/scratch/voyage.pdf")]);
    expect(readFileSync(join(outside, "pins.json"), "utf8")).toBe("sentinel");
    expect(Object.values(JSON.parse(readFileSync(join(held, "pins.json"), "utf8")).sessions)).toContainEqual([".brain/scratch/voyage.pdf"]);
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

test("a literal percent elsewhere cannot hide an encoded linked filename", () => {
  const paths = scratchLinks([answer("50% complete: [Log](.brain%2Fscratch%2Fvoyage%20log.pdf) [Log with hash](.brain/scratch/voyage%23log.pdf)")]);
  expect(paths).toContain(".brain/scratch/voyage log.pdf");
  expect(paths).toContain(".brain/scratch/voyage#log.pdf");
});

test("unavailable pin storage suspends pruning and recovers without blocking startup", async () => {
  const missing = join(root, "missing-brain"), logs = createRecordingObservability();
  const registry = createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]);
  let pins!: ReturnType<typeof createRawScratchPins>;
  expect(() => { pins = createScratchPins(missing, registry); }).not.toThrow();
  let calls = 0;
  const pruner = startScratchPrune({ pins, log: logs.logger("cron"), every: () => () => {}, brain: {
    scratchPrune: async () => { calls++; return JSON.stringify({ overageBytes: 0 }); },
  } });
  try {
    await pruner.tick(); expect(calls).toBe(0); expect(logs.logs.count({ scope: "cron", severity: "WARN" })).toBe(1);
    mkdirSync(missing); await pruner.tick(); expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(pins.file, "utf8")).ready).toBe(true);
  } finally { await pruner.close(); }
});
