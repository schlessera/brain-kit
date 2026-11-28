/** One config-selected module tool in the fictional example world. */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
export function installIthacaModuleTool(brain: string): void {
  const dir = join(brain, "modules/ithaca");
  mkdirSync(dir, { recursive: true });
  const core = JSON.stringify(resolve("packages/core/src/index.ts"));
  const zod = JSON.stringify(Bun.resolveSync("zod", import.meta.dir));
  writeFileSync(join(dir, "module.ts"), `import { defineModule } from ${core}; import { z } from ${zod};
export default defineModule({ name: "ithaca", configSchema: z.object({}), setup: () => ({ tools: {
  route: async () => ({ description: "Check the route to Ithaca.", inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ route: z.string() }), annotations: { readOnlyHint: true, openWorldHint: false },
    async run() { return { route: "Odysseus sails to Ithaca." }; } }),
} }) });`);
  rmSync(join(brain, "brain.config.ts"), { force: true });
  writeFileSync(join(brain, "brain.config.json"), JSON.stringify({ modules: { "./modules/ithaca": {} } }));
}
