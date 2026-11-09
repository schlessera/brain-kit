import type { AttachmentFile, ClientMessage, Draft, DraftSnapshot, DraftSnapshotWrite } from "@schlessera/brain-ui-sdk/protocol";

/**
 * A fixture host for outgoing snapshots (#3155), shared by the unit and the
 * browser tests. It keeps, in memory, the rules ui-server's draft store
 * enforces (#3153, #3588), restated here rather than imported:
 *
 * - `PUT /api/drafts/:id` under `If-Match`; a tombstone answers 410.
 * - The whole snapshot list on every save. A new `snapshotId` creates a held
 *   or dispatched snapshot and is refused with `409 DRAFT_OUTGOING_FULL`
 *   when the chat (every live draft of the same session) would exceed the
 *   limit. Allowed moves: held to returned or dispatched, dispatched to
 *   returned; a held one may change its files; only a returned one may be
 *   left out.
 * - Originals: one per upload, minted for one draft (lineage), the same
 *   `fileId` for a repeated `Idempotency-Key`. References are kept per file
 *   (`draft`, `outgoing`, `message`), and a file whose last reference goes
 *   is stamped `unreferencedSince`; nothing here ever unlinks a file.
 * - A save repeated under its `Idempotency-Key` gets the first answer
 *   again, and stores nothing twice (#3153). `loseSaveAnswers` stores each
 *   save and then drops its answer, as a connection lost on the way back.
 * - Acceptance releases only the accepted request's snapshot, in place and
 *   without a revision; a draft whose named revision is current is
 *   tombstoned, or kept at the next revision with an empty composer when
 *   other snapshots remain.
 *
 * Odysseus fixtures only. No key, no network.
 */
export const SESSION = "odysseus-ithaca";

type Row = Draft & { deleted?: boolean };
type Ref = `draft:${string}` | `outgoing:${string}` | `message:${string}`;

export function snapshotHost(options: { limit?: number } = {}) {
  const limit = options.limit ?? 10;
  const rows = new Map<string, Row>();
  const files = new Map<string, AttachmentFile & { draftId: string }>();
  const keys = new Map<string, string>();
  const refs = new Map<string, Set<Ref>>();
  const unreferencedSince = new Map<string, number>();
  /** Files that ever had a reference: the host's 1-hour versus 7-day choice reads this. */
  const everReferenced = new Set<string>();
  const saveAnswers = new Map<string, { revision: number; updatedAt: number }>();
  let loseSaves = false;
  /** Files the host removed from disk: never, before the 7-day sweep this fixture does not run. */
  const unlinked = new Set<string>();
  const calls: string[] = [];
  const saves: { draftId: string; status: number; body: { text: string; fileIds?: string[]; snapshots?: DraftSnapshotWrite[] } }[] = [];
  const uploads: { draftId: string; key: string; name: string }[] = [];
  const recoveryReads: string[] = [];
  let recovery: { revision: number; latestRequestId: string | null } = { revision: 1, latestRequestId: null };
  let seq = 0;
  let clock = Date.UTC(2026, 6, 12, 9, 0, 0);
  const now = () => ++clock;
  let uploadGate: Promise<void> | null = null;
  let saveGate: Promise<void> | null = null;
  let failNext: "refuse" | null = null;
  const json = (body: unknown, status = 200) => Response.json(body, { status });

  function setRefs(kind: "draft" | "outgoing", draftId: string, ids: readonly string[]) {
    const ref = `${kind}:${draftId}` as Ref;
    for (const [fileId, set] of refs) if (set.delete(ref) && set.size === 0 && !ids.includes(fileId)) unreferencedSince.set(fileId, now());
    for (const id of ids) { let set = refs.get(id); if (!set) { set = new Set(); refs.set(id, set); } set.add(ref); unreferencedSince.delete(id); everReferenced.add(id); }
  }
  const snapshotFiles = (list: readonly DraftSnapshot[]) => [...new Set(list.flatMap((s) => s.fileIds))];
  const chatSnapshots = (sessionId: string | null, except: string) => sessionId === null ? 0
    : [...rows.values()].filter((r) => !r.deleted && r.sessionId === sessionId && r.draftId !== except).reduce((n, r) => n + (r.snapshots?.length ?? 0), 0);

  function invalid(message: string) { return json({ error: "DRAFT_INVALID", message }, 400); }

  function nextSnapshots(stored: readonly DraftSnapshot[], writes: readonly DraftSnapshotWrite[]): { list: DraftSnapshot[]; created: number } | Response {
    const byId = new Map(stored.map((s) => [s.snapshotId, s]));
    const seen = new Set<string>();
    const list: DraftSnapshot[] = [];
    let created = 0;
    for (const w of writes) {
      if (seen.has(w.snapshotId)) return invalid("A snapshot is listed twice.");
      seen.add(w.snapshotId);
      const prior = byId.get(w.snapshotId);
      if (!prior) {
        if (w.state === "returned") return invalid("A new snapshot is held or dispatched.");
        list.push({ ...w, fileIds: [...w.fileIds], createdAt: now() });
        created++;
        continue;
      }
      if (w.requestId !== prior.requestId || w.text !== prior.text) return invalid("A snapshot's text and requestId do not change.");
      const same = w.fileIds.length === prior.fileIds.length && w.fileIds.every((id, i) => id === prior.fileIds[i]);
      if (!same && prior.state !== "held") return invalid("Only a held snapshot's files change.");
      const allowed = w.state === prior.state || (prior.state === "held" && (w.state === "returned" || w.state === "dispatched")) || (prior.state === "dispatched" && w.state === "returned");
      if (!allowed) return invalid(`A ${prior.state} snapshot cannot become ${w.state}.`);
      list.push({ ...prior, fileIds: [...w.fileIds], state: w.state });
    }
    for (const prior of stored) if (!seen.has(prior.snapshotId) && prior.state !== "returned") return invalid(`A ${prior.state} snapshot is not deleted; return it first.`);
    return { list, created };
  }

  const view = (row: Row): Draft => {
    const { deleted: _d, ...draft } = row;
    return { ...draft, ...(row.snapshots?.length ? { snapshots: row.snapshots.map((s) => ({ ...s, fileIds: [...s.fileIds] })) } : { snapshots: undefined }) };
  };
  const fileView = (id: string): AttachmentFile => { const { draftId: _l, ...f } = files.get(id)!; return f; };

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const path = new URL(url, "http://fixture.invalid").pathname;
    const method = init.method ?? "GET";
    calls.push(`${method} ${path}`);
    const headers = new Headers(init.headers);
    const recoveryPath = /\/sessions\/([^/]+)\/recovery$/.exec(path);
    if (recoveryPath) {
      const sessionId = decodeURIComponent(recoveryPath[1]!);
      recoveryReads.push(sessionId);
      return json({ sessionId, backendId: "claude", revision: recovery.revision,
        latest: { requestId: recovery.latestRequestId, turnId: recovery.latestRequestId ? "turn-ithaca" : null, state: recovery.latestRequestId ? "running" : "unknown", outcome: null, startedAt: null, endedAt: null }, pending: [] });
    }
    const upload = /\/drafts\/([^/]+)\/files$/.exec(path);
    if (upload) {
      const draftId = decodeURIComponent(upload[1]!);
      const key = headers.get("idempotency-key")!;
      const name = decodeURIComponent(headers.get("x-file-name") ?? "file");
      const bytes = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
      uploads.push({ draftId, key, name });
      if (uploadGate) await uploadGate;
      if (failNext === "refuse") { failNext = null; return json({ error: "ATTACHMENT_CAPACITY", message: "", limit: 1, bound: "pool" }, 507); }
      let fileId = keys.get(`${draftId}:${key}`);
      if (!fileId) {
        fileId = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
        keys.set(`${draftId}:${key}`, fileId);
        const sha256 = fileId.replace(/-/g, "").padEnd(64, "0");
        const p = `.brain-ui/attachments/${fileId}/${name}`;
        files.set(fileId, name.endsWith(".pdf")
          ? { fileId, name, path: p, bytes: bytes.byteLength, sha256, draftId, mediaType: "application/pdf", kind: "pdf", reader: "pdf" }
          : { fileId, name, path: p, bytes: bytes.byteLength, sha256, draftId, mediaType: "text/plain", kind: "text", reader: "text" });
        // An upload not yet bound: the 1-hour clock, from the host's own refs.
        unreferencedSince.set(fileId, now());
      }
      return json(fileView(fileId), 201);
    }
    const draft = /\/drafts(?:\/([^/]+))?$/.exec(path);
    if (draft) {
      const id = draft[1] && decodeURIComponent(draft[1]);
      if (!id) return json({ drafts: [...rows.values()].filter((r) => !r.deleted).map((r) => ({ draftId: r.draftId, sessionId: r.sessionId, revision: r.revision, updatedAt: r.updatedAt, preview: r.text.split("\n")[0] ?? "", attachmentCount: 0, fileCount: r.files?.length ?? 0 })) });
      const row = rows.get(id);
      if (method === "GET") return row && !row.deleted ? json(view(row)) : json({ error: "DRAFT_NOT_FOUND", message: "" }, 404);
      if (row?.deleted) return json({ error: "DRAFT_DELETED", message: "", tombstoneRevision: row.revision }, 410);
      if ((row?.revision ?? 0) !== Number(headers.get("if-match"))) return json({ error: "DRAFT_CONFLICT", message: "", current: row ? view(row) : null }, 409);
      if (method === "DELETE") {
        if (row?.snapshots?.some((s) => s.state !== "returned")) return json({ error: "DRAFT_OUTGOING_PENDING", message: "", current: view(row) }, 409);
        if (row) { row.deleted = true; setRefs("draft", id, []); setRefs("outgoing", id, []); }
        return new Response(null, { status: 204 });
      }
      if (saveGate) await saveGate;
      const saveKey = `${id}:${headers.get("idempotency-key")}`;
      const replay = saveAnswers.get(saveKey);
      if (replay) {
        if (loseSaves) throw new TypeError("Failed to fetch");
        return json(replay);
      }
      const body = JSON.parse(String(init.body)) as { sessionId: string | null; text: string; attachmentIds: string[]; fileIds?: string[]; snapshots?: DraftSnapshotWrite[] };
      const record = (status: number) => saves.push({ draftId: id, status, body: { text: body.text, ...(body.fileIds ? { fileIds: body.fileIds } : {}), ...(body.snapshots ? { snapshots: body.snapshots } : {}) } });
      const ownFile = (fileId: string) => files.get(fileId)?.draftId === id;
      for (const fileId of [...(body.fileIds ?? []), ...(body.snapshots ?? []).flatMap((s) => s.fileIds)]) {
        if (!ownFile(fileId)) { record(400); return json({ error: "ATTACHMENT_INVALID", message: "A file is not stored for this draft; upload it again." }, 400); }
      }
      let snapshots = row?.snapshots ?? [];
      if (body.snapshots !== undefined) {
        const next = nextSnapshots(snapshots, body.snapshots);
        if (next instanceof Response) { record(400); return next; }
        // The reservation: the chat's live snapshots, every draft of it, in this same step.
        if (next.created > 0 && chatSnapshots(body.sessionId, id) + next.list.length > limit) {
          record(409);
          return json({ error: "DRAFT_OUTGOING_FULL", message: "", limit }, 409);
        }
        snapshots = next.list;
      }
      record(200);
      const revision = (row?.revision ?? 0) + 1;
      rows.set(id, { draftId: id, sessionId: body.sessionId, revision, updatedAt: now(), text: body.text, attachments: [],
        files: (body.fileIds ?? []).map(fileView), ...(snapshots.length ? { snapshots } : {}) });
      setRefs("draft", id, body.fileIds ?? []);
      setRefs("outgoing", id, snapshotFiles(snapshots));
      saveAnswers.set(saveKey, { revision, updatedAt: clock });
      // Stored, and the answer lost on the way back.
      if (loseSaves) throw new TypeError("Failed to fetch");
      return json({ revision, updatedAt: clock });
    }
    return json({ providers: [], backends: {} });
  }

  /** The host accepts a chat_message, as ui-server's `accept` does. */
  function accept(frame: Extract<ClientMessage, { type: "chat_message" }>, sessionId = SESSION): "kept" | "consumed" {
    const ref = frame.draftRef;
    for (const r of frame.attachmentRefs ?? []) { let set = refs.get(r.fileId); if (!set) { set = new Set(); refs.set(r.fileId, set); } set.add(`message:${sessionId}`); unreferencedSince.delete(r.fileId); everReferenced.add(r.fileId); }
    if (!ref) return "kept";
    const row = rows.get(ref.draftId);
    if (!row || row.deleted) return "kept";
    const kept = (row.snapshots ?? []).filter((s) => s.requestId !== frame.requestId);
    if (kept.length !== (row.snapshots?.length ?? 0)) {
      // Released in place, without a revision.
      row.snapshots = kept.length ? kept : undefined;
      setRefs("outgoing", row.draftId, snapshotFiles(kept));
    }
    if (row.revision !== ref.revision) return "kept";
    if (kept.length > 0) {
      rows.set(row.draftId, { ...row, revision: row.revision + 1, text: "", files: [], updatedAt: now() });
      setRefs("draft", row.draftId, []);
      return "consumed";
    }
    row.deleted = true;
    setRefs("draft", row.draftId, []);
    return "consumed";
  }

  /** Another device's draft of the chat, already holding these snapshots. */
  function seed(draftId: string, snapshots: Array<Omit<DraftSnapshot, "createdAt" | "fileIds"> & { fileIds?: string[] }>, sessionId: string | null = SESSION, text = "") {
    const list = snapshots.map((s) => ({ ...s, fileIds: s.fileIds ?? [], createdAt: now() }));
    rows.set(draftId, { draftId, sessionId, revision: 1, updatedAt: now(), text, attachments: [], files: [], ...(list.length ? { snapshots: list } : {}) });
    setRefs("outgoing", draftId, snapshotFiles(list));
  }

  /** A stored original minted for a draft, as if uploaded earlier. */
  function storeFile(draftId: string, name: string): string {
    const fileId = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
    files.set(fileId, { fileId, name, path: `.brain-ui/attachments/${fileId}/${name}`, bytes: 64, sha256: fileId.replace(/-/g, "").padEnd(64, "0"), draftId, mediaType: "text/plain", kind: "text", reader: "text" });
    return fileId;
  }

  return {
    request, rows, files, refs, unreferencedSince, unlinked, calls, saves, uploads, recoveryReads,
    accept, seed, storeFile,
    /** Live snapshots of the chat, across its drafts. */
    count: (sessionId = SESSION) => chatSnapshots(sessionId, ""),
    snapshotsOf: (draftId: string) => rows.get(draftId)?.snapshots ?? [],
    setRecovery(next: { revision: number; latestRequestId: string | null }) { recovery = next; },
    /** Hold every upload's answer until released. */
    holdUploads(): () => void {
      let release!: () => void;
      uploadGate = new Promise<void>((resolve) => { release = () => { uploadGate = null; resolve(); }; });
      return release;
    },
    refuseNextUpload() { failNext = "refuse"; },
    /** Store every save, then drop its answer, until set back. */
    loseSaveAnswers(value = true) { loseSaves = value; },
    /**
     * The cleanup rule the host's own references put a stored file under
     * (#3151 §6.7): `kept` while referenced, `1 hour` when it was never
     * bound, `7 days` from its last reference otherwise.
     */
    cleanupRule(fileId: string): "kept" | "1 hour" | "7 days" {
      if ((refs.get(fileId)?.size ?? 0) > 0) return "kept";
      return everReferenced.has(fileId) ? "7 days" : "1 hour";
    },
    /** Hold every draft save's answer until released. */
    holdSaves(): () => void {
      let release!: () => void;
      saveGate = new Promise<void>((resolve) => { release = () => { saveGate = null; resolve(); }; });
      return release;
    },
  };
}

export type SnapshotHost = ReturnType<typeof snapshotHost>;
