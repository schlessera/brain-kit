import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";

const roots: string[] = [];
afterAll(() => { for (const root of roots) cleanup(root); });
type Mode = "valid" | "load" | "definition" | "getter" | "name" | "annotations" | "schema" | "malformed-schema" | "docs";

function fixture(mode: Mode = "valid", moduleName = "fixture") {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  const dir = join(root, "modules/fixture");
  mkdirSync(dir, { recursive: true });
  const local = mode === "name" ? "Bad" : "echo";
  const canonical = `${moduleName}_${local}`;
  writeFileSync(join(dir, "module.ts"), `
    import { defineModule } from "@schlessera/brain";
    import { z } from "zod";
    export default defineModule({ name: ${JSON.stringify(moduleName)}, configSchema: z.strictObject({}),
      setup: () => ({ tools: { ${JSON.stringify(local)}: () => import("./tool.ts") } }) });
  `);
  writeFileSync(join(dir, "tool.ts"), `
    import { defineModuleTool } from "@schlessera/brain";
    import { z } from "zod";
    ${mode === "load" ? 'throw new Error("fixture import failed");' : ""}
    export default defineModuleTool({
      ${mode === "getter" ? 'get description() { throw new Error("fixture definition getter failed"); },' : `description: ${mode === "definition" ? '""' : '"Echo one message; count defaults to 2."'},`}
      inputSchema: ${mode === "malformed-schema" ? '{ _zod: { def: { type: "object", catchall: {} } } }' : `z.strictObject({
        message: z.string()${mode === "schema" ? "" : '.describe("Message to echo")'},
        // Description inside a default must count, just as tools/list reports it.
        count: z.number().describe("Echo count").default(2),
      })`},
      outputSchema: z.strictObject({ message: z.string(), count: z.number() }),
      annotations: ${mode === "annotations" ? "{ readOnlyHint: false, openWorldHint: false }" : "{ readOnlyHint: true, openWorldHint: false }"},
      async run(input) { return { message: input.message, count: input.count }; },
    });
  `);
  writeFileSync(join(dir, "README.md"), `# Fixture\n\n## MCP tools\n\n\`${mode === "docs" ? `${canonical}_other` : canonical}\` echoes a message.\n`);
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ modules: { "./modules/fixture": {} } }));
  return { root, dir, canonical, moduleName };
}

async function lint(root: string, name = "fixture") {
  const result = await runCli(root, ["module", "lint", name, "--json"]);
  // A malformed author definition must remain a diagnostic, not a CLI crash.
  expect(result.code).not.toBe(2);
  return { ...result, body: JSON.parse(result.stdout) };
}

describe("module tool lint rules through the real CLI", () => {
  for (const [mode, rule, detail] of [
    ["load", "tool-load", "fixture import failed"],
    ["definition", "tool-load", "description"],
    ["getter", "tool-load", "fixture definition getter failed"],
    ["name", "tool-name", "tools.Bad"],
    ["annotations", "tool-annotations", "destructiveHint"],
    ["schema", "tool-schema", 'input "message" needs a description'],
    ["malformed-schema", "tool-schema", "strict zod 4 object schema"],
    ["docs", "tool-docs", 'naming "fixture_echo"'],
  ] as const) {
    test(`${rule} reports only its rule for the ${mode} fixture`, async () => {
      const { root } = fixture(mode);
      const result = await lint(root);
      // Assert the precise rule first: an exit-code assertion must not mask it.
      expect(result.body.findings.map((finding: { rule: string }) => finding.rule)).toEqual([rule]);
      expect(result.body.findings[0]).toMatchObject({ skill: "fixture", severity: "error", message: expect.stringContaining(detail) });
      expect(result.body.errors).toBe(1);
      expect(result.code).toBe(1);
    });
  }

  for (const name of ["brain", "bad_name", "a".repeat(32)]) {
    test(`tool-name diagnoses rejected module name ${name}`, async () => {
      const { root } = fixture("valid", name);
      const result = await lint(root, name);
      expect(result.body.findings.map((finding: { rule: string }) => finding.rule)).toEqual(["tool-name"]);
      expect(result.body.errors).toBe(1);
      expect(result.code).toBe(1);
      const list = await runCli(root, ["module", "list", "--json"]);
      expect(JSON.parse(list.stdout).enabled).toEqual([{ name, key: "./modules/fixture", description: null, settings: false, state: "unavailable", error: expect.stringContaining("invalid manifest") }]);
      expect(list.code).toBe(0);
    });
  }

  test("a valid non-empty tool contribution lints clean, including a description inside a default", async () => {
    const { root, canonical } = fixture();
    const list = await runCli(root, ["module", "list", "--json"]);
    const tools = JSON.parse(list.stdout).enabled[0].tools;
    expect(tools).toHaveLength(1);
    expect(tools).toEqual([canonical]);
    expect(list.code).toBe(0);
    const result = await lint(root);
    expect(result.body).toEqual({ module: "fixture", findings: [], errors: 0 });
    expect(result.code).toBe(0);
  });

  test("a disabled module is still a load finding, rather than a tool-name finding", async () => {
    const { root } = fixture();
    const result = await lint(root, "absent");
    expect(result.body.findings.map((finding: { rule: string }) => finding.rule)).toEqual(["load"]);
    expect(result.code).toBe(1);
  });

  for (const readme of [
    "# Fixture\n\n```md\n## MCP tools\nfixture_echo\n```\n",
    "# Fixture\n\n### MCP tools\nfixture_echo\n",
    "# Fixture\n\n## MCP tools\nfixture_echo_other\n\n## Other\nfixture_echo\n",
  ]) {
    test(`tool-docs requires the tool name in a real level-two section: ${JSON.stringify(readme)}`, async () => {
      const { root, dir } = fixture();
      writeFileSync(join(dir, "README.md"), readme);
      const result = await lint(root);
      expect(result.body.findings.map((finding: { rule: string }) => finding.rule)).toEqual(["tool-docs"]);
      expect(result.code).toBe(1);
    });
  }
});

async function withMcp(root: string, inspect: (client: Client) => Promise<void>) {
  const client = new Client({ name: "module-tool-lint-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(root), stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  try {
    await expect(client.connect(transport)).resolves.toBeUndefined();
    await inspect(client);
  } finally {
    await client.close();
  }
}

test("changing one definition is rejected by the shared validator in lint and real stdio MCP", async () => {
  const { root, dir, canonical } = fixture();
  expect((await lint(root)).body.errors).toBe(0);
  await withMcp(root, async (client) => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(canonical);
    const result = CallToolResultSchema.parse(await client.callTool({ name: canonical, arguments: { message: "before" } }));
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.message).toBe("before");
  });
  const file = join(dir, "tool.ts");
  writeFileSync(file, readFileSync(file, "utf8").replace('outputSchema: z.strictObject({ message: z.string(), count: z.number() })', "outputSchema: undefined"));
  const rejected = await lint(root);
  expect(rejected.body.findings.map((finding: { rule: string }) => finding.rule)).toEqual(["tool-schema"]);
  expect(rejected.body.findings[0].message).toContain("outputSchema");
  expect(rejected.code).toBe(1);
  await withMcp(root, async (client) => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(canonical);
    const result = CallToolResultSchema.parse(await client.callTool({ name: "brain_list", arguments: {} }));
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.warnings).toContainEqual(expect.stringContaining(rejected.body.findings[0].message));
  });
});
