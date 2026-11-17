/**
 * What the four media review actions do to files, references and config
 * (#2781, epic #1777, design rev 4 §5-§7): Delete, Move, Persist here and
 * Keep a permanent copy. Planning reads only; applying writes only what the
 * plan named, after its premise is recomputed and matches.
 *
 * Capture, compensation and Undo are not here. They belong to the caller
 * that holds the bounded change journal (the UI server): it retains every
 * pre-image a plan lists *before* it asks for the apply, and restores per
 * file from those retained versions, only where a file still holds what
 * this apply wrote. So an apply never compensates by itself, and the CLI
 * refuses to apply without the caller's `--journal` identity. The one thing
 * it cleans up is its own private `.part` copy.
 *
 * No all-file atomicity is claimed. Each step is checked against the
 * plan's expected version before it writes, and a step that cannot proceed
 * stops the apply with the files written so far, for the caller to
 * compensate.
 */
import { createHash } from "crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, statfsSync, unlinkSync, writeSync,
} from "fs";
import { posix } from "path";

import { canonicalFindings, type HygieneFinding } from "./hygiene.js";
import { caseFold } from "./case-fold.js";
import { mediaPolicyClass, type MediaPolicy } from "./media.js";
import { planMediaPolicyEdit, MediaConfigNotLiteral, readMediaPolicyLists, type MediaPolicyEdit } from "./media-config-edit.js";
import { mediaMatches, patternRefusal, patternScope, type MediaMatches } from "./media-matches.js";
import { buildMediaInventory, mediaCandidates, SCRATCH_PREFIX, type MediaInventory, type MediaItem } from "./media-inventory.js";
import { MEDIA_PROBE_BYTES, probeMediaHead, type MediaProbe } from "./media-probe.js";
import { DEFAULT_MEDIA_REFERENCE_LIMITS, noteReferences, type MediaReference, type MediaReferenceLimits } from "./media-references.js";
import { SENSITIVE_PATTERNS } from "./sync/assess.js";
import { matchesAnyPattern } from "./tool-leftovers.js";
import { writeFileSafely } from "./safe-path.js";

export const MEDIA_ACTIONS = ["delete", "move", "persist", "keep-copy"] as const;
export type MediaAction = (typeof MEDIA_ACTIONS)[number];

/** Where the share flow stages files (`SHARE_STAGING_DIR` in the UI SDK); its owner, not review, decides them. */
export const SHARE_STAGING_PREFIX = ".brain-ui/inbox/";
/** Destinations that are not a final location: protected state and agent-writable workspaces. */
const NOT_FINAL = [".brain/", ".brain-ui/", ".brain-index/", ".brain-cache/", ".git/", "workspaces/", "context/hygiene/", "node_modules/"];
const MAX_TARGET = 4096;

/** One file or directory an effect writes, in apply order. `before`/`after` are SHA-256, `directory`, or null for absent. */
export interface MediaEffectFile {
  path: string;
  role: "source" | "destination" | "note" | "config" | "directory";
  before: string | null;
  after: string | null;
  /** Bytes of the pre-image the caller must retain (0 when there is none). */
  bytes: number;
}

export interface MediaRefusal {
  code: string;
  path?: string;
  line?: number;
  limit?: string;
  effective?: number;
  observed?: number;
}

export interface MediaRewrite {
  note: string;
  line: number;
  kind: MediaReference["kind"];
  before: string;
  after: string;
}

export interface MediaEffectPlan {
  status: "preview";
  id: string;
  action: MediaAction;
  fingerprint: string;
  source: { path: string; sha256: string; bytes: number; kind: "content" | "scratch" | "share-staged" };
  destination: string | null;
  /** Conversation links: `linked` with a count, `unlinked`, or `unknown` when the pin snapshot cannot say. */
  links: { state: "linked" | "unlinked" | "unknown"; conversations: number };
  /** Whether every declared reference was checked; a refused scan is never "no references". */
  references: { complete: boolean; count: number };
  rewrites: MediaRewrite[];
  /** References a Move cannot rewrite, and a Delete will break. */
  blockers: Array<{ note: string; line: number; kind: MediaReference["kind"]; target: string }>;
  configDiff: { path: string; track: { before: string[]; after: string[] }; ignore: { before: string[]; after: string[] } } | null;
  /**
   * The config change's scope (rev 4 §7): `exact` adds one full path,
   * `pattern` a broader rule; null when no config change is planned.
   */
  scope: "exact" | "pattern" | null;
  /** The `media.track` entry the change adds, or null. */
  pattern: string | null;
  /** A broader `media.ignore` entry the change removes so the entry can win (M1 A), or null. */
  ignoreAdjust: string | null;
  /**
   * What a broader change does to the files sync sees now: the added track
   * entry's matches, and the removed ignore entry's. Null for an exact change.
   */
  matches: { track: MediaMatches; ignore: MediaMatches | null } | null;
  /**
   * Set when the change is broader than this one file: the approval binds
   * the config SHA-256, the diff and every match, and apply needs it back
   * (`stale-approval` otherwise). The host binds the principal.
   */
  approvalDigest: string | null;
  /** Bytes the caller must retain before any write: removed or overwritten pre-images. */
  captureBytes: number;
  copy: { bytes: number; sha256: string; diskFreeAdvisory: number | null } | null;
  /**
   * The source's dimensions and duration from one anchored read of its first
   * 64 KiB (rev 5 §9), each null when its header does not say; null when the
   * file cannot be read. Descriptive only: not part of the premise.
   */
  media: MediaProbe | null;
  /** The class sync gives the file where it ends up: `TRACK` is committed, null still awaits review. */
  resultClass: "TRACK" | "ARTIFACT" | null;
  files: MediaEffectFile[];
  premiseDigest: string;
  refusals: MediaRefusal[];
}

export interface MediaEffectFileResult extends MediaEffectFile {
  state: "created" | "changed" | "removed" | "unchanged";
}

export interface MediaEffectResult {
  /**
   * `applied`: every step wrote and the result verified. `stale`/`refused`:
   * nothing was written. `interrupted`: a step failed after earlier ones
   * wrote; the caller compensates `files` from its retained pre-images.
   */
  status: "applied" | "stale" | "refused" | "interrupted";
  id: string;
  action: MediaAction;
  journal: string | null;
  reason?: string;
  refusals?: MediaRefusal[];
  files: MediaEffectFileResult[];
  /** For a copy: the SHA-256 the copy was verified to hold. */
  copySha256?: string;
}

export interface MediaEffectRequest {
  id: string;
  action: MediaAction;
  expectFingerprint: string;
  destination?: string;
  /** Persist here or a copy's tracking by a broader `media.track` rule that matches the file (rev 4 §7). */
  pattern?: string;
  /** The one broader `media.ignore` entry to remove so the track entry wins (M1 A). */
  ignoreAdjust?: string;
}

export interface MediaEffectContext {
  root: string;
  policy: MediaPolicy;
  /** Repo-relative config path, or null without a config. */
  configPath: string | null;
  /** The Q1 bounds this plan enforces (`rewrittenNotes`, `preview`); the scan's own come with the inventory. */
  limits?: MediaReferenceLimits;
  /** Tests inject the inventory; otherwise it is built afresh. */
  inventory?: MediaInventory;
  /**
   * Tests only: run inside Keep a permanent copy's copy step, after each
   * chunk is written to the private `.part` and just before it is published,
   * to change the source or the destination at exactly that moment.
   */
  copyHooks?: { afterChunk?: () => void; beforePublish?: () => void };
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const digest = (value: unknown) => sha256(JSON.stringify(value));

// ---------------------------------------------------------------------------
// Descriptor-anchored file access (Linux): every component is opened
// O_DIRECTORY|O_NOFOLLOW from the root, so no symlink is ever followed.

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;

class Unsafe extends Error {
  constructor(readonly code: string, readonly path: string) { super(`${code}: ${path}`); }
}

/** Open `dir` (repo-relative, "" for the root) anchored at `root`; with `create`, missing components are made and reported. */
function openDir(root: string, dir: string, create?: string[]): number {
  let fd = openSync(root, DIRECTORY);
  const parts = dir === "" ? [] : dir.split("/");
  try {
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      let next: number;
      try {
        next = openSync(at(fd, name), DIRECTORY);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" || !create) throw new Unsafe(code === "ENOENT" ? "missing" : "not-contained", parts.slice(0, i + 1).join("/"));
        mkdirSync(at(fd, name), { mode: 0o755 });
        create.push(parts.slice(0, i + 1).join("/"));
        next = openSync(at(fd, name), DIRECTORY);
      }
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** SHA-256 of a regular file reached without following any link, or null when it is absent. Anything else is unsafe. */
export function anchoredSha256(root: string, path: string): string | null {
  const dir = posix.dirname(path) === "." ? "" : posix.dirname(path), name = posix.basename(path);
  let parent: number;
  try {
    parent = openDir(root, dir);
  } catch (e) {
    if (e instanceof Unsafe && e.code === "missing") return null;
    throw e;
  }
  try {
    const info = lstatSync(at(parent, name), { throwIfNoEntry: false });
    if (!info) return null;
    if (!info.isFile()) throw new Unsafe("not-contained", path);
    const fd = openSync(at(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
      let read: number;
      while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
      return hash.digest("hex");
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(parent);
  }
}

/** A regular file's bytes, reached without following any link. */
export function readAnchored(root: string, path: string, max = Infinity): Buffer {
  const parent = openDir(root, posix.dirname(path) === "." ? "" : posix.dirname(path));
  try {
    const fd = openSync(at(parent, posix.basename(path)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new Unsafe("not-contained", path);
      const chunks: Buffer[] = [], buffer = Buffer.alloc(64 * 1024);
      let read: number, total = 0;
      // With `max`, only the file's first `max` bytes are read.
      while (total < max && (read = readSync(fd, buffer, 0, Math.min(buffer.length, max - total), null)) > 0) { chunks.push(Buffer.from(buffer.subarray(0, read))); total += read; }
      return Buffer.concat(chunks);
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(parent);
  }
}

// ---------------------------------------------------------------------------
// Planning

function validPath(path: string): boolean {
  return path !== "" && Buffer.byteLength(path) <= MAX_TARGET && !path.startsWith("/") && !/[\\\u0000-\u001f\u007f]/u.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** The source's owner and conversation links, from the inventory's pin snapshot. */
function sourceKind(item: MediaItem, inventory: MediaInventory) {
  const kind: MediaEffectPlan["source"]["kind"] = item.path.startsWith(SHARE_STAGING_PREFIX) ? "share-staged" : item.path.startsWith(SCRATCH_PREFIX) ? "scratch" : "content";
  const links: MediaEffectPlan["links"] = item.pins.length > 0 ? { state: "linked", conversations: item.pins.length }
    : kind === "scratch" && inventory.links.state !== "complete" ? { state: "unknown", conversations: 0 } : { state: "unlinked", conversations: 0 };
  return { kind, links };
}

/** The availability matrix (rev 4 §4.2): the first refusal for this action on this source, or null. */
function eligibility(action: MediaAction, kind: MediaEffectPlan["source"]["kind"], links: MediaEffectPlan["links"]): MediaRefusal | null {
  if (kind === "share-staged") return { code: "share-staged" };
  if (action === "persist" && kind === "scratch") return { code: "not-final-location" };
  if (action === "move" && kind === "scratch") {
    if (links.state === "linked") return { code: "pinned-scratch" };
    if (links.state === "unknown") return { code: "pins-unknown" };
  }
  if (action === "keep-copy" && (kind !== "scratch" || links.state === "unlinked")) return { code: "not-linked-scratch" };
  return null;
}

/** Destination guards (rev 4 §5.2, §6): contained, final, absent, no sibling that differs only by case or normalization, no secret name. */
function destinationChecks(root: string, destination: string, source: string): { refusal: MediaRefusal | null; created: string[] } {
  if (!validPath(destination)) return { refusal: { code: "not-contained", path: destination }, created: [] };
  if (NOT_FINAL.some((p) => destination.startsWith(p))) return { refusal: { code: "not-final-location", path: destination }, created: [] };
  if (destination === source) return { refusal: { code: "exists", path: destination }, created: [] };
  if (matchesAnyPattern(destination, SENSITIVE_PATTERNS)) return { refusal: { code: "secret-name", path: destination }, created: [] };
  const parts = destination.split("/"), name = parts.pop()!;
  // Walk what exists of the parent chain; the rest would be created.
  const created: string[] = [];
  let existing = "";
  for (let i = 0; i < parts.length; i++) {
    const rel = parts.slice(0, i + 1).join("/");
    const info = lstatSync(posix.join(root, rel), { throwIfNoEntry: false });
    if (!info) { for (let j = i; j < parts.length; j++) created.push(parts.slice(0, j + 1).join("/")); break; }
    if (!info.isDirectory()) return { refusal: { code: "not-contained", path: rel }, created: [] };
    existing = rel;
  }
  if (created.length === 0) {
    const info = lstatSync(posix.join(root, destination), { throwIfNoEntry: false });
    if (info) return { refusal: { code: "exists", path: destination }, created: [] };
    const fold = (s: string) => caseFold(s.normalize("NFC"));
    for (const sibling of readdirSync(posix.join(root, existing || "."))) {
      if (sibling !== name && fold(sibling) === fold(name)) return { refusal: { code: "name-collision", path: posix.join(existing, sibling) }, created: [] };
    }
  }
  return { refusal: null, created };
}

/** The new destination text for one rewritable reference, keeping its style; null to leave it as it is. */
function rewriteTarget(ref: MediaReference, destination: string): string | null {
  if (ref.kind === "wiki" || ref.kind === "embed") {
    // A bare name matches by basename: it still does when the name is kept.
    if (!ref.target.includes("/") && posix.basename(destination) === ref.target) return null;
    return destination;
  }
  const raw = ref.target;
  const cut = raw.search(/[?#]/);
  const pathPart = cut < 0 ? raw : raw.slice(0, cut), suffix = cut < 0 ? "" : raw.slice(cut);
  let decoded = pathPart;
  try { decoded = decodeURI(pathPart); } catch { /* written literally */ }
  const encoded = decoded !== pathPart;
  let next = pathPart.startsWith("/") ? `/${destination}` : posix.relative(posix.dirname(ref.note), destination);
  if (encoded || /[\s()<>]/.test(next)) next = encodeURI(next);
  return next + suffix;
}

function configFormat(path: string): "ts" | "json" {
  return path.endsWith(".json") ? "json" : "ts";
}

/**
 * The config change that makes `target` TRACK (rev 4 §7, M1 A), or why it
 * cannot be made here: already tracked needs none; without a `pattern`, a
 * root-level name or a `*` has no exact form (`not-expressible`). A
 * `pattern` is a broader rule and must match `target`. An ignore entry other
 * than this exact path is removed only when it is the one entry named as
 * `ignoreAdjust`; several conflicting entries always refuse, named.
 */
function trackEdit(target: string, policy: MediaPolicy, rule: { pattern?: string; ignoreAdjust?: string } = {}): { edit: MediaPolicyEdit | null; refusal: MediaRefusal | null } {
  const refuse = (code: string, path: string) => ({ edit: null, refusal: { code, path } });
  if (rule.pattern !== undefined) {
    const invalid = patternRefusal(rule.pattern);
    if (invalid) return refuse(invalid, rule.pattern);
    if (!matchesAnyPattern(target, [rule.pattern])) return refuse("pattern-mismatch", rule.pattern);
  }
  const ignores = policy.ignore.filter((p) => matchesAnyPattern(target, [p]));
  if (ignores.length === 0 && mediaPolicyClass(target, policy) === "TRACK") {
    return rule.ignoreAdjust === undefined ? { edit: null, refusal: null } : refuse("ignore-adjust-unneeded", rule.ignoreAdjust);
  }
  if (rule.pattern === undefined && (!target.includes("/") || target.includes("*"))) return refuse("not-expressible", target);
  let removeIgnore: string | undefined;
  if (ignores.length === 1 && (ignores[0] === target || ignores[0] === rule.ignoreAdjust)) removeIgnore = ignores[0];
  else if (ignores.length > 0) return refuse("ignore-adjustment-required", ignores.join("\n"));
  if (rule.ignoreAdjust !== undefined && removeIgnore !== rule.ignoreAdjust) return refuse("ignore-adjust-unneeded", rule.ignoreAdjust);
  return { edit: { addTrack: rule.pattern ?? target, ...(removeIgnore !== undefined ? { removeIgnore } : {}) }, refusal: null };
}

/** The policy an edit leaves. */
const editedPolicy = (policy: MediaPolicy, edit: MediaPolicyEdit): MediaPolicy => ({
  ...policy,
  track: policy.track.includes(edit.addTrack!) ? policy.track : [...policy.track, edit.addTrack!],
  ignore: policy.ignore.filter((p) => p !== edit.removeIgnore),
});

/** The media finding `id` names, with its inventory item, or null when it is not detected. */
function mediaFinding(ctx: MediaEffectContext, inventory: MediaInventory, id: string): { finding: HygieneFinding; item: MediaItem } | null {
  const finding = canonicalFindings(mediaCandidates(inventory)).get(id);
  const item = finding ? inventory.items.find((i) => i.path === finding.path) : undefined;
  return finding && item ? { finding, item } : null;
}

/** Plan `request` against the brain as it is now. Reads only. */
export function planMediaEffect(ctx: MediaEffectContext, request: MediaEffectRequest): MediaEffectPlan | { status: "stale" | "refused"; id: string; action: MediaAction; reason: string; refusals: MediaRefusal[] } {
  const { root, policy } = ctx;
  const limits = ctx.limits ?? DEFAULT_MEDIA_REFERENCE_LIMITS;
  const inventory = ctx.inventory ?? buildMediaInventory(root, policy);
  const found = mediaFinding(ctx, inventory, request.id);
  const base = { id: request.id, action: request.action };
  if (!found) return { ...base, status: "refused", reason: "not-detected", refusals: [{ code: "not-detected" }] };
  if (found.finding.fingerprint !== request.expectFingerprint) return { ...base, status: "stale", reason: "stale-fingerprint", refusals: [{ code: "stale" }] };
  const { finding, item } = found;
  const { kind, links } = sourceKind(item, inventory);
  const refusals: MediaRefusal[] = [];
  const add = (r: MediaRefusal | null) => { if (r) refusals.push(r); };
  add(eligibility(request.action, kind, links));
  if (item.sha256 === "unreadable") add({ code: "source-changed", path: item.path });

  const scan = inventory.references;
  const refs = scan.status === "complete" ? scan.references.get(item.path) ?? [] : [];
  if (scan.status === "refused" && request.action !== "delete") {
    const r = scan.refusal;
    add(r.code === "inventory-too-large" ? { code: r.code, limit: r.limit, effective: r.effective, observed: r.observed } : { code: r.code, path: r.path });
  }

  const needsDestination = request.action === "move" || request.action === "keep-copy";
  let destination: string | null = null, created: string[] = [];
  if (needsDestination) {
    if (!request.destination) add({ code: "destination-required" });
    else {
      destination = request.destination;
      const checked = destinationChecks(root, destination, item.path);
      add(checked.refusal);
      created = checked.created;
    }
  } else if (request.destination !== undefined) add({ code: "destination-unexpected" });
  const rule = { ...(request.pattern !== undefined ? { pattern: request.pattern } : {}), ...(request.ignoreAdjust !== undefined ? { ignoreAdjust: request.ignoreAdjust } : {}) };
  if ((request.pattern !== undefined || request.ignoreAdjust !== undefined) && request.action !== "persist" && request.action !== "keep-copy") add({ code: "pattern-unexpected" });

  const rewrites: MediaRewrite[] = [], blockers: MediaEffectPlan["blockers"] = [];
  const files: MediaEffectFile[] = [];
  for (const ref of refs) {
    if (!ref.rewritable) { blockers.push({ note: ref.note, line: ref.line, kind: ref.kind, target: ref.target }); continue; }
    if (request.action !== "move" || !destination) continue;
    const after = rewriteTarget(ref, destination);
    if (after === null) continue;
    if (Buffer.byteLength(after) > MAX_TARGET) add({ code: "ref-unsupported", path: ref.note, line: ref.line });
    rewrites.push({ note: ref.note, line: ref.line, kind: ref.kind, before: ref.target, after });
  }
  if (request.action === "move") for (const b of blockers) add({ code: "ref-unsupported", path: b.note, line: b.line });

  // Config for Persist here, and for a copy that sync must keep.
  let configDiff: MediaEffectPlan["configDiff"] = null, configFile: MediaEffectFile | null = null;
  let change: Pick<MediaEffectPlan, "scope" | "pattern" | "ignoreAdjust" | "matches" | "approvalDigest"> = { scope: null, pattern: null, ignoreAdjust: null, matches: null, approvalDigest: null };
  const tracked = request.action === "persist" ? item.path : request.action === "keep-copy" ? destination : null;
  let resultClass: MediaEffectPlan["resultClass"] = request.action === "delete" ? null : mediaPolicyClass(destination ?? item.path, policy);
  if (tracked && refusals.length === 0) {
    const { edit, refusal } = trackEdit(tracked, policy, rule);
    add(refusal);
    if (edit) {
      if (!ctx.configPath || !validPath(ctx.configPath)) add({ code: "config-not-literal" });
      else {
        try {
          const before = readAnchored(root, ctx.configPath);
          const text = before.toString("utf8");
          const planned = planMediaPolicyEdit(text, configFormat(ctx.configPath), edit);
          const lists = readMediaPolicyLists(text, configFormat(ctx.configPath));
          configDiff = { path: ctx.configPath, track: { before: lists.track, after: planned.lists.track }, ignore: { before: lists.ignore, after: planned.lists.ignore } };
          configFile = { path: ctx.configPath, role: "config", before: sha256(before), after: sha256(planned.text), bytes: before.length };
          const edited = editedPolicy(policy, edit);
          resultClass = mediaPolicyClass(tracked, edited);
          const broaderIgnore = edit.removeIgnore !== undefined && edit.removeIgnore !== tracked ? edit.removeIgnore : null;
          change = { scope: edit.addTrack === tracked && patternScope(tracked) === "exact" ? "exact" : "pattern", pattern: edit.addTrack!, ignoreAdjust: broaderIgnore, matches: null, approvalDigest: null };
          // A change broader than this one file is shown with its current matches and approved as a whole (rev 3 §5.2-§5.4).
          if (change.scope === "pattern" || broaderIgnore !== null) {
            const matches = { track: mediaMatches(root, edit.addTrack!, policy, edited), ignore: broaderIgnore === null ? null : mediaMatches(root, broaderIgnore, policy, edited) };
            change.matches = matches;
            change.approvalDigest = digest({ config: configFile.before, diff: configDiff, matches: [matches.track.digest, matches.ignore?.digest ?? null] });
          }
        } catch (e) {
          add({ code: e instanceof MediaConfigNotLiteral ? "config-not-literal" : "config-invalid", path: ctx.configPath });
        }
      }
    }
  }

  // Notes a Move rewrites: each one's current and planned bytes.
  const byNote = new Map<string, MediaRewrite[]>();
  for (const r of rewrites) byNote.set(r.note, [...(byNote.get(r.note) ?? []), r]);
  if (byNote.size > limits.rewrittenNotes) add({ code: "inventory-too-large", limit: "rewrittenNotes", effective: limits.rewrittenNotes, observed: byNote.size });

  if (refusals.length === 0) {
    if (request.action === "delete") files.push({ path: item.path, role: "source", before: item.sha256, after: null, bytes: item.bytes });
    if (request.action === "move" || request.action === "keep-copy") {
      for (const dir of created) files.push({ path: dir, role: "directory", before: null, after: "directory", bytes: 0 });
      files.push({ path: destination!, role: "destination", before: null, after: item.sha256, bytes: 0 });
    }
    if (request.action === "move") {
      files.push({ path: item.path, role: "source", before: item.sha256, after: null, bytes: item.bytes });
      for (const note of [...byNote.keys()].sort()) {
        try {
          const before = readAnchored(root, note);
          const after = rewriteNote(note, before.toString("utf8"), item.path, destination!);
          if (after === null) { add({ code: "stale", path: note }); continue; }
          files.push({ path: note, role: "note", before: sha256(before), after: sha256(after), bytes: before.length });
        } catch {
          add({ code: "inventory-unscannable", path: note });
        }
      }
    }
    if (configFile) files.push(configFile);
  }

  let diskFreeAdvisory: number | null = null;
  if (request.action === "keep-copy") {
    try { const s = statfsSync(root); diskFreeAdvisory = Number(s.bavail) * Number(s.bsize); } catch { diskFreeAdvisory = null; }
  }
  const plan: MediaEffectPlan = {
    status: "preview",
    id: request.id,
    action: request.action,
    fingerprint: finding.fingerprint,
    source: { path: item.path, sha256: item.sha256, bytes: item.bytes, kind },
    destination,
    links,
    references: { complete: scan.status === "complete", count: refs.length },
    rewrites,
    blockers,
    configDiff,
    ...change,
    captureBytes: files.reduce((n, f) => n + (f.role === "directory" || f.before === null ? 0 : f.bytes), 0),
    copy: request.action === "keep-copy" ? { bytes: item.bytes, sha256: item.sha256, diskFreeAdvisory } : null,
    media: probeSource(root, item.path),
    resultClass,
    files: refusals.length === 0 ? files : [],
    premiseDigest: "",
    refusals,
  };
  // The premise binds everything apply depends on: the finding, every file's
  // expected bytes, the pins and the media policy (rev 4 §6).
  plan.premiseDigest = digest({ id: plan.id, action: plan.action, fingerprint: plan.fingerprint, destination, files: plan.files, pins: item.pins, links, policy: { track: policy.track, ignore: policy.ignore }, approval: plan.approvalDigest });
  const size = Buffer.byteLength(JSON.stringify(plan));
  if (size > limits.preview) {
    return { ...base, status: "refused", reason: "inventory-too-large", refusals: [{ code: "inventory-too-large", limit: "preview", effective: limits.preview, observed: size }] };
  }
  return plan;
}

/** The source's header facts, or null when it cannot be read where it was planned. */
function probeSource(root: string, path: string): MediaProbe | null {
  try { return probeMediaHead(readAnchored(root, path, MEDIA_PROBE_BYTES)); } catch { return null; }
}

/** `text` with every rewritable reference to `source` pointed at `destination`, or null when nothing changes. */
function rewriteNote(note: string, text: string, source: string, destination: string): string | null {
  const refs = noteReferences(note, text, new Set([source])).filter((r) => r.rewritable && r.span);
  let out = text, changed = false;
  for (const ref of [...refs].sort((a, b) => b.span![0] - a.span![0])) {
    const after = rewriteTarget(ref, destination);
    if (after === null) continue;
    out = out.slice(0, ref.span![0]) + after + out.slice(ref.span![1]);
    changed = true;
  }
  return changed ? out : null;
}

// ---------------------------------------------------------------------------
// Applying

class StepFailed extends Error {
  constructor(readonly reason: string) { super(reason); }
}

/** Replace a regular file's bytes only while it still holds `expected` (temp file, then rename). */
function replaceExpected(root: string, path: string, expected: string, text: string): void {
  if (anchoredSha256(root, path) !== expected) throw new StepFailed("premise-changed");
  writeFileSafely(posix.join(root, path), text, {
    beforePublish: () => { if (anchoredSha256(root, path) !== expected) throw new StepFailed("premise-changed"); },
  });
}

/** Stream `source` into an exclusive private `.part` beside `destination`, hashing as it goes; publish it with link(2), which never overwrites. */
function copyExclusive(root: string, source: string, destination: string, expected: string, opId: string, hooks: MediaEffectContext["copyHooks"] = {}): void {
  const srcParent = openDir(root, posix.dirname(source) === "." ? "" : posix.dirname(source));
  const dstParent = openDir(root, posix.dirname(destination) === "." ? "" : posix.dirname(destination));
  const name = posix.basename(destination), part = `.${name}.${opId}.part`;
  let input: number | undefined, output: number | undefined, partMade = false;
  try {
    input = openSync(at(srcParent, posix.basename(source)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const startStat = fstatSync(input);
    if (!startStat.isFile()) throw new StepFailed("source-changed");
    output = openSync(at(dstParent, part), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    partMade = true;
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let read: number, position = 0;
    while ((read = readSync(input, buffer, 0, buffer.length, position)) > 0) {
      hash.update(buffer.subarray(0, read));
      let written = 0;
      while (written < read) written += writeSync(output, buffer, written, read - written, position + written);
      position += read;
      hooks.afterChunk?.();
    }
    const endStat = fstatSync(input);
    fsyncSync(output);
    if (hash.digest("hex") !== expected || endStat.size !== startStat.size || endStat.mtimeMs !== startStat.mtimeMs) throw new StepFailed("source-changed");
    closeSync(output); output = undefined;
    hooks.beforePublish?.();
    try { linkSync(at(dstParent, part), at(dstParent, name)); }
    catch (e) { throw new StepFailed((e as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "copy-failed"); }
    unlinkSync(at(dstParent, part)); partMade = false;
    fsyncSync(dstParent);
  } finally {
    if (output !== undefined) closeSync(output);
    if (input !== undefined) closeSync(input);
    // The private part is this apply's own: it never outlives a failure.
    if (partMade) { try { unlinkSync(at(dstParent, part)); } catch { /* already gone */ } }
    closeSync(srcParent); closeSync(dstParent);
  }
}

/** Move by link(2) then unlink(2): never overwrites, and refuses across file systems (`exdev`) before anything is removed. */
function moveExclusive(root: string, source: string, destination: string, expected: string): void {
  const srcParent = openDir(root, posix.dirname(source) === "." ? "" : posix.dirname(source));
  const dstParent = openDir(root, posix.dirname(destination) === "." ? "" : posix.dirname(destination));
  try {
    if (anchoredSha256(root, source) !== expected) throw new StepFailed("source-changed");
    try { linkSync(at(srcParent, posix.basename(source)), at(dstParent, posix.basename(destination))); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new StepFailed(code === "EXDEV" ? "exdev" : code === "EEXIST" ? "exists" : "move-failed");
    }
    fsyncSync(dstParent);
    // The source must still be the file just linked before it is removed.
    if (anchoredSha256(root, destination) !== expected) throw new StepFailed("source-changed");
    unlinkSync(at(srcParent, posix.basename(source)));
    fsyncSync(srcParent);
  } finally {
    closeSync(srcParent); closeSync(dstParent);
  }
}

function removeExpected(root: string, path: string, expected: string): void {
  const parent = openDir(root, posix.dirname(path) === "." ? "" : posix.dirname(path));
  try {
    if (anchoredSha256(root, path) !== expected) throw new StepFailed("source-changed");
    unlinkSync(at(parent, posix.basename(path)));
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

/**
 * Apply a plan the caller previewed. The plan is recomputed first; a
 * different premise is `stale` and nothing is written. Then each file is
 * written in plan order, each checked against its expected pre-image.
 * `verify` runs after the last write with the post-apply policy.
 */
export function applyMediaEffect(ctx: MediaEffectContext, request: MediaEffectRequest & { expectPremise: string; journal: string; expectApproval?: string }): MediaEffectResult {
  const base = { id: request.id, action: request.action, journal: request.journal };
  if (process.platform !== "linux") return { ...base, status: "refused", reason: "platform-unsupported", files: [] };
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(request.journal)) return { ...base, status: "refused", reason: "invalid-journal", files: [] };
  const plan = planMediaEffect(ctx, request);
  if (plan.status !== "preview") return { ...base, status: plan.status, reason: plan.reason, refusals: plan.refusals, files: [] };
  if (plan.refusals.length > 0) return { ...base, status: "refused", reason: plan.refusals[0]!.code, refusals: plan.refusals, files: [] };
  // A broader change applies only as it was approved: the config, the diff and every match (rev 3 §5.4).
  if (plan.approvalDigest !== null && request.expectApproval === undefined) return { ...base, status: "refused", reason: "approval-required", refusals: [{ code: "approval-required" }], files: [] };
  if (request.expectApproval !== undefined && plan.approvalDigest !== request.expectApproval) {
    return { ...base, status: "stale", reason: "stale-approval", refusals: [{ code: "stale-approval", ...(plan.configDiff ? { path: plan.configDiff.path } : {}) }], files: [] };
  }
  if (plan.premiseDigest !== request.expectPremise) return { ...base, status: "stale", reason: "premise-changed", files: [] };

  const results: MediaEffectFileResult[] = plan.files.map((f) => ({ ...f, state: "unchanged" }));
  const mark = (path: string, state: MediaEffectFileResult["state"]) => { for (const r of results) if (r.path === path) r.state = state; };
  const written = () => results.some((r) => r.state !== "unchanged");
  const { root } = ctx;
  try {
    const source = plan.source.path, sha = plan.source.sha256;
    const createdDirs = plan.files.filter((f) => f.role === "directory").map((f) => f.path);
    if (createdDirs.length > 0) {
      const made: string[] = [];
      try { closeSync(openDir(root, createdDirs.at(-1)!, made)); }
      finally { for (const dir of made) mark(dir, "created"); }
      if (made.join("\n") !== createdDirs.join("\n")) throw new StepFailed("premise-changed");
    }
    if (request.action === "delete") { removeExpected(root, source, sha); mark(source, "removed"); }
    if (request.action === "move") {
      moveExclusive(root, source, plan.destination!, sha);
      mark(plan.destination!, "created"); mark(source, "removed");
      for (const note of plan.files.filter((f) => f.role === "note")) {
        const text = readAnchored(root, note.path).toString("utf8");
        const next = rewriteNote(note.path, text, source, plan.destination!);
        if (next === null || sha256(next) !== note.after) throw new StepFailed("premise-changed");
        replaceExpected(root, note.path, note.before!, next);
        mark(note.path, "changed");
      }
    }
    if (request.action === "keep-copy") {
      copyExclusive(root, source, plan.destination!, sha, request.journal, ctx.copyHooks);
      mark(plan.destination!, "created");
    }
    const config = plan.files.find((f) => f.role === "config");
    let policy = ctx.policy;
    if (config && plan.configDiff) {
      const text = readAnchored(root, config.path).toString("utf8");
      const tracked = request.action === "persist" ? source : plan.destination!;
      const edit = trackEdit(tracked, ctx.policy, {
        ...(request.pattern !== undefined ? { pattern: request.pattern } : {}), ...(request.ignoreAdjust !== undefined ? { ignoreAdjust: request.ignoreAdjust } : {}),
      }).edit;
      if (!edit) throw new StepFailed("premise-changed");
      const planned = planMediaPolicyEdit(text, configFormat(config.path), edit);
      if (sha256(planned.text) !== config.after) throw new StepFailed("premise-changed");
      replaceExpected(root, config.path, config.before!, planned.text);
      mark(config.path, "changed");
      // Reload: what the written config now reads as, never what was meant.
      const lists = readMediaPolicyLists(readAnchored(root, config.path).toString("utf8"), configFormat(config.path));
      if (JSON.stringify(lists) !== JSON.stringify({ track: plan.configDiff.track.after, ignore: plan.configDiff.ignore.after })) throw new StepFailed("config-invalid");
      policy = { ...ctx.policy, track: lists.track, ignore: lists.ignore };
    }
    // Verify: every file holds what the plan said, and the result classes as intended.
    for (const f of plan.files) {
      if (f.role === "directory") continue;
      if (anchoredSha256(root, f.path) !== f.after) throw new StepFailed("verification-failed");
    }
    if (request.action === "keep-copy" && anchoredSha256(root, source) !== sha) throw new StepFailed("source-changed");
    if ((request.action === "persist" || request.action === "keep-copy") && mediaPolicyClass(request.action === "persist" ? source : plan.destination!, policy) !== "TRACK") {
      throw new StepFailed("verification-failed");
    }
    return { ...base, status: "applied", files: results, ...(request.action === "keep-copy" ? { copySha256: sha } : {}) };
  } catch (e) {
    const reason = e instanceof StepFailed ? e.reason : e instanceof Unsafe ? e.code : "write-failed";
    // Nothing written yet: a refusal, never a compensation.
    if (!written()) return { ...base, status: ["exdev", "exists", "source-changed"].includes(reason) ? "refused" : "stale", reason, files: results };
    return { ...base, status: "interrupted", reason, files: results };
  }
}
