/** Host-owned raw snapshots for the turn journal; never evaluates repository code. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import ignore, { type Ignore } from "ignore";
export interface JournalSnapshotEntry {
  path: string;
  scope: string;
  kind: "file" | "symlink" | "other";
  mode: number;
  bytes: number;
  /** Host-only identity/cache facts; ignored changes are detectable without retaining their contents. */
  stamp: string;
  hash?: string;
  target?: string;
  ignored: boolean;
}
export interface JournalSnapshot {
  entries: JournalSnapshotEntry[];
  missing: { path: string; reason: string }[];
}

/** The store streams a checked regular descriptor, reserving disk before writing. */
export interface JournalSnapshotObjects {
  putFile(fd: number, size: number): string;
  has(hash: string): boolean;
}

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
const failure = (error: unknown) => (error as NodeJS.ErrnoException).code ?? (error as { reason?: string }).reason ?? "unreadable";
const stamp = (info: import("node:fs").BigIntStats) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;

type Rules = { path: string; matcher: Ignore }[];

/** Every instance freezes its own turn-start rules; the hash cache may be shared by host observations. */
export function createJournalWalker(brain: string, store: JournalSnapshotObjects, coveredPaths: readonly string[] = []) {
  const cache = new Map<string, { stamp: string; hash: string }>();
  const scopeRules = new Map<string, Rules>();
  const initiallyCovered = new Set<string>(coveredPaths);
  let started = false;

  function ignored(rules: Rules, path: string, directory: boolean): boolean {
    let result = false;
    for (const rule of rules) {
      if (rule.path && !path.startsWith(`${rule.path}/`)) continue;
      const local = rule.path ? path.slice(rule.path.length + 1) : path;
      const match = rule.matcher.test(local + (directory ? "/" : ""));
      if (match.ignored) result = true;
      else if (match.unignored) result = false;
    }
    return result;
  }

  function take(): JournalSnapshot {
    if (process.platform !== "linux") throw new Error("Raw journal snapshots require Linux descriptor paths.");
    const result: JournalSnapshot = { entries: [], missing: [] };
    const root = openSync(brain, DIRECTORY);
    const recordMissing = (path: string, error: unknown) => { result.missing.push({ path, reason: failure(error) }); };

    function file(fd: number, name: string, path: string, scope: string, rules: Rules, refs = false, parentIgnored = false): void {
      const full = at(fd, name);
      try {
        const info = lstatSync(full, { bigint: true });
        const skip = !refs && !initiallyCovered.has(path) && (parentIgnored || ignored(rules, scope ? path.slice(scope.length + 1) : path, false));
        const entry: JournalSnapshotEntry = { path, scope, mode: Number(info.mode & 0o7777n), bytes: Number(info.size), stamp: stamp(info), ignored: skip, kind: "other" };
        if (info.isSymbolicLink()) {
          entry.kind = "symlink"; entry.target = readlinkSync(full);
        } else if (info.isFile()) {
          entry.kind = "file";
          if (!skip) {
            const known = cache.get(path), observedStamp = stamp(info);
            if (known?.stamp === observedStamp && store.has(known.hash)) {
              entry.hash = known.hash;
              result.entries.push(entry); initiallyCovered.add(path); return;
            }
            const handle = openSync(full, FILE);
            try {
              const before = fstatSync(handle, { bigint: true });
              if (!before.isFile()) throw Object.assign(new Error("not a regular file"), { code: "changed_type" });
              const key = stamp(before), prior = cache.get(path);
              entry.bytes = Number(before.size); entry.mode = Number(before.mode & 0o7777n); entry.stamp = key;
              entry.hash = prior?.stamp === key && store.has(prior.hash) ? prior.hash : store.putFile(handle, entry.bytes);
              if (stamp(fstatSync(handle, { bigint: true })) !== key) throw Object.assign(new Error("file changed during capture"), { code: "changed_during_capture" });
              cache.set(path, { stamp: key, hash: entry.hash });
            } finally { closeSync(handle); }
          }
        }
        result.entries.push(entry);
        if (!skip) initiallyCovered.add(path);
      } catch (error) { recordMissing(path, error); }
    }

    function walk(fd: number, rel: string, scope: string, rules: Rules, depth: number, freeze: boolean, refs = false, parentIgnored = false): void {
      if (depth > 256) { recordMissing(rel || scope, Object.assign(new Error("directory depth"), { code: "depth_limit" })); return; }
      if (freeze && !refs) {
        try {
          const handle = openSync(at(fd, ".gitignore"), FILE);
          try {
            const info = fstatSync(handle);
            if (!info.isFile()) throw Object.assign(new Error("ignore is not regular"), { code: "invalid_ignore" });
            // Ignore data must remain bounded before allocation; refusal is explicit, never silently skipped.
            if (info.size > 1024 * 1024) throw Object.assign(new Error("ignore rules too large"), { code: "ignore_size" });
            rules.push({ path: rel, matcher: ignore().add(readFileSync(handle, "utf8")) });
          } finally { closeSync(handle); }
        } catch (error) { if (failure(error) !== "ENOENT") recordMissing([scope, rel, ".gitignore"].filter(Boolean).join("/"), error); }
      }
      let names: string[];
      try { names = readdirSync(at(fd, ".")); } catch (error) { recordMissing([scope, rel].filter(Boolean).join("/"), error); return; }
      for (const name of names.sort()) {
        const local = rel ? `${rel}/${name}` : name, path = scope ? `${scope}/${local}` : local;
        if (!refs && name === ".git") continue;
        if (!refs && !scope && !rel && name === "workspaces") continue;
        try {
          const info = lstatSync(at(fd, name));
          if (info.isDirectory()) {
            // Opening through the parent's descriptor refuses any intervening link swap.
            const child = openSync(at(fd, name), DIRECTORY);
            try { walk(child, local, scope, rules, depth + 1, freeze, refs, parentIgnored || (!refs && ignored(rules, local, true))); } finally { closeSync(child); }
          } else file(fd, name, path, scope, rules, refs, parentIgnored);
        } catch (error) { recordMissing(path, error); }
      }
    }

    function snapshotScope(fd: number, scope: string): void {
      const freeze = !started;
      const rules = scopeRules.get(scope) ?? [];
      walk(fd, "", scope, rules, 0, freeze);
      scopeRules.set(scope, rules);
      // Git is data here: read only HEAD, packed refs and refs; never config, attributes or objects.
      let git: number | undefined;
      try {
        git = openSync(at(fd, ".git"), DIRECTORY);
        for (const name of ["HEAD", "packed-refs"]) {
          if (lstatSync(at(git, name), { throwIfNoEntry: false })) file(git, name, [scope, ".git", name].filter(Boolean).join("/"), scope, [], true);
        }
        if (lstatSync(at(git, "refs"), { throwIfNoEntry: false })) {
          const refs = openSync(at(git, "refs"), DIRECTORY);
          try { walk(refs, ".git/refs", scope, [], 0, false, true); } finally { closeSync(refs); }
        }
      } catch (error) { if (failure(error) !== "ENOENT") recordMissing([scope, ".git"].filter(Boolean).join("/"), error); }
      finally { if (git !== undefined) closeSync(git); }
    }

    try {
      snapshotScope(root, "");
      let workspaces: number | undefined;
      try {
        workspaces = openSync(at(root, "workspaces"), DIRECTORY);
        for (const name of readdirSync(at(workspaces, ".")).sort()) {
          const path = `workspaces/${name}`;
          try {
            const info = lstatSync(at(workspaces, name));
            if (!info.isDirectory()) { file(workspaces, name, path, path, [], false); continue; }
            const workspace = openSync(at(workspaces, name), DIRECTORY);
            try { snapshotScope(workspace, path); } finally { closeSync(workspace); }
          } catch (error) { recordMissing(path, error); }
        }
      } catch (error) { if (failure(error) !== "ENOENT") recordMissing("workspaces", error); }
      finally { if (workspaces !== undefined) closeSync(workspaces); }
    } finally { closeSync(root); }
    result.entries.sort((a, b) => a.path.localeCompare(b.path));
    return result;
  }
  return {
    cover(paths: readonly string[]): void { for(const path of paths) initiallyCovered.add(path); },
    begin(): JournalSnapshot { if (started) throw new Error("journal walk already started"); const snapshot = take(); started = true; return snapshot; },
    observe(): JournalSnapshot { if (!started) throw new Error("journal walk not started"); return take(); },
  };
}
