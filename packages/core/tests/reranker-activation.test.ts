import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { brainConfigSchema, loadUserConfig } from "../src/lib/config";
import { openDatabase } from "../src/lib/db";
import { rerankSetup, selectReranker } from "../src/lib/registry";
import { hybridSearch, type SearchDeps } from "../src/lib/search-engine";
import type { RerankCandidate, Reranker, Ranked } from "../src/lib/seams";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";

let db: Database;
let root: string | undefined;
let savedKey: string | undefined;
let savedMode: string | undefined;
let savedFetch: typeof fetch;
let requests: unknown[];

beforeEach(() => {
  savedKey = process.env.TYPESAFE_API_KEY;
  savedMode = process.env.BRAIN_RERANK_MODE;
  process.env.TYPESAFE_API_KEY = "synthetic-activation-key";
  delete process.env.BRAIN_RERANK_MODE;
  savedFetch = globalThis.fetch;
  requests = [];
  globalThis.fetch = (async (...args: unknown[]) => {
    requests.push(args);
    throw new Error("recording fake: no network");
  }) as unknown as typeof fetch;
  db = openDatabase(":memory:");
  for (let id = 1; id <= 4; id++) {
    db.run("INSERT INTO documents(id,path,title,type,status,created,updated,content,indexed_at) VALUES (?,?,?,'note','active','2026-01-01','2026-01-01','quartzprobe','2026-01-01')", [id, `notes/${id}.md`, `Choice ${id}`]);
    db.run("INSERT INTO documents_fts(rowid,title,content) VALUES (?,?,'quartzprobe')", [id, `Choice ${id}`]);
  }
});

afterEach(() => {
  db.close();
  if (root) cleanup(root);
  root = undefined;
  globalThis.fetch = savedFetch;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
  if (savedMode === undefined) delete process.env.BRAIN_RERANK_MODE;
  else process.env.BRAIN_RERANK_MODE = savedMode;
});

function recorder(): Reranker & { calls: number } {
  return {
    id: "test:activation",
    capabilities: { modes: ["fts"], network: true },
    calls: 0,
    async rerank<C extends RerankCandidate>({ candidates }: { candidates: readonly C[] }): Promise<Ranked<C>[]> {
      this.calls++;
      expect(candidates.length).toBeGreaterThan(1);
      return [...candidates].reverse().map(item => ({ item, score: 1 }));
    },
  };
}

const paths = (response: { results: { path: string }[] }) => response.results.map(r => r.path);

describe("reranker activation policy", () => {
  test("registry exposes no callable judgment when credentials exist but activation is omitted or false", async () => {
    const candidates = [1, 2].map(id => ({ id: String(id), source: "brain", title: `Choice ${id}`, excerpt: "quartzprobe" }));
    expect(candidates.length).toBeGreaterThan(1);
    for (const config of [undefined, { provider: "jev" }, { provider: "jev", enabled: false }]) {
      const selected = selectReranker(config);
      if (selected.reranker) {
        await selected.reranker.rerank({ query: "quartzprobe", candidates }).catch(() => {});
      }
      expect(requests).toHaveLength(0);
      expect(selected.rerank).toBe("heuristic");
    }
  });

  test("direct injection cannot activate a judgment through omitted/false policy, flags or environment", async () => {
    for (const enabled of [undefined, false]) {
      for (const env of [undefined, "jev"]) {
        if (env === undefined) delete process.env.BRAIN_RERANK_MODE;
        else process.env.BRAIN_RERANK_MODE = env;
        for (const requested of [undefined, "jev"] as const) {
          const rr = recorder();
          const deps: SearchDeps = { reranker: rr, rerankerEnabled: enabled };
          const response = await hybridSearch(db, { query: "quartzprobe", mode: "fts", rerank: requested }, deps);
          expect(rr.calls).toBe(0);
          expect(response.results).toHaveLength(4);
          expect(response.results.map((r) => r.path)).toEqual(["notes/1.md", "notes/2.md", "notes/3.md", "notes/4.md"]);
          if (requested === "jev" || env === "jev") expect(response.warnings.join(" ")).toContain("reranker.enabled");
          else expect(response.warnings).toEqual([]);
        }
      }
    }
  });

  test("enabled injected judgments change non-empty order; off and re-enabled retain provider settings", async () => {
    const rr = recorder();
    const config = { provider: rr, enabled: true, exclude: ["notes/2.md"], depth: 4, timeoutMs: 100, model: "fixed-model" };
    const search = async () => {
      const setup = rerankSetup(config);
      return hybridSearch(db, { query: "quartzprobe", mode: "fts", rerank: setup.rerank }, setup.deps);
    };
    const on = await search();
    expect(rr.calls).toBe(1);
    expect(on.results).toHaveLength(4);
    expect(paths(on)).toEqual(["notes/4.md", "notes/2.md", "notes/3.md", "notes/1.md"]);
    config.enabled = false;
    const off = await search();
    expect(rr.calls).toBe(1);
    expect(paths(off)).toEqual([1, 2, 3, 4].map(id => `notes/${id}.md`));
    expect(config).toMatchObject({ provider: rr, model: "fixed-model", exclude: ["notes/2.md"], depth: 4, timeoutMs: 100 });
    config.enabled = true;
    expect(paths(await search())).toEqual(paths(on));
    expect(rr.calls).toBe(2);
  });

  test("preview bypasses activation for inspection and never invokes the provider", async () => {
    const rr = recorder();
    const previews: unknown[] = [];
    rr.preview = ({ candidates }) => ({ count: candidates.length });
    const setup = rerankSetup({ provider: rr, enabled: false }, undefined, { preview: true });
    const response = await hybridSearch(db, { query: "quartzprobe", mode: "fts", rerank: setup.rerank }, { ...setup.deps, rerankPreview: request => previews.push(request) });
    expect(rr.calls).toBe(0);
    expect(previews).toEqual([{ count: 4 }]);
    expect(response.warnings.join(" ")).toContain("nothing was sent");
  });

  test("canonical JSON reload validates the boolean and preserves provider fields through toggles", async () => {
    root = makeTempBrain({ empty: true });
    const path = join(root, "brain.config.json");
    const provider = { provider: "jev", model: "fixed-model", apiKeyEnv: "TEST_RERANK_KEY", exclude: ["notes"] };
    for (const enabled of [true, false, true]) {
      writeFileSync(path, JSON.stringify({ reranker: { ...provider, enabled } }));
      expect((await loadUserConfig(root)).config?.reranker).toEqual({ ...provider, enabled });
    }
    expect(brainConfigSchema.safeParse({ reranker: { enabled: true } }).success).toBe(true);
    for (const enabled of ["true", 1, null]) {
      expect(brainConfigSchema.safeParse({ reranker: { provider: "jev", enabled } }).success).toBe(false);
    }
  });
});

function writeRecordingConfig(enabled?: boolean): string {
  const calls = join(root!, "rerank-calls.jsonl");
  writeFileSync(join(root!, "brain.config.ts"), `
    import { appendFileSync } from "fs";
    export default {
      profile: { name: "Alex Example" },
      reranker: {
        ${enabled === undefined ? "" : `enabled: ${enabled},`}
        provider: {
          id: "test:persistent", capabilities: { modes: ["fts", "hybrid"], network: false },
          async rerank({ candidates }) {
            appendFileSync(${JSON.stringify(calls)}, JSON.stringify(candidates.map(c => c.id)) + "\\n");
            return [...candidates].reverse().map(item => ({ item, score: 1 }));
          },
          preview({ candidates }) { return { count: candidates.length }; }
        }, model: "fixed-model", exclude: ["excluded"], depth: 4, timeoutMs: 500
      }
    };
  `);
  return calls;
}

function callCount(path: string): number {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length : 0;
}

async function fixtureBrain(): Promise<string> {
  root = makeTempBrain();
  const calls = writeRecordingConfig();
  for (let id = 1; id <= 4; id++) {
    writeFileSync(join(root, `notes/activation-${id}.md`), `---\ntitle: Choice ${id}\ntype: note\n---\n\nquartzprobe\n`);
  }
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  writeFileSync(join(root, "evals/activation.jsonl"), JSON.stringify({ id: "quartzprobe", q: "quartzprobe", class: "exact", expected: ["notes/activation-1.md"] }) + "\n");
  return calls;
}

describe("activation at real entry points", () => {
  test("CLI reloads opt-in/off/on and keeps local modes and dry-run offline", async () => {
    const calls = await fixtureBrain();
    const search = async (extra: string[] = [], env: Record<string, string> = {}) => {
      const result = await runCli(root!, ["search", "quartzprobe", "--mode", "fts", "--json", ...extra], env);
      expect(result.code).toBe(0);
      const response = JSON.parse(result.stdout);
      expect(response.results).toHaveLength(4);
      return response;
    };
    await search([], { TYPESAFE_API_KEY: "synthetic-activation-key" });
    expect(callCount(calls)).toBe(0);
    writeRecordingConfig(true);
    const on = await search();
    expect(callCount(calls)).toBe(1);
    for (const mode of ["none", "heuristic"]) await search(["--rerank", mode]);
    expect(callCount(calls)).toBe(1);
    writeRecordingConfig(false);
    const off = await search(["--rerank", "jev"]);
    expect(callCount(calls)).toBe(1);
    expect(off.warnings.join(" ")).toContain("reranker.enabled");
    const fromEnv = await search([], { BRAIN_RERANK_MODE: "jev" });
    expect(fromEnv.warnings.join(" ")).toContain("reranker.enabled");
    await search(["--rerank-dry-run"]);
    expect(callCount(calls)).toBe(1);
    writeRecordingConfig(true);
    expect(paths(await search())).toEqual(paths(on));
    expect(callCount(calls)).toBe(2);
  });

  test("MCP startup reloads omitted/off/on policy and explicit model mode cannot bypass it", async () => {
    const calls = await fixtureBrain();
    for (const enabled of [undefined, true, false]) {
      writeRecordingConfig(enabled);
      const client = new Client({ name: "activation-test", version: "1" });
      try {
        await client.connect(new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(root!) }));
        const result = await client.callTool({ name: "brain_search", arguments: { query: "quartzprobe", mode: "fts" } });
        const response = JSON.parse((result.content as { text: string }[])[0].text);
        expect(response.results).toHaveLength(4);
        expect(callCount(calls)).toBe(enabled === undefined ? 0 : 1);
        if (enabled === false) {
          const explicit = await client.callTool({ name: "brain_search", arguments: { query: "quartzprobe", mode: "fts", rerank: "jev" } });
          expect(callCount(calls)).toBe(1);
          expect(JSON.stringify(explicit)).toContain("reranker.enabled");
        }
      } finally { await client.close(); }
    }
  });

  test("CLI and MCP context use the loaded activation policy", async () => {
    const calls = await fixtureBrain();
    let expectedCalls = 0;
    for (const enabled of [undefined, false, true, false]) {
      writeRecordingConfig(enabled);
      const cli = await runCli(root!, ["context", "quartzprobe", "--max-tokens", "1000"]);
      if (enabled === true) expectedCalls++;
      expect(callCount(calls)).toBe(expectedCalls);
      expect(cli.code).toBe(0);
      expect(cli.stdout).toContain("notes/activation-");
      const client = new Client({ name: "activation-context", version: "1" });
      try {
        await client.connect(new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(root!) }));
        const result = await client.callTool({ name: "brain_context", arguments: { query: "quartzprobe", max_tokens: 1000, include_identity: false, include_current_focus: false } });
        if (enabled === true) expectedCalls++;
        expect(callCount(calls)).toBe(expectedCalls);
        expect(result.isError).not.toBe(true);
        const response = result.structuredContent as { context: string };
        expect(response.context).toContain("notes/activation-");
      } finally { await client.close(); }
    }
  });

  test("eval refuses disabled flag/environment requests and scores the enabled recording provider", async () => {
    const calls = await fixtureBrain();
    writeRecordingConfig(false);
    for (const extra of [[], ["--context", "--budgets", "1000"]]) {
      for (const fromEnv of [false, true]) {
        const result = await runCli(root!, ["eval", "--set", "evals/activation.jsonl", "--mode", "fts", "--json", ...extra, ...(fromEnv ? [] : ["--rerank", "jev"])], fromEnv ? { BRAIN_RERANK_MODE: "jev" } : {});
        expect(callCount(calls)).toBe(0);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("reranker.enabled");
        expect(result.stdout).not.toContain("per_query");
      }
    }
    writeRecordingConfig(true);
    const enabled = await runCli(root!, ["eval", "--set", "evals/activation.jsonl", "--mode", "fts", "--json"]);
    expect(enabled.code).toBe(0);
    expect(callCount(calls)).toBeGreaterThan(0);
    const report = JSON.parse(enabled.stdout);
    expect(report.per_query).toHaveLength(1);
    expect(report.meta.reranker).toBe("test:persistent");
  });
});
