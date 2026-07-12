import { existsSync } from "fs";
import { dirname, join, resolve } from "path";

import type { BrainConfig } from "./config";
import type { LoadedModule, ModuleManifest } from "./module-types";

/**
 * Load the modules declared in brain.config. The `modules:` keys ARE the
 * registry — package names import `<key>/module`, `./local/path` keys import
 * `<root>/<key>/module.ts`. No filesystem scanning; load order = config order.
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

    let validated: unknown = moduleConfig;
    if (manifest.configSchema) {
      try {
        validated = manifest.configSchema.parse(moduleConfig ?? {});
      } catch (e) {
        throw new Error(
          `Invalid config for module "${manifest.name}" (key: ${key}): ${(e as Error).message}`
        );
      }
    }

    loaded.push({ key, manifest, dir, config: validated });
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
