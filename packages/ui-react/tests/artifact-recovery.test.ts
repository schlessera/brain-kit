import { afterEach, expect, test } from "bun:test";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.js";

const roots: BrainUiRoot[] = [];
const path = ".brain/scratch/raft/overview.pdf";
afterEach(() => { for (const root of roots.splice(0)) root.dispose(); });

function setup(answer: number | Error) {
  const root = createBrainUiRoot({ storage: null, request: async (url, init) => {
    if (url.includes("/files/resolve")) return Response.json({ ancestors: [] });
    if (url.includes("/files/tree")) return Response.json({ entries: [] });
    if (answer instanceof Error) throw answer;
    return new Response(init?.method === "HEAD" ? null : JSON.stringify({ error: "private backend detail", size: 42 }), { status: answer });
  } });
  roots.push(root);
  return root.stores.file;
}

for (const [answer, kind] of [[new TypeError("offline"), "unreachable"], [403, "forbidden"], [500, "unknown"], [413, "too-large"], [401, "unauthenticated"]] as const) {
  test(`artifact ${kind} is typed uncertainty rather than expiry or backend copy`, async () => {
    const file = setup(answer);
    await file.getState().openFile(path);
    expect(file.getState().contentFailure?.kind, "STRUCTURED_ARTIFACT_OUTCOME").toBe(kind);
    expect(file.getState().contentExpired).toBe(false);
    expect(file.getState().scratchFiles).toEqual({});
    expect(file.getState().contentError).not.toContain("private backend detail");
  });
}

test("ordinary 404 and scratch 404 keep distinct existing evidence", async () => {
  const file = setup(404);
  await file.getState().openFile("notes/raft-reference.md");
  expect(file.getState().contentExpired).toBe(false);
  await file.getState().openFile(path);
  expect(file.getState().contentExpired).toBe(true);
  expect(file.getState().scratchFiles[path]).toBe("expired");
});

test("manual retry owns one attempt while repeated activation cannot accumulate loads", async () => {
  let complete: (response: Response) => void = () => {};
  let requests = 0;
  const root = createBrainUiRoot({ storage: null, request: async url => {
    if (url.includes("/files/resolve")) return Response.json({ ancestors: [] });
    if (url.includes("/files/tree")) return Response.json({ entries: [] });
    if (++requests === 1) throw new TypeError("offline");
    return new Promise<Response>(resolve => { complete = resolve; });
  } });
  roots.push(root);
  const file = root.stores.file;
  await file.getState().openFile(path);
  const first = file.getState().retryFile();
  const second = file.getState().retryFile();
  expect(requests, "ONE_RETRY_REQUEST").toBe(2);
  complete(Response.json({ path, kind: "binary", mime: "application/pdf", size: 42, mtime: 0 }));
  await first;
  await second;
  expect(file.getState().contentFailure).toBeNull();
  expect(file.getState().currentContent?.path).toBe(path);
});

test("a superseded secondary preview 404 cannot expire the newer open or its reference", async () => {
  let answer: (response: Response) => void = () => {};
  const root = createBrainUiRoot({ storage: null, request: async (url, init) => {
    if (url.includes("/files/resolve")) return Response.json({ ancestors: [] });
    if (url.includes("/files/tree")) return Response.json({ entries: [] });
    if (init?.method === "HEAD") return new Promise<Response>(resolve => { answer = resolve; });
    const path = new URL(url, "http://localhost").searchParams.get("path");
    return Response.json({ path, kind: "binary", mime: "application/pdf", size: 42, mtime: 0 });
  } });
  roots.push(root);
  const file = root.stores.file;
  await file.getState().openFile(path);
  const old = file.getState().currentContent!;
  const check = file.getState().checkPreview(old);
  await file.getState().openFile("notes/raft-reference.pdf");
  answer(new Response(null, { status: 404 }));
  expect(await check).toBe(false);
  expect(file.getState().currentContent?.path, "LATEST_PREVIEW_OWNS_RESULT").toBe("notes/raft-reference.pdf");
  expect(file.getState().scratchFiles).toEqual({});
});

for (const status of [200, 404, 403, 413, 500]) {
  test(`secondary preview status ${status} carries evidence without arbitrary copy`, async () => {
    const root = createBrainUiRoot({ storage: null, request: async (url, init) => {
      if (url.includes("/files/resolve")) return Response.json({ ancestors: [] });
      if (url.includes("/files/tree")) return Response.json({ entries: [] });
      if (init?.method === "HEAD") return new Response(null, { status });
      return Response.json({ path, kind: "binary", size: 42, mtime: 0 });
    } });
    roots.push(root);
    const file = root.stores.file;
    await file.getState().openFile(path);
    expect(await file.getState().checkPreview(file.getState().currentContent!)).toBe(status === 200);
    if (status === 404) expect(file.getState().contentExpired).toBe(true);
    else expect(file.getState().contentFailure?.kind).toBe(status === 200 ? undefined : status === 403 ? "forbidden" : status === 413 ? "too-large" : "unknown");
  });
}
