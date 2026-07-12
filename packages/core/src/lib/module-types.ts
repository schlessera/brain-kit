import type { Database } from "bun:sqlite";
import type { AuditIssue } from "./types";
import type { TypeSpec } from "./config";

/** Context handed to module hygiene checks. */
export interface HygieneContext {
  db: Database;
  root: string;
  /** The module's own validated config block. */
  config: unknown;
}

/** A CLI command contributed by core or a module. */
export interface CommandModule {
  summary: string;
  helpBlock?: string;
  run(args: string[], ctx: CommandContext): Promise<number | void>;
}

/** Passed to every command's run(). */
export interface CommandContext {
  root: string;
  json: boolean;
}

export interface ModuleCronEntry {
  name: string;
  /** Standard 5-field cron expression. Advisory: consumed by container entrypoints and `brain doctor`. */
  schedule: string;
  /** A `brain …` command line (without the leading "brain"). */
  command: string;
}

/**
 * A module manifest — pure data plus lazy command imports. No lifecycle
 * beyond load-time registration.
 */
export interface ModuleManifest {
  name: string;
  taxonomy?: {
    types?: Record<string, TypeSpec>;
    classifierHints?: Record<string, string[]>;
    assetTitleRules?: import("./config").AssetTitleRule[];
    propagation?: import("./config").PropagationRule[];
  };
  /** Path to the skills directory, relative to the module package root. */
  skills?: string;
  /** ONE namespaced top-level CLI word per module (e.g. `brain jobs …`). */
  commands?: Record<string, () => Promise<{ default: CommandModule } | CommandModule>>;
  hygieneChecks?: ((ctx: HygieneContext) => AuditIssue[] | Promise<AuditIssue[]>)[];
  indexRules?: { dirAnchors?: string[] };
  exclude?: { segments?: string[] };
  cron?: ModuleCronEntry[];
  /** Zod schema validating the user's config block for this module. */
  configSchema?: { parse(input: unknown): unknown };
}

/** Identity helper — gives module authors typing + a stable authoring surface. */
export function defineModule(manifest: ModuleManifest): ModuleManifest {
  return manifest;
}

/** A loaded module: manifest + where it came from. */
export interface LoadedModule {
  /** The key used in brain.config `modules:` (package name or local path). */
  key: string;
  manifest: ModuleManifest;
  /** Absolute directory of the module package (for skills resolution). */
  dir: string;
  /** The user's validated config block for this module. */
  config: unknown;
}
