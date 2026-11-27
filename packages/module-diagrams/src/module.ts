import { type AuditIssue, defineModule, type HygieneContext, type ModuleManifest } from "@schlessera/brain";
import { z } from "zod";

export const configSchema = z.object({}).strict();
export type DiagramsConfig = z.infer<typeof configSchema>;

// Core loads this manifest in every brain process; the check, and the SVG model
// and YAML parser behind it, load only when an audit runs it.
const checkDiagramHygiene = async (ctx: HygieneContext): Promise<AuditIssue[]> => (await import("./hygiene.js")).checkDiagramHygiene(ctx);

const diagramsModule: ModuleManifest<DiagramsConfig> = defineModule<DiagramsConfig>({
  name: "diagrams",
  configSchema,
  setup: () => ({ hygieneChecks: [checkDiagramHygiene], commands: { diagram: () => import("./cli.js") }, skills: "./skills", instructions: { text: "## Diagram workflow\n\nUse the diagram skill for structured figures to keep or share, authored as versioned YAML in a diagram fence or .diagram.yaml file. Select a shipped type, preserve the facts, and validate with brain diagram check before presenting. The app supplies light/dark/white-print rendering when its pack is bundled. Use Mermaid for a quick sketch; use image-gen for pictorial illustrations or image edits. Prefer a table or paragraph when structure adds no explanation." }, renderers: { diagram: { fences: ["diagram"], extensions: [".diagram.yaml"], client: "@schlessera/brain-module-diagrams/ui", static: "@schlessera/brain-module-diagrams/render" } } }),
});
export default diagramsModule;
