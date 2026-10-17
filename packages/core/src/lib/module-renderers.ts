import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import type { LoadedModule, ModuleRenderer } from "./module-types.js";
import type { LintFinding } from "./skills/index.js";

export const moduleRendererSchema = z.object({
  fences: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).optional(),
  extensions: z.array(z.string().startsWith(".")).optional(),
  client: z.string().min(1),
  static: z.string().min(1).optional(),
}).strict();

function packageName(dir: string): string | undefined {
  try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name; }
  catch { return undefined; }
}

/** Export specifiers belong to the declaring package, including local packages. */
export function validateRendererSpecifiers(renderers: Record<string, ModuleRenderer> | undefined, dir: string, moduleName: string): void {
  if (!renderers || Object.keys(renderers).length === 0) return;
  const owner = packageName(dir);
  for (const [name, declaration] of Object.entries(renderers)) {
    for (const entry of [declaration.client, declaration.static].filter((value): value is string => value !== undefined)) {
      const subpath = owner && entry.startsWith(owner + "/") ? entry.slice(owner.length + 1) : "";
      if (!owner || !subpath || subpath.split("/").some((part) => !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(part))) {
        throw new Error(`Module "${moduleName}" renderer "${name}" entry "${entry}" must name an export subpath of its own package`);
      }
    }
  }
}

export interface ResolvedModuleRenderer extends ModuleRenderer {
  module: string;
  name: string;
  version: string | null;
}

/** The active, collision-free declarations for core and server consumers. */
export function collectModuleRenderers(modules: LoadedModule[]): ResolvedModuleRenderer[] {
  const claims = new Map<string, string>();
  const result: ResolvedModuleRenderer[] = [];
  for (const mod of modules) {
    if (mod.state === "dormant") continue;
    for (const [name, declaration] of Object.entries(mod.manifest.renderers ?? {})) {
      const owner = `${mod.manifest.name}/${name}`;
      for (const [kind, values] of [["fence", declaration.fences], ["extension", declaration.extensions]] as const) {
        for (const value of new Set(values ?? [])) {
          const key = `${kind}:${value}`;
          const previous = claims.get(key);
          if (["mermaid", "mmd", ".mermaid", ".mmd"].includes(value)) throw new Error(`Renderer ${kind} "${value}" from "${owner}" is reserved for built-in Mermaid`);
          if (previous) throw new Error(`Renderer ${kind} "${value}" collision between "${previous}" and "${owner}"`);
          claims.set(key, owner);
        }
      }
      let version: string | null = null;
      try { version = JSON.parse(readFileSync(join(mod.dir, "package.json"), "utf8")).version ?? null; } catch {}
      result.push({ ...declaration, module: mod.manifest.name, name, version });
    }
  }
  return result;
}

/** Only lint imports trusted author code. Ordinary load lists metadata alone. */
export async function lintModuleRenderers(mod: LoadedModule): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];
  for (const [name, declaration] of Object.entries(mod.manifest.renderers ?? {})) {
    for (const [kind, specifier] of [["client", declaration.client], ["static", declaration.static]] as const) {
      if (!specifier) continue;
      try {
        const entry = Bun.resolveSync(specifier, mod.dir);
        if (kind === "static") {
          const exports = await import(entry);
          if (typeof exports.toStatic !== "function") throw new Error("missing named export toStatic");
        }
      } catch (error) {
        findings.push({ skill: mod.manifest.name, severity: "error", rule: "renderer-export", message: `renderer "${name}" ${kind} entry "${specifier}": ${(error as Error).message}` });
      }
    }
  }
  return findings;
}
