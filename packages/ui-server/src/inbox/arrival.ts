/**
 * The staged bytes of one arrival, as triage and queued work read them. Intake
 * digests the same read when a person's arrival is committed, so a later read
 * that differs is not the arrival intake recorded (#2741).
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { SHARE_STAGING_DIR, SHARE_MAX_TEXT_BYTES } from "@schlessera/brain-ui-sdk/protocol";
import { safeResolve } from "../files/walker.js";

// UTF-8 bytes conservatively overcount text tokens, including escaped JSON,
// question overhead and the rubric. No guessed characters/token multiplier.
export const TRIAGE_ITEM_BYTES = 4_000;

/** An arrival's staged title and text, before evidence clipping. */
export interface StagedArrival { title: string; body: string; incomplete: boolean; binary: boolean }

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Read a bounded prefix through a non-symlink handle, inside this staging area. */
async function stagedText(root: string, directory: string, path: string, cap: number) {
  if (!path.startsWith(`${directory}/`) || path.slice(directory.length + 1).includes("/")) throw Error("Invalid staging child");
  const base = await safeResolve(directory, root), resolved = await safeResolve(path, root);
  if (await realpath(resolved) !== `${base}/${path.slice(directory.length + 1)}`) throw Error("Redirected staging child");
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw Error("Not a staging file");
    const buffer = Buffer.alloc(Math.min(stat.size, cap));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)), truncated: stat.size > bytesRead };
  } finally { await file.close(); }
}

/** A bounded prefix of one staging file, by its brain-relative path. */
type ArrivalReader = (path: string, cap: number) => Promise<{ text: string; truncated: boolean }>;

async function readArrival(stagingId: string, read: ArrivalReader): Promise<StagedArrival> {
  if (!/^[a-zA-Z0-9-]+$/.test(stagingId)) throw Error("Invalid staging identity");
  const directory = `${SHARE_STAGING_DIR}/${stagingId}`;
  const meta = await read(`${directory}/meta.json`, SHARE_MAX_TEXT_BYTES + 64_000);
  if (meta.truncated) throw Error("Oversized staging manifest");
  const manifest: unknown = JSON.parse(meta.text);
  if (!record(manifest) || manifest.id !== stagingId || manifest.dir !== directory || !Array.isArray(manifest.files)) throw Error("Invalid staging manifest");
  const title = typeof manifest.title === "string" ? manifest.title : "";
  const parts = [manifest.text, manifest.url].filter((v): v is string => typeof v === "string");
  let incomplete = Array.isArray(manifest.skipped) && manifest.skipped.length > 0, binary = false;
  for (const entry of manifest.files) {
    if (!record(entry) || typeof entry.path !== "string" || typeof entry.mediaType !== "string") throw Error("Invalid staging attachment");
    // Validated structured binary extraction (e.g. imported track summaries)
    // has the same final bound as text. No unaccounted vision/OCR invocation.
    if (record(entry.summary)) { parts.push(JSON.stringify(entry.summary)); binary = true; }
    else if (/^(text\/|application\/(json|xml)(;|$))/.test(entry.mediaType)) {
      const content = await read(entry.path, TRIAGE_ITEM_BYTES + 4);
      parts.push(content.text); incomplete ||= content.truncated;
    } else { binary = true; parts.push("A binary attachment needs extraction by the agent tier."); }
  }
  return { title, body: parts.join("\n"), incomplete, binary };
}

/** Bounded staged evidence of one arrival, read from its staging directory. */
export function stagedArrival(root: string, stagingId: string): Promise<StagedArrival> {
  const directory = `${SHARE_STAGING_DIR}/${stagingId}`;
  return readArrival(stagingId, (path, cap) => stagedText(root, directory, path, cap));
}

/**
 * The same evidence from the bytes staging is about to publish, keyed by
 * brain-relative path: what intake records, before anything else can write
 * the published directory (#2741).
 */
export function publishedArrival(stagingId: string, files: ReadonlyMap<string, Uint8Array>): Promise<StagedArrival> {
  return readArrival(stagingId, async (path, cap) => {
    const bytes = files.get(path);
    if (!bytes) throw Error("Unpublished staging child");
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, cap)), truncated: bytes.byteLength > cap };
  });
}

/** The identity of an arrival read: equal digests mean equal evidence. */
export function stagedArrivalDigest(arrival: StagedArrival): string {
  return createHash("sha256").update(JSON.stringify([arrival.title, arrival.body, arrival.incomplete, arrival.binary])).digest("hex");
}
