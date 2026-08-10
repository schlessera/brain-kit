import { join } from "path";

import type { BrainConfig, LoadedConfig } from "./config.js";
import { loadUserConfig, resolveRoot } from "./config.js";
import type { LoadedModule } from "./module-types.js";
import { loadModules } from "./module-loader.js";
import { buildTaxonomy, Taxonomy } from "./taxonomy.js";

/**
 * Everything the libraries need to operate on one brain. Created once per
 * process (CLI entry, MCP server start, test setup) and passed or fetched
 * via getContext().
 */
export interface BrainContext {
  root: string;
  dbPath: string;
  /** null = uninitialized brain (no brain.config.*). Taxonomy falls back to core defaults. */
  config: BrainConfig | null;
  configPath: string | null;
  modules: LoadedModule[];
  taxonomy: Taxonomy;
}

let current: BrainContext | null = null;

export interface InitContextOptions {
  /** Explicit root; default: BRAIN_ROOT env → config-file walk-up → git root → cwd. */
  root?: string;
}

/**
 * Resolve root, load + validate config, load modules, build the effective
 * taxonomy. Also sets the process-wide context returned by getContext().
 */
export async function initContext(opts: InitContextOptions = {}): Promise<BrainContext> {
  const root = resolveRoot(opts.root);
  const loaded: LoadedConfig = await loadUserConfig(root);
  const modules = await loadModules(loaded.config, root);
  const taxonomy = buildTaxonomy({ user: loaded.config, modules });

  current = {
    root,
    dbPath: join(root, "brain.db"),
    config: loaded.config,
    configPath: loaded.path,
    modules,
    taxonomy,
  };
  return current;
}

/** The process-wide context. Throws when initContext() has not run. */
export function getContext(): BrainContext {
  if (!current) {
    throw new Error("Brain context not initialized — call initContext() first");
  }
  return current;
}

/** Test helper: swap the process-wide context (returns the previous one). */
export function setContext(ctx: BrainContext | null): BrainContext | null {
  const prev = current;
  current = ctx;
  return prev;
}
