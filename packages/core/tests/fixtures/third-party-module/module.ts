/**
 * A module written the way a third party would write one: it imports only the
 * supported entries (`@schlessera/brain`, `@schlessera/brain/module`) and zod,
 * never core's source or `/internal`. tests/module-entry.test.ts copies it
 * into a temp brain as a path module and drives it through the real CLI.
 *
 * `brain logbook <slug> <date> <entry>` writes `logbook/<slug>.md` once,
 * putting the entry in a generated region; a second write to the same slug
 * is refused.
 */
import { defineModule, type CommandModule } from "@schlessera/brain";
import {
  WriteRefusedError,
  inertGeneratedText,
  rewriteGeneratedRegion,
  safeResolve,
  writeFileSafely,
} from "@schlessera/brain/module";
import { z } from "zod";

const configSchema = z.strictObject({ dir: z.string().default("logbook") });
type LogbookConfig = z.infer<typeof configSchema>;

const command: CommandModule<LogbookConfig> = {
  summary: "Record one logbook entry",
  async run(args, ctx) {
    const [slug, date, entry] = args.filter((arg) => !arg.startsWith("--"));
    if (!slug || !date || !entry) {
      console.error("Usage: brain logbook <slug> <date> <entry>");
      return 2;
    }
    const rel = `${ctx.config.dir}/${slug}.md`;
    const abs = safeResolve(ctx.root, rel);
    if (abs === null) {
      console.error(`${rel} is outside the brain`);
      return 2;
    }
    const skeleton = `---\ntitle: Logbook ${slug}\ntype: logbook\ncreated: ${date}\nupdated: ${date}\nrelevance: primary\ntags: [voyage]\n---\n\n# Logbook ${slug}\n`;
    const document = rewriteGeneratedRegion(skeleton, "logbook-entry", inertGeneratedText(entry), date) ?? skeleton;
    try {
      writeFileSafely(abs, document, { replace: false });
    } catch (error) {
      if (error instanceof WriteRefusedError && error.code === "EEXIST") {
        console.error(`${rel} already exists`);
        return 1;
      }
      throw error;
    }
    if (ctx.json) console.log(JSON.stringify({ path: rel }));
    else console.log(`Wrote ${rel}`);
    return 0;
  },
};

export default defineModule({
  name: "logbook",
  configSchema,
  setup: (config) => ({
    taxonomy: { types: { logbook: { dir: config.dir } } },
    commands: { logbook: async () => command },
  }),
});
