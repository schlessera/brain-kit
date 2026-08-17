import { z } from "zod";
import { defineModule, repoRelativePathSchema } from "@schlessera/brain";

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

export default defineModule({
  name: "images",
  configSchema,
  setup: () => ({
    commands: { image: () => import("./cli.js") },
    skills: "./skills",
  }),
});
