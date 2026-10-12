/** Read the actual host-owned mount sources; never evaluates repository code. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readlinkSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { nativeFileVersionFromFd, type NativeFileVersion } from "./native-file-versions.js";

export interface ObservedWorkerFile { key: string; version: NativeFileVersion }
interface Source { worker: string; host: string; rel: string }
const within = (path: string, root: string) => path === root || path.startsWith(root + "/");
const EMPTY: NativeFileVersion = { status: "known", hash: createHash("sha256").update("").digest("hex") };

/** Sources come only from the launcher's resolved mounts, and live only until worker exit. */
export function createWorkerFileObserver(options: {
  brain: string; configurationRoot: string; areas: readonly Source[]; maskPaths?: readonly string[];
}): (workerPath: string) => ObservedWorkerFile | undefined {
  const sources = [...options.areas, { worker: options.brain, host: options.configurationRoot, rel: "" }].sort((a, b) => b.worker.length - a.worker.length);
  return requested => {
    let path = isAbsolute(requested) ? resolve(requested) : resolve(options.brain, requested);
    const originalSource = sources.find(item => within(path, item.worker));
    if (!originalSource) return undefined;
    const key = [originalSource.rel, relative(originalSource.worker, path)].filter(Boolean).join("/");
    for (let links = 0; links <= 40; links++) {
      const source = sources.find(item => within(path, item.worker));
      if (!source) return undefined;
      const suffix = relative(source.worker, path);
      const canonical = resolve(options.brain, source.rel, suffix);
      // A null mask is a view of no bytes, not a host read of its secret source.
      if (/^\.env(?:\.|$)/.test(relative(options.brain, canonical).split("/")[0] ?? "") || options.maskPaths?.some(mask => within(canonical, mask))) return { key, version: EMPTY };
      const fds: number[] = [];
      try {
        let fd = openSync(source.host, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); fds.push(fd);
        const parts = suffix.split("/").filter(Boolean);
        if (!parts.length) return { key, version: { status: "unavailable" } };
        let restart = false;
        for (let index = 0; index < parts.length; index++) {
          const name = parts[index]!, at = `/proc/self/fd/${fd}/${name}`;
          try {
            const next = openSync(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (index + 1 < parts.length ? constants.O_DIRECTORY : 0));
            fds.push(next);
            if (index + 1 === parts.length) return { key, version: nativeFileVersionFromFd(next) };
            if (!fstatSync(next).isDirectory()) return { key, version: { status: "unavailable" } };
            fd = next;
          } catch (error) {
            // Read links through the held parent and resolve them in the WORKER
            // graph, so an absolute brain link in a strict copy stays frozen.
            try {
              const link = readlinkSync(at);
              path = resolve(source.worker, ...parts.slice(0, index), link, ...parts.slice(index + 1));
              restart = true; break;
            } catch {
              return { key, version: { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable" } };
            }
          }
        }
        if (!restart) return { key, version: { status: "unavailable" } };
      } catch { return { key, version: { status: "unavailable" } }; }
      finally { for (const fd of fds.reverse()) closeSync(fd); }
    }
    return undefined;
  };
}
