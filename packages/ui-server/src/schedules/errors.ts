export type ScheduleErrorCode =
  | "invalid_request" | "invalid_cursor" | "unauthorized" | "not_found" | "key_conflict"
  | "approval_required" | "approval_expired" | "definition_conflict" | "server_unavailable"
  | "unsupported_capability";
const STATUS: Record<ScheduleErrorCode, number> = {
  invalid_request: 400, invalid_cursor: 400, unauthorized: 403, not_found: 404, key_conflict: 409,
  approval_required: 409, approval_expired: 409, definition_conflict: 409, server_unavailable: 503,
  unsupported_capability: 503,
};

export class ScheduleError extends Error {
  readonly status: number;
  constructor(readonly code: ScheduleErrorCode, message: string, status?: number) {
    super(message);
    this.status = status ?? STATUS[code];
  }
}

