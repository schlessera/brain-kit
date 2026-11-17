/**
 * `brain_compute_*` MCP contract (#3107), against the real stdio server:
 * the roster and every definition are identical with and without compute
 * configuration, the input schemas are strict (no caller or provider
 * identity from arguments), results equal the CLI's for the same operation,
 * refusals carry the stable code, run returns once started and the server
 * keeps advancing the jobs it started. Keyless; offline providers only.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { registerComputeTools } from "../src/mcp-server";
import { createComputeDriver, type ComputeOps } from "../src/lib/ops/compute";
import { BRAIN_BIN, keylessEnv, runCli } from "./cli-harness";
import { computeBrain, type ComputeBrain } from "./helpers/compute/cli-brain";

const COMPUTE_TOOLS = ["brain_compute_health", "brain_compute_plan", "brain_compute_run", "brain_compute_status", "brain_compute_cancel", "brain_compute_collect"];

let box: ComputeBrain;
let bare: ComputeBrain;
let client: Client;
let bareClient: Client;

async function connect(b: ComputeBrain): Promise<Client> {
  const transport = new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: { ...keylessEnv(b.root), ...b.env } });
  const c = new Client({ name: "compute-mcp-test", version: "1.0.0" });
  await c.connect(transport);
  return c;
}

beforeAll(async () => {
  box = computeBrain();
  bare = computeBrain(null);
  client = await connect(box);
  bareClient = await connect(bare);
});
afterAll(async () => {
  await client?.close();
  await bareClient?.close();
  box?.dispose();
  bare?.dispose();
});

type Result = { isError?: boolean; structuredContent?: Record<string, any>; content: { type: string; text: string }[] };
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as Result;
const cliJson = async (b: ComputeBrain, args: string[]) => JSON.parse((await runCli(b.root, ["compute", ...args, "--json"], b.env)).stdout);

const jobState = (id: string) => JSON.parse(readFileSync(join(box.state, "jobs", id, "job.json"), "utf8")).state as string;

describe("the tool roster", () => {
  test("registers all six compute tools, identically with and without compute configured", async () => {
    const configured = (await client.listTools()).tools;
    const unconfigured = (await bareClient.listTools()).tools;
    expect(configured.map((t) => t.name).filter((n) => n.startsWith("brain_compute_"))).toEqual(COMPUTE_TOOLS);
    // Every definition, byte for byte: names, order, descriptions, schemas, annotations.
    expect(JSON.stringify(configured)).toBe(JSON.stringify(unconfigured));
  });

  test("annotations say which tools reach the provider and which change things", async () => {
    const tools = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.annotations]));
    expect(tools.brain_compute_health).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tools.brain_compute_plan).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tools.brain_compute_run).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(tools.brain_compute_status).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(tools.brain_compute_cancel).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    expect(tools.brain_compute_collect).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  });

  test("every input schema is a closed object", async () => {
    for (const tool of (await client.listTools()).tools.filter((t) => t.name.startsWith("brain_compute_"))) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });
});

describe("strict input: no caller or provider identity from arguments", () => {
  for (const [name, args] of [
    ["brain_compute_run", { provider: "pylos-memory", argv: ["exit", "0"], caller: { kind: "cli", principal: "penelope" } }],
    ["brain_compute_plan", { provider: "pylos-memory", argv: ["exit", "0"], principal: "penelope" }],
    ["brain_compute_run", { provider: "pylos-memory", argv: ["exit", "0"], apiKeyEnv: "ODYSSEUS_SPARTA_COMPUTE_KEY" }],
    ["brain_compute_status", { job: "cj_aaaaaaaaaaaaaaaaaaaaaaaaaa", caller: { kind: "mcp", principal: "telemachus" } }],
    ["brain_compute_run", { provider: "pylos-memory", argv: ["exit", "0"], artifacts: [{ path: "a", max_bytes: 1, sandbox: "sbx-0001" }] }],
  ] as [string, Record<string, unknown>][]) {
    test(`${name} refuses ${Object.keys(args).at(-1)}`, async () => {
      const result = await call(client, name, args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content[0]!.text).toMatch(/Unrecognized key|unrecognized_keys/i);
    });
  }
});

describe("the same operation gives the same result as the CLI", () => {
  test("health", async () => {
    const mcp = await call(client, "brain_compute_health", {});
    expect(mcp.isError).toBeUndefined();
    expect(mcp.structuredContent).toEqual(await cliJson(box, ["health"]));
    expect(JSON.parse(mcp.content[0]!.text)).toEqual(mcp.structuredContent!);
  });

  test("plan", async () => {
    const mcp = await call(client, "brain_compute_plan", { provider: "ithaca-host", argv: ["true"], source: ["notes/raft.md"], artifacts: [{ path: "out.txt", max_bytes: 512 }], lease_seconds: 60 });
    const cli = await cliJson(box, ["plan", "--provider", "ithaca-host", "--source", "notes/raft.md", "--artifact", "out.txt:512", "--lease", "60", "--", "true"]);
    expect(mcp.structuredContent).toEqual(cli);
    expect(cli.ok).toBe(true);
  });

  for (const [code, args, cliArgs] of [
    ["provider_unknown", { provider: "calypso", argv: ["true"] }, ["run", "--provider", "calypso", "--", "true"]],
    ["provider_unavailable", { provider: "sparta-keyed", argv: ["true"] }, ["run", "--provider", "sparta-keyed", "--", "true"]],
    ["capability_unsupported", { provider: "pylos-memory", argv: ["true"], retain: true }, ["run", "--provider", "pylos-memory", "--retain", "--", "true"]],
  ] as [string, Record<string, unknown>, string[]][]) {
    test(`refusal ${code}: a tool error carrying the envelope`, async () => {
      const mcp = await call(client, "brain_compute_run", args);
      expect(mcp.isError).toBe(true);
      expect(mcp.structuredContent).toEqual(await cliJson(box, cliArgs));
      expect(mcp.structuredContent!.error.code).toBe(code);
    });
  }

  test("compute_disabled without configuration", async () => {
    const mcp = await call(bareClient, "brain_compute_run", { provider: "pylos-memory", argv: ["true"] });
    expect(mcp.isError).toBe(true);
    expect(mcp.structuredContent).toEqual(await cliJson(bare, ["run", "--provider", "pylos-memory", "--", "true"]));
    expect(mcp.structuredContent!.error.code).toBe("compute_disabled");
    expect(existsSync(join(bare.state, "jobs"))).toBe(false);
  });
});

describe("jobs", () => {
  test("run returns once started and the server drives the job to its end on its own", async () => {
    const started = await call(client, "brain_compute_run", { provider: "pylos-memory", argv: ["sleep", "1"] });
    expect(started.isError).toBeUndefined();
    const job = started.structuredContent!.job;
    expect(job.state).toBe("running");
    expect(job.terminal).toBeNull();
    // No status call: only the server's background driver can advance it.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && jobState(job.id) !== "succeeded") await Bun.sleep(100);
    expect(jobState(job.id)).toBe("succeeded");

    const collected = await call(client, "brain_compute_collect", { job: job.id });
    expect(collected.structuredContent).toMatchObject({ ok: true, job: { id: job.id, state: "succeeded", cleanup: { state: "released" } }, output: { truncated: false } });
    // The memory provider reports usage without an amount: unknown stays null, never 0.
    expect(collected.structuredContent!.job.cost.actual).toEqual({ usd: null, coverage: "unknown", source: "provider" });
  }, 30_000);

  test("cancel stops the command, releases and says so", async () => {
    const started = await call(client, "brain_compute_run", { provider: "pylos-memory", argv: ["sleep", "600"] });
    const id = started.structuredContent!.job.id;
    const status = await call(client, "brain_compute_status", { job: id });
    expect(status.structuredContent).toMatchObject({ ok: true, job: { id, state: "running", exit: null } });
    const cancelled = await call(client, "brain_compute_cancel", { job: id });
    expect(cancelled.isError).toBeUndefined();
    expect(cancelled.structuredContent!.job).toMatchObject({ state: "cancelled", cancelRequested: true, cleanup: { state: "released" } });
  });

  test("a job started through MCP is not addressable from the CLI, and the reverse", async () => {
    const mcpJob = (await call(client, "brain_compute_run", { provider: "pylos-memory", argv: ["exit", "0"] })).structuredContent!.job.id;
    expect((await cliJson(box, ["status", mcpJob])).error.code).toBe("job_unknown");
    const cliJob = (await cliJson(box, ["run", "--provider", "ithaca-host", "--", "true"])).job.id;
    const viaMcp = await call(client, "brain_compute_status", { job: cliJob });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.structuredContent!.error.code).toBe("job_unknown");
  });
});

describe("an operation that throws", () => {
  test("returns a fixed tool error without the thrown message; the details go to the server log", async () => {
    const handlers = new Map<string, (input: unknown) => Promise<Result>>();
    const server = { registerTool: (name: string, _def: unknown, handler: (input: unknown) => Promise<Result>) => void handlers.set(name, handler) };
    const secretPath = "/home/penelope/.local/state/brain/compute/0123456789abcdef/jobs";
    const boom = async () => {
      throw new Error(`EACCES: permission denied, mkdir '${secretPath}'`);
    };
    const ops = { caller: { kind: "mcp", principal: "penelope" }, health: boom, plan: boom, run: boom, status: boom, cancel: boom, collect: boom } as unknown as ComputeOps;
    const driver = createComputeDriver(ops);
    registerComputeTools(server as never, ops, driver);
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      for (const name of COMPUTE_TOOLS) {
        const result = await handlers.get(name)!({ provider: "ithaca-host", argv: ["true"], job: "cj_aaaaaaaaaaaaaaaaaaaaaaaaaa" });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(result.content).toEqual([{ type: "text", text: `Error: ${name} failed inside the brain MCP server; its log has the details` }]);
      }
    } finally {
      console.error = original;
      driver.stop();
    }
    expect(logged.length).toBe(COMPUTE_TOOLS.length);
    expect(logged.map((args) => args.map(String).join(" ")).filter((line) => !line.includes(secretPath))).toEqual([]);
  });
});
