/**
 * The module contract from the AUTHOR's seat (G7, closing RC5).
 *
 * `ModuleManifest<C>` validates the user's config block to `C`, and for years
 * `CommandContext.config` / `HygieneContext.config` threw that away as
 * `unknown`, so every module re-parsed or cast a value the loader had already
 * validated. This test pins the fix at the type level: a fixture module with a
 * real zod configSchema asserts — with no cast and no re-parse — that
 * `ctx.config` is the parsed type inside both a command's run() and a hygiene
 * check. If the generic is ever dropped again, `tsc --noEmit` fails here
 * (`unknown` is not assignable to the parsed type).
 *
 * The runtime half round-trips a config block through the real loader and the
 * same context shapes audit.ts / registry.ts construct, so the assertion is
 * not purely structural.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";

import { brainConfigSchema } from "../src/lib/config";
import { loadModules } from "../src/lib/module-loader";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { defineModule, defineModuleTool } from "../src/index";
import type { CommandModule, HygieneContext, ModuleContribution, ToolContext } from "../src/index";
import type { AuditIssue } from "../src/lib/types";
import type { QueryCode } from "../src/queries/index";
import { bindContentIndexQueries } from "../src/queries/bound";

/**
 * Compile-time identity assertion: passing a value forces the argument type to
 * be assignable to T. Pre-fix, `ctx.config` was `unknown`, which is assignable
 * to nothing — so every call below was a compile error.
 */
function expectType<T>(value: T): T {
  return value;
}

const configSchema = z
  .object({
    dir: z.string().default("fixtures"),
    limit: z.number().int().default(5),
  })
  .strict();

type FixtureConfig = z.infer<typeof configSchema>;

// What the fixture's command and hygiene check observed at runtime.
const seen: { command?: FixtureConfig; hygiene?: FixtureConfig; tool?: FixtureConfig } = {};

const fixtureTool = defineModuleTool({
  description: "Echo the fixture's parsed config and input.",
  inputSchema: z.strictObject({ message: z.string(), count: z.number().default(1) }),
  outputSchema: z.strictObject({ message: z.string(), count: z.number() }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(input, ctx: ToolContext<FixtureConfig>) {
    expectType<string>(input.message);
    expectType<number>(input.count);
    // These compile errors must remain errors: input is inferred, not any.
    // @ts-expect-error A strict input has no undeclared field.
    expectType<unknown>(input.missing);
    // @ts-expect-error message is a string.
    expectType<number>(input.message);
    expectType<FixtureConfig>(ctx.config);
    expectType<string>(ctx.config.dir);
    expectType<number>(ctx.config.limit);
    expectType<AbortSignal>(ctx.signal);
    seen.tool = ctx.config;
    return { message: input.message, count: input.count };
  },
});

const fixtureCommand: CommandModule<FixtureConfig> = {
  summary: "fixture",
  async run(_args, ctx) {
    // The point of G7: no cast, no re-parse — the generic delivers the type.
    const config = expectType<FixtureConfig>(ctx.config);
    expectType<string>(ctx.config.dir);
    expectType<number>(ctx.config.limit);
    seen.command = config;
    return 0;
  },
};

function fixtureHygiene(ctx: HygieneContext<FixtureConfig>): AuditIssue[] {
  const config = expectType<FixtureConfig>(ctx.config);
  expectType<string>(ctx.config.dir);
  // The index is reached through root-bound query results, not a database.
  const found = ctx.queries.findIndexDocuments({ type: "opportunity", excludeStatus: "archived" });
  if (found.ok) expectType<{ path: string; updated: string | null }[]>(found.value);
  else expectType<QueryCode>(found.error.code);
  // @ts-expect-error the raw content-index handle was removed (#699)
  void ctx.db;
  // @ts-expect-error core binds the root: callers cannot pass brainPath
  void ctx.queries.listIndexDocuments({ brainPath: "/elsewhere" });
  seen.hygiene = config;
  return [];
}

// C is inferred from configSchema — no explicit type argument.
const manifest = defineModule({
  name: "fixture",
  configSchema,
  setup: (config) => {
    // setup() already had the type; the fix extends it to the contexts.
    expectType<FixtureConfig>(config);
    return {
      commands: { fixture: async () => fixtureCommand },
      tools: { echo: async () => fixtureTool },
      hygieneChecks: [
        fixtureHygiene,
        // Fully inferred: no annotation anywhere, ctx.config must still be
        // the parsed type. Pre-fix this line was the raw symptom —
        // "'unknown' is not assignable to parameter of type 'FixtureConfig'".
        (ctx) => {
          expectType<FixtureConfig>(ctx.config);
          return [];
        },
      ],
    };
  },
});

// A typed contribution still belongs in the heterogeneous loader's list.
expectType<ModuleContribution>(manifest.setup(configSchema.parse({})));

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("module author typing (G7)", () => {
  test("ctx.config round-trips through the loader into command and hygiene contexts", async () => {
    // A real on-disk module (types are erased across the dynamic import; the
    // compile-time teeth live in the inline fixture above).
    const root = mkdtempSync(join(tmpdir(), "module-typing-"));
    temps.push(root);
    mkdirSync(join(root, "local", "fixture"), { recursive: true });
    // The temp dir sits outside the repo, so it cannot resolve zod; the
    // contract only requires `{ parse(input): C }`, and a hand-rolled schema
    // keeps the round-trip meaningful (the loader must store parse's OUTPUT).
    writeFileSync(
      join(root, "local", "fixture", "module.ts"),
      `export default {
  name: "fixture",
  configSchema: {
    parse(input) {
      const block = input ?? {};
      return { dir: block.dir ?? "fixtures", limit: block.limit ?? 5 };
    },
  },
  setup: () => ({}),
};`
    );

    const parsed = brainConfigSchema.parse({
      modules: { "./local/fixture": { dir: "notes" } },
    });
    const loaded = await loadModules(parsed, root);
    expect(loaded).toHaveLength(1);
    // The loader stored the PARSED block: defaults applied, user value kept.
    expect(loaded[0]!.config).toEqual({ dir: "notes", limit: 5 });
  });

  test("the inline fixture sees the parsed config in run() and the hygiene check", async () => {
    const config = configSchema.parse({ dir: "notes" });
    const contribution = manifest.setup(config);

    // Same context shape cli/registry.ts constructs for a module command.
    const command = await contribution.commands!.fixture!();
    await ("default" in command ? command.default : command).run([], {
      root: "/tmp/brain",
      json: false,
      config,
      taxonomy: buildTaxonomy({}),
    });
    expect(seen.command).toEqual({ dir: "notes", limit: 5 });

    const imported = await contribution.tools!.echo!();
    const tool = "default" in imported ? imported.default : imported;
    const result = await tool.run({ message: "fixture", count: 2 }, {
      root: "/tmp/brain", config, taxonomy: buildTaxonomy({}),
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ message: "fixture", count: 2 });
    expect(seen.tool).toEqual({ dir: "notes", limit: 5 });

    // Same context shape auditWithModules constructs for hygiene checks.
    const issues = await contribution.hygieneChecks![0]!({
      queries: bindContentIndexQueries("/tmp/brain"),
      root: "/tmp/brain",
      config,
    });
    expect(issues).toEqual([]);
    expect(seen.hygiene).toEqual({ dir: "notes", limit: 5 });
  });
});
