/** Real stdio clients pin the module-authoring and MCP startup contract. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { brainConfigSchema } from "../src/lib/config";
import { loadModules } from "../src/lib/module-loader";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain } from "./cli-harness";

const CORE = ["brain_search", "brain_context", "brain_read", "brain_list", "brain_graph", "brain_add", "brain_update", "brain_archive"];
const roots: string[] = [];
const clients: Client[] = [];
afterAll(async () => {
  for (const client of clients) await client.close();
  for (const root of roots) cleanup(root);
});

type Mode = "echo" | "bad-output" | "throws" | "cancel" | "missing-output" | "loose-input" | "loose-output" | "legacy-schema" | "bad-annotations" | "unrepresentable" | "import-failure";
interface Fixture { name: string; owner?: string; tools: Record<string, Mode>; direct?: boolean }

function fixtures(specs: Fixture[]): string {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  const modules: Record<string, unknown> = {};
  for (const [index, spec] of specs.entries()) {
    const key = `./modules/fixture-${index}`;
    const dir = join(root, key);
    mkdirSync(dir, { recursive: true });
    modules[key] = { owner: spec.owner ?? spec.name, limit: 3 + index };
    const loaders: string[] = [];
    for (const [local, mode] of Object.entries(spec.tools)) {
      loaders.push(`${JSON.stringify(local)}: async () => ${spec.direct ? `(await import("./${local}.ts")).default` : `import("./${local}.ts")`}`);
      const result = mode === "bad-output" ? '{ message: 42 }' : `{
        message: input.message, count: input.count, owner: ctx.config.owner,
        limit: ctx.config.limit, root: ctx.root, types: ctx.taxonomy.validTypes(),
        signal: ctx.signal instanceof AbortSignal,
      }`;
      const run = mode === "throws" ? 'throw new Error("fixture operation failed");' : mode === "cancel" ? `
        await Bun.write(ctx.root + "/call-started", "started");
        await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
        await Bun.write(ctx.root + "/call-aborted", "aborted");
        return ${result};` : `return ${result};`;
      writeFileSync(join(dir, `${local}.ts`), mode === "import-failure" ? 'throw new Error("fixture import failed");' : `
        import { z } from "zod";
        ${mode === "legacy-schema" ? 'import { z as z3 } from "zod/v3";' : ""}
        ${mode === "unrepresentable" ? "" : 'import { defineModuleTool } from "@schlessera/brain";'}
        export default ${mode === "unrepresentable" ? "" : "defineModuleTool("}{
          title: "Fixture echo", description: "Echo one fixture input and its own module config.",
          inputSchema: ${mode === "legacy-schema" ? "z3.object({ message: z3.string(), count: z3.number().default(2) }).strict()" : `z.${mode === "loose-input" ? "object" : "strictObject"}({ message: z.string(), count: z.number().default(2) })`},
          ${mode === "missing-output" ? "" : `outputSchema: z.${mode === "loose-output" ? "object" : "strictObject"}({
            message: z.string(), count: z.number(), owner: z.string(), limit: z.number(),
            root: z.string(), types: z.array(z.string()), signal: z.boolean(),
            ${mode === "unrepresentable" ? "date: z.date().optional()," : ""}
          }),`}
          annotations: ${mode === "bad-annotations" ? "{ readOnlyHint: false, openWorldHint: false }" : "{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }"},
          async run(input, ctx) { ${run} },
        }${mode === "unrepresentable" ? "" : ")"};
      `);
    }
    writeFileSync(join(dir, "module.ts"), `
      import { z } from "zod";
      import { defineModule } from "@schlessera/brain";
      export default defineModule({
        name: ${JSON.stringify(spec.name)},
        configSchema: z.strictObject({ owner: z.string(), limit: z.number() }),
        setup: () => ({ tools: { ${loaders.join(",")} } }),
      });
    `);
  }
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ modules }));
  return root;
}

async function connect(root: string, entry = BRAIN_BIN, args = ["mcp"]) {
  const client = new Client({ name: "module-tools-test", version: "1.0.0" });
  clients.push(client);
  let stderr = "";
  let notifications = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notifications++; });
  const transport = new StdioClientTransport({
    command: "bun", args: [entry, ...args], env: keylessEnv(root), stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  await expect(client.connect(transport)).resolves.toBeUndefined();
  return { client, stderr: () => stderr, notifications: () => notifications };
}

async function call(client: Client, ...args: Parameters<Client["callTool"]>) {
  return CallToolResultSchema.parse(await client.callTool(...args));
}

let root: string;
let healthy: Awaited<ReturnType<typeof connect>>;
beforeAll(async () => {
  root = fixtures([
    { name: "zeta", owner: "first fixture", tools: { second: "echo", first: "echo", invalid_result: "bad-output", fail: "throws", wait: "cancel" } },
    { name: "alpha", owner: "second fixture", tools: { echo: "echo" }, direct: true },
  ]);
  healthy = await connect(root);
});

test("tools/list appends composed names in config and declaration order, with schemas and hints", async () => {
  const { tools } = await healthy.client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual([
    ...CORE, "zeta_second", "zeta_first", "zeta_invalid_result", "zeta_fail", "zeta_wait", "alpha_echo",
  ]);
  for (const tool of tools.slice(CORE.length)) {
    expect(tool.title).toBe("Fixture echo");
    expect(tool.description).toContain("own module config");
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool.inputSchema).toMatchObject({
      type: "object", additionalProperties: false,
      properties: { message: { type: "string" }, count: { type: "number", default: 2 } }, required: ["message"],
    });
    expect(tool.outputSchema).toMatchObject({ type: "object", additionalProperties: false, properties: { owner: { type: "string" }, limit: { type: "number" } } });
  }
});

test("each module receives its own non-empty parsed config and the request context", async () => {
  for (const [name, owner, limit] of [["zeta_first", "first fixture", 3], ["alpha_echo", "second fixture", 4]] as const) {
    const result = await call(healthy.client, { name, arguments: { message: "hello" } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ message: "hello", count: 2, owner, limit, root, signal: true });
    expect(result.structuredContent?.types).toContain("note");
    expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify(result.structuredContent) });
  }
});

test("unknown strict input keys produce a tool error naming the key", async () => {
  const result = await call(healthy.client, { name: "alpha_echo", arguments: { message: "hello", surprise: true } });
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining("surprise") })]);
});

test("invalid output produces a tool error naming the violated field", async () => {
  const result = await call(healthy.client, { name: "zeta_invalid_result", arguments: { message: "hello" } });
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining("message") })]);
});

test("a thrown operation uses the core Error result convention", async () => {
  const result = await call(healthy.client, { name: "zeta_fail", arguments: { message: "hello" } });
  expect(result).toEqual({ isError: true, content: [{ type: "text", text: "Error: fixture operation failed" }] });
});

test("an unregistered name produces the pinned SDK tool error", async () => {
  const result = await call(healthy.client, { name: "removed_echo", arguments: {} });
  expect(result).toEqual({ isError: true, content: [{ type: "text", text: "MCP error -32602: Tool removed_echo not found" }] });
});

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 200 && !existsSync(path); attempt++) await Bun.sleep(10);
  expect(existsSync(path)).toBe(true);
}

test("client cancellation aborts the owning call's ToolContext.signal", async () => {
  const controller = new AbortController();
  const pendingCall = call(healthy.client, { name: "zeta_wait", arguments: { message: "waiting" } }, undefined, { signal: controller.signal });
  // Observe rejection immediately, before waiting for the call to enter run.
  const outcome = pendingCall.then(() => "resolved", () => "cancelled");
  await waitForFile(join(root, "call-started"));
  controller.abort();
  expect(await outcome).toBe("cancelled");
  await waitForFile(join(root, "call-aborted"));
  expect(readFileSync(join(root, "call-aborted"), "utf8")).toBe("aborted");
});

describe("load-time declaration checks", () => {
  test("the maximum-length composed name is exactly 64 characters", async () => {
    const name = "a".repeat(31);
    const local = "b".repeat(32);
    const longest = fixtures([{ name, tools: { [local]: "echo" } }]);
    const server = await connect(longest);
    const canonical = `${name}_${local}`;
    expect(canonical).toHaveLength(64);
    expect((await server.client.listTools()).tools.map((tool) => tool.name)).toEqual([...CORE, canonical]);
    expect((await call(server.client, { name: canonical, arguments: { message: "maximum length" } })).isError).not.toBe(true);
  });
  for (const [name, local, message] of [
    ["brain", "echo", 'module name "brain" is reserved for core tools'],
    ["bad_name", "echo", "module name must match ^[a-z][a-z0-9-]{0,30}$"],
    ["a".repeat(32), "echo", "max 31 chars"],
    ["valid", "Bad", "tool local name must match ^[a-z][a-z0-9_]{0,31}$"],
    ["valid", "a".repeat(33), "max 32 chars"],
  ]) {
    test(`${name}/${local} fails load and keeps degraded core available`, async () => {
      const invalid = fixtures([{ name: name!, tools: { [local!]: "echo" } }]);
      const config = brainConfigSchema.parse(JSON.parse(readFileSync(join(invalid, "brain.config.json"), "utf8")));
      await expect(loadModules(config, invalid)).rejects.toThrow(message!);
      const server = await connect(invalid);
      expect((await server.client.listTools()).tools.map((tool) => tool.name)).toEqual(CORE);
      const result = await call(server.client, { name: "brain_list", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent?.warnings).toContainEqual(expect.stringContaining("brain.config is invalid"));
    });
  }

  test("load checks functions without importing definitions; empty tools don't restrict older module names", async () => {
    const lazy = fixtures([{ name: "lazy", tools: { echo: "import-failure" } }, { name: "legacy_name", tools: {} }]);
    const config = brainConfigSchema.parse(JSON.parse(readFileSync(join(lazy, "brain.config.json"), "utf8")));
    expect(await loadModules(config, lazy)).toHaveLength(2);
    const invalid = fixtures([{ name: "invalid", tools: { echo: "echo" } }]);
    const file = join(invalid, "modules/fixture-0/module.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace('async () => import("./echo.ts")', "42"));
    const invalidConfig = brainConfigSchema.parse(JSON.parse(readFileSync(join(invalid, "brain.config.json"), "utf8")));
    await expect(loadModules(invalidConfig, invalid)).rejects.toThrow("tool definition loader must be a function");
  });
});

describe("per-module definition failures", () => {
  for (const [mode, reason] of [
    ["missing-output", "outputSchema"], ["loose-input", "inputSchema"],
    ["loose-output", "outputSchema"], ["legacy-schema", "strict zod 4 object schema"],
    ["bad-annotations", "destructiveHint"], ["unrepresentable", "Date cannot be represented"],
    ["import-failure", "fixture import failed"],
  ] as const) {
    test(`${mode} hides all tools from the bad module while other and core tools still work`, async () => {
      const degraded = fixtures([
        { name: "broken", tools: { valid_first: "echo", invalid_second: mode } },
        { name: "working", tools: { echo: "echo" } },
      ]);
      const server = await connect(degraded);
      expect((await server.client.listTools()).tools.map((tool) => tool.name)).toEqual([...CORE, "working_echo"]);
      const good = await call(server.client, { name: "working_echo", arguments: { message: "still works" } });
      expect(good.isError).not.toBe(true);
      expect(good.structuredContent?.message).toBe("still works");
      const core = await call(server.client, { name: "brain_list", arguments: {} });
      expect(core.isError).not.toBe(true);
      expect(core.structuredContent?.warnings).toContainEqual(expect.stringContaining('module "broken" tools unavailable'));
      expect(core.structuredContent?.warnings).toContainEqual(expect.stringContaining(reason));
      expect(server.stderr()).toContain(reason);
    });
  }
});

test("the tool set stays fixed until the next process and sends no list-changed notifications", async () => {
  const fixed = fixtures([{ name: "initial", tools: { echo: "echo" } }]);
  const server = await connect(fixed);
  expect(server.client.getServerCapabilities()?.tools?.listChanged).toBe(true);
  expect((await server.client.listTools()).tools.map((tool) => tool.name)).toEqual([...CORE, "initial_echo"]);
  writeFileSync(join(fixed, "brain.config.json"), JSON.stringify({ modules: {} }));
  expect((await server.client.listTools()).tools.map((tool) => tool.name)).toEqual([...CORE, "initial_echo"]);
  expect((await call(server.client, { name: "initial_echo", arguments: { message: "still registered" } })).isError).not.toBe(true);
  expect(server.notifications()).toBe(0);
  const restarted = await connect(fixed);
  expect((await restarted.client.listTools()).tools.map((tool) => tool.name)).toEqual(CORE);
  expect((await call(restarted.client, { name: "initial_echo", arguments: {} })).isError).toBe(true);
});

test("collision preflight uses the contract message before the SDK can register a partial module", async () => {
  const collision = fixtures([{ name: "stub", tools: { first: "echo", ping: "echo" } }]);
  // Use the real startup function and real McpServer. The ordinary loader
  // prevents collisions by construction, so seed an existing owner explicitly.
  const entry = join(collision, "collision-server.ts");
  const registrar = join(import.meta.dir, "../src/lib/module-mcp-tools.ts");
  const loader = join(import.meta.dir, "../src/lib/module-loader.ts");
  const config = join(import.meta.dir, "../src/lib/config.ts");
  const taxonomy = join(import.meta.dir, "../src/lib/taxonomy.ts");
  writeFileSync(entry, `
    import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
    import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
    import { z } from "zod";
    import { registerModuleTools } from ${JSON.stringify(registrar)};
    import { loadModules } from ${JSON.stringify(loader)};
    import { brainConfigSchema } from ${JSON.stringify(config)};
    import { buildTaxonomy } from ${JSON.stringify(taxonomy)};
    const root = process.env.BRAIN_ROOT;
    const config = brainConfigSchema.parse(await Bun.file(root + "/brain.config.json").json());
    const server = new McpServer({ name: "collision-test", version: "1" });
    server.registerTool("stub_ping", { inputSchema: z.strictObject({}) }, async () => ({ content: [{ type: "text", text: "existing" }] }));
    const warnings = await registerModuleTools(server, await loadModules(config, root), root, buildTaxonomy({}), new Map([["stub_ping", process.argv[2] === "core" ? null : "earlier"]]));
    server.registerTool("inspect", { inputSchema: z.strictObject({}) }, async () => ({ content: [{ type: "text", text: JSON.stringify(warnings) }] }));
    await server.connect(new StdioServerTransport());
  `);
  for (const owner of ["core", "earlier"]) {
    const server = await connect(collision, entry, [owner]);
    const result = await call(server.client, { name: "inspect", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify([
      `module "stub" tools unavailable: module tool "stub_ping" from module "stub" collides with ${owner === "core" ? "core" : 'module "earlier"'}`,
    ]) }]);
    expect((await server.client.listTools()).tools.map((tool) => tool.name)).toEqual(["stub_ping", "inspect"]);
    expect((await call(server.client, { name: "stub_ping", arguments: {} })).content).toEqual([{ type: "text", text: "existing" }]);
  }
});
