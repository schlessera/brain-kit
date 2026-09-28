/**
 * hybridSearch's judgment-rerank stage (`rerank: "jev"`) as a degraded-mode
 * step: a reranker that fails, stalls, lies, or is unsupported on the lane
 * never breaks the search — the retrieval order stands and `warnings` says
 * why. Exclusions keep withheld documents at their retrieval rank; the depth
 * cap and the vector-margin gate bound the call; the lifecycle fields reach
 * the judgment as evidence and are not applied as multipliers after it.
 * FTS-only fixtures, keyless.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { migrateVecSchema, openDatabase, setMeta } from "../src/lib/db";
import { hybridSearch } from "../src/lib/search-engine";
import type { Ranked, RerankCandidate, Reranker } from "../src/lib/seams";

let db: Database;
beforeEach(() => {
  db = openDatabase(":memory:");
  // Retrieval order is by bm25; identical content makes it insertion order.
  for (let id = 1; id <= 4; id++) {
    db.run(
      "INSERT INTO documents(id,path,title,type,status,created,updated,content,indexed_at) VALUES (?,?,?,?,?,'2026-01-01','2026-01-01','topic','2026-01-01')",
      [id, `notes/${id}.md`, `Doc ${id}`, "note", "active"]
    );
    db.run("INSERT INTO documents_fts(rowid,title,summary,content,tags) VALUES (?,?,'','topic','')", [id, `Doc ${id}`]);
  }
});
afterEach(() => db.close());

const RRF = (i: number) => 1 / (60 + i + 1);

function reverser(overrides: Partial<Reranker> = {}): Reranker & { calls: RerankCandidate[][] } {
  const calls: RerankCandidate[][] = [];
  return {
    id: "test:reverse",
    capabilities: { modes: ["fts", "hybrid"], network: true },
    async rerank<C extends RerankCandidate>(req: { candidates: readonly C[] }): Promise<Ranked<C>[]> {
      calls.push([...req.candidates]);
      return [...req.candidates].reverse().map((item, i) => ({ item, score: i }));
    },
    ...overrides,
    calls,
  };
}

const paths = (r: { results: { path: string }[] }) => r.results.map((x) => x.path);

describe("hybridSearch rerank stage", () => {
  test("no reranker → lifecycle ordering, no warning", async () => {
    const r = await hybridSearch(db, { query: "topic", mode: "fts" });
    expect(paths(r)).toEqual(["notes/1.md", "notes/2.md", "notes/3.md", "notes/4.md"]);
    expect(r.warnings).toEqual([]);
  });

  test("applies the injected reranker and carries its scores", async () => {
    const rr = reverser();
    const r = await hybridSearch(db, { query: "topic", mode: "fts" }, { reranker: rr });
    expect(paths(r)).toEqual(["notes/4.md", "notes/3.md", "notes/2.md", "notes/1.md"]);
    // Rank-derived scores, then the lifecycle factors (equal here).
    const factor = r.results[0].score / RRF(0);
    expect(r.results.map((x) => x.score / factor)).toEqual([0, 1, 2, 3].map(RRF).map((x) => expect.closeTo(x, 10)) as unknown as number[]);
    expect(r.warnings).toEqual([]);
    expect(rr.calls[0][0]).toMatchObject({ id: "notes/1.md", source: "brain", title: "Doc 1", type: "note" });
  });

  test("rerank: 'none' skips the injected reranker", async () => {
    const rr = reverser();
    const r = await hybridSearch(db, { query: "topic", mode: "fts", rerank: "none" }, { reranker: rr });
    expect(paths(r)[0]).toBe("notes/1.md");
    expect(rr.calls).toHaveLength(0);
  });

  test("reranks before truncation, over the full pool", async () => {
    const rr = reverser();
    const r = await hybridSearch(db, { query: "topic", mode: "fts", limit: 2 }, { reranker: rr });
    expect(rr.calls[0]).toHaveLength(4);
    expect(paths(r)).toEqual(["notes/4.md", "notes/3.md"]);
  });

  test("skips a lane the reranker does not support, silently", async () => {
    const rr = reverser({ capabilities: { modes: ["hybrid"], network: false } });
    const r = await hybridSearch(db, { query: "topic", mode: "fts" }, { reranker: rr });
    expect(paths(r)[0]).toBe("notes/1.md");
    expect(rr.calls).toHaveLength(0);
    expect(r.warnings).toEqual([]);
  });

  test("withheld documents never reach a network reranker and keep their retrieval rank", async () => {
    const rr = reverser();
    const r = await hybridSearch(
      db,
      { query: "topic", mode: "fts" },
      { reranker: rr, rerankExclude: (p) => p === "notes/2.md" }
    );
    expect(rr.calls[0].map((c) => c.id)).toEqual(["notes/1.md", "notes/3.md", "notes/4.md"]);
    expect(paths(r)).toEqual(["notes/4.md", "notes/2.md", "notes/3.md", "notes/1.md"]);
  });

  test("a local reranker ignores the exclusion list", async () => {
    const rr = reverser({ capabilities: { modes: ["fts"], network: false } });
    await hybridSearch(db, { query: "topic", mode: "fts" }, { reranker: rr, rerankExclude: () => true });
    expect(rr.calls[0]).toHaveLength(4);
  });

  test("a throwing reranker degrades to retrieval order with a warning", async () => {
    const rr = reverser({ rerank: async () => { throw new Error("boom"); } });
    const r = await hybridSearch(db, { query: "topic", mode: "fts" }, { reranker: rr });
    expect(paths(r)[0]).toBe("notes/1.md");
    expect(r.warnings).toEqual(["rerank skipped (test:reverse): boom; results are in retrieval order"]);
  });

  test("a reranker that drops or invents candidates is treated as failed", async () => {
    const rr = reverser({
      rerank: async (req) => [{ item: req.candidates[0], score: 1 }],
    });
    const r = await hybridSearch(db, { query: "topic", mode: "fts" }, { reranker: rr });
    expect(paths(r)).toEqual(["notes/1.md", "notes/2.md", "notes/3.md", "notes/4.md"]);
    expect(r.warnings[0]).toMatch(/rerank skipped .*1 of 4/);
  });

  test("the deadline aborts a stalled reranker and keeps retrieval order", async () => {
    let aborted = false;
    const rr = reverser({
      rerank: (req) =>
        new Promise((_, reject) => {
          req.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    const r = await hybridSearch(db, { query: "topic", mode: "fts" }, { reranker: rr, rerankTimeoutMs: 20 });
    expect(paths(r)[0]).toBe("notes/1.md");
    expect(r.warnings).toEqual(["rerank skipped (test:reverse): rerank timed out after 20ms; results are in retrieval order"]);
    expect(aborted).toBe(true);
  });

  test("a dry run hands the preview to the caller, sends nothing, and warns", async () => {
    const seen: unknown[] = [];
    const rr = reverser({ preview: (req) => ({ n: req.candidates.length }) });
    const r = await hybridSearch(
      db,
      { query: "topic", mode: "fts" },
      { reranker: rr, rerankPreview: (p) => seen.push(p), rerankExclude: (p) => p === "notes/1.md" }
    );
    expect(rr.calls).toHaveLength(0);
    expect(seen).toEqual([{ n: 3 }]);
    expect(paths(r)[0]).toBe("notes/1.md");
    expect(r.warnings).toEqual(["rerank dry run (test:reverse): nothing was sent; results are in retrieval order"]);
  });

  test("rejects a non-positive deadline", async () => {
    await expect(
      hybridSearch(db, { query: "topic", mode: "fts" }, { reranker: reverser(), rerankTimeoutMs: 0 })
    ).rejects.toThrow(/rerankTimeoutMs/);
  });

  test("rerank: 'heuristic' keeps the lifecycle ordering and never calls the reranker", async () => {
    const rr = reverser();
    const r = await hybridSearch(db, { query: "topic", mode: "fts", rerank: "heuristic" }, { reranker: rr });
    expect(paths(r)[0]).toBe("notes/1.md");
    expect(rr.calls).toHaveLength(0);
    expect(r.warnings).toEqual([]);
  });

  test("rerank: 'jev' without an injected reranker warns and keeps the lifecycle ordering", async () => {
    const r = await hybridSearch(db, { query: "topic", mode: "fts", rerank: "jev" });
    expect(paths(r)[0]).toBe("notes/1.md");
    expect(r.warnings).toEqual(['rerank "jev" requested but no reranker is configured; results are in retrieval order']);
  });

  test("the judged order stands: lifecycle fields are evidence, not multipliers after it", async () => {
    db.run("UPDATE documents SET status='draft' WHERE id=4");
    db.run("UPDATE documents SET relevance='primary' WHERE id=3");
    const rr = reverser();
    const r = await hybridSearch(db, { query: "topic", mode: "fts", now: new Date("2026-01-02") }, { reranker: rr });
    expect(paths(r)).toEqual(["notes/4.md", "notes/3.md", "notes/2.md", "notes/1.md"]);
    // …and the judgment saw them.
    const sent = Object.fromEntries(rr.calls[0].map((c) => [c.id, c.attributes]));
    expect(sent["notes/4.md"]).toMatchObject({ status: "draft", updated: "2026-01-01" });
    expect(sent["notes/3.md"]).toMatchObject({ relevance: "primary" });
  });

  test("a judgment that fails leaves the retrieval order, not the lifecycle multipliers", async () => {
    db.run("UPDATE documents SET relevance='historical' WHERE id=1");
    const failing = reverser({ rerank: async () => { throw new Error("down"); } });
    const judged = await hybridSearch(db, { query: "topic", mode: "fts" }, { reranker: failing });
    expect(paths(judged)[0]).toBe("notes/1.md");
    const heuristic = await hybridSearch(db, { query: "topic", mode: "fts", rerank: "heuristic" });
    expect(paths(heuristic)[0]).not.toBe("notes/1.md");
  });

  test("the depth cap judges only the top N and keeps the rest in order behind them", async () => {
    const rr = reverser();
    const r = await hybridSearch(db, { query: "topic", mode: "fts" }, { reranker: rr, rerankDepth: 2 });
    expect(rr.calls[0].map((c) => c.id)).toEqual(["notes/1.md", "notes/2.md"]);
    expect(paths(r)).toEqual(["notes/2.md", "notes/1.md", "notes/3.md", "notes/4.md"]);
  });

  test("rejects a depth below 2", async () => {
    await expect(hybridSearch(db, { query: "topic", mode: "fts" }, { reranker: reverser(), rerankDepth: 1 })).rejects.toThrow(/rerankDepth/);
  });
});

describe("vector-margin gate", () => {
  let vdb: Database;
  const provider = {
    id: "test:gate",
    dimensions: 2,
    embed: async () => [],
    embedQuery: async () => new Float32Array([1, 0]),
  };
  /** Three documents whose cosine to the query falls with `spread` between neighbours. */
  async function fixture(spread: number) {
    vdb = openDatabase(":memory:");
    expect(await migrateVecSchema(vdb, 2)).toBe(true);
    setMeta(vdb, "embedding_model", "test:gate");
    for (let id = 1; id <= 3; id++) {
      vdb.run(
        "INSERT INTO documents(id,path,title,type,status,created,updated,content,indexed_at) VALUES (?,?,?,'note','active','2026-01-01','2026-01-01','topic','2026-01-01')",
        [id, `notes/${id}.md`, `Doc ${id}`]
      );
      const row = vdb.prepare("INSERT INTO chunks(document_id,chunk_index,heading,content,token_estimate) VALUES (?,0,'','topic',1) RETURNING id").get(id) as { id: number };
      const angle = (id - 1) * spread;
      vdb.run("INSERT INTO vec_chunks(chunk_id,embedding,is_archived,doc_type) VALUES (?,?,0,'note')", [
        row.id,
        new Uint8Array(new Float32Array([Math.cos(angle), Math.sin(angle)]).buffer),
      ]);
    }
  }
  afterEach(() => vdb?.close());

  const vectorReranker = () => reverser({ capabilities: { modes: ["vector"], network: false } });

  test("a clear vector winner skips the reranker", async () => {
    await fixture(0.8); // cosine gap between 1st and 2nd ≈ 0.3
    const rr = vectorReranker();
    const r = await hybridSearch(vdb, { query: "topic", mode: "vector" }, { embeddings: provider, reranker: rr, rerankSkipMargin: 0.05 });
    expect(rr.calls).toHaveLength(0);
    expect(paths(r)[0]).toBe("notes/1.md");
    expect(r.warnings).toEqual([]);
  });

  test("a close race is reranked", async () => {
    await fixture(0.05); // cosine gap ≈ 0.001
    const rr = vectorReranker();
    const r = await hybridSearch(vdb, { query: "topic", mode: "vector" }, { embeddings: provider, reranker: rr, rerankSkipMargin: 0.05 });
    expect(rr.calls).toHaveLength(1);
    expect(paths(r)[0]).toBe("notes/3.md");
  });

  test("no margin configured → always reranked", async () => {
    await fixture(0.8);
    const rr = vectorReranker();
    await hybridSearch(vdb, { query: "topic", mode: "vector" }, { embeddings: provider, reranker: rr });
    expect(rr.calls).toHaveLength(1);
  });
});
