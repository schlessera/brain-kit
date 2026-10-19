/** One alias resolver, driven synchronously by the host or asynchronously by its owned stage. */
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { isEnvName } from "./protected-paths.js";

export type EnvMaskMetadata = { kind: "directory" | "file" | "symlink" | "other"; target?: string };
export type EnvMaskQuery = { operation: "list" | "stat"; path: string };
type Reply = string[] | EnvMaskMetadata | undefined;
const within = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`);

/** No contents are read. Queries preserve the worker's names through held input aliases. */
export function* maintenanceEnvMaskQueries(source: string, brain: string,
  copies: readonly { from: string; to: string }[] = []): Generator<EnvMaskQuery, string[], Reply> {
  const argv: string[] = [], covered = new Set<string>();
  const originalName = (path: string) => {
    const copy = copies.find(copy => within(copy.to, path));
    return copy ? copy.from + path.slice(copy.to.length) : path;
  };
  const inspectedName = (path: string) => {
    const original = originalName(path);
    return within(brain, original) ? source + original.slice(brain.length) : original;
  };
  function* target(path: string, links = 0): Generator<EnvMaskQuery, { path: string; info: EnvMaskMetadata } | undefined, Reply> {
    if (links > 40) return undefined;
    const parts = path.split("/"); let current = "/";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (!part || part === ".") continue;
      if (part === "..") { current = dirname(current); continue; }
      const next = current === "/" ? `/${part}` : `${current}/${part}`;
      if (copies.some(copy => next !== copy.to && within(next, copy.to))) { current = next; continue; }
      const info = (yield { operation: "stat", path: inspectedName(next) }) as EnvMaskMetadata | undefined;
      if (!info) return undefined;
      if (info.kind === "symlink") {
        const link = info.target!;
        return yield* target(`${isAbsolute(link) ? link : `${current}/${link}`}/${parts.slice(i + 1).join("/")}`, links + 1);
      }
      current = next;
    }
    const info = (yield { operation: "stat", path: inspectedName(current) }) as EnvMaskMetadata | undefined;
    return info ? { path: current, info } : undefined;
  }
  const names = (yield { operation: "list", path: source }) as string[];
  for (const name of names) {
    if (!isEnvName(name)) continue;
    const resolved = yield* target(`${brain}/${name}`);
    if (!resolved) continue;
    const original = originalName(resolved.path), destinations = new Set([resolved.path, original]);
    for (const copy of copies) if (within(copy.from, original)) destinations.add(copy.to + original.slice(copy.from.length));
    for (const destination of destinations) {
      if (covered.has(destination)) continue;
      covered.add(destination);
      if (resolved.info.kind === "directory") argv.push("--tmpfs", destination, "--remount-ro", destination);
      else argv.push("--ro-bind", "/dev/null", destination);
    }
  }
  return argv;
}
export function hostEnvMaskQuery(query: EnvMaskQuery): Reply {
  if (query.operation === "list") return readdirSync(query.path);
  const info = lstatSync(query.path, { throwIfNoEntry: false });
  if (!info) return undefined;
  return info.isSymbolicLink() ? { kind: "symlink", target: readlinkSync(query.path) }
    : { kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other" };
}
export function maintenanceEnvMasks(source: string, brain: string, copies: readonly { from: string; to: string }[] = []): string[] {
  const plan = maintenanceEnvMaskQueries(source, brain, copies); let step = plan.next();
  while (!step.done) step = plan.next(hostEnvMaskQuery(step.value));
  return step.value;
}
