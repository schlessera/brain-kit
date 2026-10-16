import { defineModule, type ModuleManifest } from "@schlessera/brain";
import { z } from "zod";
import { checkDiagramHygiene } from "./hygiene.js";

export const configSchema = z.object({}).strict();
export type DiagramsConfig = z.infer<typeof configSchema>;

const diagramsModule: ModuleManifest<DiagramsConfig> = defineModule<DiagramsConfig>({
  name: "diagrams",
  configSchema,
  setup: () => ({ hygieneChecks: [checkDiagramHygiene], commands: { diagram: () => import("./cli.js") }, skills: "./skills", renderers: { diagram: { fences: ["diagram"], extensions: [".diagram.yaml"], client: "@schlessera/brain-module-diagrams/ui", static: "@schlessera/brain-module-diagrams/render" } } }),
});
export default diagramsModule;
