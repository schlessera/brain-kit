import { indexDbPath } from "@schlessera/brain-common/internal/index-location";

import type { BrainConfig, LoadedConfig } from "./config.js";
import { loadUserConfig, resolveRoot } from "./config.js";
import type { LoadedModule } from "./module-types.js";
import { loadModules } from "./module-loader.js";
import { buildTaxonomy, Taxonomy } from "./taxonomy.js";

/**
 * Everything the libraries need to operate on one brain. Created by
 * initContext() at each entry (CLI, MCP server start, host, test setup) and
 * passed to the code that needs it.
 */
export interface BrainContext {
  root: string;
  dbPath: string;
  /** null = uninitialized brain (no brain.config.*). Taxonomy falls back to core defaults. */
  config: BrainConfig | null;
  configPath: string | null;
  configSource?: string;
  modules: LoadedModule[];
  taxonomy: Taxonomy;
}

export interface InitContextOptions {
  /** Explicit root; default: BRAIN_ROOT env → config-file walk-up → git root → cwd. */
  root?: string;
}

/**
 * Resolve root, load + validate config, load modules, build the effective
 * taxonomy.
 */
export async function initContext(opts: InitContextOptions = {}): Promise<BrainContext> {
  const root = resolveRoot(opts.root);
  const loaded: LoadedConfig = await loadUserConfig(root);
  const modules = await loadModules(loaded.config, root);
  const taxonomy = buildTaxonomy({ user: loaded.config, modules });

  return {
    root,
    dbPath: indexDbPath(root),
    config: loaded.config,
    configPath: loaded.path,
    configSource: loaded.content,
    modules,
    taxonomy,
  };
}
