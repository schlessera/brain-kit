/**
 * Optional JSONL persistence for plain API-loop backends. Native-persistence
 * backends must keep their own store. Damaged files are quarantined in place;
 * diagnostics and explicit recovery never modify their evidence.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync,
  openSync, readdirSync, readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type { ChatSession, SessionHistoryMessage } from "../protocol.js";
import { serverSessionHistorySchema } from "../schemas.js";

export interface TranscriptFailure {
  /** One-based physical line and zero-based byte offset of the first failure. */
  line: number;
  byteOffset: number;
  position: "final" | "interior";
  reason: "invalid-json" | "invalid-record" | "invalid-utf8" | "missing-meta";
}

export interface TranscriptRecoveryProvenance {
  sourceSessionId: string;
  /** SHA-256 of all original bytes, including the damaged suffix. */
  sourceVersion: string;
  prefixBytes: number;
  prefixRecords: number;
  failure: TranscriptFailure;
}

export interface TranscriptMetaRecord {
  kind: "meta";
  id: string;
  title: string | null;
  createdAt: number;
  recovery?: TranscriptRecoveryProvenance;
}

export interface TranscriptMessageRecord {
  kind: "message";
  ts: number;
  message: SessionHistoryMessage;
  costUsd?: number;
}
export type TranscriptRecord = TranscriptMetaRecord | TranscriptMessageRecord;

export type TranscriptDiagnostic =
  | { sessionId: string; status: "missing" }
  | {
      sessionId: string;
      sourceVersion: string;
      prefixBytes: number;
      records: TranscriptRecord[];
    } & (
      | { status: "healthy"; complete: true; failure?: never }
      | { status: "quarantined"; complete: false; failure: TranscriptFailure }
    );

export class TranscriptCorruptionError extends Error {
  readonly code: "TRANSCRIPT_CORRUPT";
  constructor(readonly diagnostic: TranscriptDiagnostic) {
    super(`Quarantined transcript session: ${diagnostic.sessionId}`);
    this.code = "TRANSCRIPT_CORRUPT";
    this.name = "TranscriptCorruptionError";
  }
}

export class TranscriptRecoveryError extends Error {
  constructor(readonly code: "SOURCE_CHANGED" | "NOT_RECOVERABLE" | "RECOVERY_CONFLICT") {
    super(`Transcript recovery refused: ${code}`);
    this.name = "TranscriptRecoveryError";
  }
}

/** Existing implementations need not implement the diagnostic extension. */
export interface TranscriptStore {
  create(opts?: { title?: string }): string;
  append(sessionId: string, message: SessionHistoryMessage, opts?: { costUsd?: number }): void;
  list(): ChatSession[];
  history(sessionId: string): SessionHistoryMessage[];
}

export interface RecoverableTranscriptStore extends TranscriptStore {
  diagnose(sessionId: string): TranscriptDiagnostic;
  quarantined(): TranscriptDiagnostic[];
  /** Explicit consent to recover the exact version returned by diagnose(). */
  recover(sessionId: string, opts: { sourceVersion: string }): string;
}

const count = z.number().int().nonnegative();
const failureSchema = z.looseObject({
  line: z.number().int().positive(), byteOffset: count,
  position: z.enum(["final", "interior"]),
  reason: z.enum(["invalid-json", "invalid-record", "invalid-utf8", "missing-meta"]),
});
const recoverySchema = z.looseObject({
  sourceSessionId: z.string().min(1), sourceVersion: z.string().regex(/^[a-f0-9]{64}$/),
  prefixBytes: count, prefixRecords: z.number().int().positive(), failure: failureSchema,
});
const metaSchema = z.looseObject({
  kind: z.literal("meta"), id: z.string().min(1), title: z.string().nullable(),
  createdAt: z.number().finite().nonnegative(), recovery: recoverySchema.optional(),
});
// Reuse history validation but refuse normalization: a verified raw record
// cannot retain a malformed field the wire reader would silently discard.
const messageSchema = z.looseObject({
  kind: z.literal("message"), ts: z.number().finite().nonnegative(),
  message: serverSessionHistorySchema.shape.messages.element,
  costUsd: z.number().finite().nonnegative().optional(),
});
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const validRawRecord = (schema: z.ZodType, value: unknown) => {
  const parsed = schema.safeParse(value);
  return parsed.success && isDeepStrictEqual(parsed.data, value);
};

interface Inspection {
  bytes: Buffer;
  metaEnd: number;
  diagnostic: Exclude<TranscriptDiagnostic, { status: "missing" }>;
}

function inspect(sessionId: string, bytes: Buffer): Inspection {
  const records: TranscriptRecord[] = [];
  let offset = 0;
  let line = 1;
  let metaEnd = 0;
  let failure: TranscriptFailure | undefined;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset);
    const end = newline < 0 ? bytes.length : newline;
    const next = newline < 0 ? end : end + 1;
    let reason: TranscriptFailure["reason"] | undefined;
    let text: string | undefined;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end)); }
    catch { reason = "invalid-utf8"; }
    if (text?.trim()) {
      let value: unknown;
      try { value = JSON.parse(text); }
      catch { reason = "invalid-json"; }
      if (!reason) {
        const valid = records.length === 0
          ? validRawRecord(metaSchema, value) && (value as TranscriptMetaRecord).id === sessionId
          : validRawRecord(messageSchema, value);
        if (valid) {
          if (records.length === 0) metaEnd = next;
          records.push(value as TranscriptRecord);
        }
        else reason = "invalid-record";
      }
    }
    if (reason) {
      const position = bytes.subarray(next).some((byte) => ![9, 10, 13, 32].includes(byte))
        ? "interior" : "final";
      failure = { line, byteOffset: offset, position, reason };
      break;
    }
    offset = next;
    line++;
  }
  if (!failure && records.length === 0) {
    failure = { line: 1, byteOffset: 0, position: "final", reason: "missing-meta" };
    offset = 0;
  }
  return { bytes, metaEnd, diagnostic: {
    sessionId,
    sourceVersion: hash(bytes), prefixBytes: offset, records,
    ...(failure
      ? { status: "quarantined" as const, complete: false as const, failure }
      : { status: "healthy" as const, complete: true as const }),
  } };
}

export function createTranscriptStore(dir: string): RecoverableTranscriptStore {
  mkdirSync(dir, { recursive: true });
  let lastTs = 0;
  const nextTs = () => (lastTs = Math.max(Date.now(), lastTs + 1));
  const fileOf = (id: string) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid transcript session id");
    return join(dir, `${id}.jsonl`);
  };
  const read = (id: string): Inspection | undefined => {
    try { return inspect(id, readFileSync(fileOf(id))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const admitted = (id: string) => {
    const snapshot = read(id);
    if (snapshot?.diagnostic.status === "quarantined") {
      throw new TranscriptCorruptionError(snapshot.diagnostic);
    }
    return snapshot;
  };
  const ids = () => readdirSync(dir).filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => entry.slice(0, -6));
  const assertVersion = (id: string, version: string) => {
    if (read(id)?.diagnostic.sourceVersion !== version) {
      throw new TranscriptRecoveryError("SOURCE_CHANGED");
    }
  };
  const syncDirectory = () => {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };

  return {
    create(opts = {}) {
      const id = crypto.randomUUID();
      const meta: TranscriptMetaRecord = {
        kind: "meta", id, title: opts.title ?? null, createdAt: nextTs(),
      };
      if (!validRawRecord(metaSchema, meta)) throw new Error("Invalid transcript metadata");
      writeFileSync(fileOf(id), `${JSON.stringify(meta)}\n`, { flag: "wx" });
      return id;
    },
    append(sessionId, message, opts = {}) {
      const snapshot = admitted(sessionId);
      if (!snapshot) throw new Error(`Unknown transcript session: ${sessionId}`);
      const record: TranscriptMessageRecord = {
        kind: "message", ts: nextTs(), message,
        ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
      };
      if (!validRawRecord(messageSchema, record)) throw new Error("Invalid transcript message");
      // A complete final record need not have a newline. Separate the next one.
      const separator = snapshot.bytes.length && snapshot.bytes.at(-1) !== 10 ? "\n" : "";
      appendFileSync(fileOf(sessionId), `${separator}${JSON.stringify(record)}\n`);
    },
    list() {
      const sessions: ChatSession[] = [];
      for (const id of ids()) {
        const snapshot = read(id);
        if (!snapshot || snapshot.diagnostic.status === "quarantined") continue;
        const [meta, ...rest] = snapshot.diagnostic.records;
        const messages = rest as TranscriptMessageRecord[];
        const metadata = meta as TranscriptMetaRecord;
        sessions.push({
          id: metadata.id, title: metadata.title, createdAt: metadata.createdAt,
          lastActiveAt: messages.at(-1)?.ts ?? metadata.createdAt,
          totalCostUsd: messages.reduce((sum, message) => sum + (message.costUsd ?? 0), 0),
          numTurns: messages.filter((message) => message.message.role === "user").length,
        });
      }
      return sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    },
    history(sessionId) {
      return (admitted(sessionId)?.diagnostic.records.slice(1) as TranscriptMessageRecord[] | undefined)
        ?.map((record) => record.message) ?? [];
    },
    diagnose(sessionId) {
      return read(sessionId)?.diagnostic ?? { sessionId, status: "missing" };
    },
    quarantined() {
      return ids().map((id) => read(id)?.diagnostic)
        .filter((diagnostic): diagnostic is Inspection["diagnostic"] => diagnostic?.status === "quarantined");
    },
    recover(sessionId, opts) {
      const source = read(sessionId);
      if (!source || source.diagnostic.sourceVersion !== opts.sourceVersion) {
        throw new TranscriptRecoveryError("SOURCE_CHANGED");
      }
      const diagnostic = source.diagnostic;
      if (diagnostic.status !== "quarantined" || !diagnostic.records.length || !diagnostic.failure) {
        throw new TranscriptRecoveryError("NOT_RECOVERABLE");
      }
      const id = `recovered-${hash(`${sessionId}:${opts.sourceVersion}`)}`;
      const originalMeta = diagnostic.records[0] as TranscriptMetaRecord;
      const meta: TranscriptMetaRecord = {
        ...originalMeta, id, title: `Recovered: ${originalMeta.title ?? sessionId}`,
        recovery: {
          sourceSessionId: sessionId, sourceVersion: opts.sourceVersion,
          prefixBytes: diagnostic.prefixBytes, prefixRecords: diagnostic.records.length,
          failure: diagnostic.failure,
        },
      };
      // Replace only metadata; retain admitted message lines byte for byte.
      const prefix = source.bytes.subarray(0, diagnostic.prefixBytes);
      const messageBytes = prefix.subarray(source.metaEnd);
      const payload = Buffer.concat([Buffer.from(`${JSON.stringify(meta)}\n`), messageBytes]);
      const completePayload = payload.at(-1) === 10 ? payload : Buffer.concat([payload, Buffer.from("\n")]);
      if (inspect(id, completePayload).diagnostic.status !== "healthy") {
        throw new TranscriptRecoveryError("NOT_RECOVERABLE");
      }
      const existing = () => {
        const recovered = admitted(id);
        if (!recovered || !recovered.bytes.subarray(0, completePayload.length).equals(completePayload)) {
          throw new TranscriptRecoveryError("RECOVERY_CONFLICT");
        }
        assertVersion(sessionId, opts.sourceVersion);
        syncDirectory();
        return id;
      };
      if (existsSync(fileOf(id))) return existing();
      // Hidden staging files are never normal sessions. A crash before linking
      // leaves only staging evidence; retry converges on the same public id.
      const staging = join(dir, `.${id}-${crypto.randomUUID()}.pending`);
      const fd = openSync(staging, "wx", 0o600);
      try {
        writeFileSync(fd, completePayload);
        fsyncSync(fd);
        assertVersion(sessionId, opts.sourceVersion);
        try { linkSync(staging, fileOf(id)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          return existing();
        }
        // Also catch a source edit racing the publication call. The original
        // remains untouched; discard only this operation's newly linked copy.
        try { assertVersion(sessionId, opts.sourceVersion); }
        catch (error) {
          unlinkSync(fileOf(id));
          syncDirectory();
          throw error;
        }
        syncDirectory();
        return id;
      } finally {
        closeSync(fd);
        unlinkSync(staging);
      }
    },
  };
}
