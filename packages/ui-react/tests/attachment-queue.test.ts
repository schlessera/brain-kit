import { expect, test, vi } from "bun:test";
import type { AttachmentFile } from "@schlessera/brain-ui-sdk/protocol";
import { createAttachmentQueue, fileNameHeader, queuedFileCopy, storedFileCopy, type QueuedFile } from "../src/lib/attachment-queue.js";

// The generic composer queue (#3155, design §6.1, §8.4) against a fixture
// transport. Odysseus fixtures only; no network.

const DRAFT = "6f1c2a4e-1d3b-4f6a-9c2e-0a7d5b3e9f10";
async function settle(predicate: () => boolean, ms = 100) { const end = Date.now() + ms; while (Date.now() <= end) { if (predicate()) return; await Bun.sleep(1); } throw Error("The queue did not settle."); }
const permit = () => new File(["%PDF-1.7\nIthaca harbour permit: mooring fee, water levy\n%%EOF\n"], "ithaca-permit.pdf", { type: "application/pdf" });
function stored(fileId: string, over: Partial<AttachmentFile> = {}): AttachmentFile {
  return { fileId, name: "ithaca-permit.pdf", path: `.brain-ui/attachments/${fileId}/ithaca-permit.pdf`, mediaType: "application/pdf", bytes: 56, sha256: "a".repeat(64), kind: "pdf", reader: "pdf", ...over };
}
const FILE_ID = "0b6d2f3e-8c4a-4e1b-9f7d-2a5c6e8b1d30";

function harness(answer: (call: number, init: RequestInit, url: string) => Promise<Response> | Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const done: { item: QueuedFile; file: AttachmentFile }[] = [];
  const queue = createAttachmentQueue({
    request: async (url, init) => { calls.push({ url, init: init! }); return answer(calls.length, init!, url); },
    apiBase: "/api",
    stored: (item, file) => done.push({ item, file }),
    changed: () => {},
  });
  return { queue, calls, done };
}

test("a PDF goes to the neutral draft route unfiltered, as its own raw bytes, and leaves the queue once stored", async () => {
  const h = harness(() => Response.json(stored(FILE_ID), { status: 201 }));
  try {
    const file = permit();
    expect(h.queue.add([file], DRAFT, { count: 0, bytes: 0 }, null)).toEqual([]);
    await settle(() => h.done.length === 1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe(`/api/drafts/${DRAFT}/files`);
    const headers = new Headers(h.calls[0]!.init.headers);
    expect(headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.get("x-file-name")).toBe("ithaca-permit.pdf");
    expect(headers.get("content-type")).toBe("application/pdf");
    expect(h.calls[0]!.init.body, "the original File, not a multipart form").toBe(file);
    expect(h.done[0]!.file.fileId).toBe(FILE_ID);
    expect(h.done[0]!.item.draftId).toBe(DRAFT);
    expect(h.queue.files).toEqual([]);
  } finally { h.queue.dispose(); }
});

test("a lost answer is unknown, never 'not stored'; the drop's reconnect uploads it again once under the same key", async () => {
  const h = harness((call) => { if (call === 1) throw new TypeError("Failed to fetch"); return Response.json(stored(FILE_ID), { status: 201 }); });
  try {
    h.queue.add([permit()], DRAFT, { count: 0, bytes: 0 }, null);
    await settle(() => h.queue.files[0]?.state === "unknown");
    const copy = queuedFileCopy(h.queue.files[0]!);
    expect(copy.status).toBe("checking upload…");
    expect(`${copy.status} ${copy.detail}`).not.toMatch(/not stored|nothing was stored/i);
    h.queue.setOnline(false);
    expect(h.calls).toHaveLength(1);
    expect(h.queue.files[0]!.state, "it waits for the connection, with the others").toBe("paused");
    h.queue.setOnline(true);
    await settle(() => h.done.length === 1);
    expect(h.calls).toHaveLength(2);
    const key = (n: number) => new Headers(h.calls[n]!.init.headers).get("idempotency-key");
    expect(key(1), "the re-upload replays the same key").toBe(key(0));
    // Stored now: a later reconnect asks nothing more.
    h.queue.setOnline(false); h.queue.setOnline(true);
    expect(h.calls).toHaveLength(2);
  } finally { h.queue.dispose(); }
});

/** `BUSY_RETRY_MS` in attachment-queue.ts: a busy host is asked again after this pause. */
const BUSY_RETRY = 2_000;
/** Promise turns until `predicate` holds; real under the fake clock, unlike `Bun.sleep`. */
async function turns(predicate: () => boolean) {
  for (let turn = 0; !predicate(); turn++) {
    if (turn === 100) throw Error("The queue did not settle.");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("while connected, a lost answer waits for Upload again, which replays the same key; a busy host is asked again with it too", async () => {
  // No automatic loop while the page is online: only Upload again asks. The
  // queue's only clock is its busy-host timer, so a fake clock owns it.
  vi.useFakeTimers();
  const h = harness((call) => {
    if (call === 1) throw new TypeError("Failed to fetch");
    if (call === 2) return Response.json({ error: "busy" }, { status: 503 });
    return Response.json(stored(FILE_ID), { status: 201 });
  });
  try {
    h.queue.add([permit()], DRAFT, { count: 0, bytes: 0 }, null);
    await turns(() => h.queue.files[0]?.state === "unknown");
    expect(vi.getTimerCount(), "no timer is armed to ask again").toBe(0);
    vi.runAllTimers();
    expect(h.calls, "nothing asks again on its own while connected").toHaveLength(1);
    h.queue.retry(h.queue.files[0]!.id);
    await turns(() => h.calls.length === 2 && h.queue.files[0]?.state === "waiting");
    // The busy host is asked again after its pause, not at once.
    vi.advanceTimersByTime(BUSY_RETRY - 1);
    expect(h.calls).toHaveLength(2);
    vi.advanceTimersByTime(1);
    await turns(() => h.done.length === 1);
    expect(h.calls).toHaveLength(3);
    const keys = h.calls.map((c) => new Headers(c.init.headers).get("idempotency-key"));
    expect(new Set(keys).size).toBe(1);
  } finally { h.queue.dispose(); vi.useRealTimers(); }
}, 10_000);

test("host refusals are known not stored and say why; a 5xx is a retryable failure", async () => {
  const answers = [
    Response.json({ error: "ATTACHMENT_TOO_LARGE", message: "", limit: 25_000_000, bound: "file" }, { status: 413 }),
    Response.json({ error: "ATTACHMENT_CAPACITY", message: "", limit: 1, bound: "pool" }, { status: 507 }),
    Response.json({ error: "INTERNAL_ERROR" }, { status: 500 }),
  ];
  const h = harness((call) => answers[call - 1]!);
  try {
    h.queue.add([permit(), permit(), permit()], DRAFT, { count: 0, bytes: 0 }, null);
    await settle(() => h.queue.files.every((f) => f.state === "refused" || f.state === "failed"));
    const [large, full, broken] = h.queue.files.map((f) => ({ state: f.state, ...queuedFileCopy(f) }));
    expect(large).toMatchObject({ state: "refused", status: "too large", detail: "Files can be up to 25 MB each." });
    expect(full).toMatchObject({ state: "refused", status: "not stored · no space", detail: "This host's attachment space is full. Nothing was removed to make room." });
    expect(broken).toMatchObject({ state: "failed", status: "upload failed", detail: "Retrying is safe: it won't store a second copy." });
  } finally { h.queue.dispose(); }
});

test("files over the per-message envelope are not queued and come back as one batch notice", () => {
  const h = harness(() => new Promise<Response>(() => {}));
  try {
    const notices = h.queue.add([permit(), permit(), permit()], DRAFT, { count: 8, bytes: 0 }, { maxFiles: 10, maxFileBytes: 25_000_000, maxTotalBytes: 50_000_000, poolBytes: 1 });
    expect(h.queue.files).toHaveLength(2);
    expect(notices).toEqual(["Up to 10 files per message. 1 wasn't added."]);
  } finally { h.queue.dispose(); }
});

test("stored chips: unread PDF/text says not read yet, no reader says so, a rejected track says so; never readable/processed/decoded/saved", () => {
  const copies = [
    storedFileCopy(stored(FILE_ID)),
    storedFileCopy(stored(FILE_ID, { name: "crew-list.txt", kind: "text", reader: "text", mediaType: "text/plain", bytes: 1_843 })),
    storedFileCopy(stored(FILE_ID, { name: "sirens.m4a", kind: "binary", reader: "none", mediaType: "audio/mp4", bytes: 3_250_000 })),
    storedFileCopy(stored(FILE_ID, { name: "dock-walk.json", kind: "text", reader: "text", mediaType: "application/json", trackRejected: true })),
  ];
  expect(copies.map((c) => c.status)).toEqual(["PDF · 56 B · not read yet", "Text · 1.8 KB · not read yet", "3.1 MB · no reader here", "Text · not a usable track"]);
  for (const copy of copies) expect(`${copy.status} ${copy.detail ?? ""}`).not.toMatch(/\b(readable|processed|decoded|saved)\b/i);
});

test("the file-name hint is percent-encoded and bounded to 1,024 encoded bytes", () => {
  expect(fileNameHeader("Ἰθάκη.pdf")).toBe(encodeURIComponent("Ἰθάκη.pdf"));
  const long = fileNameHeader(`${"Ὀδυσσεύς".repeat(80)}.pdf`);
  expect(long.length).toBeLessThanOrEqual(1024);
  expect(() => decodeURIComponent(long)).not.toThrow();
});

test("an upload Send moved into a held snapshot reports to that snapshot, and a refused one leaves the queue for it (#3155)", async () => {
  const answers: ((r: Response) => void)[] = [];
  const settled: QueuedFile[] = [];
  const done: QueuedFile[] = [];
  const queue = createAttachmentQueue({
    request: () => new Promise<Response>((resolve) => { answers.push(resolve); }),
    apiBase: "/api",
    stored: (item) => done.push(item),
    settled: (item) => { settled.push(item); return item.snapshotId !== undefined; },
    changed: () => {},
  });
  try {
    queue.add([permit()], DRAFT, { count: 0, bytes: 0 }, null);
    await settle(() => queue.files[0]?.state === "uploading");
    // Send happens while the bytes are on the wire.
    queue.assign([queue.files[0]!.id], "snapshot-aeolus");
    answers[0]!(Response.json(stored(FILE_ID), { status: 201 }));
    await settle(() => done.length === 1);
    expect(done[0]!.snapshotId, "the result goes to the snapshot it was moved into").toBe("snapshot-aeolus");
    queue.add([permit()], DRAFT, { count: 0, bytes: 0 }, null);
    await settle(() => queue.files[0]?.state === "uploading");
    queue.assign([queue.files[0]!.id], "snapshot-sirens");
    expect(queue.add([permit()], DRAFT, { count: 9, bytes: 0 }, { maxFiles: 10, maxFileBytes: 25_000_000, maxTotalBytes: 50_000_000, poolBytes: 1 }), "a snapshot's upload does not count against the composer's ten").toEqual([]);
    queue.remove(queue.files.find((item) => !item.snapshotId)!.id);
    answers[1]!(Response.json({ error: "ATTACHMENT_CAPACITY", limit: 1, bound: "pool" }, { status: 507 }));
    await settle(() => settled.length === 1);
    expect(settled[0]!.state).toBe("refused");
    expect(queue.files, "its snapshot recorded the refusal").toEqual([]);
  } finally { queue.dispose(); }
});
