import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { z } from "zod";

import { resolveEnv } from "../config/env.js";

import type { AgentRunner, CompletionProvider, EmbeddingProvider, Reranker } from "./seams.js";
import { SCRATCH_DIR } from "./scratch.js";
import { MERGE_STRATEGIES } from "./sync/types.js";

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
    /**
     * Search recency half-life in days: a doc of this type loses half its
     * recency boost per half-life. Defaults to `staleDays`, else 365.
     */
    halfLifeDays: z.number().int().positive().optional(),
    /** This type's dir is the capture inbox (`brain add` default target). */
    inbox: z.boolean().optional(),
    /** Exempt from the orphan (no wiki-links) audit check. */
    orphanExempt: z.boolean().optional(),
    /**
     * `brain add` content titled exactly after an existing document of this
     * type appends into that document instead of creating a new file.
     */
    appendMatch: z.boolean().optional(),
    /**
     * How `brain sync` merges a document of this type that both sides
     * changed. Unset → chosen from the file itself: `_index.md` is
     * `table-union`, a `## Timeline` heading is `timeline-append`, anything
     * else `synthesize`.
     */
    mergeStrategy: z.enum(MERGE_STRATEGIES).optional(),
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

/**
 * Capturing groups in a regex source, counted by what an empty match reports.
 * The source is compiled as it is first: wrapped, a malformed pattern such
 * as `a)|(b` would turn valid and count as one group.
 */
function captureGroups(source: string): number {
  new RegExp(source, "i");
  return new RegExp(`(?:${source})|`, "i").exec("")!.length - 1;
}

/**
 * How a keyed fact is restated in prose: the canonical document whose
 * `facts:` frontmatter holds the value, and the patterns that find a
 * restatement. Each pattern is a case-insensitive regex with exactly one
 * capture group, the value.
 */
export const factRuleSchema = z
  .object({
    /** The canonical document (exact path) whose `facts:` map holds the value. */
    source: repoRelativePathSchema,
    patterns: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type FactRule = z.infer<typeof factRuleSchema>;

const factsConfigSchema = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "a fact key is a letter, then letters, digits, _ or -"), factRuleSchema)
  .superRefine((facts, ctx) => {
    for (const [key, rule] of Object.entries(facts)) {
      rule.patterns.forEach((pattern, i) => {
        let groups: number;
        try {
          groups = captureGroups(pattern);
        } catch (e) {
          ctx.addIssue({
            code: "custom",
            path: [key, "patterns", i],
            message: `fact "${key}": pattern ${JSON.stringify(pattern)} is not a valid regular expression (${(e as Error).message})`,
          });
          return;
        }
        if (groups !== 1) {
          ctx.addIssue({
            code: "custom",
            path: [key, "patterns", i],
            message: `fact "${key}": pattern ${JSON.stringify(pattern)} must have exactly one capture group for the value, not ${groups}`,
          });
        }
      });
    }
  });

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

/** A tag as `brain validate` wants it: lowercase, no spaces. */
const tagNameSchema = z
  .string()
  .min(1)
  .refine((t) => t === t.toLowerCase() && !/\s/.test(t), "a tag is lowercase with no spaces");

const tagsConfigSchema = z
  .object({
    /** The tags the owner means to use. When set, `brain tags` and `brain validate` report the others. */
    vocabulary: z.array(tagNameSchema).optional(),
    /** Old tag → canonical tag. */
    aliases: z
      .record(tagNameSchema, tagNameSchema)
      .refine((a) => Object.entries(a).every(([from, to]) => from !== to), "an alias cannot map a tag to itself")
      .optional(),
    /** Report tags that repeat the document's type or a directory of its path. */
    redundant: z.enum(["warn", "off"]).optional(),
    /** Group English singular/plural pairs; "off" for a non-English vocabulary. */
    inflection: z.enum(["en", "off"]).optional(),
  })
  .strict();

export type TagsConfig = z.infer<typeof tagsConfigSchema>;

const taxonomyConfigSchema = z
  .object({
    types: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), typeSpecSchema).optional(),
    /** Anchor files a directory wiki-link resolves to, in order. */
    dirAnchors: z.array(repoRelativePathSchema).optional(),
    /** Well-known documents (identity, currentFocus, …). Features degrade gracefully when unset or missing. Empty string disables an entry. */
    canonical: z.record(z.string(), z.union([z.literal(""), repoRelativePathSchema])).optional(),
    /**
     * Per canonical key: a size budget and a review cadence `brain audit`
     * checks. Merged field by field over DEFAULT_CANONICAL_POLICY; `null`
     * unsets a default.
     */
    canonicalPolicy: z
      .record(
        z.string(),
        z
          .object({
            /** Estimated tokens above which the document is a `budget` issue. */
            maxTokens: z.number().int().positive().nullable().optional(),
            /** Days after `updated` at which the document is `review-overdue`. */
            reviewDays: z.number().int().positive().max(3650).nullable().optional(),
          })
          .strict()
      )
      .optional(),
    propagation: z.array(propagationRuleSchema).optional(),
    /**
     * Keyed facts `brain audit` checks for drift: each names its canonical
     * document (whose `facts:` frontmatter holds the value) and the patterns
     * that find a restatement of it elsewhere.
     */
    facts: factsConfigSchema.optional(),
    assetTitleRules: z.array(assetTitleRuleSchema).optional(),
    /** type → keyword/phrase list; compiled to word-boundary regexes for heuristic classification. */
    classifierHints: z.record(z.string(), z.array(z.string())).optional(),
    defaultStaleness: z
      .object({ days: z.number().int().positive(), severity: severitySchema })
      .strict()
      .optional(),
    /** Tag vocabulary and hygiene rules for `brain tags` and `brain validate`. */
    tags: tagsConfigSchema.optional(),
  })
  .strict();

export type TaxonomyConfig = z.infer<typeof taxonomyConfigSchema>;

const excludeConfigSchema = z
  .object({
    dirs: z.array(z.string()).optional(),
    files: z.array(z.string().refine((path) => !path.endsWith("/"), {
      error: (issue) => `exact file exclusion ${JSON.stringify(issue.input)} must not end in /; use exclude.dirs for a directory`,
    })).optional(),
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
const rerankerValue = z.custom<Reranker>(
  (v) => !!v && typeof v === "object" && typeof (v as Reranker).rerank === "function",
  { message: "expected a Reranker implementation" }
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
        /** Env var holding the key for the built-in `provider` (default: its own). */
        apiKeyEnv: z.string().min(1).optional(),
        /** Env var holding the key for the built-in `fallback` (default: its own). */
        fallbackApiKeyEnv: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    agentRunner: z.union([z.string(), agentRunnerValue]).optional(),
    /**
     * Search reranking. Model judgments require `enabled: true` (default off).
     * `provider`: "jev" (default; needs its key, else lifecycle ordering), "heuristic" (lifecycle factors
     * only), "none", or a Reranker value. `exclude` lists paths (prefixes or
     * globs) a network reranker never receives; they keep their retrieval
     * rank. `depth`, `skipMargin` and `timeoutMs` bound the call.
     */
    reranker: z
      .object({
        enabled: z.boolean().optional(),
        provider: z.union([z.string(), rerankerValue]).optional(),
        model: z.string().optional(),
        apiKeyEnv: z.string().optional(),
        exclude: z.array(z.string()).optional(),
        timeoutMs: z.number().int().positive().optional(),
        depth: z.number().int().min(2).optional(),
        skipMargin: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
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
     * Warn levels for the health figures `brain stats` reports. Ratios in
     * 0..1; a missing key falls back to DEFAULT_STATS_THRESHOLDS. Staleness
     * and orphan rules are NOT here — they live on the type spec (staleDays,
     * orphanExempt) and `brain stats` reads them the way `brain audit` does.
     */
    stats: z
      .object({
        /** Embedding coverage (vec_chunks / chunks) below this ratio needs attention. */
        coverageFloor: z.number().min(0).max(1).optional(),
        /** Broken-link rate (broken / links) above this ratio needs attention. */
        brokenLinkCeiling: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    /**
     * What `brain sync assess` and `brain doctor` treat as media, and how big a
     * tracked file may get. Missing keys fall back to DEFAULT_MEDIA_POLICY.
     */
    media: z
      .object({
        /** A file over this many bytes is LARGE in `sync assess`, and a warning in `brain doctor`. */
        maxTrackedBytes: z.number().int().positive().optional(),
        /** Globs that are always TRACK in `sync assess` (`*` matches any run; a glob without `/` matches the file name). */
        track: z.array(z.string().min(1)).optional(),
        /** Globs that are always ARTIFACT in `sync assess`. */
        ignore: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    /** What the installed git hooks do beyond their free default. */
    hooks: z
      .object({
        /**
         * The post-commit hook also runs the embeddings pass, in the
         * background, when an embedding provider is configured: paid calls
         * for every chunk without a vector (on the first commit after opting
         * in, the whole backlog, not only the changed chunks), plus chunk
         * contexts and asset descriptions when completions are set up. Off by
         * default, so a commit never bills unless the brain opts in.
         */
        embedOnCommit: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** How full-text search reads text. */
    search: z
      .object({
        /**
         * The language the full-text index and its query builder assume.
         * `english` (the default): the Porter stemmer and English stopwords.
         * `none`: no stemming and no stopwords, for a brain in another
         * language. Changing it rebuilds the full-text index on the next
         * `brain index`; nothing is re-embedded.
         */
        language: z.enum(["english", "none"]).optional(),
      })
      .strict()
      .optional(),
    /**
     * The always-loaded instruction weight `brain doctor` checks: CLAUDE.md
     * with its `@` imports, AGENTS.md, and model-invocable skill descriptions.
     * A missing key falls back to DEFAULT_INSTRUCTIONS_MAX_TOKENS.
     */
    instructions: z
      .object({
        /** Estimated tokens above which `brain doctor` warns. */
        maxTokens: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    /** How `brain sync` resolves what git cannot. */
    sync: z
      .object({
        /**
         * Who answers the judgments a merge or an unclassified file needs.
         * `jev` (the default): TypeSafe's classifier, when `TYPESAFE_API_KEY`
         * is set; without the key, or on any failure, the conservative
         * default applies. `off`: always the conservative default.
         */
        judge: z.enum(["jev", "off"]).optional(),
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
  identity: { dir: "me", halfLifeDays: 1095, mergeStrategy: "latest-wins-additive" },
  context: { dir: "context", staleDays: 30, staleSeverity: "warning", orphanExempt: true, halfLifeDays: 30 },
  note: { dir: "notes", inbox: true, halfLifeDays: 60, mergeStrategy: "keep-both" },
  index: { dir: null, orphanExempt: true, halfLifeDays: 365, mergeStrategy: "table-union" },
};

export const DEFAULT_EXCLUDE = {
  // SCRATCH_DIR: the scratch area is never content (#310). The dot already
  // hides it from the markdown glob; the entry keeps every `isExcludedPath`
  // caller (MCP listing, stats, OKF export) agreeing on it too.
  // evals: a retrieval query set measures search only if search cannot see
  // it, and a note beside the set quoting its queries would answer them.
  dirs: [".git", "node_modules", ".claude", ".agents", "scripts", "logs", "tmp", "workspaces", "okf-dist", SCRATCH_DIR, "evals"],
  files: ["CLAUDE.md", "README.md", "AGENTS.md"],
  segments: [] as string[],
};

export const DEFAULT_DIR_ANCHORS = ["_index.md"];

export const DEFAULT_STALENESS = { days: 180, severity: "info" as const };

/** Warn levels `brain stats` applies when the `stats` config block is absent. */
export const DEFAULT_STATS_THRESHOLDS = { coverageFloor: 0.9, brokenLinkCeiling: 0.05 };

/** `instructions.maxTokens` when absent: the shipped contract (~850) plus a generous overlay. */
export const DEFAULT_INSTRUCTIONS_MAX_TOKENS = 8000;

/** Where the canonical policy lives when a config sets none: the focus document stays short. */
export const DEFAULT_CANONICAL_POLICY: Record<string, { maxTokens?: number; reviewDays?: number }> = {
  currentFocus: { maxTokens: 1000 },
};

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
  const { brainRoot } = resolveEnv();
  if (brainRoot) return resolve(brainRoot);

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
  /** null when no config file exists. Not the same as uninitialized — see `isPersonalized`. */
  config: BrainConfig | null;
  /** Absolute path of the loaded file, or null. */
  path: string | null;
  source: "ts" | "json" | null;
}

/**
 * Has anyone said anything about THIS brain, or is the config still the empty
 * starter the template ships?
 *
 * The template's `brain.config.ts` is a teaching file: every field is
 * commented out, so it parses to `{}`. Testing for the file's existence
 * therefore reported every brand-new brain as already set up, and
 * `/brain-init` took its amend-mode branch on a brain that had never been
 * through the interview (#74).
 *
 * The test is "declares any key at all" rather than a list of the fields that
 * count. A list would have to be extended every time the schema grows, and the
 * failure of forgetting is silent — a personalized brain read as pristine.
 * Nothing in the schema carries a zod default, so an empty config parses to an
 * empty object and this stays true.
 *
 * Note what it does NOT mean: `brain init --default` writes core defaults and
 * deliberately leaves a brain unpersonalized, because nobody has answered the
 * interview yet.
 */
export function isPersonalized(config: BrainConfig | null): boolean {
  return config !== null && Object.keys(config).length > 0;
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
