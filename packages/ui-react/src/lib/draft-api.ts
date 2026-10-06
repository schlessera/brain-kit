import { draftListResponseSchema, draftSaveResponseSchema, draftSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { Draft, DraftErrorResponse, DraftListResponse, DraftSaveRequest, DraftSaveResponse } from "@schlessera/brain-ui-sdk/protocol";

/**
 * The six `/api/drafts` routes (#979, D52 §6) as one root's client, each
 * answer classified rather than thrown, so the draft client can decide what
 * a failure means for the reader's content. Nothing here sends a message,
 * starts work or answers anything: these are data operations only.
 */
/** A failure body's fields, any of which a given `DraftErrorResponse` may carry. */
export interface DraftFailureBody {
  error?: DraftErrorResponse["error"] | string;
  message?: string;
  current?: Draft;
  tombstoneRevision?: number;
  limit?: number;
  bound?: string;
}

export type DraftCallResult<T> =
  | { ok: true; value: T }
  /** The host answered with a failure (`body` is its envelope, or empty); 0 is no answer at all. */
  | { ok: false; status: number; body: DraftFailureBody };

export interface DraftApi {
  list(): Promise<DraftCallResult<DraftListResponse>>;
  get(draftId: string): Promise<DraftCallResult<Draft>>;
  save(draftId: string, ifMatch: number, idempotencyKey: string, body: DraftSaveRequest): Promise<DraftCallResult<DraftSaveResponse>>;
  upload(draftId: string, idempotencyKey: string, image: { mime: string; base64: string; name: string | null }): Promise<DraftCallResult<{ attachmentId: string }>>;
  remove(draftId: string, ifMatch: number): Promise<DraftCallResult<null>>;
  bind(draftId: string, body: { sessionId: string; requestId: string }): Promise<DraftCallResult<{ revision: number }>>;
}

/** How long one draft call may take before it counts as no answer. */
const DRAFT_CALL_TIMEOUT_MS = 15_000;

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createDraftApi(
  base: () => string,
  request: (url: string, init?: RequestInit) => Promise<Response>,
): DraftApi {
  async function call<T>(path: string, init: RequestInit, parse: (body: unknown) => T | null): Promise<DraftCallResult<T>> {
    let res: Response;
    try {
      res = await request(`${base()}${path}`, { cache: "no-store", signal: AbortSignal.timeout(DRAFT_CALL_TIMEOUT_MS), ...init });
    } catch {
      return { ok: false, status: 0, body: {} };
    }
    // A delete's acknowledgement has no body.
    if (res.status === 204) return { ok: true, value: null as T };
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      return { ok: false, status: res.status, body: body && typeof body === "object" ? (body as DraftFailureBody) : {} };
    }
    const value = parse(body);
    // A 200 the client cannot read proves nothing was stored as it believes.
    if (value === null) return { ok: false, status: 0, body: {} };
    return { ok: true, value };
  }
  const json = (method: string, payload: unknown, headers: Record<string, string> = {}): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const id = (draftId: string) => encodeURIComponent(draftId);

  return {
    list: () => call("/drafts", {}, (body) => {
      const parsed = draftListResponseSchema.safeParse(body);
      return parsed.success ? (parsed.data as DraftListResponse) : null;
    }),
    get: (draftId) => call(`/drafts/${id(draftId)}`, {}, (body) => {
      const parsed = draftSchema.safeParse(body);
      return parsed.success ? (parsed.data as Draft) : null;
    }),
    save: (draftId, ifMatch, idempotencyKey, body) => call(
      `/drafts/${id(draftId)}`,
      json("PUT", body, { "If-Match": String(ifMatch), "Idempotency-Key": idempotencyKey }),
      (answer) => {
        const parsed = draftSaveResponseSchema.safeParse(answer);
        return parsed.success ? (parsed.data as DraftSaveResponse) : null;
      },
    ),
    upload: (draftId, idempotencyKey, image) => call(
      `/drafts/${id(draftId)}/attachments${image.name ? `?name=${encodeURIComponent(image.name.slice(0, 255))}` : ""}`,
      { method: "POST", headers: { "Content-Type": image.mime, "Idempotency-Key": idempotencyKey }, body: decodeBase64(image.base64) as BodyInit },
      (answer) => {
        const attachmentId = (answer as { attachmentId?: unknown } | undefined)?.attachmentId;
        return typeof attachmentId === "string" && attachmentId.length > 0 ? { attachmentId } : null;
      },
    ),
    remove: (draftId, ifMatch) => call(`/drafts/${id(draftId)}`, { method: "DELETE", headers: { "If-Match": String(ifMatch) } }, () => null),
    bind: (draftId, body) => call(`/drafts/${id(draftId)}/bind`, json("POST", body), (answer) => {
      const revision = (answer as { revision?: unknown } | undefined)?.revision;
      return typeof revision === "number" && Number.isInteger(revision) && revision > 0 ? { revision } : null;
    }),
  };
}
