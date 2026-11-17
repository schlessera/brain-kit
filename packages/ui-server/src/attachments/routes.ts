import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import {
  ATTACHMENT_MAX_FILE_BYTES,
  SHARE_MAX_CONCURRENT_INTAKE,
  type AttachmentErrorResponse,
} from "@schlessera/brain-ui-sdk/protocol";
import type { AppEnv } from "../app-env.js";
import { DraftAuthError, DraftError, type AwaitableDraftStore } from "../drafts/store.js";
import { sanitizeFileName } from "../share/staging.js";
import { detectKind } from "./detect.js";
import { attachmentRoot, readVerified } from "./files.js";
import { attachmentPath, FILE_ID, type NewAttachment } from "./store.js";

/**
 * The neutral composer-upload route and its read-back (#3153,
 * docs/plans/chat-attachments.md §6.1 and §6.5). Mounted behind the auth
 * guard. The upload creates no inbox item, queue job or triage; `/share` and
 * `/track-upload` keep their behavior. Each store call re-resolves the
 * principal inside its own transaction.
 */

const DRAFT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;
const FORMAT = /\p{Cf}/gu;
const MAX_NAME_HEADER_BYTES = 1_024;
const MAX_INCOMING_NAME_BYTES = 100;
/** Headers that try to claim authority an upload never has. */
const AUTHORITY = new Set(["trust", "trustclass", "source", "profile", "profileid", "principal", "principalid", "allowedtools", "targetpath",
  "enforceallowedtools", "nograntsurface", "capability", "capabilities", "path", "fileid", "owner", "draftowner", "kind", "reader"]);

/** A file the track parser recognised but whose name does not say so gets the track extension. */
const TRACK_EXT = { gpx: "application/gpx+xml", kml: "application/vnd.google-earth.kml+xml", geojson: "application/geo+json" } as const;

function fail(status: 404 | 413, body: AttachmentErrorResponse): DraftError {
  return new DraftError(status, body);
}

function invalid(message: string): DraftError {
  return new DraftError(400, { error: "ATTACHMENT_INVALID", message });
}

function truncateBytes(value: string, max: number): string {
  let out = "";
  let size = 0;
  for (const char of value) {
    const n = Buffer.byteLength(char);
    if (size + n > max) break;
    out += char; size += n;
  }
  return out;
}

function nameHint(c: Context): string {
  const raw = c.req.header("x-file-name");
  if (raw === undefined) return "";
  if (Buffer.byteLength(raw) > MAX_NAME_HEADER_BYTES) throw invalid("X-File-Name is too long.");
  try { return decodeURIComponent(raw); }
  catch { throw invalid("X-File-Name must be percent-encoded UTF-8."); }
}

function mediaHint(c: Context): string {
  const bare = (c.req.header("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  return MEDIA_TYPE.test(bare) ? bare : "application/octet-stream";
}

interface AttachmentRoutesDeps {
  brainRoot: string;
  store: AwaitableDraftStore;
  /** This server process, for reservations. */
  instanceId: string;
}

export function createAttachmentRoutes(deps: AttachmentRoutesDeps): Hono<AppEnv> {
  const { brainRoot, store } = deps;
  const app = new Hono<AppEnv>();
  let inFlight = 0;

  const run = (handler: (c: Context<AppEnv>, principalId: string) => Promise<Response>) => async (c: Context<AppEnv>) => {
    const principal = c.get("principal");
    let response: Response;
    try {
      if (!principal) throw new DraftAuthError();
      response = await handler(c, principal.id);
    } catch (error) {
      if (error instanceof DraftError) response = c.json(error.body, error.status);
      else if (error instanceof DraftAuthError) response = c.json({ error: "Authentication required", authRequired: true }, 401);
      else throw error;
    }
    response.headers.set("Cache-Control", "no-store");
    return response;
  };

  app.post("/drafts/:draftId/files", run(async (c, principalId) => {
    const draftId = c.req.param("draftId") ?? "";
    if (!DRAFT_ID.test(draftId)) throw invalid("The draft id is malformed.");
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw invalid("Send an Idempotency-Key of 1–128 letters, digits or ._:-");
    for (const header of Object.keys(c.req.header())) {
      const lower = header.toLowerCase();
      if (lower.startsWith("x-") && lower !== "x-file-name" && AUTHORITY.has(lower.slice(2).replace(/[_-]/g, ""))) {
        throw invalid("An upload cannot claim authority, a path or a kind.");
      }
    }
    const name = nameHint(c);
    const media = mediaHint(c);
    const declared = Number(c.req.header("content-length"));
    const hasLength = c.req.header("content-length") !== undefined && Number.isFinite(declared) && declared >= 0;
    if (hasLength && declared > ATTACHMENT_MAX_FILE_BYTES) {
      throw fail(413, { error: "ATTACHMENT_TOO_LARGE", message: "Files can be up to 25 MB each.", limit: ATTACHMENT_MAX_FILE_BYTES, bound: "file" });
    }
    if (hasLength && declared === 0) throw invalid("The file is empty.");
    if (inFlight >= SHARE_MAX_CONCURRENT_INTAKE) return c.json({ error: "busy" }, 503);
    inFlight += 1;
    let reservationId: string | undefined;
    let committed = false;
    const fileId = crypto.randomUUID();
    let root: string | undefined;
    const partialDir = () => join(root!, `.${fileId}.partial`);
    const finalDir = () => join(root!, fileId);
    try {
      ({ reservationId } = await store.reserveAttachment(principalId, draftId, { bytes: hasLength ? declared : ATTACHMENT_MAX_FILE_BYTES, instanceId: deps.instanceId }));
      root = await attachmentRoot(brainRoot);
      await mkdir(partialDir(), { mode: 0o755 });
      const temp = join(partialDir(), "upload");
      const handle = await open(temp, "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0;
      try {
        const reader = c.req.raw.body?.getReader();
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          // The reservation is the declared length: a longer body is refused
          // before its extra bytes reach the disk uncharged.
          if (hasLength && size > declared) {
            await reader.cancel().catch(() => {});
            throw invalid("The body is longer than its Content-Length.");
          }
          // Stop at the first byte past the cap; nothing is buffered whole.
          if (size > ATTACHMENT_MAX_FILE_BYTES) {
            await reader.cancel().catch(() => {});
            throw fail(413, { error: "ATTACHMENT_TOO_LARGE", message: "Files can be up to 25 MB each.", limit: ATTACHMENT_MAX_FILE_BYTES, bound: "file" });
          }
          hash.update(value);
          await handle.write(value);
        }
      } finally { await handle.close(); }
      if (size === 0) throw invalid("The file is empty.");
      const sha256 = hash.digest("hex");
      // Detection reads the stored bytes back, bounded by the cap above.
      const bytes = await readFile(temp);
      const incoming = truncateBytes(name.replace(CONTROL, "").replace(FORMAT, ""), MAX_INCOMING_NAME_BYTES);
      let storedName = sanitizeFileName(name || "file", media);
      const provisional = detectKind(bytes, { name: storedName, mediaType: media, path: attachmentPath(fileId, storedName) });
      if (provisional.kind === "track" && (!/\.[a-z0-9]{1,8}$/i.test(storedName) || /\.(?:bin|dat|tmp|xml|json|txt)$/i.test(storedName))) {
        storedName = sanitizeFileName(storedName.replace(/\.[a-z0-9]{1,8}$/i, ""), TRACK_EXT[provisional.track!.format]);
      }
      const path = attachmentPath(fileId, storedName);
      // Re-run on the final path so a track's summary names where it lives.
      const detected = provisional.kind === "track" ? detectKind(bytes, { name: storedName, mediaType: media, path }) : provisional;
      const mediaType = detected.mediaType ?? media;
      const track = detected.track ? {
        name: storedName, path, mediaType, bytes: size, sha256,
        ...(incoming ? { incomingName: incoming } : {}),
        ...detected.track.meta,
      } : null;
      await rename(temp, join(partialDir(), storedName));
      await chmod(join(partialDir(), storedName), 0o444);
      // The original becomes visible here, whole, in one operation.
      await rename(partialDir(), finalDir());
      const file: NewAttachment = {
        fileId, sha256, bytes: size, storedName, incomingName: incoming || null, mediaType,
        kind: detected.kind, reader: detected.reader, trackRejected: detected.trackRejected === true, track,
      };
      const fingerprint = createHash("sha256").update(JSON.stringify([draftId, name, media])).update(sha256).digest("hex");
      const result = await store.commitAttachment(principalId, draftId, { reservationId, idempotencyKey, fingerprint, file });
      reservationId = undefined;
      committed = !result.replay;
      return c.json(result.file, result.replay ? 200 : 201);
    } finally {
      inFlight -= 1;
      if (reservationId) await Promise.resolve(store.releaseReservation(reservationId)).catch(() => {});
      if (root && !committed) {
        await rm(partialDir(), { recursive: true, force: true }).catch(() => {});
        await rm(finalDir(), { recursive: true, force: true }).catch(() => {});
      }
    }
  }));

  app.get("/attachments/:fileId", run(async (c) => {
    const fileId = c.req.param("fileId") ?? "";
    const notFound = () => fail(404, { error: "ATTACHMENT_NOT_FOUND", message: "No attachment with this id is available on this host." });
    if (!FILE_ID.test(fileId)) throw notFound();
    await store.settled?.();
    const row = store.attachments([fileId]).get(fileId);
    // Any live reference authorizes a read; an unreferenced file reads as absent.
    if (!row || row.state !== "stored" || !store.attachmentReferenced(fileId)) throw notFound();
    const read = await readVerified(brainRoot, row);
    if (!read.ok) {
      if (read.reason === "missing") throw notFound();
      return c.json({ error: "ATTACHMENT_CHANGED", message: "The original changed since it was stored. Nothing of it is served." }, 409);
    }
    const preview = row.kind === "image" && row.reader === "image";
    return new Response(new Blob([read.bytes as Uint8Array<ArrayBuffer>]), {
      status: 200,
      headers: {
        "Content-Type": preview ? row.media_type : "application/octet-stream",
        "Content-Length": String(read.bytes.byteLength),
        "Content-Disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.stored_name)}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "Cache-Control": "no-store",
      },
    });
  }));

  return app;
}
