/**
 * Sent-row read states (#3155, design §8.4 sent rows, rev 3 §6): what a row
 * says comes only from the host's read records (#3589), never from a file's
 * kind or reader, and the reads client delivers those records per session.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AttachmentFile, AttachmentReadEntry } from "@schlessera/brain-ui-sdk/protocol";
import { attachmentRowProps, readCopy } from "../src/lib/track-attachment.js";
import { createAttachmentReadStore } from "../src/stores/attachment-read-state.js";
import { createAttachmentReadClient } from "../src/lib/attachment-reads.js";
import { createBrainUiRoot } from "../src/root.js";

const PERMIT: AttachmentFile = {
  fileId: "00000000-0000-4000-8000-000000000001", name: "ithaca-permit.pdf", path: ".brain-ui/attachments/00000000-0000-4000-8000-000000000001/ithaca-permit.pdf",
  mediaType: "application/pdf", bytes: 2_516_582, sha256: "a".repeat(64), kind: "pdf", reader: "pdf",
};
const CREW: AttachmentFile = { ...PERMIT, fileId: "00000000-0000-4000-8000-000000000002", name: "crew-list.txt", mediaType: "text/plain", bytes: 1_843, kind: "text", reader: "text" };
const SIRENS: AttachmentFile = { ...PERMIT, fileId: "00000000-0000-4000-8000-000000000003", name: "sirens.m4a", mediaType: "audio/mp4", bytes: 3_250_000, kind: "binary", reader: "none" };

let at = 1_783_836_720_000;
const pdf = (outcome: AttachmentReadEntry["outcome"], pages?: [number, number], pageCount = 12): AttachmentReadEntry =>
  ({ fileId: PERMIT.fileId, turnId: `turn-${at}`, outcome, scope: pages ? { pages, pageCount } : null, at: at++ });
const text = (outcome: AttachmentReadEntry["outcome"], bytes?: [number, number], totalBytes = 1_843): AttachmentReadEntry =>
  ({ fileId: CREW.fileId, turnId: `turn-${at}`, outcome, scope: bytes ? { bytes, totalBytes } : null, at: at++ });
const meta = (file: AttachmentFile, reads?: AttachmentReadEntry[]) => (attachmentRowProps(file, reads).meta as string[])[0];

describe("readCopy", () => {
  test("no record is no claim", () => expect(readCopy([])).toBeNull());
  test("a whole PDF read in one call reads as read, a range names its pages", () => {
    expect(readCopy([pdf("read", [1, 12])])).toEqual({ text: "read", tone: "teal" });
    expect(readCopy([pdf("read", [1, 3])])).toEqual({ text: "read p. 1–3", tone: "teal" });
  });
  test("later ranges join earlier ones instead of hiding them", () => {
    expect(readCopy([pdf("read", [1, 3]), pdf("read", [4, 6])])!.text).toBe("read p. 1–6");
    expect(readCopy([pdf("read", [1, 2]), pdf("read", [9, 9])])!.text).toBe("read p. 1–2, 9");
    expect(readCopy([pdf("read", [1, 6]), pdf("read", [7, 12])])!.text).toBe("read");
  });
  test("a partial PDF read never reads as read", () => {
    expect(readCopy([pdf("partial", [1, 3])])).toEqual({ text: "partly read p. 1–3", tone: "amber" });
  });
  test("text reads by byte range: whole, cut short, and continued to the end", () => {
    expect(readCopy([text("read", [0, 1_843])])).toEqual({ text: "read", tone: "teal" });
    expect(readCopy([text("partial", [0, 1_024])])).toEqual({ text: "read stopped at 1.0 KB", tone: "amber" });
    expect(readCopy([text("partial", [0, 1_024]), text("read", [1_024, 1_843])])!.text).toBe("read");
  });
  test("failures show only when nothing was read, and say what the record knows", () => {
    expect(readCopy([pdf("no_text", [1, 3])])!.text).toBe("no text found · may be scanned");
    expect(readCopy([pdf("encrypted")])!.text).toBe("couldn't read: password-protected");
    expect(readCopy([pdf("malformed")])!.text).toBe("couldn't read: damaged file");
    expect(readCopy([pdf("failed")])!.text, "the record has no reason, so none is named").toBe("couldn't read");
    expect(readCopy([pdf("unavailable")])).toEqual({ text: "no reader for this kind of file", tone: "neutral" });
    expect(readCopy([pdf("read", [1, 3]), pdf("failed")])!.text, "an earlier read still stands").toBe("read p. 1–3");
  });
  test("a changed original always shows, even after reads", () => {
    expect(readCopy([pdf("read", [1, 12]), pdf("changed")])).toEqual({ text: "original changed since sending", tone: "amber" });
  });
});

describe("attachmentRowProps", () => {
  test("without records the row claims neither read nor not read yet", () => {
    expect(meta(PERMIT)).toBe("PDF · 2.4 MB · sent");
    expect(meta(SIRENS)).toBe("Binary · 3.1 MB · sent".replace("Binary", attachmentRowProps(SIRENS).meta![0]!.split(" · ")[0]!));
  });
  test("with records, an unread readable file is not read yet and an unreadable one has no reader", () => {
    expect(meta(PERMIT, [])).toBe("PDF · 2.4 MB · not read yet");
    expect(meta(CREW, [])).toBe("Text · 1.8 KB · not read yet");
    expect(meta(SIRENS, [])).toBe("3.1 MB · no reader for this kind of file");
  });
  test("a recorded read drives the meta and tone", () => {
    const row = attachmentRowProps(PERMIT, [pdf("read", [1, 3])]);
    expect(row.meta).toEqual(["PDF · 2.4 MB · read p. 1–3"]);
    expect(row.tone).toBe("teal");
  });
  test("an image never reads as not read yet", () => {
    expect(meta({ ...PERMIT, kind: "image", reader: "image", mediaType: "image/jpeg" }, [])).toMatch(/ · sent$/);
  });
});

describe("reads client", () => {
  const SESSION = "odysseus-ithaca";
  const roots: { dispose(): void }[] = [];
  afterEach(() => { for (const r of roots.splice(0)) r.dispose(); });
  function rig(answer: (url: string) => Promise<Response>) {
    const root = createBrainUiRoot({ storage: null });
    roots.push(root);
    const chat = root.stores.chat;
    const attachmentReads = createAttachmentReadStore();
    const asked: string[] = [];
    const client = createAttachmentReadClient({
      stores: { chat, attachmentReads } as never,
      apiBase: () => "/api",
      request: async (url) => { asked.push(url); return answer(url); },
    });
    const hello = (attachmentReads_: boolean) => client.hello({ type: "server_hello", protocolRev: 5, capabilities: attachmentReads_ ? { attachmentReads: true } : {} } as never);
    return { chat, store: attachmentReads, client, asked, hello };
  }
  test("a host without the capability is never asked, and rows stay without a claim", async () => {
    const r = rig(async () => Response.json({}));
    r.chat.getState().setActiveSession(SESSION);
    r.hello(false);
    await Bun.sleep(0);
    expect(r.asked).toEqual([]);
    expect(r.store.getState().loaded[SESSION]).toBeUndefined();
  });
  test("the session in view is read once per hello; a frame adds a read once", async () => {
    const r = rig(async () => Response.json({ sessionId: SESSION, reads: [pdf("read", [1, 3])] }));
    r.chat.getState().setActiveSession(SESSION);
    r.hello(true);
    await Bun.sleep(0); await Bun.sleep(0);
    expect(r.asked).toEqual([`/api/sessions/${SESSION}/attachment-reads`]);
    expect(r.store.getState().loaded[SESSION]).toBe(true);
    const later = pdf("read", [4, 6]);
    r.client.frame({ type: "attachment_read", sessionId: SESSION, read: later });
    r.client.frame({ type: "attachment_read", sessionId: SESSION, read: later });
    expect(r.store.getState().reads[SESSION]![PERMIT.fileId]).toHaveLength(2);
  });
  test("an answer from before a new hello is dropped; the new connection asks again", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let n = 0;
    const r = rig(async () => { if (n++ === 0) await gate; return Response.json({ sessionId: SESSION, reads: n === 1 ? [pdf("read", [1, 1])] : [] }); });
    r.chat.getState().setActiveSession(SESSION);
    r.hello(true);
    r.hello(true);
    release();
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    expect(r.store.getState().reads[SESSION]?.[PERMIT.fileId]).toBeUndefined();
  });
  test("opening another session reads that one", async () => {
    const r = rig(async (url) => Response.json({ sessionId: decodeURIComponent(url.split("/")[3]!), reads: [] }));
    r.hello(true);
    r.chat.getState().setActiveSession("odysseus-aeolus");
    await Bun.sleep(0); await Bun.sleep(0);
    expect(r.asked).toEqual(["/api/sessions/odysseus-aeolus/attachment-reads"]);
    expect(r.store.getState().loaded["odysseus-aeolus"]).toBe(true);
  });
});
