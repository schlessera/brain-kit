import { expect, test } from "bun:test";
import { join } from "node:path";
import { ATTACHMENT_READ_MAX_CALL_BYTES } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createExtractor, EXTRACTOR_BOUNDS } from "../src/attachments/extract";
import { cutUtf8 } from "../src/attachments/extract-protocol";
import { ithacaPermitPdf, logbookPdf, odysseusPdf, PERMIT_FACT } from "./helpers/odysseus-pdf";

// The PDF extractor child and its bounds (#3154, docs/plans/chat-attachments.md
// §7.3). Every case runs the real child process over a deterministic Odysseus
// PDF; the bound cases swap in a misbehaving child.

const MISBEHAVING = join(import.meta.dir, "fixtures/extract-misbehaving-worker.ts");
const live = () => new AbortController().signal;
/** The page text without the markers this reader adds, in order. */
const strip = (text: string) => text.replace(/\n?\[page \d+(?:, continued)?\]\n/g, "");
const request = (startPage: number, endPage: number, offset = 0, maxBytes = ATTACHMENT_READ_MAX_CALL_BYTES) => ({ startPage, endPage, offset, maxBytes });

test("the child reads only the requested pages of a real text-bearing PDF", async () => {
  const extractor = createExtractor();
  const page2 = await extractor.extract(ithacaPermitPdf(), request(2, 2), live());
  expect(page2).toEqual({ outcome: "text", pageCount: 3, pages: [2, 2], pagesWithoutText: [],
    text: `[page 2]\nConditions of mooring\n${PERMIT_FACT}\nPenelope countersigns for the household.` });
  const page1 = await extractor.extract(ithacaPermitPdf(), request(1, 1), live());
  expect(page1.outcome === "text" && page1.text).not.toContain(PERMIT_FACT);
  // A range past the end is clamped to the document; a start past it is refused.
  expect(await extractor.extract(ithacaPermitPdf(), request(3, 9), live())).toMatchObject({ outcome: "text", pages: [3, 3], pageCount: 3 });
  expect(await extractor.extract(ithacaPermitPdf(), request(4, 5), live())).toEqual({ outcome: "out_of_range", pageCount: 3 });
});

test("encrypted, malformed, non-PDF and image-only inputs get their own outcome", async () => {
  const extractor = createExtractor();
  expect(await extractor.extract(odysseusPdf([{ lines: ["The suitors' names"] }], { encrypted: true }), request(1, 1), live())).toEqual({ outcome: "encrypted" });
  expect(await extractor.extract(ithacaPermitPdf().subarray(0, 300), request(1, 1), live())).toEqual({ outcome: "malformed" });
  expect(await extractor.extract(new TextEncoder().encode("Crew list: Eurylochus, Perimedes"), request(1, 1), live())).toEqual({ outcome: "malformed" });
  // A scanned page: valid, with drawing operators and no text.
  expect(await extractor.extract(odysseusPdf([{}, { lines: ["Ithaca at dawn"] }, {}]), request(1, 3), live()))
    .toEqual({ outcome: "text", pageCount: 3, pages: [1, 3], pagesWithoutText: [1, 3], text: "[page 2]\nIthaca at dawn" });
});

test("the output bound cuts on a code point, and continuing loses and repeats nothing", async () => {
  const extractor = createExtractor();
  const pdf = logbookPdf(20, 100);
  const whole = await extractor.extract(pdf, request(1, 20, 0, 10_000_000), live());
  if (whole.outcome !== "text") throw new Error(whole.outcome);
  expect(Buffer.byteLength(whole.text)).toBeGreaterThan(ATTACHMENT_READ_MAX_CALL_BYTES * 2);
  let collected = "", cursor = { page: 1, offset: 0 }, calls = 0;
  for (;;) {
    const part = await extractor.extract(pdf, request(cursor.page, 20, cursor.offset), live());
    if (part.outcome !== "text") throw new Error(part.outcome);
    expect(Buffer.byteLength(part.text), "EXTRACT_CALL_BOUND").toBeLessThanOrEqual(ATTACHMENT_READ_MAX_CALL_BYTES);
    calls++;
    collected += strip(part.text);
    if (!part.next) break;
    cursor = part.next;
  }
  expect(calls).toBeGreaterThan(2);
  expect(collected, "EXTRACT_CONTINUATION_EXACT").toBe(strip(whole.text));
  // Multi-byte text is never split.
  const bytes = new TextEncoder().encode("Ὀδυσσεύς");
  for (let max = 0; max <= bytes.length; max++) expect(() => new TextDecoder("utf-8", { fatal: true }).decode(cutUtf8(bytes, max))).not.toThrow();
});

test("wall clock, CPU and memory bounds stop the child, and the rest of the host queues", async () => {
  const slow = createExtractor({ timeoutMs: 400 }, { worker: MISBEHAVING });
  const started = Date.now();
  expect(await slow.extract(new Uint8Array(8), request(1, 1, 5_000), live()), "EXTRACT_TIMEOUT").toEqual({ outcome: "failed", reason: "timeout" });
  expect(Date.now() - started).toBeLessThan(4_000);
  const flood = createExtractor({}, { worker: MISBEHAVING });
  expect(await flood.extract(new Uint8Array(8), request(4, 4), live())).toEqual({ outcome: "failed", reason: "crash" });

  const limited = createExtractor({ cpuSeconds: 1, dataBytes: 268_435_456 }, { worker: MISBEHAVING });
  if (!limited.limited) throw new Error("prlimit is required on this host for the CPU and memory bounds");
  expect(await limited.extract(new Uint8Array(8), request(2, 2), live()), "EXTRACT_CPU_BOUND").toEqual({ outcome: "failed", reason: "resource_limit" });
  expect(await limited.extract(new Uint8Array(8), request(3, 3), live()), "EXTRACT_MEMORY_BOUND").toEqual({ outcome: "failed", reason: "resource_limit" });

  // One slot: the second read waits for the first, it never runs beside it.
  const single = createExtractor({ concurrency: 1 }, { worker: MISBEHAVING });
  const at = Date.now();
  const both = await Promise.all([single.extract(new Uint8Array(8), request(1, 1, 300), live()), single.extract(new Uint8Array(8), request(1, 1, 300), live())]);
  expect(both).toEqual([{ outcome: "malformed" }, { outcome: "malformed" }]);
  expect(Date.now() - at, "EXTRACT_CONCURRENCY_QUEUES").toBeGreaterThanOrEqual(600);
  expect(EXTRACTOR_BOUNDS).toEqual({ timeoutMs: 30_000, cpuSeconds: 20, dataBytes: 1_073_741_824, concurrency: 2 });
});

test("cancelling the turn kills a running child and drops a queued one", async () => {
  const single = createExtractor({ concurrency: 1 }, { worker: MISBEHAVING });
  const controller = new AbortController();
  // Observe the first child's spawn. The extractor arms its abort listener in
  // the same synchronous step, so once the spawn has returned the child is
  // running and cancellable, and the second read is waiting for its slot.
  const descriptor = Object.getOwnPropertyDescriptor(Bun, "spawn")!;
  const spawned = Promise.withResolvers<void>();
  Object.defineProperty(Bun, "spawn", { ...descriptor, value: (...args: Parameters<typeof Bun.spawn>) => {
    const child = (descriptor.value as typeof Bun.spawn)(...args);
    spawned.resolve();
    return child;
  } });
  try {
    const running = single.extract(new Uint8Array(8), request(1, 1, 10_000), controller.signal);
    const queued = single.extract(new Uint8Array(8), request(1, 1, 10_000), controller.signal);
    // Bounded, so a read that settles without spawning, or never spawns, fails
    // here and the finally below still restores Bun.spawn.
    let bound: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([spawned.promise,
        running.then(result => { throw new Error(`EXTRACT_SETTLED_BEFORE_SPAWN: ${JSON.stringify(result)}`); }),
        new Promise<never>((_, reject) => { bound = setTimeout(() => reject(new Error("EXTRACT_NEVER_SPAWNED")), 10_000); })]);
    } finally { clearTimeout(bound); }
    const at = Date.now();
    controller.abort();
    expect(await running, "EXTRACT_CANCEL_RUNNING").toEqual({ outcome: "cancelled" });
    expect(await queued, "EXTRACT_CANCEL_QUEUED").toEqual({ outcome: "cancelled" });
    expect(Date.now() - at).toBeLessThan(2_000);
  } finally { Object.defineProperty(Bun, "spawn", descriptor); }
  expect(Object.getOwnPropertyDescriptor(Bun, "spawn"), "EXTRACT_SPAWN_DESCRIPTOR_RESTORED").toEqual(descriptor);
  // The slot is free again afterwards.
  expect(await single.extract(new Uint8Array(8), request(1, 1, 10), live())).toEqual({ outcome: "malformed" });
});
