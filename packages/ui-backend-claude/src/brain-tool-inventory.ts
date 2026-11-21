/** Disposable configuration-fact cache. No code from the brain executes on the host. */
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { safeStartupTiming } from "@schlessera/brain-ui-sdk/server";
import type { BrainToolWorkerInput } from "./brain-tool-forwarder.js";

export type BrainInventory = "core-only" | "module-tools" | "unavailable";
export interface BrainInventoryResolution {
  inventory: BrainInventory;
  modules: Array<{ key: string; name: string }>;
}
const CORE_ENTRY = realpathSync(Bun.resolveSync("@schlessera/brain", import.meta.dir));
const MAX_INPUT_BYTES = 16 * 1024 * 1024;

/** Hash actual config bytes, their static local imports, lock/manifest and resolved module inputs. */
export function brainInventoryInputHash(root: string, modules: BrainInventoryResolution["modules"]): string {
  const canonical = realpathSync(root), hash = createHash("sha256"), seen = new Set<string>();
  let bytes = 0;
  const read = (requested: string, optional = false, scan = false): void => {
    const logical = isWithin(canonical, requested) ? relative(canonical, requested) : requested;
    if (seen.has(logical)) return;
    seen.add(logical);
    if (seen.size > 256) throw new Error("brain_bridge_inventory_input_limit");
    let fd: number;
    try { fd = openSync(requested, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") { hash.update(JSON.stringify([logical, "absent"])); return; }
      throw error;
    }
    let content: Buffer;
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.size > BigInt(MAX_INPUT_BYTES - bytes)) throw new Error("brain_bridge_inventory_input_unreadable");
      content = readFileSync(fd); bytes += content.length;
      const after = fstatSync(fd, { bigint: true });
      if (bytes > MAX_INPUT_BYTES || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("brain_bridge_inventory_input_changed");
    } finally { closeSync(fd); }
    hash.update(JSON.stringify([logical, content.length]));
    hash.update(content);
    if (!scan || extname(requested) === ".json") return;
    const source = content.toString("utf8");
    // Unknown runtime-selected dependencies cannot establish a reusable fact.
    if (/\b(?:process|Bun)\.env\b|\bDate\b|Math\.random\s*\(|\b(?:import|require)\s*\(\s*[^\s'"]/.test(source))
      throw new Error("brain_bridge_inventory_dynamic_inputs");
    const loader = /\.[jt]sx$/.test(requested) ? "tsx" : "ts";
    for (const dependency of new Bun.Transpiler({ loader }).scanImports(source)) {
      if (["@schlessera/brain", "@schlessera/brain/module"].includes(dependency.path)) continue;
      if (/^(?:node:)?fs(?:\/promises)?$/.test(dependency.path)) throw new Error("brain_bridge_inventory_dynamic_inputs");
      if (dependency.path.startsWith("node:")) throw new Error("brain_bridge_inventory_dynamic_inputs");
      const target = realpathSync(Bun.resolveSync(dependency.path, dirname(requested)));
      if (target === CORE_ENTRY) continue; // defineConfig/defineModule do not select modules beyond their data.
      if ((dependency.path.startsWith(".") || isAbsolute(dependency.path)) && isWithin(canonical, target)) read(target, false, true);
      else {
        // Installed packages are selected by their package manifest and lockfile.
        // Also hash the entry, without walking the installed dependency tree.
        read(target);
        for (let parent = dirname(target); dirname(parent) !== parent; parent = dirname(parent)) {
          if (existsSync(join(parent, "package.json"))) { read(join(parent, "package.json")); break; }
        }
      }
    }
  };
  for (const name of ["brain.config.ts", "brain.config.json", "package.json", "bun.lock", "bun.lockb"]) read(join(canonical, name), true, name.endsWith(".ts"));
  for (const module of modules) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(module.name)) throw new Error("brain_bridge_inventory_module_name");
    if (module.key.startsWith("./")) {
      const directory = resolve(canonical, module.key);
      if (!isWithin(canonical, directory)) throw new Error("brain_bridge_inventory_module_path");
      read(join(directory, "package.json"), true);
      read(realpathSync(existsSync(join(directory, "module.ts")) ? join(directory, "module.ts") : join(directory, "module.js")), false, true);
    } else {
      const entry = realpathSync(Bun.resolveSync(`${module.key}/module`, canonical));
      read(entry, false, true);
      for (let parent = dirname(entry); dirname(parent) !== parent; parent = dirname(parent)) {
        if (existsSync(join(parent, "package.json"))) { read(join(parent, "package.json")); break; }
      }
    }
    read(join(canonical, "settings", `${module.name}.json`), true);
  }
  return hash.digest("hex");
}

/** Cache only successful facts; unknown input/failed helpers always keep project stdio. */
export function createBrainInventoryCache(run: (input: BrainToolWorkerInput, signal: AbortSignal) => Promise<BrainInventoryResolution>) {
  type Entry = BrainInventoryResolution & { hash: string };
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<Entry | undefined>>();
  return async (input: BrainToolWorkerInput, signal: AbortSignal): Promise<BrainInventory> => {
    const attributes = { cached: false };
    const observed = safeStartupTiming(input.req.startupTiming)?.start("brain_tool_inventory", attributes);
    try {
      signal.throwIfAborted();
      const owner = realpathSync(input.brainPath), root = input.startupView?.root ?? input.brainPath;
      const previous = entries.get(owner), modules = previous?.modules ?? [];
      const boundary = JSON.stringify({ profile: input.sandbox?.profile, masks: input.sandbox?.providerMasks && {
        folders: input.sandbox.providerMasks.folders, visible: input.sandbox.providerMasks.visible,
      } });
      const inputHash = (selected: BrainInventoryResolution["modules"]) => createHash("sha256")
        .update(brainInventoryInputHash(root, selected)).update(boundary).digest("hex");
      const before = inputHash(modules);
      if (previous?.hash === before) { attributes.cached = true; return previous.inventory; }
      const pendingKey = `${owner}:${before}`;
      let work = pending.get(pendingKey);
      if (!work) {
        work = (async () => {
          let result = await run(input, signal);
          if (result.inventory === "unavailable" || inputHash(modules) !== before) return undefined;
          const hash = inputHash(result.modules);
          // When new module sources were not in the first key, prove a positive
          // fact again with those sources included before reusing it.
          if (result.inventory === "core-only" && JSON.stringify(result.modules) !== JSON.stringify(modules)) {
            const confirmed = await run(input, signal);
            if (JSON.stringify(confirmed) !== JSON.stringify(result) || inputHash(result.modules) !== hash) return undefined;
            result = confirmed;
          }
          const entry = { ...result, hash };
          entries.delete(owner); entries.set(owner, entry);
          if (entries.size > 128) entries.delete(entries.keys().next().value!);
          return entry;
        })();
        pending.set(pendingKey, work);
        void work.finally(() => pending.delete(pendingKey)).catch(() => {});
      }
      const result = await work;
      signal.throwIfAborted();
      return result?.inventory ?? "unavailable";
    } catch { return "unavailable"; }
    finally { observed?.(); }
  };
}
