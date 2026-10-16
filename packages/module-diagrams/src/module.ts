import { defineModule, type ModuleManifest } from "@schlessera/brain";
import { z } from "zod";

export const configSchema = z.object({}).strict();
export type DiagramsConfig = z.infer<typeof configSchema>;

const diagramsModule: ModuleManifest<DiagramsConfig> = defineModule({
  name: "diagrams",
  configSchema,
  setup: () => ({ commands: { diagram: () => import("./cli.js") }, skills: "./skills" }),
});
export default diagramsModule;
