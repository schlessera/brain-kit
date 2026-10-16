import { createHmac } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import type { StorageFileEntry, StorageRoot, StorageSnapshot, StorageOwner, StorageBytes } from "@schlessera/brain-ui-sdk/protocol";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import { serverMetadata, coreMetadata } from "./process.js";
import type { MetadataEntry, MetadataRoot } from "./metadata.js";
export const STORAGE_SERVER_LIMITS = Object.freeze({ entries: 100_000, page: 200, roots: 32, milliseconds: 35_000, cacheBytes: 96 * 1024 * 1024 });
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const coreInventory = z.object({ schema_version: z.literal(1), status: z.enum(["complete", "partial", "unsupported"]),
  roots: z.array(z.object({ id: z.string(), kind: z.enum(["brain", "git"]), path: z.string().max(4096) })).max(65),
  entries: z.array(z.object({ rootId: z.string(), path: z.string().max(16384), kind: z.enum(["file", "directory", "symlink", "special"]), objectId: z.string(), version: z.string(), logicalBytes: bytes, allocatedBytes: bytes, links: z.number().int().nonnegative() })).max(100_000),
  errors: z.array(z.object({ reason: z.string().max(128) })).max(100), omittedErrors: z.number().int().nonnegative(),
});
export interface StorageStore { path: string; label: string; category: StorageRoot["category"]; owner: StorageOwner; recursive: boolean; optional?: boolean }
export interface StorageCollection { summary: StorageSnapshot; entries: StorageFileEntry[]; bytes: number }
export interface StorageCollectOptions {
  brainPath: string; stores: StorageStore[]; gitRoots?: string[];
  /** Unknown private owner stores are explicit rows, never scans of host /tmp or broker state. */
  unavailable?: Array<{ label: string; category: StorageRoot["category"]; owner: StorageOwner; reason: string }>;
  salt: string;
}
const validPath = (path: string) => path === "" || (!path.startsWith("/") && path.split("/").every(piece => piece !== "." && piece !== ".." && piece !== "") && !path.includes("\0"));
export function storageTotals(entries: readonly Pick<StorageFileEntry, "objectId" | "kind" | "logical" | "allocated">[], complete = true): StorageBytes {
  if (!entries.length && !complete) return { logical: null, allocated: null, coverage: "unknown" };
  const seen = new Set<string>(); let logical = 0n, allocated = 0n, hasLogical = true, hasAllocation = true;
  for (const entry of entries) {
    if (seen.has(entry.objectId)) continue;
    seen.add(entry.objectId);
    if (entry.kind === "file") { if (entry.logical === null) hasLogical = false; else logical += BigInt(entry.logical); }
    if (entry.allocated === null) hasAllocation = false; else allocated += BigInt(entry.allocated);
  }
  const safe = (value: bigint) => value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return { logical: hasLogical ? safe(logical) : null, allocated: hasAllocation ? safe(allocated) : null, coverage: complete && hasLogical && hasAllocation ? "complete" : "partial" };
}
export async function collectStorage(options: StorageCollectOptions, id: string, signal: AbortSignal): Promise<StorageCollection> {
  const startedAt = Date.now(), key = (value: string) => createHmac("sha256", options.salt).update(value).digest("hex").slice(0, 32);
  const roots: StorageRoot[] = [], errors: StorageSnapshot["errors"] = [], entries: StorageFileEntry[] = [];
  let omittedErrors = 0;
  const failedRoots = new Set<string>();
  const fail = (rootId: string, reason: string) => { failedRoots.add(rootId); if (errors.length < 100) errors.push({ rootId, reason }); else omittedErrors++; };
  const root = (identity: string, label: string, category: StorageRoot["category"], owner: StorageOwner) => {
    const id = key(`root:${identity}`); let found = roots.find(item => item.id === id);
    if (!found) { found = { id, label, category, owner, logical: null, allocated: null, coverage: "unknown", reason: null }; roots.push(found); }
    return found;
  };
  const brain = root("brain", "Brain files", "content", "brain");
  const sources = new Map<string, { root: StorageRoot; path: string; recursive: boolean; optional?: boolean }>();
  const rawEntries: MetadataEntry[] = [];
  const coreRootMappings = new Map<string, { path: string; root: StorageRoot }>();
  try {
    const raw = coreInventory.parse(await coreMetadata(options.brainPath, options.gitRoots ?? [], signal));
    if (raw.status !== "complete") fail(brain.id, "core-inventory-partial");
    for (const value of raw.errors) fail(brain.id, value.reason);
    omittedErrors += raw.omittedErrors;
    for (const item of raw.roots) {
      if (sources.size >= 16) { fail(brain.id, "core-root-budget"); break; }
      const view = item.kind === "brain" ? brain : root(`git:${item.path}`, "Git store", "git", "brain");
      coreRootMappings.set(item.id, { path: resolve(item.path), root: view });
      sources.set(view.id, { root: view, path: item.path, recursive: false });
    }
    if (raw.status !== "complete") for (const mapped of coreRootMappings.values()) if (mapped.root.id !== brain.id) fail(mapped.root.id, "core-inventory-partial");
    for (const item of raw.entries) {
      const mapped = coreRootMappings.get(item.rootId);
      if (!mapped || !validPath(item.path)) { fail(brain.id, "core-entry-unavailable"); continue; }
      let view = mapped.root, path = item.path;
      if (view.id === brain.id) {
        // Core reports its Git root separately, so collapse the canonical in-tree alias.
        const git = [...coreRootMappings.values()].find(value => value.root.category === "git" && resolve(options.brainPath, path) === value.path);
        if (git) { view = git.root; path = ""; }
        else {
          const containing = [...coreRootMappings.values()].find(value => value.root.category === "git" && resolve(options.brainPath, path).startsWith(`${value.path}/`));
          if (containing) { view = containing.root; path = resolve(options.brainPath, path).slice(containing.path.length + 1); }
        }
        if (view.id === brain.id) {
          for (const [prefix, label, category, owner] of [
            [".git", "Git metadata", "git", "brain"], [SHARE_STAGING_DIR, "Upload staging", "staging", "app"], [".brain/scratch", "Scratch", "scratch", "brain"], ["workspaces", "Workspaces", "workspace", "brain"],
          ] as const) if (path === prefix || path.startsWith(`${prefix}/`)) { view = root(prefix, label, category, owner); sources.set(view.id, { root: view, path: resolve(options.brainPath, prefix), recursive: false, optional: true }); path = path.slice(prefix.length).replace(/^\//, ""); break; }
          if (/^brain\.db(?:-wal|-shm|-journal)?$/.test(path)) { view = root("index", "Content index", "index", "brain"); sources.set(view.id, { root: view, path: options.brainPath, recursive: false }); }
        }
      }
      rawEntries.push({ rootId: view.id, path, kind: item.kind, object: item.objectId, version: item.version, device: item.objectId.split(":")[0], logical: item.logicalBytes, allocated: item.allocatedBytes, links: item.links });
    }
  } catch { fail(brain.id, signal.aborted ? "cancelled" : "storage-reader-unavailable-or-incompatible"); }
  const appSources: MetadataRoot[] = [];
  for (const store of options.stores) {
    if (roots.length >= STORAGE_SERVER_LIMITS.roots - (options.unavailable?.length ?? 0)) { fail("", "root-budget"); break; }
    const view = root(`store:${store.path}`, store.label, store.category, store.owner);
    const source = { root: view, path: store.path, recursive: store.recursive, optional: store.optional };
    sources.set(view.id, source); appSources.push({ id: view.id, ...source });
  }
  const probes: MetadataRoot[] = [...sources.values()].filter(source => !appSources.some(item => item.id === source.root.id)).map(source => ({ id: source.root.id, path: source.path, recursive: false, optional: source.optional }));
  const capacities: StorageSnapshot["capacities"] = [];
  const capacityByRoot = new Map<string, string>();
  try {
    const measured = await serverMetadata([...appSources, ...probes], signal, Math.max(1, STORAGE_SERVER_LIMITS.entries - rawEntries.length));
    for (const error of measured.errors) fail(error.rootId, error.reason);
    omittedErrors += measured.omittedErrors;
    if (measured.omittedErrors) for (const source of sources.values()) fail(source.root.id, "metadata-errors-omitted");
    const appIds = new Set(appSources.map(item => item.id));
    rawEntries.push(...measured.entries.filter(item => appIds.has(item.rootId)));
    for (const value of measured.capacities) {
      const capacityId = key(value.identity ? `fs:${value.filesystem}:${value.identity}` : `unknown:${value.rootId}`);
      capacityByRoot.set(value.rootId, capacityId);
      const previous = capacities.find(item => item.id === capacityId);
      if (previous) { if (!previous.rootIds.includes(value.rootId)) previous.rootIds.push(value.rootId); continue; }
      capacities.push({ id: capacityId, rootIds: [value.rootId], total: value.total, used: value.used, free: value.free, available: value.available,
        provenance: "statfs", kind: value.filesystem === String(0x01021994) ? "tmpfs" : value.reason === "overlay-capacity-unknown" ? "unknown" : "filesystem", identity: value.identity ? "resolved" : "unknown", quota: null, measured: null, other: null, reason: value.reason ?? "shared-extent-partition-unknown" });
    }
  } catch { for (const source of sources.values()) fail(source.root.id, signal.aborted ? "cancelled" : "metadata-unavailable"); }
  if ((options.unavailable?.length ?? 0) > STORAGE_SERVER_LIMITS.roots - roots.length) fail("", "root-budget");
  for (const unavailable of (options.unavailable ?? []).slice(0, STORAGE_SERVER_LIMITS.roots - roots.length)) { const view = root(`unavailable:${unavailable.label}`, unavailable.label, unavailable.category, unavailable.owner); view.reason = unavailable.reason; fail(view.id, unavailable.reason); }
  const representedRoots = new Set(rawEntries.filter(value => value.path === "").map(value => value.rootId));
  const ids = new Set<string>(), objects = new Map<string, string>();
  const versions = new Map<string, { version: string; rootId: string }>();
  for (const value of rawEntries) {
    if (entries.length >= STORAGE_SERVER_LIMITS.entries) { fail(value.rootId, "entry-budget"); break; }
    const entryId = key(`${value.rootId}:${value.path}`);
    if (ids.has(entryId)) continue;
    ids.add(entryId);
    const objectId = key(`object:${value.object}`), first = objects.get(objectId);
    const observed = versions.get(objectId);
    if (observed && observed.version !== value.version) { fail(value.rootId, "object-changed-during-scan"); fail(observed.rootId, "object-changed-during-scan"); }
    versions.set(objectId, { version: value.version, rootId: value.rootId });
    objects.set(objectId, first ?? entryId);
    entries.push({ id: entryId, parentId: value.path && (dirname(value.path) !== "." || representedRoots.has(value.rootId)) ? key(`${value.rootId}:${dirname(value.path) === "." ? "" : dirname(value.path)}`) : null,
      rootId: value.rootId, path: value.path, name: value.path ? basename(value.path) : roots.find(item => item.id === value.rootId)?.label ?? "Store",
      kind: value.kind, objectId, version: key(`version:${value.version}`), capacityId: capacityByRoot.get(value.rootId) ?? null, aliasOf: first ?? null,
      logical: value.logical, allocated: value.allocated, links: value.links,
      references: { state: "unchecked", count: null, observedAt: null, unchecked: ["indexed links", "unindexed files", "external consumers"] } });
  }
  entries.sort((a, b) => a.rootId.localeCompare(b.rootId) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const view of roots) {
    const values = entries.filter(entry => entry.rootId === view.id), issue = errors.find(error => error.rootId === view.id || !error.rootId) ?? (failedRoots.has(view.id) || failedRoots.has("") ? { reason: "additional-errors-omitted" } : undefined);
    if (!values.length && issue) { view.reason ??= issue.reason; continue; }
    Object.assign(view, storageTotals(values, !issue), { reason: issue?.reason ?? view.reason });
  }
  const ownerOf = new Map(roots.map(view => [view.id, view.owner]));
  const total = (owner: StorageOwner) => storageTotals(entries.filter(entry => ownerOf.get(entry.rootId) === owner), roots.filter(view => view.owner === owner).every(view => view.coverage === "complete"));
  const observedAt = Date.now();
  const summary: StorageSnapshot = { id, startedAt, observedAt, staleAfter: observedAt + 60_000, coverage: errors.length ? "partial" : "complete", consistency: "live-observation",
    basis: "512 * st_blocks; shared extents may be charged more than once", roots, capacities, totals: { all: storageTotals(entries, errors.length === 0), brain: total("brain"), app: total("app"), operator: total("operator") }, entries: entries.length, errors, omittedErrors };
  const size = Buffer.byteLength(JSON.stringify({ summary, entries }));
  if (size > STORAGE_SERVER_LIMITS.cacheBytes / 2) throw Error("cache-budget");
  return { summary, entries, bytes: size };
}
