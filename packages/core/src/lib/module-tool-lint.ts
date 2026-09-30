import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { readDocumentPart, topLevelBlocks } from "./document-parts.js";
import { inspectModuleTool } from "./module-mcp-tools.js";
import { moduleToolNameIssues } from "./module-tool-names.js";
import type { LoadedModule } from "./module-types.js";
import type { LintFinding } from "./skills/index.js";

/** Author checks over the same definitions MCP startup validates. */
export async function lintModuleTools(module: LoadedModule): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];
  const add = (rule: string, message: string) =>
    findings.push({ skill: module.manifest.name, severity: "error", rule, message } satisfies LintFinding);
  const entries = Object.entries(module.manifest.tools ?? {});
  if (entries.length === 0) return findings;
  for (const issue of moduleToolNameIssues(module.manifest.name, entries.map(([local]) => local))) {
    add("tool-name", issue);
  }

  let docs: string | undefined;
  try {
    const readme = readFileSync(join(module.dir, "README.md"), "utf8");
    const section = readDocumentPart(readme, { section: "MCP tools", sectionHint: "## MCP tools" });
    if (topLevelBlocks(section)[0]?.depth === 2) docs = section;
  } catch {
    // An absent README or section is reported per declared tool below.
  }

  for (const [local, load] of entries) {
    const name = `${module.manifest.name}_${local}`;
    const inspected = await inspectModuleTool(name, load);
    for (const problem of inspected.problems) add(problem.rule, problem.message);
    if (inspected.tool) {
      const schema = z.toJSONSchema(inspected.tool.inputSchema, { target: "draft-7", io: "input" });
      for (const [input, property] of Object.entries(schema.properties ?? {})) {
        if (typeof property !== "object" || typeof property.description !== "string" || !property.description.trim()) {
          add("tool-schema", `module tool "${name}" input "${input}" needs a description`);
        }
      }
    }
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (docs === undefined || !new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`).test(docs)) {
      add("tool-docs", `README.md needs a ## MCP tools section naming "${name}"`);
    }
  }
  return findings;
}
