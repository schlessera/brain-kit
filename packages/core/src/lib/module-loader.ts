import { existsSync } from "fs";
import { dirname, join } from "path";
import { z } from "zod";

import type { BrainConfig } from "./config.js";
import {
  assetTitleRuleSchema,
  propagationRuleSchema,
  repoRelativePathSchema,
  typeSpecSchema,
} from "./config.js";
import type { LoadedModule, ModuleContribution, ModuleManifest } from "./module-types.js";
import { safeResolve } from "./safe-path.js";
import { MODULE_TOOL_LOCAL_NAME, MODULE_TOOL_LOCAL_NAME_MESSAGE, ModuleToolNameError, moduleToolNameIssues } from "./module-tool-names.js";

/**
 * Structural validation of a setup() return value. Functions are checked for
 * shape only; data fields reuse the brain.config schemas so a module cannot
 * contribute what a user config couldn't (escaping dirs, malformed rules).
 * `.strict()` throughout: an unknown key in a contribution is a typo, and
 * silently dropping it would ship a module that half-works.
 */
const contributionSchema = z
  .object({
    taxonomy: z
      .object({
        types: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), typeSpecSchema).optional(),
        classifierHints: z.record(z.string(), z.array(z.string())).optional(),
        assetTitleRules: z.array(assetTitleRuleSchema).optional(),
        propagation: z.array(propagationRuleSchema).optional(),
      })
      .strict()
      .optional(),
    skills: repoRelativePathSchema.optional(),
    instructions: z.object({
      text: z.string().min(1).refine((s) => s.trim().length > 0)
        .refine((s) => !/<!--\s*\/?brain:(?:generated|module-instructions):/.test(s), {
          message: "instruction text must not contain ownership markers",
        }),
    }).strict().optional(),
    commands: z.record(z.string(), z.custom<() => Promise<unknown>>((v) => typeof v === "function")).optional(),
    tools: z.record(
      z.string().regex(MODULE_TOOL_LOCAL_NAME, {
        message: MODULE_TOOL_LOCAL_NAME_MESSAGE,
      }),
      z.custom<() => Promise<unknown>>((v) => typeof v === "function", {
        message: "tool definition loader must be a function",
      }),
      { error: (issue) => issue.code === "invalid_key"
        ? MODULE_TOOL_LOCAL_NAME_MESSAGE
        : undefined },
    ).optional(),
    hygieneChecks: z.array(z.custom<(ctx: unknown) => unknown>((v) => typeof v === "function")).optional(),
    indexRules: z.object({ dirAnchors: z.array(repoRelativePathSchema).optional() }).strict().optional(),
    exclude: z.object({ segments: z.array(z.string()).optional() }).strict().optional(),
    // Cron entries are materialized into a real crontab by container
    // entrypoints — a newline or shell metacharacter in any field would let a
    // module contribute an arbitrary (root) cron line. Constrain them here,
    // where every consumer inherits the guarantee.
    cron: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, {
              message: "cron name must be kebab-case, max 64 chars",
            }),
            schedule: z.string().regex(/^[-0-9*,/ ]{1,100}$/, {
              message: "cron schedule must be a 5-field expression (digits, * , / -)",
            }),
            command: z.string().regex(/^[A-Za-z0-9 _.:=@,\-/]{1,200}$/, {
              message:
                "cron command must be a plain `brain …` argument string (no shell metacharacters)",
            }),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

/**
 * Load the modules declared in brain.config. The `modules:` keys ARE the
 * registry — package names import `<key>/module`, `./local/path` keys import
 * `<root>/<key>/module.ts`. No filesystem scanning; load order = config order.
 *
 * Two-phase per module: validate the user's config block against the
 * manifest's configSchema, call `setup(validatedConfig)`, then validate the
 * returned contribution before it is merged anywhere.
 */
export async function loadModules(
  config: BrainConfig | null,
  root: string
): Promise<LoadedModule[]> {
  const entries = Object.entries(config?.modules ?? {});
  const loaded: LoadedModule[] = [];
  const seenNames = new Set<string>();

  for (const [key, moduleConfig] of entries) {
    const { manifest, dir } = await importManifest(key, root);

    if (seenNames.has(manifest.name)) {
      throw new Error(`Duplicate module name "${manifest.name}" (key: ${key})`);
    }
    seenNames.add(manifest.name);

    // enabled belongs to core, never to a module's strict domain schema.
    let domainConfig: unknown = moduleConfig ?? {};
    let enabled = true;
    if (domainConfig && typeof domainConfig === "object" && !Array.isArray(domainConfig) && Object.hasOwn(domainConfig, "enabled")) {
      const { enabled: flag, ...domain } = domainConfig as Record<string, unknown>;
      if (flag !== undefined) {
        const parsedFlag = z.boolean().safeParse(flag);
        if (!parsedFlag.success) throw new Error(`Invalid enabled flag for module "${manifest.name}": expected a boolean`);
        enabled = parsedFlag.data;
      }
      domainConfig = domain;
    }
    let validated: unknown = domainConfig;
    if (manifest.configSchema) {
      try {
        validated = manifest.configSchema.parse(domainConfig);
      } catch (e) {
        throw new Error(
          `Invalid config for module "${manifest.name}" (key: ${key}): ${(e as Error).message}`
        );
      }
    }

    let contribution: ModuleContribution;
    try {
      contribution = manifest.setup(validated);
    } catch (e) {
      throw new Error(
        `Module "${manifest.name}" setup() failed (key: ${key}): ${(e as Error).message}`
      );
    }

    const tools = contribution?.tools;
    if (tools && typeof tools === "object" && !Array.isArray(tools)) {
      const nameIssues = moduleToolNameIssues(manifest.name, Object.keys(tools));
      if (nameIssues.length > 0) throw new ModuleToolNameError(manifest.name, nameIssues);
    }

    const parsed = contributionSchema.safeParse(contribution);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      throw new Error(`Module "${manifest.name}" contributed an invalid manifest:\n${issues}`);
    }
    if (parsed.data.instructions && !/^[a-z][a-z0-9-]{0,30}$/.test(manifest.name)) {
      throw new Error(`Module "${manifest.name}" instruction owner must match ^[a-z][a-z0-9-]{0,30}$`);
    }

    loaded.push({
      key,
      // Store the VALIDATED output, not the raw contribution, so any schema
      // defaults/normalization actually take effect. (Cast: zod types the
      // z.custom function fields loosely; the values pass through unchanged.)
      manifest: {
        name: manifest.name,
        ...(manifest.canBeDormant !== undefined ? { canBeDormant: manifest.canBeDormant } : {}),
        ...(manifest.dormancyReason !== undefined ? { dormancyReason: manifest.dormancyReason } : {}),
        ...(parsed.data as ModuleContribution),
      },
      dir,
      config: validated,
      state: enabled ? "active" : "dormant",
    });
  }

  return loaded;
}

async function importManifest(
  key: string,
  root: string
): Promise<{ manifest: ModuleManifest; dir: string }> {
  let specifier: string;
  let dir: string;

  if (key.startsWith("./")) {
    // `../` keys are rejected by the config schema, but that check is LEXICAL:
    // a symlink inside the root makes "./link" look clean while pointing
    // anywhere. This is the one config value that leads to import(), so
    // canonicalize it and refuse to execute code from outside the root.
    const base = safeResolve(root, key.slice(2));
    if (!base) {
      throw new Error(
        `Module "${key}" resolves outside the brain root — refusing to load code from there`
      );
    }
    specifier = existsSync(join(base, "module.ts"))
      ? join(base, "module.ts")
      : join(base, "module.js");
    dir = base;
  } else {
    // Package: import "<pkg>/module"; resolve dir from the package's entry.
    specifier = `${key}/module`;
    const entry = Bun.resolveSync(specifier, root);
    dir = packageRootFrom(entry);
  }

  let mod: { default?: ModuleManifest };
  try {
    mod = await import(specifier.startsWith("/") ? specifier : Bun.resolveSync(specifier, root));
  } catch (e) {
    throw new Error(`Cannot load module "${key}": ${(e as Error).message}`);
  }

  const manifest = mod.default;
  if (!manifest || typeof manifest.name !== "string") {
    throw new Error(`Module "${key}" must default-export defineModule({ name, … })`);
  }
  if (typeof manifest.setup !== "function") {
    throw new Error(
      `Module "${key}" uses the legacy flat manifest — move its contributions into ` +
        `defineModule({ name, configSchema, setup: (config) => ({ … }) })`
    );
  }
  if (manifest.canBeDormant !== undefined && typeof manifest.canBeDormant !== "boolean") {
    throw new Error(`Module "${manifest.name}" canBeDormant must be a boolean`);
  }
  if (manifest.dormancyReason !== undefined &&
    (typeof manifest.dormancyReason !== "string" || !manifest.dormancyReason.trim())) {
    throw new Error(`Module "${manifest.name}" dormancyReason must be a non-empty string`);
  }
  return { manifest, dir };
}

/** Walk up from a module entry file to the directory containing package.json. */
function packageRootFrom(entryFile: string): string {
  let dir = dirname(entryFile);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(entryFile);
    dir = parent;
  }
}
