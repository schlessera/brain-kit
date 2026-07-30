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

/** Passed to every module command's run(). */
export interface CommandContext {
  root: string;
  json: boolean;
  /**
   * The module's own validated config block (what its configSchema parsed at
   * load). Commands must use this instead of re-loading brain.config — the
   * loader already failed hard on an invalid block, so no silent-default
   * fallback path exists here.
   */
  config: unknown;
  /** The fully-merged taxonomy (core + user + every loaded module). */
  taxonomy: import("./taxonomy").Taxonomy;
}

export interface ModuleCronEntry {
  name: string;
  /** Standard 5-field cron expression. Advisory: consumed by container entrypoints and `brain doctor`. */
  schedule: string;
  /** A `brain …` command line (without the leading "brain"). */
  command: string;
}

/**
 * Everything a module adds to the brain. Returned by the manifest's `setup()`
 * so the contribution can be shaped by the user's validated module config
 * (e.g. a taxonomy dir that follows a configured directory).
 */
export interface ModuleContribution {
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
}

/**
 * A module manifest, two-phase: static identity (name + configSchema), then
 * `setup(config)` building the contribution from the ALREADY-VALIDATED user
 * config block. Config-independent modules simply ignore the argument. No
 * lifecycle beyond load-time registration.
 */
export interface ModuleManifest<C = unknown> {
  name: string;
  /** Zod schema validating the user's config block for this module. */
  configSchema?: { parse(input: unknown): C };
  setup(config: C): ModuleContribution;
}

/** Identity helper — gives module authors typing + a stable authoring surface. */
export function defineModule<C = unknown>(manifest: ModuleManifest<C>): ModuleManifest<C> {
  return manifest;
}

/** The contribution as stored after setup(), tagged with the module's name. */
export type ResolvedManifest = ModuleContribution & { name: string };

/** A loaded module: resolved contribution + where it came from. */
export interface LoadedModule {
  /** The key used in brain.config `modules:` (package name or local path). */
  key: string;
  /** The module's resolved contribution (setup() output) plus its name. */
  manifest: ResolvedManifest;
  /** Absolute directory of the module package (for skills resolution). */
  dir: string;
  /** The user's validated config block for this module. */
  config: unknown;
}
