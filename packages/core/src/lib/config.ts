import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { z } from "zod";

import type { AgentRunner, CompletionProvider, EmbeddingProvider } from "./seams.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const severitySchema = z.enum(["error", "warning", "info"]);

/**
 * A path (or path prefix / glob) that must stay inside the brain repo:
 * relative, no `..` segments, no absolute/home/backslash forms. Applied at
 * every config field that later feeds a filesystem read or write, so a
 * mistyped or malicious config value can never point resolution outside the
 * root. `"."` (the root itself) and trailing slashes are allowed.
 */
export const repoRelativePathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.startsWith("~"), {
    message: "must be a repo-relative path (no absolute or ~ paths)",
  })
  .refine((p) => !p.includes("\\"), {
    message: "must use forward slashes",
  })
  .refine((p) => p.split("/").every((seg) => seg !== ".."), {
    message: "must not contain '..' segments",
  })
  // Control characters never belong in a path, and a newline here is
  // load-bearing: these values (and the `modules` keys built on this schema)
  // are interpolated into generated files — a container entrypoint writes
  // module cron entries into a ROOT crontab, where a newline is a new command.
  .refine((p) => !/[\u0000-\u001f\u007f]/.test(p), {
    message: "must not contain control characters",
  });

/**
 * One entry per document type. Replaces the historical trio of unsynchronized
 * type→dir maps (ingestion TYPE_DIRECTORIES, auditor TYPE_DIR_MAP, indexer
 * inferAssetType).
 */
export const typeSpecSchema = z
  .object({
    /** Canonical creation directory. `null` = any directory; dir checks are skipped. */
    dir: repoRelativePathSchema.nullable(),
    /** Accepted path prefixes (defaults to [dir]). Longest prefix wins for inference. */
    match: z.array(repoRelativePathSchema).optional(),
    /** Staleness threshold in days for docs under this type's dir. */
    staleDays: z.number().int().positive().optional(),
    /** Severity of staleness findings (default "warning" when staleDays is set). */
    staleSeverity: severitySchema.optional(),
    /** This type's dir is the capture inbox (`brain add` default target). */
    inbox: z.boolean().optional(),
    /** Exempt from the orphan (no wiki-links) audit check. */
    orphanExempt: z.boolean().optional(),
    /**
     * `brain add` content titled exactly after an existing document of this
     * type appends into that document instead of creating a new file.
     */
    appendMatch: z.boolean().optional(),
  })
  .strict();

export type TypeSpec = z.infer<typeof typeSpecSchema>;

export const propagationRuleSchema = z
  .object({
    /** Canonical source document (exact path). */
    source: repoRelativePathSchema,
    /** Glob for derivative documents that must not lag behind the source. */
    derivatives: repoRelativePathSchema,
    severity: severitySchema.optional(),
  })
  .strict();

export type PropagationRule = z.infer<typeof propagationRuleSchema>;

export const assetTitleRuleSchema = z.union([
  z
    .object({
      /** Directory prefix match. */
      prefix: z.string(),
      label: z.string(),
    })
    .strict(),
  z
    .object({
      /** Glob over the asset's directory: `*` = one segment, `**` = any depth. */
      pattern: z.string(),
      label: z.string(),
      /** Path segment index appended in parens, e.g. the talk slug. */
      slugFrom: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);

export type AssetTitleRule = z.infer<typeof assetTitleRuleSchema>;

const taxonomyConfigSchema = z
  .object({
    types: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), typeSpecSchema).optional(),
    /** Anchor files a directory wiki-link resolves to, in order. */
    dirAnchors: z.array(repoRelativePathSchema).optional(),
    /** Well-known documents (identity, currentFocus, …). Features degrade gracefully when unset or missing. Empty string disables an entry. */
    canonical: z.record(z.string(), z.union([z.literal(""), repoRelativePathSchema])).optional(),
    propagation: z.array(propagationRuleSchema).optional(),
    assetTitleRules: z.array(assetTitleRuleSchema).optional(),
    /** type → keyword/phrase list; compiled to word-boundary regexes for heuristic classification. */
    classifierHints: z.record(z.string(), z.array(z.string())).optional(),
    defaultStaleness: z
      .object({ days: z.number().int().positive(), severity: severitySchema })
      .strict()
      .optional(),
  })
  .strict();

export type TaxonomyConfig = z.infer<typeof taxonomyConfigSchema>;

const excludeConfigSchema = z
  .object({
    dirs: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
    segments: z.array(z.string()).optional(),
  })
  .strict();

const embeddingProviderValue = z.custom<EmbeddingProvider>(
  (v) => !!v && typeof v === "object" && typeof (v as EmbeddingProvider).embed === "function",
  { message: "expected an EmbeddingProvider implementation" }
);
const completionProviderValue = z.custom<CompletionProvider>(
  (v) => !!v && typeof v === "object" && typeof (v as CompletionProvider).complete === "function",
  { message: "expected a CompletionProvider implementation" }
);
const agentRunnerValue = z.custom<AgentRunner>(
  (v) => !!v && typeof v === "object" && typeof (v as AgentRunner).run === "function",
  { message: "expected an AgentRunner implementation" }
);

export const brainConfigSchema = z
  .object({
    profile: z
      .object({
        name: z.string().optional(),
        /** Shown in `brain --help`. */
        cliTitle: z.string().optional(),
      })
      .strict()
      .optional(),
    taxonomy: taxonomyConfigSchema.optional(),
    exclude: excludeConfigSchema.optional(),
    embeddings: z
      .object({
        provider: z.union([z.string(), embeddingProviderValue]),
        model: z.string().optional(),
        apiKeyEnv: z.string().optional(),
        dimensions: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    completions: z
      .object({
        provider: z.union([z.string(), completionProviderValue]),
        fallback: z.union([z.string(), completionProviderValue]).optional(),
      })
      .strict()
      .optional(),
    agentRunner: z.union([z.string(), agentRunnerValue]).optional(),
    graph: z
      .object({
        /**
         * The document the knowledge graph is measured from. May be an indexed
         * note or an index-excluded entry file (AGENTS.md, CLAUDE.md), which
         * becomes a virtual root. Unset → AGENTS.md, then CLAUDE.md.
         */
        root: repoRelativePathSchema.optional(),
      })
      .strict()
      .optional(),
    skills: z
      .object({
        /** Extra skill emitters to run on `brain skills sync` (claude always runs; add "codex", "gemini", "pi"). */
        emitters: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    /**
     * package name or ./local/path → module config block (validated by the
     * module's configSchema). Keys lead to import() — constrain them: a
     * `./`-prefixed key must stay inside the repo (no `..`, no absolute), and
     * anything else must look like an npm package specifier. brain.config.json
     * is agent-editable data; an unconstrained key would turn it into
     * arbitrary code execution outside the root.
     */
    modules: z
      .record(
        z.string().refine(
          (key) =>
            key.startsWith("./")
              ? repoRelativePathSchema.safeParse(key.slice(2)).success
              : /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(key),
          {
            message:
              "module key must be an npm package name or a ./repo-relative path (no .., no absolute)",
          }
        ),
        z.unknown()
      )
      .optional(),
  })
  .strict();

export type BrainConfig = z.infer<typeof brainConfigSchema>;

/** Typed authoring helper for brain.config.ts. Validation happens at load. */
export function defineConfig(config: BrainConfig): BrainConfig {
  return config;
}

// ---------------------------------------------------------------------------
// Core defaults
// ---------------------------------------------------------------------------

/** Types every brain has, regardless of configuration. */
export const CORE_TYPES: Record<string, TypeSpec> = {
  identity: { dir: "me" },
  context: { dir: "context", staleDays: 30, staleSeverity: "warning", orphanExempt: true },
  note: { dir: "notes", inbox: true },
  index: { dir: null, orphanExempt: true },
};

export const DEFAULT_EXCLUDE = {
  dirs: [".git", "node_modules", ".claude", ".agents", "scripts", "logs", "tmp", "workspaces", "okf-dist"],
  files: ["CLAUDE.md", "README.md", "AGENTS.md"],
  segments: [] as string[],
};

export const DEFAULT_DIR_ANCHORS = ["_index.md"];

export const DEFAULT_STALENESS = { days: 180, severity: "info" as const };

export const DEFAULT_CANONICAL: Record<string, string> = {
  identity: "me/identity.md",
  currentFocus: "context/current-focus.md",
};

// ---------------------------------------------------------------------------
// Root resolution + config loading
// ---------------------------------------------------------------------------

export const CONFIG_FILENAMES = ["brain.config.ts", "brain.config.json"];

/**
 * Resolve the brain root: explicit argument → BRAIN_ROOT env → nearest
 * ancestor of cwd containing a brain.config.* → nearest ancestor containing
 * .git → cwd.
 */
export function resolveRoot(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.BRAIN_ROOT) return resolve(process.env.BRAIN_ROOT);

  const findUp = (marker: (dir: string) => boolean): string | null => {
    let dir = process.cwd();
    for (;;) {
      if (marker(dir)) return dir;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  };

  return (
    findUp((dir) => CONFIG_FILENAMES.some((f) => existsSync(join(dir, f)))) ??
    findUp((dir) => existsSync(join(dir, ".git"))) ??
    process.cwd()
  );
}

export interface LoadedConfig {
  /** null when no config file exists (uninitialized brain). */
  config: BrainConfig | null;
  /** Absolute path of the loaded file, or null. */
  path: string | null;
  source: "ts" | "json" | null;
}

/** Formats a zod error into actionable one-line-per-issue text. */
export function formatConfigError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  ${where}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Load and validate the user's brain.config.{ts,json}. Returns config: null
 * when no file exists; throws with a readable message on schema violations.
 */
export async function loadUserConfig(root: string): Promise<LoadedConfig> {
  const tsPath = join(root, "brain.config.ts");
  const jsonPath = join(root, "brain.config.json");

  let raw: unknown;
  let path: string;
  let source: "ts" | "json";

  if (existsSync(tsPath)) {
    const mod = await import(tsPath);
    raw = mod.default;
    if (raw === undefined) {
      throw new Error(`${tsPath} must default-export defineConfig({...})`);
    }
    path = tsPath;
    source = "ts";
  } else if (existsSync(jsonPath)) {
    raw = JSON.parse(await Bun.file(jsonPath).text());
    path = jsonPath;
    source = "json";
  } else {
    return { config: null, path: null, source: null };
  }

  const parsed = brainConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${path}:\n${formatConfigError(parsed.error)}`);
  }
  return { config: parsed.data, path, source };
}
