/**
 * `brain config media <add|remove>-<track|ignore> <pattern>` (#2781, epic
 * #1777, design rev 4 §7): one change to the media lists of `brain.config`,
 * previewed with its current matches and applied only against the config
 * bytes and match inventory the approval saw. The config is edited as syntax
 * (`media-config-edit.ts`) and never evaluated here.
 *
 * - **Preview** reads only: the diff, the pattern's current matches (count,
 *   bytes, the five largest, what an ignore still wins over, what is secret
 *   shaped) and the approval digest binding the config SHA-256, the diff and
 *   the match-inventory digest.
 * - **Apply** needs the previewed config SHA-256 (`--expect-sha`); with
 *   `--expect-approval` it also needs the same diff and matches. A
 *   different config is `stale`, a different approval `stale-approval`, and
 *   nothing is written. The write is a minimal splice, published by rename
 *   only while the file still holds the previewed bytes; then the config is
 *   read back, and a config that does not read as the intended lists is put
 *   back to its pre-image.
 */
import { createHash } from "crypto";
import { posix } from "path";

import type { MediaPolicy } from "./media.js";
import { MediaConfigNotLiteral, planMediaPolicyEdit, readMediaPolicyLists, type MediaPolicyEdit } from "./media-config-edit.js";
import { anchoredSha256, readAnchored, type MediaRefusal } from "./media-effects.js";
import { mediaMatches, patternRefusal, patternScope, type MediaMatches } from "./media-matches.js";
import { writeFileSafely } from "./safe-path.js";

export const MEDIA_CONFIG_OPS = ["add-track", "remove-track", "add-ignore", "remove-ignore"] as const;
export type MediaConfigOp = (typeof MEDIA_CONFIG_OPS)[number];

export interface MediaConfigDiff {
  path: string;
  track: { before: string[]; after: string[] };
  ignore: { before: string[]; after: string[] };
}

export interface MediaConfigPlan {
  status: "preview";
  op: MediaConfigOp;
  pattern: string;
  /** `exact` is one full path (it has a `/` and no `*`); anything else is a broader rule. */
  scope: "exact" | "pattern";
  config: { path: string; sha256: string };
  configDiff: MediaConfigDiff;
  matches: MediaMatches;
  approvalDigest: string;
  refusals: MediaRefusal[];
}

export interface MediaConfigRefused {
  status: "refused" | "stale";
  op: MediaConfigOp;
  pattern: string;
  reason: string;
  refusals: MediaRefusal[];
}

export interface MediaConfigApplied {
  status: "applied";
  op: MediaConfigOp;
  pattern: string;
  config: { path: string; before: string; after: string };
  configDiff: MediaConfigDiff;
}

export interface MediaConfigContext {
  root: string;
  policy: MediaPolicy;
  /** Repo-relative config path, or null without a config. */
  configPath: string | null;
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const format = (path: string): "ts" | "json" => (path.endsWith(".json") ? "json" : "ts");

/** The approval digest (rev 3 §5.4): config SHA-256, the exact diff, every match. The host binds the principal. */
export function mediaApprovalDigest(configSha: string, diff: MediaConfigDiff, matches: MediaMatches[]): string {
  return sha256(JSON.stringify({ config: configSha, diff, matches: matches.map((m) => m.digest) }));
}

function editOf(op: MediaConfigOp, pattern: string): MediaPolicyEdit {
  return op === "add-track" ? { addTrack: pattern } : op === "remove-track" ? { removeTrack: pattern } : op === "add-ignore" ? { addIgnore: pattern } : { removeIgnore: pattern };
}

/** Preview one change. Reads only. */
export function planMediaConfigChange(ctx: MediaConfigContext, op: MediaConfigOp, pattern: string): MediaConfigPlan | MediaConfigRefused {
  const refused = (code: string, path?: string): MediaConfigRefused => ({ status: "refused", op, pattern, reason: code, refusals: [{ code, ...(path ? { path } : {}) }] });
  const invalid = patternRefusal(pattern);
  if (invalid) return refused(invalid, pattern);
  const configPath = ctx.configPath;
  if (!configPath || configPath.startsWith("../") || configPath.startsWith("/")) return refused("config-not-literal");
  let text: string, before: Buffer;
  try {
    before = readAnchored(ctx.root, configPath);
    text = before.toString("utf8");
  } catch {
    return refused("config-invalid", configPath);
  }
  let lists, planned;
  try {
    lists = readMediaPolicyLists(text, format(configPath));
    const list = op.endsWith("track") ? lists.track : lists.ignore;
    if (op.startsWith("add") && list.includes(pattern)) return refused("already-listed", pattern);
    if (op.startsWith("remove") && !list.includes(pattern)) return refused("not-listed", pattern);
    planned = planMediaPolicyEdit(text, format(configPath), editOf(op, pattern));
  } catch (e) {
    return refused(e instanceof MediaConfigNotLiteral ? "config-not-literal" : "config-invalid", configPath);
  }
  const configDiff: MediaConfigDiff = { path: configPath, track: { before: lists.track, after: planned.lists.track }, ignore: { before: lists.ignore, after: planned.lists.ignore } };
  const after: MediaPolicy = { ...ctx.policy, track: planned.lists.track, ignore: planned.lists.ignore };
  const matches = mediaMatches(ctx.root, pattern, { ...ctx.policy, track: lists.track, ignore: lists.ignore }, after);
  const configSha = sha256(before);
  return {
    status: "preview", op, pattern, scope: patternScope(pattern),
    config: { path: configPath, sha256: configSha },
    configDiff, matches,
    approvalDigest: mediaApprovalDigest(configSha, configDiff, [matches]),
    refusals: [],
  };
}

/** Apply one change against the previewed config bytes (and, when given, the previewed approval). */
export function applyMediaConfigChange(
  ctx: MediaConfigContext, op: MediaConfigOp, pattern: string, expect: { sha256: string; approval?: string },
): MediaConfigApplied | MediaConfigRefused {
  const plan = planMediaConfigChange(ctx, op, pattern);
  if (plan.status !== "preview") return plan;
  const stale = (code: "stale" | "stale-approval"): MediaConfigRefused => ({ status: "stale", op, pattern, reason: code, refusals: [{ code, path: plan.config.path }] });
  const path = plan.config.path, abs = posix.join(ctx.root, path);
  // The bytes this apply edits are the ones previewed, and the ones the plan was made from.
  const before = readAnchored(ctx.root, path);
  if (sha256(before) !== expect.sha256 || plan.config.sha256 !== expect.sha256) return stale("stale");
  if (expect.approval !== undefined && plan.approvalDigest !== expect.approval) return stale("stale-approval");
  const { text } = planMediaPolicyEdit(before.toString("utf8"), format(path), editOf(op, pattern));
  const holds = (sha: string) => { if (anchoredSha256(ctx.root, path) !== sha) throw new Error("premise-changed"); };
  try {
    // Published only while the file still holds the bytes just read and edited.
    writeFileSafely(abs, text, { beforePublish: () => holds(sha256(before)) });
  } catch {
    return stale("stale");
  }
  // Reload: what the written config now reads as, never what was meant.
  let reread: { track: string[]; ignore: string[] } | null = null;
  try { reread = readMediaPolicyLists(readAnchored(ctx.root, path).toString("utf8"), format(path)); } catch { reread = null; }
  const intended = { track: plan.configDiff.track.after, ignore: plan.configDiff.ignore.after };
  if (JSON.stringify(reread) !== JSON.stringify(intended)) {
    // Put the pre-image back, but only over the bytes this apply wrote.
    try { writeFileSafely(abs, before, { beforePublish: () => holds(sha256(text)) }); } catch { /* left as written: reported below */ }
    return { status: "refused", op, pattern, reason: "config-invalid", refusals: [{ code: "config-invalid", path }] };
  }
  return { status: "applied", op, pattern, config: { path, before: expect.sha256, after: sha256(text) }, configDiff: plan.configDiff };
}
