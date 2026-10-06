import { z } from "zod";
import { defineModule, type ModuleManifest, repoRelativePathSchema } from "@schlessera/brain";
import type { AuditIssue, HygieneContext } from "@schlessera/brain";
import { checkSync, type FinanceOptions } from "./finance.js";

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

function optionsFrom(ctx: HygieneContext<FinanceConfig>): FinanceOptions {
  // ctx.config is the loader-validated block, typed by the module contract —
  // defaults already applied, no re-parse or cast needed.
  return {
    root: ctx.root,
    clientsDir: ctx.config.clientsDir,
    feeTolerance: ctx.config.feeTolerance,
    defaultCurrency: ctx.config.currency,
    defaultTermsDays: ctx.config.termsDays,
  };
}

/** Hygiene: flag ledgers whose generated table block lags behind their frontmatter. */
function checkLedgerBlocksUpToDate(ctx: HygieneContext<FinanceConfig>): AuditIssue[] {
  return checkSync(optionsFrom(ctx)).map((path) => ({
    path,
    severity: "warning" as const,
    category: "finance",
    message: "ledger generated block out of date",
    suggestion: "run `brain finance sync`",
  }));
}

// Annotated so the public signature report records the manifest type.
const financeModule: ModuleManifest<FinanceConfig> = defineModule({
  name: "finance",
  configSchema,
  // Two-phase: the taxonomy dir follows the configured clientsDir instead of
  // a static literal that had to be manually kept in sync.
  setup: (config) => ({
    taxonomy: {
      types: { finance: { dir: config.clientsDir } },
    },
    instructions: { text: `## Finance workflow\n\nKeep client ledgers under ${config.clientsDir}/. Invoice, payment and allocation frontmatter is authoritative; balances, aging and tables are derived. Defaults are ${config.currency} and ${config.termsDays} payment-term days. Run brain finance sync to regenerate owned tables, preserving prose outside their regions.` },
    commands: { finance: () => import("./cli.js") },
    hygieneChecks: [checkLedgerBlocksUpToDate],
  }),
});

export default financeModule;
