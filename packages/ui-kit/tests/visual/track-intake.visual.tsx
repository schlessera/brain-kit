/** Actual browser picker, image decoding and shared-target multipart with synthetic files. */
import { expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { Composer } from "../../../ui-react/src/components/chat/composer.js";
import { trackView } from "../../../ui-react/tests/track-fixtures.js";
import { registerShareTarget, type ShareFetchEvent } from "../../../ui-sdk/src/client/share-target.js";
import { createMemoryShareStoreForTests } from "../../../ui-sdk/src/client/share-store.js";
import type { ClientChatMessage } from "../../../ui-sdk/src/protocol.js";

for (const width of [390, 1440]) test(`mixed image and track picker preserves the held draft at ${width}px`, async () => {
  const before = { width: innerWidth, height: innerHeight };
  const outer = await commands.formViewport(width, 1000);
  await page.viewport(width, 1000);
  const previousTheme = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = "dark";
  const style = document.createElement("style"); style.textContent = await commands.formConsumerStyles(); document.head.append(style);
  const host = document.createElement("div"); host.style.cssText = "width:100%;padding:20px;box-sizing:border-box;background:var(--bk-color-canvas);color:var(--bk-color-ink)"; document.body.append(host);
  const source = '{"type":"LineString","coordinates":[[3,2],[3.01,2]]}';
  let resolveUpload!: (response: Response) => void;
  let uploaded: File | undefined;
  const ui = createBrainUiRoot({ storage: null, request: async (url, init) => {
    if (url.endsWith("/track-upload")) {
      uploaded = (init!.body as FormData).get("files") as File;
      return new Promise<Response>(resolve => { resolveUpload = resolve; });
    }
    return Response.json({ providers: [], sessions: [], entries: [], models: [] });
  } });
  ui.stores.connection.setState({ wsStatus: "connected", chatRequestAck: true });
  const sent: ClientChatMessage[] = [];
  const renderer = createRoot(host);
  try {
    flushSync(() => renderer.render(<BrainUiProvider root={ui}><Composer send={message => { if (message.type === "chat_message") sent.push(message); return true; }} /></BrainUiProvider>));
    const field = host.querySelector<HTMLTextAreaElement>("textarea")!;
    await userEvent.click(field); await userEvent.keyboard("Show the route beside the raft photo");
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 64; const context = canvas.getContext("2d")!; context.fillStyle = "#3d9b95"; context.fillRect(0,0,64,64); context.fillStyle = "#e4a137"; context.fillRect(10,32,44,12); context.fillStyle = "#f8f4eb"; context.fillRect(30,8,3,24);
    const image = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/png"));
    const transfer = new DataTransfer(); transfer.items.add(new File([source], "loop.json", { type: "application/octet-stream" })); transfer.items.add(new File([image], "raft.png", { type: "image/png" }));
    const input = host.querySelector<HTMLInputElement>('input[accept*=".gpx"]')!;
    input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => host.querySelectorAll('img[alt="raft.png"]').length).toBe(1);
    expect(uploaded).toBeDefined(); expect(await uploaded!.text()).toBe(source); expect(uploaded!.type).toBe("application/octet-stream");
    await userEvent.click(field); await userEvent.keyboard("{Enter}");
    expect(sent).toHaveLength(0); expect(host.textContent).toContain("sends when 1 file finishes");
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    await page.screenshot({ element: host, path: `../../.vitest-attachments/track-intake/held-${width}.png` });
    resolveUpload(Response.json({ files: [trackView().file] }));
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]!.text).toBe("Show the route beside the raft photo"); expect(sent[0]!.files).toHaveLength(1); expect(sent[0]!.attachments).toHaveLength(1); expect(sent[0]!.attachments![0]!.data.length).toBeGreaterThan(100);
    const user = ui.stores.chat.getState().draft!.messages.find(message => message.role === "user");
    expect(user!.files![0]!.summary!.counts.retained).toBe(129); expect(user!.attachments).toHaveLength(1);
    await page.screenshot({ element: host, path: `../../.vitest-attachments/track-intake/ready-${width}.png` });
  } finally {
    flushSync(() => renderer.unmount()); ui.dispose(); host.remove(); style.remove();
    if (previousTheme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = previousTheme;
    await page.viewport(before.width, before.height); await commands.formViewport(outer.width - 100, outer.height - 120);
  }
});

test("the documented GPX manifest reaches a real browser multipart handler with nonempty mixed files and original MIME", async () => {
  // Same target documented in the contract; the SDK unit test reads its exact JSON.
  const store = createMemoryShareStoreForTests(); let listener!: (event: ShareFetchEvent) => void;
  registerShareTarget({ path: "/share-target", store }, { addEventListener(_type, callback) { listener = callback; } });
  const original = '<gpx version="1.1"><trk><trkseg><trkpt lat="2" lon="3"/><trkpt lat="2" lon="3.01"/></trkseg></trk></gpx>';
  const form = new FormData(); form.append("files", new File([original], "shared-1", { type: "application/octet-stream" })); form.append("files", new File([new Uint8Array([1,2,3])], "raft.png", { type: "image/png" })); form.set("text", "Odysseus reviews a synthetic track");
  let response!: Promise<Response>;
  listener({ request: new Request("https://example.test/share-target", { method: "POST", body: form }), respondWith(value) { response = Promise.resolve(value); } });
  expect((await response).status).toBe(303); const records = await store.list(); expect(records).toHaveLength(1); expect(records[0]!.files).toHaveLength(2);
  expect(records[0]!.files[0]!.size).toBeGreaterThan(0); expect(await records[0]!.files[0]!.text()).toBe(original); expect(records[0]!.files[0]!.name).toBe("shared-1"); expect(records[0]!.files[0]!.type).toBe("application/octet-stream"); expect(records[0]!.files[1]!.type).toBe("image/png"); expect(new Uint8Array(await records[0]!.files[1]!.arrayBuffer())).toEqual(new Uint8Array([1,2,3]));
});
