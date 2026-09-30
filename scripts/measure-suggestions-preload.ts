/**
 * Harness-only description arm (#550). Loaded in a fresh subprocess before
 * either backend imports its tool contract. It changes exactly one line in
 * memory; production source, schema, brief and handlers stay identical.
 * Bun onLoad/preload: https://bun.sh/docs/runtime/plugins
 */
import { plugin } from "bun";

const arm = process.env.BRAIN_MEASURE_SUGGESTIONS_ARM;
if (arm !== "rule" && arm !== "no-rule") throw new Error("Missing suggestions measurement arm.");
plugin({
  name: "measure-suggestions-description",
  setup(build) {
    build.onLoad({ filter: /\/ui-sdk\/src\/tool-contracts\/blocks\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const lines = source.split("\n");
      const matches = lines.filter((line) => /^\s*"suggestions:/.test(line));
      if (matches.length !== 1) throw new Error("Expected exactly one suggestions description source line.");
      return {
        contents: arm === "rule" ? source : lines.filter((line) => line !== matches[0]).join("\n"),
        loader: "ts",
      };
    });
  },
});
