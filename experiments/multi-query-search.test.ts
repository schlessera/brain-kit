/**
 * #3645 spike harness: a bounded multi-query search, measured against the
 * parallel single-query `brain_search` calls agents already make.
 *
 * Arms over the same Odysseus workload (`multi-query-search/workload.ts`):
 * sequential and parallel `brain_search` over the real keyless stdio MCP
 * server, one Pi assistant message of parallel `brain_search` calls through
 * Pi's real agent loop and curated tool, and the PRIVATE prototype
 * (`multi-query-search/prototype.ts`, not exported, not a served tool). The
 * Pi provider is pi-ai's faux provider: its tool choices are scripted, so
 * they prove runtime mechanics, never that a model would choose or fill a
 * tool, and its request count is not a provider-request saving. Provider
 * tokens, cache, cost and model usability stay unavailable. Keyless, so the
 * vector lane and the judgment reranker never run: hybrid degrades to the
 * full-text lane with a warning, and only the full-text lane is qualified.
 *
 * Set BRAIN_MULTI_QUERY_EVIDENCE to a file path to write the raw evidence.
 * The decision is docs/decisions/multi-query-search.md.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runAgentLoop, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { initContext, type BrainContext } from "../packages/core/src/lib/context.ts";
import { loadVecSupport, openDatabase } from "../packages/core/src/lib/db.ts";
import { searchDocuments, type SearchedDocument } from "../packages/core/src/lib/ops/read.ts";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "../packages/core/tests/cli-harness.ts";
import { createBrainAccess } from "../packages/ui-backend-pi/src/brain-access.ts";
import { createBrainTools, toolLockFromKeyed } from "../packages/ui-backend-pi/src/tools.ts";
import { createTurnContext } from "../packages/ui-backend-pi/src/turn-context.ts";

import { envelopeOverhead, escapedChars, maxOverlap, median, recordWire, sizeOf, timed, UNAVAILABLE, wireTotals } from "./bounded-read/measure.ts";
import {
  associations, DEFAULT_TOTAL_CHARS, MAX_QUERIES, PROPOSED_TOOL, searchManyPrototype, SearchManyRequestError,
  type DocumentFields, type QueryItem, type SearchManyInput, type SearchManyResult, type SearchManyWork,
} from "./multi-query-search/prototype.ts";
import { EDGE_QUERIES, REFERENCE_DATE, SCOPED_QUERIES, scenarioDocuments, TASKS, type NamedQuery, type Task } from "./multi-query-search/workload.ts";

const REPEATS = 5;
const evidence: Record<string, unknown> = {
  issue: 3645,
  referenceDate: REFERENCE_DATE,
  units: "chars = UTF-16 code units; bytes = UTF-8; estTokens = ceil(chars / 4), an estimate, never provider tokens",
  unavailable: {
    ...UNAVAILABLE,
    vectorLane: "not qualified: keyless, no embedding provider; hybrid degrades to the full-text lane with a warning",
    judgmentReranker: "not qualified: keyless, reranker disabled; heuristic lifecycle rerank only",
    paidWork: "none performed; embedding and rerank requests per query are inferred from the contract, not observed",
  },
  scripted: "Pi provider responses are scripted by the faux provider; they establish mechanics only",
  clock: "in-process prototype tests pin the clock to the reference date (setSystemTime); the MCP and Pi arms run on the wall clock, as the shipped surfaces measure recency from it, and compare scores to 1e-6",
};

let root: string;
let brain: BrainContext;
let db: Database;
const deps = () => ({ db, brain });
const search = (input: SearchManyInput, opts?: Parameters<typeof searchManyPrototype>[2]) => searchManyPrototype(deps(), input, opts);
const ROOMY = { max_total_chars: 40_000, max_total_results: 200 } as const;

/** The MCP arguments of one named query: everything but its id and the scope `brain_search` does not take. */
const mcpArgs = ({ id: _id, include: _i, exclude: _e, ...rest }: NamedQuery) => rest;
/** The same query through the shared operation `brain_search` calls. */
const viaOperation = (q: NamedQuery) => searchDocuments(deps(), {
  query: q.query, mode: q.mode ?? "hybrid", type: q.type, tag: q.tag, relevance: q.relevance,
  includeArchived: q.include_archived ?? false, assetsOnly: false, limit: q.limit ?? 10,
  updatedSince: q.updated_since, updatedBefore: q.updated_before, deadlineFrom: q.deadline_from, deadlineTo: q.deadline_to,
  sort: q.sort, upcoming: false,
});
const DOC_FIELDS = ["title", "type", "relevance", "status", "summary", "updated", "deadline", "tags", "supersededBy"] as const;
const docFields = (r: Record<string, unknown>) => Object.fromEntries(DOC_FIELDS.filter(k => k in r).map(k => [k, r[k] ?? null]));
/** A query's answer by id; a duplicate resolves to the query it points at. */
function okItem(r: SearchManyResult, id: string): Extract<QueryItem, { status: "ok" }> {
  const it = r.queries.find(q => q.id === id)!;
  return (it.status === "duplicate" ? r.queries[it.of]! : it) as Extract<QueryItem, { status: "ok" }>;
}

/** Useful (query, path) pairs of a task, and how many an answer attributes correctly. */
function coverage(task: Task, pairs: Array<[string, string]>): { useful: number; found: number; ratio: number } {
  const want = Object.entries(task.useful).flatMap(([id, paths]) => paths.map(p => `${id}\u0000${p}`));
  const have = new Set(pairs.map(([id, p]) => `${id}\u0000${p}`));
  const found = want.filter(w => have.has(w)).length;
  return { useful: want.length, found, ratio: Math.round((found / want.length) * 1000) / 1000 };
}

/**
 * What the per-query rows of one task repeat. `documentFieldChars`: the
 * query-independent fields of every path after its first appearance.
 * `identicalRowChars`: rows equal in every field, snippet and score included.
 */
function duplication(rowsByQuery: Array<Array<Record<string, unknown>>>) {
  const seenPath = new Map<string, number>(), seenRow = new Set<string>();
  let documentFieldChars = 0, identicalRowChars = 0, repeatedPaths = 0, rows = 0;
  for (const rowsOfQuery of rowsByQuery) for (const r of rowsOfQuery) {
    rows++;
    const path = String(r.path), whole = JSON.stringify(r);
    if (seenPath.has(path)) { repeatedPaths++; documentFieldChars += JSON.stringify(docFields(r)).length; }
    if (seenRow.has(whole)) identicalRowChars += whole.length;
    seenPath.set(path, (seenPath.get(path) ?? 0) + 1); seenRow.add(whole);
  }
  return { rows, distinctPaths: seenPath.size, repeatedPaths, documentFieldChars, identicalRowChars };
}

beforeAll(async () => {
  root = makeTempBrain();
  for (const [path, text] of Object.entries(scenarioDocuments())) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  expect((await runCli(root, ["index", "--force", "--json"])).code).toBe(0);
  brain = await initContext({ root });
  db = openDatabase(brain.dbPath, { readonly: true });
  // The MCP server and the Pi access load the vector extension too; without
  // it the degraded-lane warning would name a different cause.
  await loadVecSupport(db);
}, 120_000);

afterAll(() => {
  if (process.env.BRAIN_MULTI_QUERY_EVIDENCE) writeFileSync(process.env.BRAIN_MULTI_QUERY_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
  db?.close();
  cleanup(root);
});

/** The in-process clock of the prototype tests: recency is measured from the pinned reference date. */
const PINNED_NOW = new Date(`${REFERENCE_DATE}T12:00:00Z`);

describe("prototype over the Odysseus workload", () => {
  beforeAll(() => { setSystemTime(PINNED_NOW); });
  afterAll(() => { setSystemTime(); });

  test("every query keeps the filters, order, ranks, scores and snippets of its own brain_search", async () => {
    for (const task of [...TASKS, { id: "scoped-unscoped", queries: SCOPED_QUERIES.map(({ include: _i, exclude: _e, ...q }) => q) } as Task]) {
      const r = await search({ queries: task.queries, dedupe: "none", ...ROOMY });
      expect(r.truncated, task.id).toBe(false);
      for (const q of task.queries) {
        const { results } = await viaOperation(q);
        const item = okItem(r, q.id);
        expect(item.hits.map(h => h.path), `SAME_ORDER ${task.id}/${q.id}`).toEqual(results.map(x => x.path));
        expect(item.hits.map(h => h.rank)).toEqual(results.map((_, i) => i + 1));
        for (const [i, h] of item.hits.entries()) {
          const x = results[i]!;
          expect({ ...h, rank: undefined }, `SAME_ROW ${task.id}/${q.id}`).toEqual({ ...x, rank: undefined } as never);
        }
      }
    }
  });

  test("deduplication folds document fields only: every association, rank, score and snippet survives", async () => {
    const rows: unknown[] = [];
    for (const task of TASKS) {
      const none = await search({ queries: task.queries, dedupe: "none", ...ROOMY });
      const docs = await search({ queries: task.queries, dedupe: "documents", ...ROOMY });
      expect(associations(docs), `ASSOCIATIONS_KEPT ${task.id}`).toEqual(associations(none));
      for (const q of task.queries) {
        const a = okItem(none, q.id), b = okItem(docs, q.id);
        expect(b.hits).toEqual(a.hits.map(h => ({ rank: h.rank, path: h.path, score: h.score, snippet: h.snippet })));
        for (const h of a.hits) expect(docs.documents![h.path], `DOC_FIELDS ${h.path}`).toEqual(docFields(h as never) as unknown as DocumentFields);
      }
      rows.push({ task: task.id, none: sizeOf(JSON.stringify(none)), documents: sizeOf(JSON.stringify(docs)),
        distinctDocuments: Object.keys(docs.documents!).length, hits: associations(docs).length });
    }
    evidence.dedupe = rows;
  });

  test("the whole answer stays within max_total_chars and max_total_results at every budget", async () => {
    const rows: unknown[] = [];
    for (const task of TASKS) for (const dedupe of ["none", "documents"] as const) {
      const uncapped = await search({ queries: task.queries, dedupe, ...ROOMY });
      for (let max = 2_000; max <= 40_000; max += 1_000) {
        let r: SearchManyResult;
        try { r = await search({ queries: task.queries, dedupe, max_total_chars: max }); } catch (e) {
          expect(e, `${task.id} ${max}`).toBeInstanceOf(SearchManyRequestError);
          continue;
        }
        expect(JSON.stringify(r).length, `TOTAL_CAP ${task.id} ${dedupe} ${max}`).toBeLessThanOrEqual(max);
        expect(associations(r).length, `RESULT_CAP ${task.id}`).toBeLessThanOrEqual(r.max_total_results);
        for (const it of r.queries) if (it.status === "ok") {
          // Every query returns a prefix of its own ranking and counts the rest.
          expect(it.hits.map(h => h.rank)).toEqual(it.hits.map((_, i) => i + 1));
          expect(it.returned + it.omitted, `OMITTED_ACCOUNTED ${task.id}`).toBe(okItem(uncapped, it.id).returned);
        }
      }
      for (const total of [1, 5, 13]) {
        const r = await search({ queries: task.queries, dedupe, max_total_results: total, max_total_chars: 40_000 });
        expect(associations(r).length, `RESULT_CAP ${task.id} ${total}`).toBeLessThanOrEqual(total);
        rows.push({ task: task.id, dedupe, max_total_results: total, returned: r.queries.map(q => q.status === "ok" ? q.returned : null) });
      }
    }
    evidence.resultCaps = rows;
  });

  test("a shared budget needs a fair fill: rank by rank across queries keeps every query's best hits", async () => {
    const rows: unknown[] = [];
    for (const task of TASKS) for (const max of [4_000, 8_000, 12_000, DEFAULT_TOTAL_CHARS]) {
      const fair = await search({ queries: task.queries, max_total_chars: max });
      const seq = await search({ queries: task.queries, max_total_chars: max }, { strategy: "sequential" });
      rows.push({
        task: task.id, max_total_chars: max,
        fair: { coverage: coverage(task, associations(fair)), returned: fair.queries.map(q => q.status === "ok" ? q.returned : 0), chars: JSON.stringify(fair).length },
        sequential: { coverage: coverage(task, associations(seq)), returned: seq.queries.map(q => q.status === "ok" ? q.returned : 0), chars: JSON.stringify(seq).length },
      });
      // Fair: when any query has hits, every query keeps at least its first hit.
      for (const it of fair.queries) if (it.status === "ok" && it.returned + it.omitted > 0) expect(it.returned, `FAIR_FIRST_HIT ${task.id} ${max}`).toBeGreaterThan(0);
    }
    evidence.budgetFill = rows;
    const heavy = rows.find(r => (r as { task: string; max_total_chars: number }).task === "heavy-overlap" && (r as { max_total_chars: number }).max_total_chars === 8_000) as
      { fair: { coverage: { found: number } }; sequential: { coverage: { found: number }; returned: number[] } };
    expect(heavy.sequential.returned.at(-1), "SEQUENTIAL_STARVES_LAST_QUERY").toBe(0);
    expect(heavy.fair.coverage.found).toBeGreaterThanOrEqual(heavy.sequential.coverage.found);
  });

  test("per-query errors, duplicates and no-answer queries do not fail the call", async () => {
    const work: SearchManyWork = { searches: 0, vectorLaneRequested: 0 };
    const r = await search({ queries: EDGE_QUERIES }, { work });
    expect(r.queries.map(q => q.status === "error" ? `error:${q.code}` : q.status)).toEqual(["ok", "error:invalid_query", "ok", "duplicate", "error:invalid_query"]);
    expect(r.queries[3]).toMatchObject({ id: "raft-again", of: 0 });
    // Full-text OR matching finds partial matches for a question the corpus cannot answer: no-answer is not empty.
    expect(okItem(r, "no-answer").returned).toBeGreaterThan(0);
    expect(associations(r).filter(([id]) => id === "raft-again").map(([, p]) => p)).toEqual(associations(r).filter(([id]) => id === "raft").map(([, p]) => p));
    expect(JSON.stringify(r)).not.toContain(root);
    expect(work.searches, "DUPLICATE_RUNS_ONCE").toBe(4);
    evidence.edge = { items: r.queries.map(q => ({ id: q.id, status: q.status, ...(q.status === "error" ? { code: q.code, message: q.message } : {}), ...(q.status === "ok" ? { returned: q.returned } : {}) })), work };
  });

  test("invalid calls are rejected whole, never clamped", async () => {
    const one = { id: "raft", query: "raft" };
    for (const input of [
      { queries: [] },
      { queries: Array.from({ length: MAX_QUERIES + 1 }, (_, i) => ({ id: `q${i}`, query: "raft" })) },
      { queries: [one, { ...one }] },
      { queries: [{ id: "", query: "raft" }] },
      { queries: [{ id: "has space", query: "raft" }] },
      { queries: [{ ...one, limit: 51 }] },
      { queries: [{ ...one, limit: 0 }] },
      { queries: [one], max_total_chars: 1_999 },
      { queries: [one], max_total_chars: 40_001 },
      { queries: [one], max_total_results: 0 },
    ] as SearchManyInput[]) await expect(search(input), JSON.stringify(input).slice(0, 80)).rejects.toBeInstanceOf(SearchManyRequestError);
  });

  test("cancellation stops between queries and returns nothing partial", async () => {
    const controller = new AbortController();
    const work: SearchManyWork = { searches: 0, vectorLaneRequested: 0 };
    const pending = search({ queries: TASKS[0]!.queries }, { signal: controller.signal, work, between: i => { if (i === 0) controller.abort(new Error("Odysseus cancelled the search")); } });
    await expect(pending).rejects.toThrow("Odysseus cancelled the search");
    expect(work.searches, "CANCEL_BETWEEN_QUERIES").toBe(1);
    // The read transaction was closed: the connection still answers.
    expect((await search({ queries: [{ id: "raft", query: "raft" }] })).queries[0]!.status).toBe("ok");
    evidence.prototypeCancellation = { requested: TASKS[0]!.queries.length, searchesBeforeStop: work.searches };
  });

  test("all queries of one call read one index snapshot; separate calls do not", async () => {
    const copy = join(dirname(brain.dbPath), "snapshot-copy.db");
    db.run(`VACUUM INTO '${copy}'`);
    const writer = openDatabase(copy);
    writer.run("PRAGMA journal_mode = WAL");
    const reader = openDatabase(copy, { readonly: true });
    await loadVecSupport(reader);
    const path = "projects/active/raft/status.md", renamed = "Raft status (renamed by Penelope)";
    const rename = (title: string) => writer.prepare("UPDATE documents SET title = ? WHERE path = ?").run(title, path);
    const original = (reader.prepare("SELECT title FROM documents WHERE path = ?").get(path) as { title: string }).title;
    const queries = [{ id: "a", query: "raft status", limit: 3 }, { id: "b", query: "raft status", type: "project", limit: 3 }];
    const titleInB = async (snapshot: boolean) => {
      try {
        const r = await searchManyPrototype({ db: reader, brain }, { queries, dedupe: "none", ...ROOMY }, { snapshot, between: i => { if (i === 0) rename(renamed); } });
        return okItem(r, "b").hits.filter(h => h.path === path).map(h => (h as { title: string }).title);
      } finally { rename(original); }
    };
    try {
      expect(await titleInB(true), "ONE_SNAPSHOT").toEqual([original]);
      // Separate calls, as parallel brain_search makes them: the second sees a write made in between.
      expect(await titleInB(false), "SEPARATE_READS_SEE_THE_WRITE").toEqual([renamed]);
      evidence.snapshot = { oneCall: "every query of the call reads the snapshot of its first read", separateReads: "a write between two searches reaches the second" };
    } finally { reader.close(); writer.close(); }
  });

  test("path scope (#3644 semantics) is pushed into the pool, not filtered after the limit", async () => {
    const pushed = await search({ queries: SCOPED_QUERIES, dedupe: "none", ...ROOMY });
    const rows: unknown[] = [];
    for (const q of SCOPED_QUERIES) {
      const item = okItem(pushed, q.id);
      const { results: unscoped } = await viaOperation(q);
      const inScope = (p: string) => !(q.exclude ?? []).some(e => e.endsWith("/") ? p.startsWith(e) : p === e) && (!q.include || q.include.some(e => e.endsWith("/") ? p.startsWith(e) : p === e));
      for (const h of item.hits) expect(inScope(h.path), `SCOPE_HOLDS ${q.id} ${h.path}`).toBe(true);
      // What an agent can do today: run brain_search unscoped and drop what is out of scope.
      const filtered = unscoped.filter(r => inScope(r.path)).map(r => r.path);
      const kept = item.hits.map(h => h.path);
      expect(kept.length, `PUSHDOWN_FILLS_LIMIT ${q.id}`).toBeGreaterThanOrEqual(filtered.length);
      rows.push({ id: q.id, include: q.include ?? null, exclude: q.exclude ?? null, pushedDown: kept.length, postFiltered: filtered.length,
        missedByPostFilter: kept.filter(p => !filtered.includes(p)).length });
    }
    expect(rows.some(r => (r as { missedByPostFilter: number }).missedByPostFilter > 0), "POST_FILTER_LOSES_RESULTS").toBe(true);
    // An invalid scope entry is that query's error, as brain_context refuses the same entry.
    const bad = await search({ queries: [{ id: "ok", query: "raft" }, { id: "escape", query: "raft", include: ["../outside/"] }] });
    expect(bad.queries.map(q => q.status)).toEqual(["ok", "error"]);
    // An exclusion matches under case folding, as in context assembly.
    const folded = await search({ queries: [{ id: "x", query: "Ithaca", exclude: ["ME/"] }], dedupe: "none" });
    expect(okItem(folded, "x").hits.some(h => h.path.startsWith("me/")), "EXCLUDE_CASE_FOLDED").toBe(false);
    evidence.scope = rows;
  });
});

/** A modelled JSON-RPC response carrying the prototype result as the MCP server's structured tools do. */
const modelledResponse = (id: number, result: SearchManyResult) =>
  JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result }, jsonrpc: "2.0", id });

describe("real keyless stdio MCP exercise", () => {
  let client: Client;
  let wire: ReturnType<typeof recordWire>;
  type CallResult = { content: Array<{ type: string; text: string }>; structuredContent?: { results: SearchedDocument[]; warnings: string[] }; isError?: boolean };

  beforeAll(async () => {
    const transport = new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(root) });
    client = new Client({ name: "multi-query-search-spike", version: "1.0.0" });
    await client.connect(transport);
    wire = recordWire(transport);
  }, 60_000);
  afterAll(async () => { await client?.close(); });

  const call = async (args: Record<string, unknown>, signal?: AbortSignal) =>
    (await client.callTool({ name: "brain_search", arguments: args }, undefined, signal ? { signal } : undefined)) as CallResult;

  test("sequential and parallel brain_search against the prototype, task by task", async () => {
    const rows: unknown[] = [];
    for (const task of TASKS) {
      const arms: Record<string, unknown> = {};
      let lastParallel: CallResult[] = [];
      for (const arm of ["sequential", "parallel"] as const) {
        const times: number[] = [];
        let measured: Record<string, unknown> = {};
        for (let rep = 0; rep < REPEATS; rep++) {
          const sentBefore = wire.sent.length, receivedBefore = wire.received.length;
          const { ms, value: results } = await timed(async () => arm === "parallel"
            ? Promise.all(task.queries.map(q => call(mcpArgs(q))))
            : task.queries.reduce(async (acc, q) => [...await acc, await call(mcpArgs(q))], Promise.resolve([] as CallResult[])));
          times.push(ms);
          const sent = wire.sent.slice(sentBefore), received = wire.received.slice(receivedBefore);
          const texts = results.map(r => r.content[0]!.text);
          const rowsByQuery = results.map(r => r.structuredContent!.results as unknown as Array<Record<string, unknown>>);
          const warnings = results.flatMap(r => r.structuredContent!.warnings);
          measured = {
            toolCalls: task.queries.length, requestsSent: wireTotals(sent), responsesReceived: wireTotals(received),
            payload: sizeOf(texts.join("")), duplication: duplication(rowsByQuery),
            // Each response carries its JSON twice: the text copy (escaped) and structuredContent (raw).
            envelopeCharsPerCall: received.map((line, i) => envelopeOverhead(line, [texts[i]!]) - JSON.stringify(results[i]!.structuredContent).length),
            warnings: { total: warnings.length, distinct: [...new Set(warnings)], chars: warnings.join("").length, repeatedChars: warnings.join("").length - [...new Set(warnings)].join("").length },
            coverage: coverage(task, results.flatMap((r, i) => r.structuredContent!.results.map(x => [task.queries[i]!.id, x.path] as [string, string]))),
          };
          if (arm === "parallel") lastParallel = results;
        }
        expect((measured.requestsSent as { messages: number }).messages, `ONE_REQUEST_PER_QUERY ${task.id} ${arm}`).toBe(task.queries.length);
        arms[arm] = { ...measured, latencyMsMedian: median(times), latencyMsAll: times.map(t => Math.round(t * 100) / 100) };
      }
      // Equivalence: the prototype answers each query as the served tool did.
      const proto = await search({ queries: task.queries, dedupe: "none", ...ROOMY });
      for (const [i, q] of task.queries.entries()) {
        const served = lastParallel[i]!.structuredContent!.results;
        const item = okItem(proto, q.id);
        expect(item.hits.map(h => h.path), `MCP_SAME_ORDER ${task.id}/${q.id}`).toEqual(served.map(r => r.path));
        for (const [k, h] of item.hits.entries()) expect(h.score!).toBeCloseTo(served[k]!.score!, 6);
      }
      for (const dedupe of ["none", "documents"] as const) for (const caps of [ROOMY, {}] as const) {
        const times: number[] = [];
        let r!: SearchManyResult;
        for (let rep = 0; rep < REPEATS; rep++) { const t = await timed(() => search({ queries: task.queries, dedupe, ...caps })); times.push(t.ms); r = t.value; }
        const response = modelledResponse(9_000, r);
        arms[`prototype:${dedupe}:${caps === ROOMY ? "roomy" : "default"}`] = {
          toolCalls: 1, payload: sizeOf(JSON.stringify(r)), responseModelled: wireTotals([response]),
          truncated: r.truncated, returned: associations(r).length, omitted: r.queries.reduce((a, q) => a + (q.status === "ok" ? q.omitted : 0), 0),
          coverage: coverage(task, associations(r)), warnings: r.warnings.length,
          latencyMsMedian: median(times), latencyMsInProcessOnly: true,
        };
      }
      rows.push({ task: task.id, shape: task.shape, queries: task.queries.length, arms });
    }
    evidence.mcp = {
      transport: "real stdio, `brain mcp` spawned keyless against the workload corpus", repeats: REPEATS, tasks: rows,
      wireNote: "structuredResult sends each brain_search result twice (text copy and structuredContent); the prototype response is modelled with the same framing",
    };
  }, 180_000);

  test("what the single tool does with the edges the prototype answers per query", async () => {
    const rows: unknown[] = [];
    for (const q of EDGE_QUERIES) {
      const r = await call(mcpArgs(q)).catch(e => ({ thrown: String((e as Error).message) }));
      const text = "content" in r ? r.content.map(p => p.text).join("") : r.thrown;
      expect(text).not.toContain(root);
      rows.push({ id: q.id, isError: "content" in r ? r.isError ?? false : "thrown", text: text.slice(0, 240), results: "structuredContent" in r ? r.structuredContent?.results.length ?? null : null });
    }
    // A limit above 50 is capped silently over MCP.
    const capped = await call({ query: "safe beach", limit: 60 });
    rows.push({ id: "limit-60", returned: capped.structuredContent!.results.length });
    expect(capped.structuredContent!.results.length).toBeLessThanOrEqual(50);
    evidence.mcpEdges = rows;
  });

  test("cancelling one of four parallel searches rejects it on the client", async () => {
    const controller = new AbortController();
    const calls = TASKS[0]!.queries.map((q, i) => call(mcpArgs(q), i === 1 ? controller.signal : undefined));
    controller.abort();
    const settled = await Promise.allSettled(calls);
    expect(settled.map(s => s.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
    await Bun.sleep(200);
    evidence.mcpCancellation = { cancelNotificationSent: wire.sent.some(l => l.includes("notifications/cancelled")),
      note: "searchDocuments does not take a signal; a cancelled search runs to completion in the server and the client discards it" };
  });

  test("roster cost: the listed brain_search definition and the proposed one", async () => {
    const { tools } = await client.listTools();
    const listed = tools.find(t => t.name === "brain_search")!;
    // A like-for-like definition: brain_search's own input schema and descriptions as the item schema, plus the call's fields.
    const { query: _q, ...listedProps } = (listed.inputSchema as { properties: Record<string, unknown> }).properties;
    const likeForLike = {
      ...PROPOSED_TOOL,
      description: `${PROPOSED_TOOL.description} ${listed.description}`,
      inputSchema: { ...PROPOSED_TOOL.inputSchema, properties: { ...PROPOSED_TOOL.inputSchema.properties,
        queries: { ...PROPOSED_TOOL.inputSchema.properties.queries, items: { type: "object", required: ["id", "query"],
          properties: { id: PROPOSED_TOOL.inputSchema.properties.queries.items.properties.id, query: { type: "string", description: "Search query" }, ...listedProps,
            include: PROPOSED_TOOL.inputSchema.properties.queries.items.properties.include, exclude: PROPOSED_TOOL.inputSchema.properties.queries.items.properties.exclude } } } } },
    };
    evidence.rosterChars = { brain_search: JSON.stringify(listed).length, proposedSketch: JSON.stringify(PROPOSED_TOOL).length, proposedLikeForLike: JSON.stringify(likeForLike).length,
      note: "present on every provider request of a session that has the tool, cached or not; provider tokens unavailable" };
  });
});

interface PiRun { providerRequests: number; contextCharsPerRequest: number[]; toolResults: string[]; transcriptChars: number; spans: Array<{ start: number; end: number }>; ms: number }

/** One Pi agent-loop run with scripted assistant steps: each step is the tool calls of one assistant message. */
async function piRun(steps: Array<Array<{ name: string; args: Record<string, unknown> }>>): Promise<PiRun> {
  const faux = createFauxCore({});
  const contextChars: number[] = [];
  let finalContext: Message[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  faux.setResponses([
    ...steps.map((calls, s) => (context: { messages: Message[] }) => {
      contextChars.push(JSON.stringify(context.messages).length);
      return fauxAssistantMessage(calls.map((c, i) => fauxToolCall(c.name, c.args as Parameters<typeof fauxToolCall>[1], { id: `call_ithaca_${s}_${i}` })), { stopReason: "toolUse" });
    }),
    (context: { messages: Message[] }) => {
      contextChars.push(JSON.stringify(context.messages).length);
      finalContext = context.messages;
      return fauxAssistantMessage(fauxText("The raft and the sail are on track for the passage."));
    },
  ]);
  const tools = createBrainTools({ brain: createBrainAccess(root), turn: createTurnContext(), lock: toolLockFromKeyed(createKeyedLock()) });
  const def = tools.find(t => t.name === "brain_search")!;
  const timedTool = (name: string, execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>, parameters: unknown, description: string): AgentTool => ({
    name, label: name, description, parameters: parameters as never,
    async execute(id, params, signal) {
      const start = performance.now();
      try { return await execute(id, params, signal) as never; } finally { spans.push({ start, end: performance.now() }); }
    },
  });
  const brainSearch = timedTool("brain_search", (id, params, signal) => (def.execute as (...a: unknown[]) => Promise<unknown>)(id, params, signal, undefined, {}), def.parameters, def.description);
  const prototype = timedTool("prototype_search_many", async (_id, params, signal) => {
    const result = await search(params as SearchManyInput, { signal });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: null };
  }, Type.Object({ queries: Type.Array(Type.Object({ id: Type.String(), query: Type.String() })) }), "Private #3645 prototype; not a supported tool.");
  const { ms } = await timed(() => runAgentLoop(
    [{ role: "user", content: "Odysseus asks where the raft and the sail stand.", timestamp: 0 } as AgentMessage],
    { messages: [], tools: [brainSearch, prototype] },
    { model: faux.getModel(), convertToLlm: m => m as Message[] },
    () => {}, undefined, faux.streamSimple,
  ));
  const toolResults = finalContext.filter(m => m.role === "toolResult").map(m => (m.content as Array<{ type: string; text?: string }>).map(p => p.text ?? "").join(""));
  return { providerRequests: faux.state.callCount, contextCharsPerRequest: contextChars, toolResults, transcriptChars: JSON.stringify(finalContext.slice(1)).length, spans, ms };
}

/** The Pi tool's arguments: it has no mode, relevance or archive switch, and no scope. */
const piArgs = ({ id: _id, include: _i, exclude: _e, mode: _m, relevance: _r, include_archived: _a, ...rest }: NamedQuery) => rest;
/** Paths a Pi brain_search text answer lists, in order: `- <path> — <title> [<type>]`. */
const piPaths = (text: string) => [...text.matchAll(/^- (\S+) — /gm)].map(m => m[1]!);

describe("Pi tool-execution exercise (faux provider, scripted calls)", () => {
  test("one message of parallel brain_search calls, one call per message, and a prototype call", async () => {
    const rows: unknown[] = [];
    for (const task of TASKS) {
      const arms = {
        parallelOneMessage: [task.queries.map(q => ({ name: "brain_search", args: piArgs(q) }))],
        oneCallPerMessage: task.queries.map(q => [{ name: "brain_search", args: piArgs(q) }]),
        prototype: [[{ name: "prototype_search_many", args: { queries: task.queries } }]],
      };
      const out: Record<string, unknown> = {};
      for (const [name, steps] of Object.entries(arms)) {
        const times: number[] = [];
        let run!: PiRun;
        for (let rep = 0; rep < REPEATS; rep++) { run = await piRun(steps); times.push(run.ms); }
        const pairs: Array<[string, string]> = name === "prototype"
          ? associations(JSON.parse(run.toolResults[0]!) as SearchManyResult)
          : run.toolResults.flatMap((t, i) => piPaths(t).map(p => [task.queries[i]!.id, p] as [string, string]));
        const warningLines = run.toolResults.flatMap(t => t.split("\n").filter(l => l.startsWith("> ")));
        out[name] = {
          scriptedProviderRequests: run.providerRequests, toolCalls: steps.flat().length, maxConcurrentExecutions: maxOverlap(run.spans),
          payload: sizeOf(run.toolResults.join("")), transcriptChars: run.transcriptChars,
          transcriptOverheadChars: run.transcriptChars - run.toolResults.reduce((a, t) => a + escapedChars(t), 0),
          contextCharsPerRequest: run.contextCharsPerRequest, sumContextChars: run.contextCharsPerRequest.reduce((a, b) => a + b, 0),
          coverage: coverage(task, pairs), warningLines: warningLines.length, warningChars: warningLines.join("\n").length,
          latencyMsMedian: median(times),
        };
        expect(run.providerRequests, `${task.id} ${name}`).toBe(steps.length + 1);
        if (name === "parallelOneMessage") {
          // The Pi view carries no score: the same paths in the same order, nothing to compare a rank's meaning by.
          for (const [i, q] of task.queries.entries()) {
            const { results } = await viaOperation({ ...q, mode: undefined, relevance: undefined, include_archived: undefined });
            expect(piPaths(run.toolResults[i]!), `PI_SAME_ORDER ${task.id}/${q.id}`).toEqual(results.map(r => r.path));
          }
        }
      }
      rows.push({ task: task.id, arms: out });
    }
    evidence.pi = {
      runtime: "pi-agent-core runAgentLoop with pi-ai createFauxCore; the curated brain_search from createBrainTools",
      defaultToolExecution: "parallel (pi-agent-core default; the Pi backend does not set it)",
      repeats: REPEATS, tasks: rows,
      view: "Pi's brain_search answers markdown lines of path, title, type and snippet: no score, status, updated or deadline",
    };
  }, 180_000);

  test("Pi's brain_search has no limit cap of its own; only its 30,000-char clip bounds it", async () => {
    const run = await piRun([[{ name: "brain_search", args: { query: "safe beach", limit: 60 } }]]);
    const paths = piPaths(run.toolResults[0]!);
    evidence.piLimit = { requested: 60, returned: paths.length, chars: run.toolResults[0]!.length,
      note: "MCP caps limit at 50 (MAX_SEARCH_LIMIT); Pi passes the model's limit through" };
    expect(paths.length).toBeGreaterThan(0);
  }, 60_000);
});
