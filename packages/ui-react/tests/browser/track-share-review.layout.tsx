/// <reference types="@vitest/browser-playwright" />
/** Lifecycle assertions migrated from render-smoke to their native storage boundary. */
import { expect, test, vi, type TestContext } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { ShareIntake } from "../../src/components/chat/share-card.js";
import { handleShareTargetRequest } from "@schlessera/brain-ui-sdk/internal/client";
import { trackOriginal, trackView } from "../track-fixtures.js";
import type { ClientChatMessage } from "@schlessera/brain-ui-sdk/protocol";

async function mountedShare(ctx: TestContext) {
  const online = Object.getOwnPropertyDescriptor(navigator, "onLine");
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
  ctx.onTestFinished(() => { if (online) Object.defineProperty(navigator, "onLine", online); else delete (navigator as { onLine?: boolean }).onLine; });
  const uploads: Array<{ signal: AbortSignal; resolve(response: Response): void; original: Promise<string> }> = [];
  const sent: ClientChatMessage[] = [];
  const account = `odysseus-track-share-${crypto.randomUUID()}`;
  const root = createBrainUiRoot({ storage: localStorage, storagePrefix: account, request: async (url, init) => {
    if (url.endsWith("/share")) return new Promise<Response>((resolve, reject) => {
      const signal = init!.signal!;
      const form = init!.body as FormData;
      uploads.push({ signal, resolve, original: (form.get("files") as File).text() });
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    return Response.json({ providers: [] });
  } });
  const sendSpy = vi.spyOn(root.connection, "send").mockImplementation(message => { if (message.type === "chat_message") sent.push(message); return true; });
  root.stores.connection.getState().setVpnStatus("connected", account);
  root.stores.connection.getState().setWsStatus("connected");
  const form = new FormData(); form.set("text", "Review this synthetic loop");
  form.set("files", new File([trackOriginal()], "Ithaca loop.geojson", { type: "application/octet-stream" }));
  expect((await handleShareTargetRequest(new Request(`${location.origin}/share-target`, { method: "POST", body: form }))).status).toBe(303);
  const host = document.createElement("div"); document.body.append(host);
  const renderer = createRoot(host);
  ctx.onTestFinished(() => { flushSync(() => renderer.unmount()); sendSpy.mockRestore(); root.dispose(); host.remove(); });
  flushSync(() => renderer.render(<BrainUiProvider root={root}><ShareIntake /></BrainUiProvider>));
  await expect.poll(() => root.stores.share.getState().queue.length).toBe(1);
  const ready = (index: number) => { const file = trackView().file; uploads[index]!.resolve(Response.json({ id: "odysseus-track-intake", receivedAt: Date.now(), text: "Review this synthetic loop", dir: file.path.slice(0, file.path.lastIndexOf("/")), files: [file] })); };
  return { root, host, uploads, sent, ready };
}

test("an unseen share stays under review across connection changes, and dismiss cancels a confirmed upload without dispatch", async ctx => {
  const h = await mountedShare(ctx);
  expect(h.host.textContent).toContain("Ithaca loop.geojson"); expect(h.host.textContent).toContain("awaiting your review");
  h.root.stores.connection.getState().setWsStatus("disconnected"); h.root.stores.connection.getState().setWsStatus("connected");
  expect(h.uploads).toHaveLength(0); expect(h.sent).toHaveLength(0);
  await userEvent.click(page.getByRole("button", { name: "Add to brain", exact: true }));
  await expect.poll(() => h.uploads.length).toBe(1); expect(h.host.textContent).toContain("uploading…");
  await userEvent.click(page.getByRole("button", { name: "Dismiss shared files", exact: true }));
  expect(h.uploads[0]!.signal.aborted).toBe(true);
  h.ready(0);
  await expect.poll(() => h.root.stores.share.getState().queue.length).toBe(0);
  expect(h.sent).toHaveLength(0);
});

test("only an explicitly confirmed share resumes after an interrupted upload, retaining nonempty canonical file evidence", async ctx => {
  const h = await mountedShare(ctx);
  await userEvent.click(page.getByRole("button", { name: "Add to brain", exact: true }));
  await expect.poll(() => h.uploads.length).toBe(1);
  h.root.stores.connection.getState().setWsStatus("disconnected");
  await expect.poll(() => h.uploads[0]!.signal.aborted).toBe(true); expect(h.sent).toHaveLength(0);
  await expect.poll(() => h.host.textContent).toContain("waiting for connection");
  h.root.stores.connection.getState().setWsStatus("connected");
  await expect.poll(() => h.uploads.length).toBe(2);
  expect(await h.uploads[1]!.original).toBe(trackOriginal());
  h.ready(1);
  await expect.poll(() => h.sent.length).toBe(1);
  expect(h.sent[0]!.files).toHaveLength(1); expect(h.sent[0]!.files![0]!.path).toBe(trackView().file.path);
  const user = h.root.stores.chat.getState().draft!.messages.find(message => message.role === "user");
  expect(user!.files![0]!.summary!.counts.retained).toBe(129);
  expect(h.root.stores.share.getState().queue).toHaveLength(0);
  const form = new FormData(); form.set("text", "Inspect the next unconfirmed route.");
  await handleShareTargetRequest(new Request(`${location.origin}/share-target`, { method: "POST", body: form }));
  await expect.poll(() => h.root.stores.share.getState().queue.length).toBe(1);
  h.root.stores.connection.getState().setWsStatus("disconnected"); h.root.stores.connection.getState().setWsStatus("connected");
  expect(h.uploads).toHaveLength(2); expect(h.sent).toHaveLength(1);
});
