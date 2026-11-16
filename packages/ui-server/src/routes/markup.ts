import { Hono, type Context } from "hono";
import {
  BRAIN_MARKUP_MAX_BYTES,
  BRAIN_MARKUP_MAX_NOTES,
  BRAIN_MARKUP_NOTE_MAX_CHARS,
} from "@schlessera/brain-ui-sdk/server";

import type { AppEnv } from "../app-env.js";
import type { MarkupSubmission, TurnCoordinator } from "../ws/turns.js";

/**
 * The markup layer upload (#3975). A layer may be up to 52,428,800 bytes, far
 * beyond the 12,000,000-byte client frame, so it does not travel on the
 * socket. One `multipart/form-data` POST answers one open `markup_request`:
 * a `layer` part (the PNG) and a `summary` part (`{ marks, notes }`, the
 * drawing's own counts and note texts).
 *
 * Only the principal whose turn opened the request may answer it, with that
 * turn's id. The route bounds the body as it streams, whatever
 * `Content-Length` says, and hands the bytes to the waiting request: the
 * request's own application checks the PNG, its size against the source and
 * every authority and destination rule before anything is written. A refused
 * upload leaves the request open, so the editor stays up with its reason.
 */

/** Room for multipart framing and the summary above the layer's own cap. */
const MARKUP_UPLOAD_HEADROOM_BYTES = 256 * 1024;
/** The most bytes one markup upload body may carry. */
export const MARKUP_UPLOAD_MAX_BODY_BYTES = BRAIN_MARKUP_MAX_BYTES + MARKUP_UPLOAD_HEADROOM_BYTES;

const REQUEST_ID = /^markup-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_MARKS = 100_000;

class UploadError extends Error {
  constructor(readonly status: 400 | 404 | 413 | 415, readonly code: string, message: string) { super(message); }
}

const tooLarge = (bytes?: number) => new UploadError(413, "markup_too_large", bytes === undefined
  ? `This markup is over the ${BRAIN_MARKUP_MAX_BYTES}-byte (50 MiB) limit.`
  : `This markup is ${bytes} bytes; the limit is ${BRAIN_MARKUP_MAX_BYTES} bytes (50 MiB).`);

async function readCapped(c: Context, limit: number): Promise<Uint8Array> {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  const reader = c.req.raw.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function summaryOf(raw: unknown): Pick<MarkupSubmission, "marks" | "notes"> {
  const invalid = (message: string) => new UploadError(400, "markup_invalid", message);
  if (typeof raw !== "string" || raw.length > MARKUP_UPLOAD_HEADROOM_BYTES) throw invalid("Send the drawing summary as a short JSON part.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalid("The drawing summary is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("The drawing summary must be an object.");
  const { marks, notes } = value as Record<string, unknown>;
  if (!marks || typeof marks !== "object" || Array.isArray(marks)) throw invalid("The drawing summary needs its mark counts.");
  const counts = {} as MarkupSubmission["marks"];
  for (const kind of ["pen", "arrow", "ellipse", "text"] as const) {
    const n = (marks as Record<string, unknown>)[kind];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_MARKS) throw invalid(`The ${kind} count must be a whole number.`);
    counts[kind] = n;
  }
  if (counts.pen + counts.arrow + counts.ellipse + counts.text === 0) {
    throw invalid("Draw at least one mark.");
  }
  if (!Array.isArray(notes) || notes.length > BRAIN_MARKUP_MAX_NOTES
    || notes.some(note => typeof note !== "string" || note.length === 0 || [...note].length > BRAIN_MARKUP_NOTE_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(note))) {
    throw invalid(`Notes must be at most ${BRAIN_MARKUP_MAX_NOTES} single lines of at most ${BRAIN_MARKUP_NOTE_MAX_CHARS} characters.`);
  }
  if (notes.length !== counts.text) throw invalid("The note count does not match the notes sent.");
  return { marks: counts, notes: [...notes] as string[] };
}

/**
 * The request's own principal and exact turn, or nothing: an id from another
 * account, a stale tab's turn, or no turn at all finds no request. Null when
 * the caller is not authenticated.
 */
function ownership(c: Context<AppEnv>): ((p: { principalId: string; turnId: string }) => boolean) | null {
  const principal = c.get("principal");
  if (!principal) return null;
  const turnId = c.req.query("turnId");
  return p => p.principalId === principal.id && typeof turnId === "string" && turnId.length > 0 && p.turnId === turnId;
}

export function createMarkupRoutes(coordinator: Pick<TurnCoordinator, "peekMarkup" | "claimMarkup">): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // The source the editor draws on, for as long as its request is open: the
  // general file route stops at 10 MiB, and a markup source may be larger.
  app.get("/markup/:requestId/source", (c) => {
    let response: Response;
    const owns = ownership(c);
    const requestId = c.req.param("requestId") ?? "";
    const pending = owns && REQUEST_ID.test(requestId) ? coordinator.peekMarkup(requestId, owns) : undefined;
    if (!owns) response = c.json({ error: "Authentication required", authRequired: true }, 401);
    else if (!pending) response = c.json({ error: "markup_request_not_found", message: "No markup editor is waiting for this image." }, 404);
    else {
      try {
        const { bytes, type } = pending.source();
        response = new Response(bytes as unknown as BodyInit, { status: 200, headers: { "Content-Type": type, "Content-Length": String(bytes.byteLength), "X-Content-Type-Options": "nosniff" } });
      } catch (error) {
        response = c.json({ error: "markup_source_unavailable", message: error instanceof Error ? error.message : String(error) }, 409);
      }
    }
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
  app.post("/markup/:requestId", async (c) => {
    let response: Response;
    try {
      const owns = ownership(c);
      if (!owns) response = c.json({ error: "Authentication required", authRequired: true }, 401);
      else {
      const requestId = c.req.param("requestId") ?? "";
      if (!REQUEST_ID.test(requestId) || !coordinator.peekMarkup(requestId, owns)) {
        throw new UploadError(404, "markup_request_not_found", "No markup editor is waiting for this upload.");
      }
      const media = c.req.header("content-type") ?? "";
      if (media.split(";", 1)[0]!.trim().toLowerCase() !== "multipart/form-data") {
        throw new UploadError(415, "unsupported_media_type", "Send the layer as multipart/form-data.");
      }
      const body = await readCapped(c, MARKUP_UPLOAD_MAX_BODY_BYTES);
      let form: FormData;
      try { form = await new Response(body as unknown as BodyInit, { headers: { "content-type": media } }).formData(); }
      catch { throw new UploadError(400, "markup_invalid", "The upload is not valid multipart/form-data."); }
      const layer = form.get("layer");
      if (!(layer instanceof Blob)) throw new UploadError(400, "markup_invalid", "Send the PNG as the layer part.");
      // Inclusive: exactly the cap is accepted, one byte over is not.
      if (layer.size > BRAIN_MARKUP_MAX_BYTES) throw tooLarge(layer.size);
      const summary = summaryOf(form.get("summary"));
      const png = new Uint8Array(await layer.arrayBuffer());
      const pending = coordinator.claimMarkup(requestId, owns);
      if (!pending) throw new UploadError(404, "markup_request_not_found", "No markup editor is waiting for this upload.");
      pending.resolve({ png, ...summary });
      response = c.json({ accepted: true, bytes: png.byteLength }, 202);
      }
    } catch (error) {
      if (!(error instanceof UploadError)) throw error;
      response = c.json({ error: error.code, message: error.message,
        ...(error.status === 413 ? { limit: BRAIN_MARKUP_MAX_BYTES } : {}) }, error.status);
    }
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
  return app;
}
