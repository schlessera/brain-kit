import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { z } from "zod";

import type { BrainConfig } from "./config";
import {
  assetTitleRuleSchema,
  propagationRuleSchema,
  repoRelativePathSchema,
  typeSpecSchema,
} from "./config";
import type { LoadedModule, ModuleContribution, ModuleManifest } from "./module-types";

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
    commands: z.record(z.string(), z.custom<() => Promise<unknown>>((v) => typeof v === "function")).optional(),
    hygieneChecks: z.array(z.custom<(ctx: unknown) => unknown>((v) => typeof v === "function")).optional(),
    indexRules: z.object({ dirAnchors: z.array(repoRelativePathSchema).optional() }).strict().optional(),
    exclude: z.object({ segments: z.array(z.string()).optional() }).strict().optional(),
    cron: z
      .array(
        z.object({ name: z.string(), schedule: z.string(), command: z.string() }).strict()
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

    let validated: unknown = moduleConfig ?? {};
    if (manifest.configSchema) {
      try {
        validated = manifest.configSchema.parse(moduleConfig ?? {});
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

    const parsed = contributionSchema.safeParse(contribution);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      throw new Error(`Module "${manifest.name}" contributed an invalid manifest:\n${issues}`);
    }

    loaded.push({
      key,
      manifest: { name: manifest.name, ...contribution },
      dir,
      config: validated,
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

  if (key.startsWith("./") || key.startsWith("../")) {
    const base = resolve(root, key);
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
