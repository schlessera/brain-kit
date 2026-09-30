import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LoadedModule, ModuleTool } from "./module-types.js";
import type { Taxonomy } from "./taxonomy.js";

/** The SDK must receive the full strict schema, rather than its raw shape. */
const strictObjectSchema = z.custom<z.ZodObject>((value) => {
  if (!value || typeof value !== "object" || !("_zod" in value)) return false;
  const schema = value as z.ZodObject;
  return schema._zod?.def?.type === "object" &&
    schema._zod.def.catchall?._zod.def.type === "never";
}, { message: "must be a strict zod 4 object schema" });

const toolDefinitionSchema = z.object({
  title: z.string().optional(),
  description: z.string().trim().min(1),
  inputSchema: strictObjectSchema,
  outputSchema: strictObjectSchema,
  annotations: z.object({
    readOnlyHint: z.boolean(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean(),
  }).strict().refine((hints) => hints.readOnlyHint || hints.destructiveHint !== undefined, {
    path: ["destructiveHint"],
    message: "required when readOnlyHint is false",
  }),
  run: z.custom<ModuleTool["run"]>((value) => typeof value === "function", {
    message: "must be a function",
  }),
}).strict();

/** Resolve all definitions before registration, so a bad module adds no tools. */
export async function loadModuleTools(module: LoadedModule): Promise<Array<{ name: string; tool: ModuleTool }>> {
  const tools: Array<{ name: string; tool: ModuleTool }> = [];
  for (const [localName, load] of Object.entries(module.manifest.tools ?? {})) {
    const name = `${module.manifest.name}_${localName}`;
    const imported = await load();
    const definition = imported && "default" in imported ? imported.default : imported;
    const parsed = toolDefinitionSchema.safeParse(definition);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) =>
        `${issue.path.join(".") || "(root)"}: ${issue.message}`
      ).join("; ");
      throw new Error(`module tool "${name}" has an invalid definition: ${issues}`);
    }
    // tools/list performs this conversion too. Reject an unrepresentable
    // field here, while the failure can still be isolated to its module.
    z.toJSONSchema(parsed.data.inputSchema, { target: "draft-7", io: "input" });
    z.toJSONSchema(parsed.data.outputSchema, { target: "draft-7", io: "input" });
    tools.push({ name, tool: parsed.data });
  }
  return tools;
}

/** Internal startup registration; callers seed owners with already-registered tools.
 * A null owner identifies core. Register before connecting the server transport.
 */
export async function registerModuleTools(
  server: McpServer,
  modules: LoadedModule[],
  root: string,
  taxonomy: Taxonomy,
  owners: Map<string, string | null>,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const module of modules) {
    try {
      const tools = await loadModuleTools(module);
      for (const { name } of tools) {
        if (owners.has(name)) {
          const owner = owners.get(name);
          throw new Error(`module tool "${name}" from module "${module.manifest.name}" collides with ${owner === null ? "core" : `module "${owner}"`}`);
        }
      }
      for (const { name, tool } of tools) {
        server.registerTool(name, {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: tool.annotations,
        }, async (input, extra) => {
          try {
            const result = await tool.run(input, {
              root, config: module.config, taxonomy, signal: extra.signal,
            });
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              // The required object output schema is validated by the SDK.
              structuredContent: result as Record<string, unknown>,
            };
          } catch (error) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
            };
          }
        });
        owners.set(name, module.manifest.name);
      }
    } catch (error) {
      const warning = `module "${module.manifest.name}" tools unavailable: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`brain MCP: ${warning}`);
      warnings.push(warning);
    }
  }
  return warnings;
}
