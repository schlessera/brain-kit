/**
 * #3641 spike harness, rerun by #3642 against the delivered bounded
 * multi-read: `brain_read_many` measured against the individual `brain_read`
 * calls agents make today.
 *
 * Three arms on the same Odysseus scenarios (`bounded-read/scenarios.ts`):
 * sequential individual reads, parallel individual reads, and the batch. The
 * spike measured a private prototype; since #3642 the contract tests drive the
 * shipped core operation (`readMany`, `packages/core/src/lib/ops/read-many.ts`),
 * the MCP arm calls the served `brain_read_many` over stdio, and the Pi arm
 * executes the roster's `brain_read_many`. Mechanics run through the real
 * keyless stdio MCP server and Pi's real agent loop with its faux provider. The faux provider's tool choices
 * are scripted: they prove runtime mechanics, never that a model would choose
 * or understand a tool, and its request count is not a provider-request
 * saving. Provider tokens, cache, cost and model usability stay unavailable.
 *
 * Set BRAIN_BOUNDED_READ_EVIDENCE to a file path to write the raw evidence.
 * The decision is docs/decisions/bounded-multi-read.md.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runAgentLoop, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";

import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { readDocument } from "../packages/core/src/lib/ops/read.ts";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "../packages/core/tests/cli-harness.ts";
import { createBrainAccess } from "../packages/ui-backend-pi/src/brain-access.ts";
import { createBrainTools, toolLockFromKeyed } from "../packages/ui-backend-pi/src/tools.ts";
import { createTurnContext } from "../packages/ui-backend-pi/src/turn-context.ts";
import { MAX_READ_BYTES } from "../packages/ui-backend-pi/src/tool-kit.ts";
import { createUiDb } from "../packages/ui-server/src/db/client.ts";
import { createTurnJournal } from "../packages/ui-server/src/brain/turn-journal.ts";
import { toolObservation } from "../packages/ui-server/src/brain/tool-observation.ts";
import { createNativeJournalFixture } from "../packages/ui-server/tests/helpers/native-journal-fixture.ts";

import { bytes, envelopeOverhead, escapedChars, maxOverlap, median, recordWire, sizeOf, timed, UNAVAILABLE, wireTotals } from "./bounded-read/measure.ts";
import {
  READ_MANY_DEFAULT_TOTAL_CHARS as DEFAULT_TOTAL_CHARS, READ_MANY_MAX_REQUESTS as MAX_ITEMS, readMany, ReadManyRequestError,
  type ReadManyInput, type ReadManyItem, type ReadManyRequest, type ReadManyResult,
} from "../packages/core/src/lib/ops/read-many.ts";
import { raftLog, REFERENCE_DATE, SCENARIOS, scenarioDocuments, SMALL_PATHS } from "./bounded-read/scenarios.ts";

const REPEATS = 5;
const evidence: Record<string, unknown> = {
  issue: 3641,
  referenceDate: REFERENCE_DATE,
  units: "chars = UTF-16 code units; bytes = UTF-8; estTokens = ceil(chars / 4), an estimate, never provider tokens",
  unavailable: UNAVAILABLE,
  scripted: "Pi provider responses are scripted by the faux provider; they establish mechanics only",
};

let root: string;
let outside: string;

const kinds = (r: ReadManyResult) => r.items.map(i => i.kind === "error" ? `error:${i.code}` : i.kind);
const read = (input: ReadManyInput, opts?: Parameters<typeof readMany>[2]) => readMany(root, input, opts);
const scenario = (id: string) => SCENARIOS.find(s => s.id === id)!;

beforeAll(async () => {
  root = makeTempBrain();
  for (const [path, text] of Object.entries(scenarioDocuments())) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  outside = join(dirname(root), `${root.split("/").pop()}-outside.md`);
  writeFileSync(outside, "Polyphemus keeps this cave closed.\n");
  symlinkSync(outside, join(root, "notes/escape-link.md"));
  const index = await runCli(root, ["index", "--json"]);
  expect(index.code).toBe(0);
}, 120_000);

afterAll(() => {
  if (process.env.BRAIN_BOUNDED_READ_EVIDENCE) writeFileSync(process.env.BRAIN_BOUNDED_READ_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
  cleanup(root);
  rmSync(outside, { force: true });
});

describe("delivered contract over the Odysseus scenarios", () => {
  test("every scenario keeps the whole serialized result and each item within their char caps", async () => {
    const rows: unknown[] = [];
    for (const s of SCENARIOS) {
      for (const caps of [{}, { max_total_chars: 2_000, max_item_chars: 512 }, { max_total_chars: 40_000, max_item_chars: 40_000 }]) {
        let result: ReadManyResult;
        try { result = await read({ requests: s.requests, ...caps }); } catch (e) {
          // Twenty requests cannot all be answered, even as stubs, in 2,000 chars.
          expect(e, `${s.id} ${JSON.stringify(caps)}`).toBeInstanceOf(ReadManyRequestError);
          rows.push({ scenario: s.id, caps, rejected: (e as Error).message });
          continue;
        }
        const text = JSON.stringify(result);
        expect(text.length, `TOTAL_CAP ${s.id}`).toBeLessThanOrEqual(result.max_total_chars);
        for (const item of result.items) expect(JSON.stringify(item).length, `ITEM_CAP ${s.id}`).toBeLessThanOrEqual(result.max_item_chars);
        rows.push({ scenario: s.id, caps, kinds: kinds(result), ...sizeOf(text), truncated: result.truncated });
      }
    }
    evidence.scenarios = rows;
  });

  test("at the smallest accepted total, items longer than their reserve become stubs and the cap holds", async () => {
    // Refusals carry a longer message than the budget_exhausted stub each item reserves.
    const requests = Array.from({ length: MAX_ITEMS }, (_, i) => ({ path: `../ithaca/${"suitor-".repeat(8)}${i}.md` }));
    let total = 2_000;
    for (; total <= 10_000; total += 10) {
      try { await read({ requests, max_total_chars: total, max_item_chars: Math.min(total, 512) }); break; } catch (e) { expect(e).toBeInstanceOf(ReadManyRequestError); }
    }
    const smallest = await read({ requests, max_total_chars: total, max_item_chars: Math.min(total, 512) });
    expect(JSON.stringify(smallest).length, "TIGHT_TOTAL_CAP").toBeLessThanOrEqual(total);
    expect(new Set(kinds(smallest))).toEqual(new Set(["error:budget_exhausted"]));
    // A little more room: early refusals fit whole, later requests are stubs, and the cap still holds.
    const mixed = await read({ requests, max_total_chars: total + 100, max_item_chars: 512 });
    expect(JSON.stringify(mixed).length, "TIGHT_TOTAL_CAP").toBeLessThanOrEqual(total + 100);
    expect(kinds(mixed)[0]).toBe("error:refused");
    expect(kinds(mixed).at(-1)).toBe("error:budget_exhausted");
  });

  test("each scenario answers with the expected discriminators at the default caps", async () => {
    const expected: Record<string, string[]> = {
      "small-files": ["full", "full", "full", "full"],
      "large-frontmatter": ["outline"],
      "many-headings": ["outline"],
      "huge-line": ["partial"],
      "mixed-scripts": ["full"],
      sections: ["full", "full", "full"],
      "missing-refused": ["error:not_found", "error:refused", "error:refused", "error:refused", "error:not_a_file", "error:section_not_found"],
      duplicates: ["full", "duplicate", "full", "duplicate", "full"],
      // The spike's prototype held 13 whole, 6 outlines and 1 stub; without the
      // dropped per-item size fields on full items one more note fits whole.
      "aggregate-overflow": [...Array(14).fill("full"), "outline", ...Array(5).fill("error:budget_exhausted")],
    };
    for (const s of SCENARIOS) expect([s.id, kinds(await read({ requests: s.requests }))]).toEqual([s.id, expected[s.id]!]);
  });

  test("full items and sections are byte for byte what brain_read returns", async () => {
    for (const id of ["small-files", "sections", "mixed-scripts"]) {
      const r = await read({ requests: scenario(id).requests });
      for (const [i, req] of scenario(id).requests.entries()) {
        const item = r.items[i]!;
        expect(item.kind).toBe("full");
        if (item.kind === "full") expect(item.content, `SAME_AS_BRAIN_READ ${req.path}`).toBe(readDocument(root, { path: req.path, section: req.section }));
      }
    }
  });

  test("a large frontmatter is reported, not returned, when it does not fit; headings still are", async () => {
    const [item] = (await read({ requests: [{ path: "notes/crew-ledger.md" }] })).items;
    expect(item!.kind).toBe("outline");
    if (item!.kind !== "outline") return;
    expect(item.frontmatter).toBeUndefined();
    expect(item.frontmatter_chars).toBeGreaterThan(20_000);
    expect(item.headings.map(h => h.text)).toEqual(["Count", "Losses"]);
  });

  test("an outline over many headings lists a prefix and counts the rest", async () => {
    const [item] = (await read({ requests: [{ path: "journal/passage-log.md" }] })).items;
    if (item!.kind !== "outline") throw new Error("expected an outline");
    expect(item.headings[0]).toEqual({ level: 1, text: "Passage log", est_tokens: expect.any(Number) });
    expect(item.headings.length + (item.omitted_headings ?? 0)).toBe(241);
    expect(item.omitted_headings).toBeGreaterThan(0);
  });

  test("continuation pages reproduce huge lines, mixed scripts and long logs exactly, each page within its cap", async () => {
    const rows: unknown[] = [];
    for (const path of ["studies/raw-bearings.md", "notes/names-of-the-wanderer.md", "journal/passage-log.md"]) {
      let req: ReadManyRequest = { path, offset: 1 };
      let text = "", calls = 0, largest = 0;
      for (;;) {
        const r = await read({ requests: [req], max_total_chars: 2_100, max_item_chars: 2_000 });
        largest = Math.max(largest, JSON.stringify(r).length);
        const item = r.items[0]!;
        if (item.kind !== "partial") throw new Error(`expected a page, got ${item.kind}`);
        calls++;
        if (calls > 200) throw new Error(`CONTINUATION_DOES_NOT_ADVANCE ${path}`);
        text += item.text;
        if (!item.next) break;
        req = { path, offset: item.next.offset, ...(item.next.column !== undefined ? { column: item.next.column } : {}), expected_sha256: item.sha256 };
      }
      expect(text, `CONTINUATION_EXACT ${path}`).toBe(readFileSync(join(root, path), "utf8"));
      expect(largest).toBeLessThanOrEqual(2_100);
      rows.push({ path, pages: calls, largestPageChars: largest, ...sizeOf(text) });
    }
    evidence.continuation = rows;
  });

  test("mixed scripts: the cap counts escaped UTF-16 units, so UTF-8 bytes exceed it and JSON escaping is charged", async () => {
    const r = await read({ requests: scenario("mixed-scripts").requests });
    const text = JSON.stringify(r);
    const content = (r.items[0] as Extract<ReadManyItem, { kind: "full" }>).content;
    expect(escapedChars(content)).toBeGreaterThan(content.length);
    expect(bytes(text)).toBeGreaterThan(text.length);
    evidence.mixedScripts = { content: sizeOf(content), contentEscapedChars: escapedChars(content), result: sizeOf(text) };
  });

  test("a late-document update is detected on the follow-up, where individual reads mix versions silently", async () => {
    const path = "projects/active/raft/build-log.md";
    const first = (await read({ requests: [{ path }], max_item_chars: 600, max_total_chars: 2_000 })).items[0]!;
    if (first.kind !== "outline") throw new Error("expected an outline");
    expect(first.headings.map(h => h.text)).not.toContain(`${REFERENCE_DATE} Launch`);
    writeFileSync(join(root, path), raftLog(true));
    try {
      const stale = (await read({ requests: [{ path, section: "Build day 4", expected_sha256: first.sha256 }] })).items[0]!;
      expect(stale).toMatchObject({ kind: "error", code: "source_changed" });
      if (stale.kind === "error") expect(stale.sha256).not.toBe(first.sha256);
      const fresh = (await read({ requests: [{ path, section: `${REFERENCE_DATE} Launch` }] })).items[0]!;
      expect(fresh.kind).toBe("full");
      // brain_read has no version in its answer: the follow-up section comes
      // from the new file and nothing says the outline was of the old one.
      expect(readDocument(root, { path, section: `${REFERENCE_DATE} Launch` })).toContain("seventeen days to Scheria");
    } finally { writeFileSync(join(root, path), raftLog(false)); }
  });

  test("duplicates point at the first equal request and one call reads each file once", async () => {
    const work = { filesRead: 0, bytesRead: 0 };
    const r = await read({ requests: scenario("duplicates").requests }, { work });
    expect(r.items[1]).toMatchObject({ kind: "duplicate", of: 0 });
    expect(r.items[3]).toMatchObject({ kind: "duplicate", of: 2 });
    expect(work.filesRead).toBe(2);
  });

  test("item errors carry a code and never a host path", async () => {
    const r = await read({ requests: scenario("missing-refused").requests });
    for (const item of r.items) {
      expect(item.kind).toBe("error");
      expect(JSON.stringify(item)).not.toContain(root);
      expect(JSON.stringify(item)).not.toContain("Polyphemus");
    }
    const missing = r.items.at(-1)!;
    if (missing.kind === "error") expect(missing.headings).toEqual(["Current Identity", "How to Work With Odysseus", "Reaching Odysseus"]);
  });

  test("invalid calls are rejected whole, never clamped", async () => {
    const one = [{ path: "me/identity.md" }];
    for (const input of [
      { requests: [] },
      { requests: Array.from({ length: MAX_ITEMS + 1 }, () => one[0]!) },
      { requests: one, max_total_chars: 40_001 },
      { requests: one, max_total_chars: 1_999 },
      { requests: one, max_item_chars: 511 },
      { requests: one, max_total_chars: 2_000, max_item_chars: 2_001 },
      { requests: [{ path: "me/identity.md", column: 3 }] },
      { requests: [{ path: "me/identity.md", offset: 0 }] },
      { requests: [{ path: "x".repeat(1_025) }] },
    ] as ReadManyInput[]) await expect(read(input), JSON.stringify(input).slice(0, 80)).rejects.toBeInstanceOf(ReadManyRequestError);
  });

  test("cancellation stops reading between files and returns nothing partial", async () => {
    const controller = new AbortController();
    const work = { filesRead: 0, bytesRead: 0 };
    const pending = read({ requests: scenario("aggregate-overflow").requests }, { signal: controller.signal, work });
    await Promise.resolve();
    controller.abort(new Error("Odysseus cancelled the read"));
    await expect(pending).rejects.toThrow("Odysseus cancelled the read");
    expect(work.filesRead).toBeLessThan(20);
    evidence.batchCancellation = { requested: 20, filesReadBeforeStop: work.filesRead };
  });

  test("the old single read keeps its uncapped outline threshold (#383)", () => {
    // max_tokens is a threshold, not a cap: 20 thousand chars of frontmatter for a 100-token threshold.
    const outline = readDocument(root, { path: "notes/crew-ledger.md", maxTokens: 100 });
    expect(outline).toContain("over the 100-token limit");
    expect(outline.length).toBeGreaterThan(20_000);
    evidence.legacyOutline = { maxTokens: 100, ...sizeOf(outline) };
  });
});

/** The known-path tasks every arm answers. Each `rounds` entry depends on the one before it. */
const TASKS: Array<{ id: string; rounds: ReadManyRequest[][]; legacy?: Array<Record<string, unknown>[]> }> = [
  { id: "overview-small", rounds: [SMALL_PATHS.map(path => ({ path }))] },
  { id: "sections", rounds: [scenario("sections").requests] },
  { id: "overflow-20", rounds: [scenario("aggregate-overflow").requests] },
  {
    id: "outline-then-section",
    rounds: [[{ path: "journal/passage-log.md" }], [{ path: "journal/passage-log.md", section: "Day 17" }]],
    legacy: [[{ path: "journal/passage-log.md", max_tokens: 500 }], [{ path: "journal/passage-log.md", section: "Day 17" }]],
  },
];
const legacyArgs = (task: (typeof TASKS)[number]) =>
  task.legacy ?? task.rounds.map(round => round.map(r => ({ path: r.path, ...(r.section ? { section: r.section } : {}) })));

describe("real keyless stdio MCP exercise", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let wire: ReturnType<typeof recordWire>;

  beforeAll(async () => {
    // The late-update scenario rewrote a file; start from a fresh index so no
    // stale-index warning rides on the measured arms (measured separately below).
    // --force: a plain index counts a same-content rewrite as unchanged and
    // leaves its indexed_at, so the staleness probe would still flag it.
    expect((await runCli(root, ["index", "--force", "--json"])).code).toBe(0);
    transport = new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(root) });
    client = new Client({ name: "bounded-read-spike", version: "1.0.0" });
    await client.connect(transport);
    wire = recordWire(transport);
  }, 60_000);
  afterAll(async () => { await client?.close(); });

  const call = async (args: Record<string, unknown>, signal?: AbortSignal) =>
    (await client.callTool({ name: "brain_read", arguments: args }, undefined, signal ? { signal } : undefined)) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const callMany = async (args: Record<string, unknown>, signal?: AbortSignal) =>
    (await client.callTool({ name: "brain_read_many", arguments: args }, undefined, signal ? { signal } : undefined)) as { content: Array<{ type: string; text: string }>; isError?: boolean; structuredContent?: unknown };

  test("sequential, parallel and served-batch arms over the same tasks", async () => {
    const rows: unknown[] = [];
    for (const task of TASKS) {
      const args = legacyArgs(task);
      const arms: Record<string, unknown> = {};
      for (const arm of ["sequential", "parallel"] as const) {
        const times: number[] = [];
        let measured: Record<string, unknown> = {};
        for (let rep = 0; rep < REPEATS; rep++) {
          const sentBefore = wire.sent.length, receivedBefore = wire.received.length;
          const texts: string[] = [];
          const warningParts: string[] = [];
          const { ms } = await timed(async () => {
            for (const round of args) {
              const results = arm === "sequential"
                ? await round.reduce(async (acc, a) => [...await acc, await call(a)], Promise.resolve([] as Awaited<ReturnType<typeof call>>[]))
                : await Promise.all(round.map(a => call(a)));
              for (const r of results) { texts.push(r.content.map(p => p.text).join("")); warningParts.push(...r.content.slice(1).map(p => p.text)); }
            }
          });
          times.push(ms);
          const sent = wire.sent.slice(sentBefore), received = wire.received.slice(receivedBefore);
          measured = {
            toolCalls: args.flat().length, dependentRounds: args.length,
            requestsSent: wireTotals(sent), responsesReceived: wireTotals(received),
            payload: sizeOf(texts.join("")),
            warningParts: [...new Set(warningParts)].map(w => w.split(root).join("<brain-root>")),
            envelopeCharsPerCall: received.map((line, i) => envelopeOverhead(line, [texts[i] ?? ""])),
          };
        }
        expect(measured.warningParts, `NO_WARNING_IN_MEASURED_ARMS ${task.id}`).toEqual([]);
        arms[arm] = { ...measured, latencyMsMedian: median(times), latencyMsAll: times.map(t => Math.round(t * 100) / 100) };
      }
      // The served brain_read_many over the same stdio pipe: one text block, no structuredContent.
      const times: number[] = [];
      let served: Record<string, unknown> = {};
      for (let rep = 0; rep < REPEATS; rep++) {
        const sentBefore = wire.sent.length, receivedBefore = wire.received.length;
        const texts: string[] = [];
        const { ms } = await timed(async () => {
          for (const round of task.rounds) {
            const r = await callMany({ requests: round });
            expect(r.isError, `BATCH_SERVED ${task.id}`).toBeFalsy();
            expect(r.content, `BATCH_TEXT_ONLY ${task.id}`).toHaveLength(1);
            texts.push(r.content[0]!.text);
          }
        });
        times.push(ms);
        const received = wire.received.slice(receivedBefore);
        const results = texts.map(t => JSON.parse(t) as ReadManyResult);
        served = {
          toolCalls: task.rounds.length, dependentRounds: task.rounds.length,
          requestsSent: wireTotals(wire.sent.slice(sentBefore)), responsesReceived: wireTotals(received),
          payload: sizeOf(texts.join("")),
          envelopeCharsPerCall: received.map((line, i) => envelopeOverhead(line, [texts[i] ?? ""])),
          kinds: results.map(kinds),
          warnings: results.flatMap(r => r.warnings),
        };
        for (const [i, text] of texts.entries()) expect(text.length, `BATCH_TOTAL_CAP ${task.id}`).toBeLessThanOrEqual(results[i]!.max_total_chars);
      }
      arms.batchServed = { ...served, latencyMsMedian: median(times), latencyMsAll: times.map(t => Math.round(t * 100) / 100) };
      rows.push({ task: task.id, arms });
      const seq = arms.sequential as { requestsSent: { messages: number } }, par = arms.parallel as { requestsSent: { messages: number } };
      expect(seq.requestsSent.messages).toBe(args.flat().length);
      expect(par.requestsSent.messages, "PARALLEL_STILL_ONE_REQUEST_PER_READ").toBe(args.flat().length);
    }
    evidence.mcp = { transport: "real stdio, `brain mcp` spawned keyless against the scenario corpus", repeats: REPEATS, tasks: rows };
  }, 120_000);

  test("a stale-index warning repeats on every individual result", async () => {
    const path = join(root, "projects/active/raft/build-log.md");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original + "\nPenelope weaves by day.\n");
    // A fresh server: the running one caches its staleness probe for 10 seconds.
    const fresh = new Client({ name: "bounded-read-spike-stale", version: "1.0.0" });
    try {
      await fresh.connect(new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(root) }));
      const results = await Promise.all(SMALL_PATHS.map(p =>
        fresh.callTool({ name: "brain_read", arguments: { path: p } }) as Promise<{ content: Array<{ type: string; text: string }> }>));
      const warnings = results.map(r => r.content.slice(1).map(p => p.text).join(""));
      expect(warnings.map(w => w.slice(0, "warning: ".length))).toEqual(SMALL_PATHS.map(() => "warning: "));
      evidence.mcpRepeatedWarnings = { calls: results.length, warningCharsPerCall: warnings.map(w => w.length), totalWarningChars: warnings.join("").length,
        note: "one batch result would carry the warning once" };
    } finally {
      await fresh.close();
      writeFileSync(path, original);
      expect((await runCli(root, ["index", "--force", "--json"])).code).toBe(0);
    }
  }, 60_000);

  test("roster cost: the listed brain_read and brain_read_many definitions", async () => {
    const { tools } = await client.listTools();
    const listed = tools.find(t => t.name === "brain_read")!;
    const many = tools.find(t => t.name === "brain_read_many")!;
    expect([listed?.name, many?.name]).toEqual(["brain_read", "brain_read_many"]);
    evidence.rosterChars = { brain_read: JSON.stringify(listed).length, brain_read_many: JSON.stringify(many).length,
      note: "Present on every provider request of a session that has the tool, cached or not; provider tokens unavailable" };
  });

  test("individual reads return what the served batch's full items carry", async () => {
    const batch = JSON.parse((await callMany({ requests: SMALL_PATHS.map(path => ({ path })) })).content[0]!.text) as ReadManyResult;
    const individual = await Promise.all(SMALL_PATHS.map(path => call({ path })));
    for (const [i, r] of individual.entries()) {
      const item = batch.items[i]!;
      expect(item.kind).toBe("full");
      if (item.kind === "full") expect(r.content[0]!.text).toBe(item.content);
    }
  });

  test("brain_read keeps its unbounded default and uncapped outline over MCP", async () => {
    const whole = await call({ path: "studies/raw-bearings.md" });
    expect(whole.content[0]!.text).toBe(readFileSync(join(root, "studies/raw-bearings.md"), "utf8"));
    const outline = await call({ path: "notes/crew-ledger.md", max_tokens: 100 });
    expect(outline.content[0]!.text.length).toBeGreaterThan(20_000);
    evidence.mcpLegacy = { wholeHugeLine: sizeOf(whole.content[0]!.text), outlineAt100Tokens: sizeOf(outline.content[0]!.text) };
  });

  test("individual errors: a missing path is a tool error whose text is recorded", async () => {
    const rows: unknown[] = [];
    for (const args of [{ path: "projects/active/raft/missing.md" }, { path: "../outside.md" }, { path: "notes/escape-link.md" }, { path: "me/identity.md", section: "No Such Heading" }]) {
      const r = await call(args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      const text = r.content.map(p => p.text).join("");
      expect(text).not.toContain("Polyphemus");
      rows.push({ args, text: text.split(root).join("<brain-root>"), containsHostPath: text.includes(root) });
    }
    evidence.mcpErrors = rows;
  });

  test("cancelling one of four parallel reads rejects it; the other three complete", async () => {
    const controller = new AbortController();
    const receivedBefore = wire.received.length;
    const calls = SMALL_PATHS.map((path, i) => call({ path }, i === 1 ? controller.signal : undefined));
    controller.abort();
    const settled = await Promise.allSettled(calls);
    expect(settled.map(s => s.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
    // Give a late response for the cancelled id a moment to arrive.
    await Bun.sleep(200);
    const cancelSent = wire.sent.some(line => line.includes("notifications/cancelled"));
    evidence.mcpCancellation = {
      cancelNotificationSent: cancelSent,
      responsesReceivedAfter: wire.received.length - receivedBefore,
      note: "brain_read is synchronous in the server, so a cancelled read runs to completion; the client discards it",
    };
  });
});

/** Adapt a Pi coding-agent tool definition to the agent core's tool shape. */
function agentTool(def: { name: string; label: string; description: string; parameters: unknown; execute: (...a: never[]) => Promise<unknown> }, spans: Array<{ start: number; end: number }>): AgentTool {
  return {
    name: def.name, label: def.label, description: def.description, parameters: def.parameters as never,
    async execute(id, params, signal, onUpdate) {
      const start = performance.now();
      try { return await (def.execute as (...a: unknown[]) => Promise<never>)(id, params, signal, onUpdate, {}); }
      finally { spans.push({ start, end: performance.now() }); }
    },
  };
}

interface PiRun { providerRequests: number; contextCharsPerRequest: number[]; toolResults: string[]; transcriptChars: number; spans: Array<{ start: number; end: number }>; events: AgentEvent[]; ms: number; messages: AgentMessage[] }

/**
 * One Pi agent-loop run with scripted assistant steps. Each step is the tool
 * calls of one assistant message; a final text answer follows.
 */
async function piRun(steps: Array<Array<{ name: string; args: Record<string, unknown> }>>, opts: { mode?: "parallel" | "sequential"; batch?: boolean; signal?: AbortSignal; onStart?: (call: number) => void } = {}): Promise<PiRun> {
  const faux = createFauxCore({});
  const contextChars: number[] = [];
  let finalContext: Message[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  faux.setResponses([
    ...steps.map((calls, s) => (context: { messages: Message[] }) => {
      contextChars.push(JSON.stringify(context.messages).length);
      return fauxAssistantMessage(calls.map((c, i) => fauxToolCall(c.name, c.args as Parameters<typeof fauxToolCall>[1], { id: `call_odysseus_${s}_${i}` })), { stopReason: "toolUse" });
    }),
    (context: { messages: Message[] }) => {
      contextChars.push(JSON.stringify(context.messages).length);
      finalContext = context.messages;
      return fauxAssistantMessage(fauxText("The raft is ready for the seventeen-day passage."));
    },
  ]);
  const tools = createBrainTools({ brain: createBrainAccess(root), turn: createTurnContext(), lock: toolLockFromKeyed(createKeyedLock()) });
  const brainRead = tools.find(t => t.name === "brain_read")!;
  const brainReadMany = tools.find(t => t.name === "brain_read_many")!;
  const events: AgentEvent[] = [];
  let started = 0;
  const { ms, value: messages } = await timed(() => runAgentLoop(
    [{ role: "user", content: "Odysseus asks for the raft overview.", timestamp: 0 } as AgentMessage],
    { messages: [], tools: [agentTool(brainRead as never, spans), ...(opts.batch ? [agentTool(brainReadMany as never, spans)] : [])] },
    { model: faux.getModel(), convertToLlm: m => m as Message[], ...(opts.mode ? { toolExecution: opts.mode } : {}) },
    e => { events.push(e); if (e.type === "tool_execution_start") opts.onStart?.(started++); },
    opts.signal,
    faux.streamSimple,
  ));
  const toolResults = finalContext.filter(m => m.role === "toolResult").map(m => (m.content as Array<{ type: string; text?: string }>).map(p => p.text ?? "").join(""));
  // Everything after the prompt: assistant tool calls and their results.
  const transcriptChars = JSON.stringify(finalContext.slice(1)).length;
  return { providerRequests: faux.state.callCount, contextCharsPerRequest: contextChars, toolResults, transcriptChars, spans, events, ms, messages };
}

describe("Pi tool-execution exercise (faux provider, scripted calls)", () => {
  const readCalls = (round: Array<Record<string, unknown>>) => round.map(args => ({ name: "brain_read", args }));

  test("one message of parallel calls, one call per message, sequential mode and a brain_read_many batch", async () => {
    const rows: unknown[] = [];
    for (const task of TASKS) {
      const legacy = legacyArgs(task);
      const arms = {
        parallelOneMessage: { steps: legacy.map(readCalls), opts: {} },
        sequentialMode: { steps: legacy.map(readCalls), opts: { mode: "sequential" as const } },
        oneCallPerMessage: { steps: legacy.flatMap(round => round.map(args => readCalls([args]))), opts: {} },
        batch: { steps: task.rounds.map(round => [{ name: "brain_read_many", args: { requests: round } }]), opts: { batch: true } },
      };
      const out: Record<string, unknown> = {};
      for (const [name, arm] of Object.entries(arms)) {
        const times: number[] = [];
        let run!: PiRun;
        for (let rep = 0; rep < REPEATS; rep++) { run = await piRun(arm.steps, arm.opts); times.push(run.ms); }
        const payload = run.toolResults.join("");
        out[name] = {
          scriptedProviderRequests: run.providerRequests,
          toolCalls: arm.steps.flat().length,
          maxConcurrentExecutions: maxOverlap(run.spans),
          payload: sizeOf(payload),
          transcriptChars: run.transcriptChars,
          transcriptOverheadChars: run.transcriptChars - run.toolResults.reduce((a, t) => a + escapedChars(t), 0),
          contextCharsPerRequest: run.contextCharsPerRequest,
          latencyMsMedian: median(times),
        };
        expect(run.providerRequests, `${task.id} ${name}`).toBe(arm.steps.length + 1);
      }
      rows.push({ task: task.id, arms: out });
    }
    evidence.pi = {
      runtime: "pi-agent-core runAgentLoop with pi-ai createFauxCore; the curated brain_read and brain_read_many factories from createBrainTools",
      defaultToolExecution: "parallel (pi-agent-core Agent default; the Pi backend does not set it)",
      repeats: REPEATS,
      tasks: rows,
      transcriptNote: "Pi's internal transcript JSON, not a provider's wire format",
    };
  }, 120_000);

  test("Pi clips an individual read by UTF-16 length, so a mixed-script read can exceed its byte-named limit in bytes", async () => {
    const big = "notes/names-of-the-wanderer.md";
    const text = readFileSync(join(root, big), "utf8");
    expect(text.length).toBeLessThan(MAX_READ_BYTES);
    const run = await piRun([[{ name: "brain_read", args: { path: big } }]]);
    expect(run.toolResults[0]).toBe(text);
    expect(bytes(text)).toBeGreaterThan(text.length);
    evidence.piClipUnit = { MAX_READ_BYTES, measuredBy: "string.length (UTF-16 code units)", sample: sizeOf(text) };
  });

  test("aborting during parallel brain_read calls: what the loop returns", async () => {
    const controller = new AbortController();
    const run = await piRun([readCalls(SMALL_PATHS.map(path => ({ path })))], { signal: controller.signal, onStart: n => { if (n === 0) controller.abort(); } });
    const ends = run.events.filter(e => e.type === "tool_execution_end") as Extract<AgentEvent, { type: "tool_execution_end" }>[];
    const batch = new AbortController();
    const batchRun = await piRun([[{ name: "brain_read_many", args: { requests: SMALL_PATHS.map(path => ({ path })) } }]], { batch: true, signal: batch.signal, onStart: () => batch.abort() });
    const batchEnds = batchRun.events.filter(e => e.type === "tool_execution_end") as Extract<AgentEvent, { type: "tool_execution_end" }>[];
    const summary = (r: PiRun, e: typeof ends) => ({
      readsExecuted: r.spans.length,
      executionsEnded: e.length,
      errors: e.filter(x => x.isError).length,
      toolResultMessages: r.messages.filter(m => (m as { role?: string }).role === "toolResult").length,
      streamCalls: r.providerRequests,
      lastStopReason: (r.messages.filter(m => (m as { role?: string }).role === "assistant").at(-1) as { stopReason?: string } | undefined)?.stopReason,
    });
    const individual = summary(run, ends), batchSummary = summary(batchRun, batchEnds);
    evidence.piCancellation = {
      individual, batch: batchSummary,
      note: "Aborted at the first tool_execution_start. Parallel mode stops preparing calls, so later calls of the message get no result; " +
        "the loop then calls the stream function once more with the aborted signal and the faux provider answers 'aborted'. " +
        "Whether a real provider adapter sends anything for that call is not observable offline.",
    };
    // Observed mechanics: nothing is read after the abort, and the loop settles with an aborted answer.
    for (const r of [individual, batchSummary]) {
      expect(r.readsExecuted).toBe(0);
      expect(r.toolResultMessages).toBe(1);
      expect(r.streamCalls).toBe(2);
      expect(r.lastStopReason).toBe("aborted");
    }
  });
});

describe("turn-journal observation per call", () => {
  test("every unproven brain_read result is observed; a batch is one call and so one observation", async () => {
    expect(toolObservation("brain_read", undefined), "BRAIN_READ_HAS_NO_EXECUTION_PROOF").toBe("unproven");
    const dir = mkdtempSync(join(tmpdir(), "odysseus-bounded-read-journal-")), brain = join(dir, "brain"), dbPath = join(dir, "ui.db");
    mkdirSync(join(brain, "notes"), { recursive: true });
    writeFileSync(join(brain, "notes", "raft.md"), "The raft holds.\n");
    const native = createNativeJournalFixture(brain, dir);
    const db = createUiDb(dbPath);
    const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath, objectsRoot: join(dir, "objects") });
    let observations = 0;
    journal.onObservation(() => { observations++; });
    const rows: Record<string, unknown> = {};
    try {
      const turn = async (id: string, run: () => Promise<void>) => {
        await journal.begin(id, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, e => { throw e; });
        const before = observations;
        const { ms } = await timed(run);
        const seen = observations - before;
        await journal.finish(id);
        return { observations: seen, ms: Math.round(ms * 100) / 100 };
      };
      rows.sequential = await turn("sequential", async () => {
        for (let i = 0; i < 4; i++) { journal.toolStarted("sequential", `r${i}`, "brain_read", true); await journal.toolEnded("sequential", `r${i}`); }
      });
      rows.parallel = await turn("parallel", async () => {
        for (let i = 0; i < 4; i++) journal.toolStarted("parallel", `r${i}`, "brain_read", true);
        await Promise.all([0, 1, 2, 3].map(i => journal.toolEnded("parallel", `r${i}`)));
      });
      rows.batch = await turn("batch", async () => {
        journal.toolStarted("batch", "b0", "brain_read_many", true); await journal.toolEnded("batch", "b0");
      });
      expect(rows.sequential).toMatchObject({ observations: 4 });
      expect(rows.batch).toMatchObject({ observations: 1 });
      evidence.journal = { ...rows, note: "brain_read and a batch name both lack execution proof (toolObservation 'unproven'); each result is observed and the turn becomes lasting" };
    } finally {
      await journal.close(); await native.close(); db.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("the default total cap stays under the Claude Agent SDK's 50,000-char persistence threshold", () => {
  expect(DEFAULT_TOTAL_CHARS).toBeLessThan(50_000);
});
