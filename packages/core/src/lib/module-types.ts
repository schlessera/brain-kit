import type { Database } from "bun:sqlite";
import type { z } from "zod";
import type { AuditIssue } from "./types.js";
import type { TypeSpec } from "./config.js";

/**
 * Context handed to module hygiene checks. `C` is the module's config type,
 * threaded from its configSchema by `defineModule` — inside a module authored
 * with a schema, `config` is the parsed type, no cast needed.
 */
export interface HygieneContext<C = unknown> {
  db: Database;
  root: string;
  /** The module's own validated config block. */
  config: C;
}

/** A CLI command contributed by core or a module. */
export interface CommandModule<C = unknown> {
  summary: string;
  helpBlock?: string;
  run(args: string[], ctx: CommandContext<C>): Promise<number | void>;
}

/** Passed to every module command's run(). */
export interface CommandContext<C = unknown> {
  root: string;
  json: boolean;
  /**
   * The module's own validated config block (what its configSchema parsed at
   * load). Commands must use this instead of re-loading brain.config — the
   * loader already failed hard on an invalid block, so no silent-default
   * fallback path exists here. Typed `C` when the command is authored against
   * its module's config type (e.g. `CommandModule<MyConfig>`).
   */
  config: C;
  /** The fully-merged taxonomy (core + user + every loaded module). */
  taxonomy: import("./taxonomy.js").Taxonomy;
}

/** Context for a module tool, with its owning module's validated config.
 * @experimental Until 1.0; follows the shared integration contract.
 */
export interface ToolContext<C = unknown> {
  root: string;
  config: C;
  taxonomy: import("./taxonomy.js").Taxonomy;
  /** Aborted when the client cancels this request. */
  signal: AbortSignal;
}

/** A namespaced MCP wrapper over a module operation.
 * Both schemas must be strict zod 4 objects.
 * @experimental Until 1.0; follows the shared integration contract.
 */
export interface ModuleTool<C = unknown, I = unknown, O = unknown> {
  title?: string;
  description: string;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodObject;
  annotations: {
    readOnlyHint: boolean;
    /** Required when readOnlyHint is false. */
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint: boolean;
  };
  run(input: I, ctx: ToolContext<C>): Promise<O>;
}

/** Identity helper: infer run's input and result from the schemas.
 * @experimental Until 1.0; follows the shared integration contract.
 */
export function defineModuleTool<
  C = unknown,
  Input extends z.ZodObject = z.ZodObject,
  Output extends z.ZodObject = z.ZodObject,
>(tool: ModuleTool<C, z.output<Input>, z.output<Output>> & {
  inputSchema: Input;
  outputSchema: Output;
}): ModuleTool<C, z.output<Input>, z.output<Output>> & {
  inputSchema: Input;
  outputSchema: Output;
} {
  return tool;
}

/**
 * A hygiene check contributed by a module. Declared through a method signature
 * (the standard bivariance hack) so a `ModuleContribution<MyConfig>` stays
 * assignable to `ModuleContribution<unknown>` — the loader and every list of
 * heterogeneous modules (`LoadedModule[]`) work on the erased type, and the
 * loader guarantees at runtime that a check only ever receives its own
 * module's validated config. `CommandModule.run` gets the same treatment for
 * free from method syntax.
 */
export type HygieneCheck<C = unknown> = {
  bivariantHygieneCheck(ctx: HygieneContext<C>): AuditIssue[] | Promise<AuditIssue[]>;
}["bivariantHygieneCheck"];

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
 * (e.g. a taxonomy dir that follows a configured directory). `C` flows into
 * the command and hygiene contexts, so contributed functions see the module's
 * own config type.
 */
export interface ModuleContribution<C = unknown> {
  taxonomy?: {
    types?: Record<string, TypeSpec>;
    classifierHints?: Record<string, string[]>;
    assetTitleRules?: import("./config.js").AssetTitleRule[];
    propagation?: import("./config.js").PropagationRule[];
  };
  /**
   * Path to the skills directory, relative to the MODULE PACKAGE root (which
   * for an npm module lives outside the brain repo). Validated for shape only
   * (relative, no `..`/absolute) — the repo-containment guarantee of
   * repoRelativePathSchema does not apply here.
   */
  skills?: string;
  /** Authoritative generated context, derived from validated config by setup(). */
  instructions?: { text: string };
  /** ONE namespaced top-level CLI word per module (e.g. `brain jobs …`). */
  commands?: Record<string, () => Promise<{ default: CommandModule<C> } | CommandModule<C>>>;
  /** Lazy MCP definitions, served as `<module-name>_<local-name>`.
   * @experimental Until 1.0; follows the shared integration contract.
   */
  tools?: Record<string, () => Promise<{ default: ModuleTool<C> } | ModuleTool<C>>>;
  hygieneChecks?: HygieneCheck<C>[];
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
  /** Omission permits dormancy. A false value prevents CLI disable. */
  canBeDormant?: boolean;
  /** Explanation shown when canBeDormant is false. */
  dormancyReason?: string;
  /** Zod schema validating the user's config block for this module. */
  configSchema?: { parse(input: unknown): C };
  setup(config: C): ModuleContribution<C>;
}

/**
 * Identity helper — gives module authors typing + a stable authoring surface.
 * `C` is inferred from `configSchema`, so `setup(config)`, contributed
 * commands (`ctx.config` in `run()`), and hygiene checks all see the parsed
 * config type end to end, with no explicit type argument and no cast.
 */
export function defineModule<C = unknown>(manifest: ModuleManifest<C>): ModuleManifest<C> {
  return manifest;
}

/** The contribution as stored after setup(), tagged with the module's name. */
export type ResolvedManifest<C = unknown> = ModuleContribution<C> & {
  name: string;
  canBeDormant?: boolean;
  dormancyReason?: string;
};

/**
 * A loaded module: resolved contribution + where it came from. The loader
 * works on dynamically imported manifests, so at rest `C` is `unknown`; the
 * parameter exists for embedders that know which module they hold.
 */
export interface LoadedModule<C = unknown> {
  /** The key used in brain.config `modules:` (package name or local path). */
  key: string;
  /** The module's resolved contribution (setup() output) plus its name. */
  manifest: ResolvedManifest<C>;
  /** Absolute directory of the module package (for skills resolution). */
  dir: string;
  /** The user's validated config block for this module. */
  config: C;
  /** The loader always supplies state; omission in constructed contexts means active. */
  state?: "active" | "dormant";
}
