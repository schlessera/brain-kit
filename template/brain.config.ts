import { defineConfig } from "@schlessera/brain";

/**
 * brain.config.ts — the single source of truth for your brain's shape.
 *
 * This starter is intentionally almost empty. The core document types are
 * built in, so a brand-new brain works with no configuration at all:
 *
 *   identity → me/        context → context/        note → notes/        index
 *
 * Run `/brain-init` in your coding agent to grow this file from a short
 * interview — it adds your taxonomy, profile, providers, and any modules you
 * enable. You can also edit it by hand; `brain validate` checks it against the
 * schema and refuses on errors.
 */
export default defineConfig({
  // profile: {
  //   name: "Your Name",
  //   cliTitle: "Your Name's personal knowledge base", // shown in `brain --help`
  // },

  // Add your own document types. Each maps a type name to its canonical
  // directory plus optional staleness / inbox / audit rules. Example:
  // taxonomy: {
  //   types: {
  //     project: {
  //       dir: "projects/active",
  //       match: ["projects/"],        // path prefixes counted as this type
  //       staleDays: 90,
  //       staleSeverity: "warning",
  //     },
  //   },
  // },

  // Turn on semantic search once you add a GEMINI_API_KEY (see .env.example):
  // embeddings: { provider: "gemini", model: "gemini-embedding-2", apiKeyEnv: "GEMINI_API_KEY" },

  // Enable an optional domain module. Modules ship their own types, skills, and
  // CLI commands; `/brain-module` wires one up for you. Example:
  // modules: {
  //   "@schlessera/brain-module-speaking": {},
  // },
});
