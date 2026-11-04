/**
 * Symlink-safe path containment, held once for core, the ui-sdk and ui-server
 * (#2506). Two parts:
 *
 * - {@link isWithin}, the string question "is this path the root or below
 *   it?". The callers' answers differ on equality, the separator, a root
 *   ending in a separator and normalisation, so those are parameters
 *   ({@link WithinRule}) rather than hidden choices.
 * - {@link resolveContained} and {@link resolveContainedSync}, one
 *   canonicalisation algorithm: resolve the request under the root's
 *   realpath, canonicalise its nearest existing ancestor, and check the
 *   canonical result against the root. A dangling link is either followed
 *   to its target, which must stay inside, or refused. The algorithm is a
 *   generator of filesystem queries, so the synchronous and asynchronous
 *   variants run the same steps.
 *
 * What a caller accepts as a request (absolute paths, `..`, Windows syntax)
 * and how it reports a refusal stay in that caller: they are its policy, and
 * the resolver rows of #2506 differ on them. Everything after the request is
 * accepted is decided here.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** How {@link isWithin} answers the cases its callers disagree on. */
export interface WithinRule {
  /** Whether the root itself counts as within. Default `true`. */
  readonly includeRoot?: boolean;
  /** The separator that must follow the root. Default `/`. */
  readonly separator?: string;
  /**
   * A root already ending in the separator: `"append"` (default) appends
   * another, so `/` and `/a/` hold nothing below them; `"boundary"` takes the
   * root's own separator as the boundary, so `/` holds every absolute path.
   */
  readonly trailingSeparator?: "append" | "boundary";
  /**
   * Resolve both paths against the working directory first, as
   * `path.relative` does, so `/a/b/../c` is not within `/a/b`. Default
   * `false`: the comparison is on the strings as given.
   */
  readonly resolvePaths?: boolean;
}

/** Whether `path` is `root` or below it, under `rule`. The argument order is fixed: root first. */
export function isWithin(root: string, path: string, rule: WithinRule = {}): boolean {
  if (rule.resolvePaths) {
    root = resolve(root);
    path = resolve(path);
  }
  if (path === root) return rule.includeRoot ?? true;
  const separator = rule.separator ?? "/";
  const prefix = rule.trailingSeparator === "boundary" && root.endsWith(separator) ? root : root + separator;
  return path.startsWith(prefix);
}

/** The platform-separator rule the resolvers check canonical paths with. */
const CANONICAL: WithinRule = { separator: sep };

/** What a caller decides about the filesystem it resolves through. */
export interface ContainmentPolicy {
  /**
   * A root whose realpath fails. `"refuse"`: nothing resolves. `"lexical"`:
   * a root that does not exist yet contains the lexical path; a dangling
   * link in its place is refused and any other failure is an error.
   */
  readonly missingRoot: "refuse" | "lexical";
  /**
   * A symlink whose target cannot be resolved. `"follow"`: re-check its
   * target, which must stay inside, so a write through it lands inside.
   * `"refuse"`: refuse it, wherever it points.
   */
  readonly danglingLinks: "follow" | "refuse";
  /**
   * `"final"`: only the canonical path must stay inside, so a request may
   * leave through one link and come back through another. `"every"`: each
   * existing component on the way must stay inside too.
   */
  readonly components: "final" | "every";
  /**
   * Refuse a symlink at this lexical component without following it; `root`
   * is the root's realpath. Only consulted with `components: "every"`,
   * which visits each component.
   */
  readonly refuseLinkAt?: (path: string, root: string) => boolean;
}

/** Why a request was refused. */
export type ContainmentRefusal = "nul" | "missing-root" | "escape" | "dangling" | "link-budget" | "refused-link";

export type ContainedPath =
  | {
    readonly ok: true;
    /** The root's realpath (its lexical path when a missing root is allowed). */
    readonly root: string;
    /** The request resolved under {@link root}, links as written. */
    readonly lexical: string;
    /** The request with every existing link followed; the missing tail as written. */
    readonly canonical: string;
  }
  | { readonly ok: false; readonly reason: ContainmentRefusal }
  /** A filesystem failure that is neither absence nor a refusal (EIO, ...). */
  | { readonly ok: false; readonly reason: "error"; readonly error: NodeJS.ErrnoException };

/**
 * Codes that mean "this component cannot be resolved": the lookup stops
 * there and what follows is treated as not existing yet. Any other code is
 * an error, never an acceptance.
 */
const UNRESOLVABLE = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG", "ELOOP", "EACCES", "EPERM"]);

/** The kernel's symlink budget for one lookup. */
const MAX_LINK_HOPS = 40;

type FsQuery =
  | { readonly op: "realpath" | "readlink"; readonly path: string }
  | { readonly op: "lstat"; readonly path: string };
type FsReply =
  | { readonly ok: true; readonly value: string; readonly link: boolean }
  | { readonly ok: false; readonly error: NodeJS.ErrnoException };
type Steps<T> = Generator<FsQuery, T, FsReply>;

const failed = (error: unknown): FsReply => ({ ok: false, error: error as NodeJS.ErrnoException });
const unresolvable = (reply: FsReply) => !reply.ok && UNRESOLVABLE.has(reply.error.code ?? "");

function querySync(query: FsQuery): FsReply {
  try {
    if (query.op === "lstat") return { ok: true, value: query.path, link: lstatSync(query.path).isSymbolicLink() };
    return { ok: true, value: query.op === "realpath" ? realpathSync(query.path) : readlinkSync(query.path), link: false };
  } catch (error) {
    return failed(error);
  }
}

async function queryAsync(query: FsQuery): Promise<FsReply> {
  try {
    if (query.op === "lstat") return { ok: true, value: query.path, link: (await lstat(query.path)).isSymbolicLink() };
    return { ok: true, value: query.op === "realpath" ? await realpath(query.path) : await readlink(query.path), link: false };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Canonicalise `path` (lexically inside `root`, a realpath): realpath its
 * nearest existing ancestor and re-append the missing tail. A purely lexical
 * fallback would let a symlinked parent smuggle a not-yet-created file
 * outside the root. A dangling link is not "missing": a write through it is
 * created at its target, so it is followed and re-checked, or refused.
 */
function* canonicalise(root: string, path: string, policy: ContainmentPolicy): Steps<ContainedPath> {
  let existing = path;
  let tail: string[] = [];
  let hops = 0;
  for (;;) {
    const real = yield { op: "realpath", path: existing };
    if (real.ok) {
      const candidate = tail.length > 0 ? join(real.value, ...tail) : real.value;
      if (!isWithin(root, candidate, CANONICAL)) return { ok: false, reason: "escape" };
      return { ok: true, root, lexical: path, canonical: candidate };
    }
    if (!unresolvable(real)) return { ok: false, reason: "error", error: real.error };
    const entry = yield { op: "lstat", path: existing };
    if (entry.ok && entry.link) {
      // A link whose realpath fails: dangling, a cycle, or unreadable.
      if (policy.danglingLinks === "refuse") return { ok: false, reason: "dangling" };
      if (++hops > MAX_LINK_HOPS) return { ok: false, reason: "link-budget" };
      const target = yield { op: "readlink", path: existing };
      if (!target.ok) return { ok: false, reason: "error", error: target.error };
      const resolved = isAbsolute(target.value) ? resolve(target.value) : resolve(dirname(existing), target.value);
      const rejoined = tail.length > 0 ? join(resolved, ...tail) : resolved;
      if (!isWithin(root, rejoined, CANONICAL)) return { ok: false, reason: "escape" };
      existing = rejoined;
      tail = [];
      continue;
    }
    if (!entry.ok && !unresolvable(entry)) return { ok: false, reason: "error", error: entry.error };
    // Not there (yet), or there but not resolvable as a whole: canonicalise
    // what is above it. The walk ends at the root, which resolved.
    tail.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) return { ok: false, reason: "escape" };
    existing = parent;
  }
}

function* containedSteps(root: string, rel: string, policy: ContainmentPolicy): Steps<ContainedPath> {
  // A NUL would make the later fs call throw: a containment failure, not a
  // deferred TypeError.
  if (rel.includes("\0")) return { ok: false, reason: "nul" };
  const lexicalRoot = resolve(root);
  const rootReal = yield { op: "realpath", path: lexicalRoot };
  if (!rootReal.ok) {
    if (policy.missingRoot === "refuse") return { ok: false, reason: "missing-root" };
    if (rootReal.error.code !== "ENOENT") return { ok: false, reason: "error", error: rootReal.error };
    // Present but unresolvable means a dangling link stands in its place.
    const entry = yield { op: "lstat", path: lexicalRoot };
    if (entry.ok) return { ok: false, reason: "dangling" };
    if (!unresolvable(entry)) return { ok: false, reason: "error", error: entry.error };
    const lexical = resolve(lexicalRoot, rel);
    if (!isWithin(lexicalRoot, lexical, CANONICAL)) return { ok: false, reason: "escape" };
    // Nothing below a missing root exists to be followed.
    return { ok: true, root: lexicalRoot, lexical, canonical: lexical };
  }
  const absRoot = rootReal.value;
  const lexical = resolve(absRoot, rel);
  if (!isWithin(absRoot, lexical, CANONICAL)) return { ok: false, reason: "escape" };
  if (policy.components === "final") {
    const contained = yield* canonicalise(absRoot, lexical, policy);
    return contained.ok ? { ...contained, lexical } : contained;
  }
  // Each component in order, from the root down: a link refused here is
  // refused before it is followed, and every existing prefix must canonicalise
  // inside, not only the whole path.
  let prefix = absRoot;
  const prefixes = [absRoot];
  for (const segment of relative(absRoot, lexical).split(sep)) {
    if (!segment) continue;
    prefix = join(prefix, segment);
    prefixes.push(prefix);
  }
  let canonical = absRoot;
  for (const path of prefixes) {
    if (policy.refuseLinkAt?.(path, absRoot)) {
      const entry = yield { op: "lstat", path };
      if (entry.ok && entry.link) return { ok: false, reason: "refused-link" };
    }
    const contained = yield* canonicalise(absRoot, path, policy);
    if (!contained.ok) return contained;
    canonical = contained.canonical;
  }
  return { ok: true, root: absRoot, lexical, canonical };
}

/** {@link resolveContained}, synchronously. */
export function resolveContainedSync(root: string, rel: string, policy: ContainmentPolicy): ContainedPath {
  const steps = containedSteps(root, rel, policy);
  let step = steps.next();
  while (!step.done) step = steps.next(querySync(step.value));
  return step.value;
}

/**
 * Resolve `rel` under `root` and check that it stays inside, following
 * symlinks, under the caller's {@link ContainmentPolicy}. Each call reads the
 * filesystem again: the answer describes the moment of the call, so a
 * caller that opens the path later still owns the race between the two.
 */
export async function resolveContained(root: string, rel: string, policy: ContainmentPolicy): Promise<ContainedPath> {
  const steps = containedSteps(root, rel, policy);
  let step = steps.next();
  while (!step.done) step = steps.next(await queryAsync(step.value));
  return step.value;
}
