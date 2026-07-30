import { z } from "zod";
import { defineModule, repoRelativePathSchema } from "@endoxa/core";
import type { AuditIssue, HygieneContext } from "@endoxa/core";
import { checkSync, type FinanceOptions } from "./finance";

/** User config block for the finance module (validated at load). */
export const configSchema = z
  .object({
    clientsDir: repoRelativePathSchema.default("clients"),
    feeTolerance: z.number().default(30),
    currency: z.string().default("USD"),
    termsDays: z.number().int().positive().default(30),
  })
  .strict();

export type FinanceConfig = z.infer<typeof configSchema>;

function optionsFrom(ctx: HygieneContext): FinanceOptions {
  const cfg = configSchema.parse(ctx.config ?? {});
  return {
    root: ctx.root,
    clientsDir: cfg.clientsDir,
    feeTolerance: cfg.feeTolerance,
    defaultCurrency: cfg.currency,
    defaultTermsDays: cfg.termsDays,
  };
}

/** Hygiene: flag ledgers whose generated table block lags behind their frontmatter. */
function checkLedgerBlocksUpToDate(ctx: HygieneContext): AuditIssue[] {
  return checkSync(optionsFrom(ctx)).map((path) => ({
    path,
    severity: "warning" as const,
    category: "finance",
    message: "ledger generated block out of date",
    suggestion: "run `brain finance sync`",
  }));
}

export default defineModule({
  name: "finance",
  configSchema,
  // Two-phase: the taxonomy dir follows the configured clientsDir instead of
  // a static literal that had to be manually kept in sync.
  setup: (config) => ({
    taxonomy: {
      types: { finance: { dir: config.clientsDir } },
    },
    commands: { finance: () => import("./cli") },
    hygieneChecks: [checkLedgerBlocksUpToDate],
  }),
});
