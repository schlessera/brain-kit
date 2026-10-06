import { z } from "zod";
import { defineModule, type ModuleManifest, repoRelativePathSchema } from "@schlessera/brain";

/** User config block for the images module (validated at load). */
export const configSchema = z
  .object({
    /** Where generated images land when `--out` is not given. */
    imagesDir: repoRelativePathSchema.default("assets/images"),
    /**
     * Models to hide even when their provider has a key. Use it to keep an
     * expensive tier out of reach, or to drop a model a given account cannot
     * reach (GPT-image models need API Organization Verification).
     */
    disabledModels: z.array(z.string()).optional(),
    /**
     * Tie-break order for requests where capability does not decide.
     *
     * There is a defensible default (see evidence.ts), but it is a reading of
     * public preference arenas at a point in time, not a fact about your work.
     * State an order here and it wins over that default.
     */
    preferredModels: z.array(z.string()).optional(),
  })
  .strict();

export type ImagesConfig = z.infer<typeof configSchema>;

// Annotated so the public signature report records the manifest type.
const imagesModule: ModuleManifest<ImagesConfig> = defineModule({
  name: "images",
  configSchema,
  setup: (config) => ({
    commands: { image: () => import("./cli.js") },
    skills: "./skills",
    instructions: { text: `## Images workflow\n\nPlace generated assets beside the content they illustrate; use ${config.imagesDir} as the fallback directory. Use brain image --dry-run to inspect a capability-compatible model and its estimated cost before a billed generation. Honor the configured model preferences and exclusions; choose an explicit output path for the intended asset.` },
  }),
});

export default imagesModule;
