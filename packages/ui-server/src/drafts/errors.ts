/** Draft refusals, shared by the store and its write procedures. */
import type { AttachmentErrorResponse, DraftErrorResponse } from "@schlessera/brain-ui-sdk/protocol";

/** A refusal with its HTTP status and typed body. */
export class DraftError extends Error {
  readonly bodyJson: string;
  constructor(readonly status: 400 | 404 | 409 | 410 | 413 | 428 | 507, readonly body: DraftErrorResponse | AttachmentErrorResponse) {
    super(body.message);
    this.name = "DraftError";
    this.bodyJson = JSON.stringify(body);
  }
}

/** The calling principal is no longer usable (revoked, expired or gone). */
export class DraftAuthError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "DraftAuthError";
  }
}

export function invalid(message: string): DraftError {
  return new DraftError(400, { error: "DRAFT_INVALID", message });
}
