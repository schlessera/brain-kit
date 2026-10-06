import { expect, test } from "bun:test";
import { createTrackUploads, TRACK_MAX_BYTES } from "../src/lib/track-uploads.js";
import { trackView } from "./track-fixtures.js";
import { MAX_ROUTE_BYTES } from "@schlessera/brain-geo/internal";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
async function settle(predicate: () => boolean) { for (let i = 0; i < 50; i++) { if (predicate()) return; await Bun.sleep(1); } throw Error("Upload did not settle."); }
const original = () => new File(['{"type":"LineString","coordinates":[[3,2],[3.01,2]]}'], "shared-1", { type: "application/octet-stream" });
const answer = () => Response.json({ files: [trackView().file] });

test("actual multipart queue preserves original bytes, separates upload/parse states, and admits only canonical track responses", async () => {
  const http = deferred<Response>(); const json = deferred<unknown>();
  const calls: RequestInit[] = [], states: string[] = [];
  const queue = createTrackUploads(async (_url, init) => { calls.push(init!); return http.promise; }, "/api", () => states.push(queue.files[0]?.state ?? "removed"));
  try {
    const file = original(); expect(file.size).toBeGreaterThan(0);
    expect(queue.add([file])).toEqual([]);
    expect(queue.files[0]!.state).toBe("uploading");
    const sent = (calls[0]!.body as FormData).get("files") as File;
    expect(await sent.text()).toBe(await file.text()); expect(sent.name).toBe(file.name); expect(sent.type).toBe(file.type);
    http.resolve({ ok: true, json: () => json.promise } as Response);
    await settle(() => queue.files[0]?.state === "parsing");
    json.resolve({ files: [trackView().file] });
    await settle(() => queue.files[0]?.state === "ready");
    expect(queue.files[0]!.meta!.detected).toBe("geojson");
    expect(states).toContain("picked"); expect(states).toContain("parsing");
  } finally { queue.dispose(); }
});

test("offline pauses and resumes automatically, removal aborts and ignores late completion, and failed uploads retry", async () => {
  let count = 0; let signal: AbortSignal | undefined;
  const late = deferred<Response>();
  const queue = createTrackUploads(async (_url, init) => { signal = init?.signal ?? undefined; return ++count === 1 ? late.promise : count === 2 ? Response.json({ error: "unsupported_track" }, { status: 422 }) : answer(); }, "/api", () => {});
  try {
    queue.setOnline(false); queue.add([original()]); expect(count).toBe(0); expect(queue.files[0]!.state).toBe("paused");
    queue.setOnline(true); expect(count).toBe(1); const id = queue.files[0]!.id;
    queue.remove(id); expect(signal!.aborted).toBe(true); late.resolve(answer());
    await Bun.sleep(2); expect(queue.files).toEqual([]);
    queue.add([original()]); await settle(() => queue.files[0]?.state === "failed");
    expect(queue.files[0]!.error).toContain("ordinary JSON");
    queue.retry(queue.files[0]!.id); await settle(() => queue.files[0]?.state === "ready"); expect(count).toBe(3);
  } finally { queue.dispose(); }
});

test("two concurrent uploads respect mixed-message count, byte and parser limits before upload", async () => {
  expect(TRACK_MAX_BYTES).toBe(MAX_ROUTE_BYTES);
  let count = 0; const held = deferred<Response>();
  const queue = createTrackUploads(async () => { count++; return (await held.promise).clone(); }, "/api", () => {});
  try {
    expect(queue.add([original(), original(), original()])).toEqual([]); expect(count).toBe(2); expect(queue.files[2]!.state).toBe("picked");
    expect(queue.add([original()], 7)).toHaveLength(1); expect(queue.files).toHaveLength(3);
    expect(queue.add([new File([new Uint8Array(TRACK_MAX_BYTES + 1)], "too-big.gpx")])).toHaveLength(1);
    held.resolve(answer()); await settle(() => queue.files.every(f => f.state === "ready")); expect(count).toBe(3);
  } finally { queue.dispose(); }
});
