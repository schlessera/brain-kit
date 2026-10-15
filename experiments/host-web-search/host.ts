/** Research-only use of the existing activity RPC as a search carrier. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const installation = process.env.SEARCH_RESEARCH_INSTALL!;
const mode = process.env.SEARCH_RESEARCH_MODE!;
const root = "/root/search-executors";
mkdirSync(root, { recursive: true });
const sentinel = "Odysseus-host-only-credential";
writeFileSync(join(root, "private-credential"), sentinel);
let providerCalls = 0;
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  assert.equal(request.headers.get("x-odysseus-fixture"), sentinel, "HOST_HEADER_SENTINEL");
  providerCalls++;
  return Response.json({ results: [{ title: "Odysseus and the mast", url: "https://example.com/mast",
    content: "Athena advises Odysseus to secure the mast." }] });
} });

async function executor(identity: string) {
  const state = join(root, identity); mkdirSync(state, { recursive: true });
  const config = JSON.stringify({ searchProvider: "searxng", workflow: "none", allowedProviders: ["searxng"],
    searxngBaseUrl: provider.url.origin, searxngHeaders: { "x-odysseus-fixture": sentinel },
    ssrf: { allowRanges: ["127.0.0.0/8"] }, githubClone: { enabled: false },
    allowBrowserCookies: false });
  writeFileSync(join(state, "web-search.json"), config);
  const env = { PATH: process.env.PATH!, LANG: "C.UTF-8", HOME: state, PI_CODING_AGENT_DIR: state };
  const start = performance.now();
  if (mode === "mcp") {
    const transport = new StdioClientTransport({ command: "node", args: [join(installation, "node_modules/pi-web-access/dist/mcp-cli.js")], env, stderr: "pipe" });
    const client = new Client({ name: "odysseus-research", version: "1.0.0" });
    await client.connect(transport);
    // Research-only observation of the pinned client transport's actual child.
    const process = (transport as any)._process;
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve =>
      process.once("exit", (code: number | null, signal: string | null) => resolve({ code, signal })));
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 4, "MCP_FOUR_TOOLS");
    return { startupMs: performance.now() - start,
      call: (name: string, args: any) => client.callTool({ name, arguments: args }),
      async close() { await client.close(); const exit = await exited;
        assert.deepEqual(exit, { code: 0, signal: null }, "MCP_EXECUTOR_EXIT"); },
      unchanged: () => readFileSync(join(state, "web-search.json"), "utf8") === config };
  }
  const child = Bun.spawn([process.execPath, "--preload", resolve("scripts/test-network-child-preload.ts"),
    resolve("experiments/host-web-search/executor.ts"), mode, installation, state], { env, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const lines = createInterface({ input: Readable.fromWeb(child.stdout as any) });
  // Bun stdout is a web stream; readline consumes a Node adapter.
  const iterator = lines[Symbol.asyncIterator]();
  async function next() { const line = await iterator.next(); if (line.done) throw new Error("EXECUTOR_EOF"); return JSON.parse(line.value); }
  const ready = await next();
  assert.equal(ready.ready, true, "FULL_EXTENSION_READY");
  assert(ready.tools.includes("web_search"), "FULL_EXTENSION_REGISTERED");
  let id = 0;
  return { startupMs: performance.now() - start,
    async call(name: string, args: any) { child.stdin.write(JSON.stringify({ id: ++id, name, arguments: args }) + "\n"); return (await next()).result; },
    async close() { child.stdin.end(); assert.equal(await child.exited, 0, "FULL_EXECUTOR_EXIT"); },
    unchanged: () => readFileSync(join(state, "web-search.json"), "utf8") === config };
}

let a: Awaited<ReturnType<typeof executor>>;
let b: Awaited<ReturnType<typeof executor>>;
let bridgeCalls = 0;
const available = Promise.withResolvers<string>();
export const resultId = () => available.promise;
export async function runForeignSearch(input: any) {
  assert.equal(input.scope, "run", "FOREIGN_BRIDGE_SCOPE");
  assert.equal(input.runId, await available.promise, "FOREIGN_REPLAY_INPUT");
  b ??= await executor("troy");
  const result = await b.call("get_search_content", { responseId: input.runId, queryIndex: 0 });
  assert(!JSON.stringify(result).includes("Athena"), "WORKER_SESSION_REPLAY_DENIED");
  return { researchResult: result };
}
export async function runSearch(input: any) {
  assert.equal(input.scope, "run", "BRIDGE_SCOPE");
  assert.equal(input.runId, "Odysseus mast", "BRIDGE_FIXED_QUERY");
  bridgeCalls++;
  a ??= await executor("ithaca");
  const before = providerCalls;
  const result = await a.call("web_search", { query: input.runId, provider: "searxng" });
  const text = JSON.stringify(result);
  assert(text.includes("Athena"), "WORKER_HOST_UPSTREAM_RESULT");
  assert.equal(providerCalls, before + 1, "REAL_PROVIDER_CALLED");
  assert(!text.includes(sentinel), "CREDENTIAL_NOT_IN_RESULT");
  const handle = text.match(/\b[a-z0-9]{13,16}\b/)?.[0];
  assert(handle, "BRIDGE_RESULT_HANDLE");
  available.resolve(handle);
  return { researchResult: result };
}

export async function finishSearch() {
  try {
    assert(bridgeCalls > 0, "REAL_WORKER_FORWARDED");
    b ??= await executor("troy");
    const first = await a.call("web_search", { query: "Odysseus mast", provider: "searxng" });
    const id = JSON.stringify(first).match(/\b[a-z0-9]{13,16}\b/)?.[0];
    assert(id, "UPSTREAM_RESULT_ID");
    const own = await a.call("get_search_content", { responseId: id, queryIndex: 0 });
    const other = await b.call("get_search_content", { responseId: id, queryIndex: 0 });
    assert(JSON.stringify(own).includes("Athena"), "SESSION_OWN_RESULT");
    assert(!JSON.stringify(other).includes("Athena"), "SESSION_REPLAY_DENIED");
    assert(a.unchanged() && b.unchanged(), "PARENT_CONFIG_PRESERVED");
    const startupMs = [a.startupMs, b.startupMs];
    await a.close();
    a = await executor("ithaca");
    const restarted = await a.call("get_search_content", { responseId: id, queryIndex: 0 });
    assert(!JSON.stringify(restarted).includes("Athena"), "RESTART_WITHOUT_SESSION_RESTORE_LOSES_RESULT");
    console.error(JSON.stringify({ research: mode, bridgeCalls, providerCalls, processPerSession: true,
      startupMs, ownResult: true, foreignResultDenied: true, restartLosesResult: true }));
  } finally { await a?.close(); await b?.close(); provider.stop(true); }
}
