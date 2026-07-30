import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

import { buildTaxonomy, loadModules, loadUserConfig, safeResolve } from "@brainform/core";
import type { CommandContext, CommandModule } from "@brainform/core";

import { configSchema, type FinanceConfig } from "./module";
import {
  buildPortfolio,
  renderReport,
  syncFiles,
  type FinanceOptions,
} from "./finance";

const HELP = `brain finance — accounts-receivable across client ledgers

  finance                 AR report across every client ledger
  finance sync            Regenerate ledger tables + <clientsDir>/_index.md dashboard
  finance new-client <slug>   Scaffold clients/<slug>/ledger.md from the template

Flags: --json  emit a machine-readable envelope (report / sync)`;

/** Resolve this module's validated config from the brain at `root`, or defaults. */
async function resolveConfig(root: string): Promise<FinanceConfig> {
  try {
    const { config } = await loadUserConfig(root);
    const modules = await loadModules(config, root);
    const self = modules.find((m) => m.manifest.name === "finance");
    if (self?.config) return self.config as FinanceConfig;
  } catch {
    // Fall through to schema defaults for an uninitialized / partial brain.
  }
  return configSchema.parse({});
}

function optionsFrom(root: string, cfg: FinanceConfig): FinanceOptions {
  return {
    root,
    clientsDir: cfg.clientsDir,
    feeTolerance: cfg.feeTolerance,
    defaultCurrency: cfg.currency,
    defaultTermsDays: cfg.termsDays,
  };
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function templatePath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "templates", "ledger.md");
}

function newClient(opts: FinanceOptions, slug: string): number {
  // slug is a raw CLI argument — refuse anything that resolves outside the root.
  const dir = safeResolve(opts.root, join(opts.clientsDir, slug));
  if (dir === null) {
    console.error(`Client slug escapes the brain root: ${slug}`);
    return 1;
  }
  const ledgerPath = join(dir, "ledger.md");
  if (existsSync(ledgerPath)) {
    console.error(`Ledger already exists: ${relative(opts.root, ledgerPath)}`);
    return 1;
  }
  const day = today();
  const rendered = readFileSync(templatePath(), "utf8")
    .replaceAll("__SLUG__", slug)
    .replaceAll("__DISPLAY__", titleCase(slug))
    .replaceAll("__CURRENCY__", opts.defaultCurrency)
    .replaceAll("__TERMS__", String(opts.defaultTermsDays))
    .replaceAll("__YEAR__", day.slice(0, 4))
    .replaceAll("__PERIOD__", day.slice(0, 7))
    .replaceAll("__TODAY__", day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(ledgerPath, rendered);
  console.log(`Created ${relative(opts.root, ledgerPath)} — edit the frontmatter, then run \`brain finance sync\`.`);
  return 0;
}

const command: CommandModule = {
  summary: "Accounts-receivable report, ledger sync, and client scaffolding",
  helpBlock: HELP,
  async run(args: string[], ctx: CommandContext): Promise<number> {
    const sub = args[0];
    const cfg = await resolveConfig(ctx.root);
    const opts = optionsFrom(ctx.root, cfg);

    if (!sub || sub === "report") {
      const pf = buildPortfolio(opts);
      if (ctx.json) console.log(JSON.stringify({ portfolio: pf }, null, 2));
      else console.log(renderReport(pf));
      return 0;
    }

    if (sub === "sync") {
      const res = syncFiles(opts);
      if (ctx.json) {
        console.log(JSON.stringify({ files: res.files }, null, 2));
      } else {
        console.log(
          res.files.length
            ? `Synced ${res.files.length} file(s):\n${res.files.map((f) => `  ${f}`).join("\n")}`
            : "All ledgers up to date."
        );
      }
      return 0;
    }

    if (sub === "new-client") {
      const slug = args[1];
      if (!slug) {
        console.error("usage: brain finance new-client <slug>");
        return 1;
      }
      return newClient(opts, slug);
    }

    console.error(`Unknown finance subcommand: ${sub}\n\n${HELP}`);
    return 1;
  },
};

export default command;
