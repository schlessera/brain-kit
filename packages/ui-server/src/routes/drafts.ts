import { Hono, type Context } from "hono";
import { ALLOWED_IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES } from "@schlessera/brain-ui-sdk/protocol";

import type { AppEnv } from "../app-env.js";
import { DraftAuthError, DraftError, type DraftImageType, type DraftStore } from "../drafts/store.js";

/**
 * Session draft routes (#979, D52 §6). Mounted behind the auth guard; each
 * store call re-resolves the principal inside its transaction, after the
 * request body has been read, so a credential revoked mid-request commits
 * nothing. Responses are never cached: they carry unsent private text.
 */

/** A save body: 64 KiB of text even at JSON's six-byte escapes, plus ids. */
const MAX_SAVE_BODY_BYTES = 512 * 1024;
const MAX_BIND_BODY_BYTES = 4 * 1024;
const MAX_NAME_CHARS = 255;
const MAX_REFERENCE_CHARS = 256;
const DRAFT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const REVISION = /^"?(\d{1,15})"?$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

class BodyTooLarge extends Error {}

function invalid(message: string): DraftError {
  return new DraftError(400, { error: "DRAFT_INVALID", message });
}

/** Read at most `limit` bytes, whatever Content-Length claims. */
async function readCapped(c: Context, limit: number): Promise<Uint8Array> {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge();
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
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readJson(c: Context, limit: number): Promise<Record<string, unknown>> {
  const media = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (media !== "application/json") throw new UnsupportedMedia();
  const bytes = await readCapped(c, limit);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw invalid("The body is not valid UTF-8."); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw invalid("The body is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("The body must be a JSON object.");
  return value as Record<string, unknown>;
}

class UnsupportedMedia extends Error {}

function draftIdOf(c: Context): string {
  const id = c.req.param("draftId") ?? "";
  if (!DRAFT_ID.test(id)) throw invalid("The draft id is malformed.");
  return id;
}

function ifMatchOf(c: Context): number {
  const raw = c.req.header("if-match");
  if (raw === undefined) {
    throw new DraftError(428, { error: "DRAFT_PRECONDITION_REQUIRED", message: "Send If-Match with the revision you edited (0 to create)." });
  }
  const match = REVISION.exec(raw.trim());
  if (!match) throw invalid("If-Match must be a revision number.");
  return Number(match[1]);
}

function idempotencyKeyOf(c: Context): string {
  const key = c.req.header("idempotency-key");
  if (!key || !IDEMPOTENCY_KEY.test(key)) throw invalid("Send an Idempotency-Key of 1–128 letters, digits or ._:-");
  return key;
}

function reference(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REFERENCE_CHARS || CONTROL.test(value)) {
    throw invalid(`${label} must be a short identifier.`);
  }
  return value;
}

export function createDraftRoutes(store: DraftStore): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const run = (handler: (c: Context<AppEnv>, principalId: string) => Promise<Response>) => async (c: Context<AppEnv>) => {
    const principal = c.get("principal");
    let response: Response;
    try {
      if (!principal) throw new DraftAuthError();
      response = await handler(c, principal.id);
    } catch (error) {
      if (error instanceof DraftError) response = c.json(error.body, error.status);
      else if (error instanceof DraftAuthError) response = c.json({ error: "Authentication required", authRequired: true }, 401);
      else if (error instanceof UnsupportedMedia) response = c.json({ error: "unsupported_media_type" }, 415);
      else if (error instanceof BodyTooLarge) {
        const save = c.req.method === "PUT";
        response = c.json({
          error: "DRAFT_TOO_LARGE",
          message: save ? "Draft text is too large." : "This image is too large.",
          limit: save ? store.limits.maxTextBytes : MAX_IMAGE_BYTES,
          bound: save ? "text" : "image",
        }, 413);
      } else throw error;
    }
    response.headers.set("Cache-Control", "no-store");
    return response;
  };

  app.get("/drafts", run(async (c, principalId) => c.json(store.list(principalId))));

  app.get("/drafts/:draftId", run(async (c, principalId) => c.json(store.get(principalId, draftIdOf(c)))));

  app.put("/drafts/:draftId", run(async (c, principalId) => {
    const draftId = draftIdOf(c);
    const ifMatch = ifMatchOf(c);
    const idempotencyKey = idempotencyKeyOf(c);
    const body = await readJson(c, MAX_SAVE_BODY_BYTES);
    const { sessionId, text, attachmentIds } = body;
    if (sessionId !== null) reference(sessionId, "sessionId");
    if (typeof text !== "string") throw invalid("text must be a string.");
    if (!Array.isArray(attachmentIds) || attachmentIds.some((id) => typeof id !== "string" || !DRAFT_ID.test(id))) {
      throw invalid("attachmentIds must be an array of attachment ids.");
    }
    return c.json(store.save(principalId, draftId, {
      ifMatch, idempotencyKey,
      sessionId: sessionId as string | null,
      text,
      attachmentIds: attachmentIds as string[],
    }));
  }));

  app.post("/drafts/:draftId/attachments", run(async (c, principalId) => {
    const draftId = draftIdOf(c);
    const idempotencyKey = idempotencyKeyOf(c);
    const mime = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!ALLOWED_IMAGE_MEDIA_TYPES.includes(mime as DraftImageType)) throw new UnsupportedMedia();
    const name = c.req.query("name") ?? null;
    if (name !== null && (name.length === 0 || name.length > MAX_NAME_CHARS || CONTROL.test(name))) {
      throw invalid(`name must be 1–${MAX_NAME_CHARS} printable characters.`);
    }
    const bytes = await readCapped(c, MAX_IMAGE_BYTES);
    return c.json(store.upload(principalId, draftId, { idempotencyKey, mime: mime as DraftImageType, name, bytes }));
  }));

  app.delete("/drafts/:draftId", run(async (c, principalId) => {
    store.remove(principalId, draftIdOf(c), ifMatchOf(c));
    return c.body(null, 204);
  }));

  app.post("/drafts/:draftId/bind", run(async (c, principalId) => {
    const draftId = draftIdOf(c);
    let body: Record<string, unknown>;
    try { body = await readJson(c, MAX_BIND_BODY_BYTES); }
    catch (error) { if (error instanceof BodyTooLarge) throw invalid("The body is too large."); throw error; }
    return c.json(store.bind(principalId, draftId, {
      sessionId: reference(body.sessionId, "sessionId"),
      requestId: reference(body.requestId, "requestId"),
    }));
  }));

  return app;
}
