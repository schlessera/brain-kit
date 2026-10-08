import { expect, test } from "bun:test";
import { DAY, fixtures, prepare } from "../scripts/evals/canonical-conflicts/fixtures";
import { collect } from "../scripts/evals/canonical-conflicts/collector";
import { pairs } from "../scripts/evals/canonical-conflicts/prototype";
import { decoded, jevJudge, jevTransport, JevBook, request } from "../scripts/evals/canonical-conflicts/jev";
import { validateCurrent } from "../scripts/evals/canonical-conflicts/current";
import { reconcile, readHygieneLog } from "../packages/core/src/lib/hygiene";

const answer = (noul: number, usage: unknown = { input_tokens: 100, output_tokens: 8 }, model = "jev-1.13.0") => Response.json({ model, usage,
  answers: { sameSubject: { type: "noul", noul }, contradiction: { type: "noul", noul } } });

test("actual core Jev transport observes both complete source orders and persists a finding", async () => {
  const p = prepare(fixtures[0]!); const bodies: any[] = [], book = new JevBook(15);
  try {
    const client = jevTransport(book, async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return answer(0.98); }, "fictional-key");
    const result = await collect(p.root, p.taxonomy, jevJudge(client, book, 0.9));
    expect(result.entries).toHaveLength(1); expect(result.entries[0]!.state).toBe("open"); expect(bodies).toHaveLength(2);
    expect(Object.keys(bodies[0].questions)).toEqual(["sameSubject", "contradiction"]);
    expect(bodies[0].state.first.document).toBe(p.files["me/anchor.md"]); expect(bodies[1].state.first.document).toBe(p.files["profiles/record.md"]);
    expect(bodies[0].state.first.span.text).toBe(fixtures[0]!.anchor); expect(JSON.stringify(bodies)).not.toContain("golden");
    expect(book.calls).toHaveLength(2); expect(book.calls[0]!.inputTokens).toBe(100); expect(book.calls[0]!.outputTokens).toBe(8);
    expect(book.calls[0]!.cacheReadTokens).toBeNull(); expect(book.calls[0]!.cacheWriteTokens).toBeNull(); expect(book.calls[0]!.actualInvoiceUsd).toBeNull();
    expect(book.usd).toBeCloseTo(0.0000084, 10); expect(book.unknown).toBe(false);
  } finally { p.close(); }
});

test("missing physical usage is retained and stops another real transport admission", async () => {
  const p = prepare(fixtures[0]!); let requests = 0; const book = new JevBook(15);
  try {
    const client = jevTransport(book, async () => { requests++; return answer(0.99, {}); }, "fictional-key");
    const result = await collect(p.root, p.taxonomy, jevJudge(client, book, 0.9));
    expect(result.failure).toContain("unknown charge/model/usage"); expect(result.entries).toEqual([]);
    expect(requests).toBe(1); expect(book.calls[0]!.inputTokens).toBeNull(); expect(book.calls[0]!.priceDerivedChargeUsd).toBeNull();
    expect(book.unknown).toBe(true); expect(() => book.reserve(20)).toThrow("no next physical admission");
  } finally { p.close(); }
});

test("failed physical HTTP attempt remains unknown and core retry cannot send another request", async () => {
  const p = prepare(fixtures[0]!); let requests = 0; const book = new JevBook(15);
  try {
    const client = jevTransport(book, async () => { requests++; return Response.json({ error: "scripted overload" }, { status: 529 }); }, "fictional-key");
    const pair = pairs(p.root, p.taxonomy, DAY)[0]!;
    const result = await client.ask(request({ document: pair.canonical.raw, span: pair.anchor }, { document: pair.secondary.raw, span: pair.restatement }));
    expect(result.outcome).not.toBe("answered"); expect(requests).toBe(1); expect(book.calls).toHaveLength(1);
    expect(book.calls[0]!.status).toBe(529); expect(book.calls[0]!.outcome).toBe("http_error"); expect(book.calls[0]!.apiEquivalentUsd).toBeNull();
  } finally { p.close(); }
});

test("unconfigured provider and null/low-probability threshold preserve abstention", async () => {
  const book = new JevBook(15); let requests = 0;
  const client = jevTransport(book, async () => { requests++; return answer(1); }, null);
  const result = await client.ask({ model: "jev-1.13.0", state: "fictional evidence", questions: { sameSubject: { type: "noul", instructions: "Same subject?" } } });
  expect(result.outcome).toBe("no_key"); expect(requests).toBe(0); expect(book.calls).toEqual([]);
  const answered = { outcome: "answered", durationMs: 0, model: "jev-1.13.0", answers: { sameSubject: { type: "noul", noul: 0.8 }, contradiction: { type: "noul", noul: 0.98 } } } as const;
  expect(decoded(answered, null)).toEqual({ sameSubject: "unknown", contradiction: "unknown" });
  expect(decoded(answered, 0.9)).toEqual({ sameSubject: "unknown", contradiction: "yes" });
});

test("current candidate output preserves raw misses separately from code authority/evidence admission", () => {
  const p = prepare(fixtures[0]!);
  try {
    const raw = [
      { category: "conflict" as const, path: "profiles/record.md", evidence: fixtures[0]!.anchor, message: "Different exclusive role." },
      { category: "conflict" as const, path: "profiles/record.md", evidence: "An invented canonical quote", message: "Unsupported claim." },
      { category: "conflict" as const, path: "me/anchor.md", evidence: fixtures[0]!.anchor, message: "Forbidden canonical target." },
    ];
    const parsed = validateCurrent(JSON.stringify(raw), p.root, p.taxonomy);
    expect(parsed.raw).toHaveLength(3); expect(parsed.accepted).toEqual([raw[0]]); expect(parsed.invalid).toHaveLength(2);
    reconcile(p.root, [], new Map(), { now: new Date(DAY), extra: parsed.accepted, failedChecks: ["canonical-conflicts"] });
    const entries = readHygieneLog(p.root); expect(entries).toHaveLength(1); expect(entries[0]!.path).toBe("profiles/record.md");
    p.taxonomy.canonical.identity = "";
    const unconfigured = validateCurrent(JSON.stringify([raw[0]]), p.root, p.taxonomy);
    reconcile(p.root, [], new Map(), { now: new Date(DAY), extra: unconfigured.accepted, failedChecks: ["canonical-conflicts"] });
    expect(unconfigured.accepted).toEqual([]); expect(readHygieneLog(p.root)[0]!.state).toBe("open");
  } finally { p.close(); }
});


test("Jev private physical receipts retain exact successful request and response bytes", async () => {
  const raw = JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 5, output_tokens: 1 }, answers: { sameSubject: { type: "noul", noul: 0.99 }, contradiction: { type: "noul", noul: 0.99 } } });
  let requestBody = ""; const book = new JevBook(15);
  const client = jevTransport(book, async (_url, init) => { requestBody = String(init.body); return new Response(raw); }, "fictional-key");
  await client.ask({ model: "jev-1.13.0", state: { subject: "Odysseus" }, questions: { sameSubject: { type: "noul", instructions: "Same subject", criteria: { true: "same", false: "different" } } } });
  const call = book.calls[0]!;
  expect(Buffer.from(call.rawRequestBase64, "base64").toString()).toBe(requestBody);
  expect(Buffer.from(call.rawResponseBase64, "base64").toString()).toBe(raw);
  expect(call.responseClosed).toBe(true); expect(call.responseEof).toBe(true); expect(call.actualInvoiceUsd).toBeNull();
});

for (const kind of ["binary-http-error", "malformed-json", "stream-error"] as const) test(`Jev failed literal physical payload retained before decode: ${kind}`, async () => {
  const raw = kind === "binary-http-error" ? Uint8Array.from([0, 255, 128]) : new TextEncoder().encode("{malformed Odysseus payload");
  const book = new JevBook(15), client = jevTransport(book, async () => new Response(kind === "stream-error" ? new ReadableStream({ start(c) { c.enqueue(raw); }, pull(c) { c.error(Error("controlled physical failure")); } }) : raw, { status: kind === "binary-http-error" ? 529 : 200 }), "fictional-key");
  await client.ask({ model: "jev-1.13.0", state: { subject: "Odysseus" }, questions: { sameSubject: { type: "noul", instructions: "Same subject", criteria: { true: "same", false: "different" } } } });
  expect(book.calls.length).toBe(1); const call = book.calls[0]!;
  expect(Buffer.from(call.rawResponseBase64, "base64")).toEqual(Buffer.from(raw));
  expect(call.responseEof).toBe(kind !== "stream-error"); expect(call.responseClosed).toBe(true);
  expect(call.apiEquivalentUsd).toBeNull(); expect(call.actualInvoiceUsd).toBeNull(); expect(book.unknown).toBe(true);
});
