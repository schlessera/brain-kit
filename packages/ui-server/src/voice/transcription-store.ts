import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { RecordingTranscription, TranscriptionErrorResponse, TranscriptionFailure } from "@schlessera/brain-ui-sdk/protocol";
import { isUsablePrincipal, resolvePrincipal, type Principal } from "../db/principals.js";

export class TranscriptionError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 501, readonly body: TranscriptionErrorResponse) {
    super(body.message);
  }
}
export const refuse = (status: TranscriptionError["status"], error: string, message: string, receipt?: RecordingTranscription): never => {
  throw new TranscriptionError(status, { error, message, ...(receipt ? { receipt } : {}) });
};
interface Row {
  recording_id: string; account_key: string; sha256: string | null; provider_id: string | null;
  principal_id: string; status: RecordingTranscription["status"]; attempt_id: string; retry_count: number;
  text: string | null; failure: string | null; failures: string; disposition: RecordingTranscription["disposition"] | null;
}
function receipt(row: Row): RecordingTranscription {
  return { recordingId: row.recording_id, sha256: row.sha256, providerId: row.provider_id, status: row.status,
    attemptId: row.attempt_id, retryCount: row.retry_count, failures: JSON.parse(row.failures),
    ...(row.text !== null ? { text: row.text } : {}), ...(row.failure ? { failure: JSON.parse(row.failure) } : {}),
    ...(row.disposition ? { disposition: row.disposition } : {}) };
}

/** Durable operational receipts, never the disposable brain index. Only an
 * immediate transaction winning a claim may dispatch. No retention pruning. */
export function createTranscriptionStore(db: Database, accountKey: (principal: Principal | undefined) => string | null) {
  // A restart cannot establish whether the previous worker reached the provider.
  const unknown: TranscriptionFailure = { reason: "outcome_unknown", retryable: false };
  for (const row of db.query("SELECT * FROM recording_transcriptions WHERE status = 'transcribing'").all() as Row[]) {
    db.query("UPDATE recording_transcriptions SET status = 'outcome_unknown', failure = ?, failures = ? WHERE recording_id = ? AND status = 'transcribing'")
      .run(JSON.stringify(unknown), JSON.stringify([...JSON.parse(row.failures), { ...unknown, attemptId: row.attempt_id }]), row.recording_id);
  }
  const read = (id: string) => db.query("SELECT * FROM recording_transcriptions WHERE recording_id = ?").get(id) as Row | null;
  const authorize = (principalId: string) => {
    const current = resolvePrincipal(db, principalId);
    if (!current || !isUsablePrincipal(current, Date.now())) return refuse(401, "authentication_required", "Sign in again.");
    const key = accountKey(current);
    if (!key) return refuse(403, "owner_required", "Only the authenticated account may transcribe recordings.");
    return key;
  };
  const owned = (key: string, id: string) => {
    const row = read(id);
    // An id belongs to exactly one account, even if another knows its hash.
    if (row && row.account_key !== key) return refuse(404, "transcription_not_found", "No transcription for this account.");
    return row;
  };
  return {
    authorize,
    get(principalId: string, id: string) {
      const row = owned(authorize(principalId), id);
      if (!row) return refuse(404, "transcription_not_found", "No transcription is stored.");
      return receipt(row);
    },
    claim(principalId: string, id: string, sha256: string, providerId: string, retry?: string): { dispatch: boolean; receipt: RecordingTranscription } {
      return db.transaction(() => {
        const key = authorize(principalId);
        const row = owned(key, id);
        if (row) {
          const stored = receipt(row);
          if (row.status === "consumed") return refuse(410, "transcription_consumed", "This transcription was accepted or discarded.", stored);
          if (row.sha256 !== sha256) return refuse(409, "recording_hash_mismatch", "This recording id already names different audio.", stored);
          if (row.status === "done") return { dispatch: false, receipt: stored };
          if (row.status === "transcribing") return refuse(409, "transcription_in_progress", "Transcription is already in progress.", stored);
          if (row.status === "outcome_unknown") return refuse(409, "transcription_outcome_unknown", "The provider may have processed this audio. It cannot be retried.", stored);
          if (!retry) return refuse(409, "transcription_failed", "Review the failed transcription before choosing a retry.", stored);
          if (retry !== row.attempt_id) return refuse(409, "transcription_retry_stale", "This retry names an older attempt.", stored);
          if (!stored.failure?.retryable) return refuse(409, "transcription_not_retryable", "This provider rejection cannot be retried.", stored);
          if (row.retry_count >= 3) return refuse(409, "transcription_retry_limit", "All three retries have been used. The recording is kept.", stored);
          db.query("UPDATE recording_transcriptions SET status = 'transcribing', attempt_id = ?, retry_count = retry_count + 1, failure = NULL, principal_id = ?, provider_id = ? WHERE recording_id = ? AND status = 'failed' AND attempt_id = ?")
            .run(randomUUID(), principalId, providerId, id, retry);
        } else {
          if (retry !== undefined) return refuse(409, "transcription_retry_stale", "No failed attempt exists to retry.");
          db.query("INSERT INTO recording_transcriptions (recording_id, account_key, sha256, provider_id, principal_id, status, attempt_id) VALUES (?, ?, ?, ?, ?, 'transcribing', ?)")
            .run(id, key, sha256, providerId, principalId, randomUUID());
        }
        return { dispatch: true, receipt: receipt(read(id)!) };
      }).immediate();
    },
    complete(id: string, attemptId: string, result: { text: string } | { failure: TranscriptionFailure }) {
      return db.transaction(() => {
        const row = read(id)!;
        if (row.status !== "transcribing" || row.attempt_id !== attemptId) return receipt(row);
        const failure = "failure" in result ? result.failure : null;
        const status = failure ? failure.reason === "outcome_unknown" ? "outcome_unknown" : "failed" : "done";
        db.query("UPDATE recording_transcriptions SET status = ?, text = ?, failure = ?, failures = ? WHERE recording_id = ? AND attempt_id = ? AND status = 'transcribing'")
          .run(status, "text" in result ? result.text : null, failure ? JSON.stringify(failure) : null,
            JSON.stringify([...JSON.parse(row.failures), ...(failure ? [{ ...failure, attemptId }] : [])]), id, attemptId);
        return receipt(read(id)!);
      }).immediate();
    },
    remove(principalId: string, id: string, disposition: "accepted" | "discarded") {
      return db.transaction(() => {
        const key = authorize(principalId);
        const row = owned(key, id);
        if (!row) db.query("INSERT INTO recording_transcriptions (recording_id, account_key, principal_id, status, attempt_id, disposition) VALUES (?, ?, ?, 'consumed', ?, ?)")
          .run(id, key, principalId, randomUUID(), disposition);
        else if (row.status !== "consumed") db.query("UPDATE recording_transcriptions SET status = 'consumed', text = NULL, disposition = ? WHERE recording_id = ?").run(disposition, id);
        return receipt(read(id)!);
      }).immediate();
    },
  };
}
export type TranscriptionStore = ReturnType<typeof createTranscriptionStore>;
