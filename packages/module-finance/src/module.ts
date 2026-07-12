import { z } from "zod";
import { defineModule } from "@brainform/core";
import type { AuditIssue, HygieneContext } from "@brainform/core";
import { checkSync, type FinanceOptions } from "./finance";

/**
 * User config block for the finance module (validated at load).
 *
 * NOTE: the manifest's taxonomy dir below is the static literal "clients". A
 * default-exported manifest cannot read user config, so relocating `clientsDir`
 * also requires overriding `taxonomy.types.finance.dir` in brain.config (see README).
 */
export const configSchema = z
  .object({
    clientsDir: z.string().default("clients"),
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
  taxonomy: {
    // Static default dir; keep in sync with configSchema.clientsDir's default.
    types: { finance: { dir: "clients" } },
  },
  commands: { finance: () => import("./cli") },
  hygieneChecks: [checkLedgerBlocksUpToDate],
  configSchema,
});
