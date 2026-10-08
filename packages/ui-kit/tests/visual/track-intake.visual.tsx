/** Actual browser picker, image decoding and shared-target multipart with synthetic files. */
import { expect, test, vi } from "vitest";
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

/** Keep the connectivity gate local; inherit the original property again on every exit. */
async function withNavigatorOnline(initial: boolean, run: (setOnline: (online: boolean) => void) => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(navigator, "onLine");
  let online = initial;
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  try {
    await run(value => {
      online = value;
      window.dispatchEvent(new Event(value ? "online" : "offline"));
    });
  } finally {
    if (previous) Object.defineProperty(navigator, "onLine", previous);
    else Reflect.deleteProperty(navigator, "onLine");
  }
}

async function mixedPicker(width: number, initiallyOnline: boolean) {
  await withNavigatorOnline(initiallyOnline, async setOnline => {
    const before = { width: innerWidth, height: innerHeight };
    const previousTheme = document.documentElement.dataset.theme;
    const style = document.createElement("style");
    const host = document.createElement("div");
    const source = '{"type":"LineString","coordinates":[[3,2],[3.01,2]]}';
    const text = "Show the route beside the raft photo";
    let resolveUpload!: (response: Response) => void;
    let uploaded: File | undefined;
    let uploadCount = 0;
    const started = performance.now();
    const trace: Record<string, unknown>[] = [];
    const record = (stage: string, detail: Record<string, unknown> = {}) => trace.push({stage, ms: Math.round(performance.now() - started), ...detail});
    const nativeBitmap = globalThis.createImageBitmap;
    const nativeToBlob = HTMLCanvasElement.prototype.toBlob;
    const nativeRead = FileReader.prototype.readAsDataURL;
    const nativeDecode = HTMLImageElement.prototype.decode;
    const nativeObjectUrl = URL.createObjectURL;
    const nativeRevoke = URL.revokeObjectURL;
    const restores: (() => void)[] = [];
    const snapshot = (stage: string) => {
      const drafts = ui.stores.drafts.getState();
      record(stage, { online: navigator.onLine, uploadCount,
        authEpoch: ui.authLock.epoch(), authPhase: ui.authLock.state.getState().phase,
        sessionId: ui.stores.chat.getState().activeSessionId,
        activeDraft: drafts.idFor(ui.stores.chat.getState().activeSessionId),
        images: Array.from(host.querySelectorAll('img'), img => ({alt:img.alt,complete:img.complete,width:img.naturalWidth})),
        text: host.textContent?.slice(0,1200), field:host.querySelector('textarea')?.value,
        drafts: Object.entries(drafts.drafts).map(([id,draft]) => ({id,textLength:draft.text.length,attachments:draft.attachments.map(image=>({name:image.name,bytes:image.bytes}))})),
      });
    };
    const ui = createBrainUiRoot({ storage: null, request: async (url, init) => {
      if (url.endsWith("/track-upload")) {
        uploadCount++;
        uploaded = (init!.body as FormData).get("files") as File;
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          const aborted = () => reject(new DOMException("Fixture upload aborted", "AbortError"));
          resolveUpload = response => { signal?.removeEventListener("abort", aborted); resolve(response); };
          if (signal?.aborted) aborted(); else signal?.addEventListener("abort", aborted, { once: true });
        });
      }
      return Response.json({ providers: [], sessions: [], entries: [], models: [] });
    } });
    ui.stores.connection.setState({ wsStatus: "connected", chatRequestAck: true });
    const sent: ClientChatMessage[] = [];
    let renderer: ReturnType<typeof createRoot> | undefined;
    let outer: { width: number; height: number } | undefined;
    try {
      outer = await commands.formViewport(width, 1000);
      await page.viewport(width, 1000);
      document.documentElement.dataset.theme = "dark";
      style.textContent = await commands.formConsumerStyles(); document.head.append(style);
      host.style.cssText = "width:100%;padding:20px;box-sizing:border-box;background:var(--bk-color-canvas);color:var(--bk-color-ink)"; document.body.append(host);
      const mounted = createRoot(host);
      renderer = mounted;
      flushSync(() => mounted.render(<BrainUiProvider root={ui}><Composer send={message => { if (message.type === "chat_message") sent.push(message); return true; }} /></BrainUiProvider>));
      const field = host.querySelector<HTMLTextAreaElement>("textarea")!;
      await userEvent.click(field); await userEvent.keyboard(text);
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 64; const context = canvas.getContext("2d")!; context.fillStyle = "#3d9b95"; context.fillRect(0,0,64,64); context.fillStyle = "#e4a137"; context.fillRect(10,32,44,12); context.fillStyle = "#f8f4eb"; context.fillRect(30,8,3,24);
      const image = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/png"));
      const transfer = new DataTransfer(); transfer.items.add(new File([source], "loop.json", { type: "application/octet-stream" })); transfer.items.add(new File([image], "raft.png", { type: "image/png" }));
      // Composer resets the picker after consuming it, which also clears this live FileList.
      const originals = Array.from(transfer.files);
      expect(originals).toHaveLength(2);
      const input = host.querySelector<HTMLInputElement>('input[accept*=".gpx"]')!;
      const bitmap = vi.spyOn(globalThis, "createImageBitmap").mockImplementation(((...args: unknown[]) => {
        record("bitmap-start", {size:(args[0] as Blob).size,type:(args[0] as Blob).type});
        const result: Promise<ImageBitmap> = Reflect.apply(nativeBitmap, globalThis, args);
        void result.then(bitmap => record("bitmap-done", {width:bitmap.width,height:bitmap.height}),
          error => record("bitmap-error", {message:String(error)}));
        // Return the native promise, preserving the product's continuation.
        return result;
      }) as typeof nativeBitmap);
      restores.push(() => bitmap.mockRestore());
      const encoding = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function(this:HTMLCanvasElement, callback, type, quality) {
        record("encode-start", {type,width:this.width,height:this.height});
        nativeToBlob.call(this, blob => {record("encode-done", {type:blob?.type,size:blob?.size});callback(blob);},type,quality);
      });
      restores.push(() => encoding.mockRestore());
      const reading = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function(this:FileReader, blob) {
        record("read-start", {type:blob.type,size:blob.size});
        this.addEventListener("load",()=>record("read-done",{length:String(this.result).length}),{once:true});
        this.addEventListener("error",()=>record("read-error",{message:String(this.error)}),{once:true});
        nativeRead.call(this,blob);
      });
      restores.push(() => reading.mockRestore());
      const decode = vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function(this: HTMLImageElement) {
        record("fallback-decode-start", {src: this.src});
        const result = nativeDecode.call(this);
        void result.then(() => record("fallback-decode-done", {width: this.naturalWidth, height: this.naturalHeight}),
          error => record("fallback-decode-error", {message: String(error)}));
        return result;
      });
      restores.push(() => decode.mockRestore());
      const objectUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(blob => {
        const url = nativeObjectUrl.call(URL, blob);
        record("object-url-created", {url, type: (blob as Blob).type, size: (blob as Blob).size});
        return url;
      });
      restores.push(() => objectUrl.mockRestore());
      const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(url => {
        record("object-url-revoked", {url});
        nativeRevoke.call(URL, url);
      });
      restores.push(() => revoke.mockRestore());
      const authUnsubscribe = ui.authLock.state.subscribe(() => snapshot("auth-change"));
      restores.push(authUnsubscribe);
      const unsubscribe = ui.stores.drafts.subscribe(() => snapshot("draft-change")); restores.push(unsubscribe);
      snapshot("before-pick");
      record("picked", {imageBytes: image?.size, inputConnected: input.isConnected, files:originals.map(file=>({name:file.name,type:file.type,size:file.size}))});
      input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
      snapshot("change-dispatched");
      await expect.poll(() => {
        const count = host.querySelectorAll('img[alt="raft.png"]').length;
        record("preview-poll", {count});
        return count;
      }).toBe(1);
      snapshot("preview-ready");
      console.info("TRACK_INTAKE_CONTROL", JSON.stringify({width,initiallyOnline,trace}));
      if (!initiallyOnline) {
        expect(navigator.onLine).toBe(false);
        expect(uploadCount).toBe(0); expect(uploaded).toBeUndefined();
        expect(host.textContent).toContain("waiting for connection");
        expect(host.textContent).toContain("loop.json");
        expect(field.value).toBe(text);
        expect(await originals[0]!.text()).toBe(source);
        expect(originals[0]!.size).toBeGreaterThan(0); expect(originals[1]!.size).toBeGreaterThan(100);
        await userEvent.click(field); await userEvent.keyboard("{Enter}");
        expect(sent).toHaveLength(0); expect(host.textContent).toContain("sends when 1 file finishes");
        expect(field.value).toBe(text); expect(host.querySelectorAll('img[alt="raft.png"]').length).toBe(1);
        setOnline(true);
        await expect.poll(() => uploaded).toBeDefined();
        expect(uploadCount).toBe(1);
      }
      expect(uploaded).toBeDefined(); expect(await uploaded!.text()).toBe(source); expect(uploaded!.type).toBe("application/octet-stream");
      if (initiallyOnline) { await userEvent.click(field); await userEvent.keyboard("{Enter}"); }
      expect(sent).toHaveLength(0); expect(host.textContent).toContain("sends when 1 file finishes");
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
      const suffix = initiallyOnline ? `${width}` : `offline-${width}`;
      await page.screenshot({ element: host, path: `../../.vitest-attachments/track-intake/held-${suffix}.png` });
      resolveUpload(Response.json({ files: [trackView().file] }));
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0]!.text).toBe(text); expect(sent[0]!.files).toHaveLength(1); expect(sent[0]!.attachments).toHaveLength(1); expect(sent[0]!.attachments![0]!.data.length).toBeGreaterThan(100);
      const user = ui.stores.chat.getState().draft!.messages.find(message => message.role === "user");
      expect(user!.files![0]!.summary!.counts.retained).toBe(129); expect(user!.attachments).toHaveLength(1);
      await page.screenshot({ element: host, path: `../../.vitest-attachments/track-intake/ready-${suffix}.png` });
    } catch (error) {
      snapshot("failure-before-cleanup");
      console.error("TRACK_INTAKE_DIAGNOSTIC", JSON.stringify({width,initiallyOnline,error: String(error),trace}));
      try {
        if (host.isConnected) await page.screenshot({element:host,path:`../../.vitest-attachments/track-intake/failure-${initiallyOnline ? "online" : "offline"}-${width}.png`});
      } catch (captureError) {
        record("failure-capture-error", {message: String(captureError)});
      }
      snapshot("after-failure-capture");
      console.error("TRACK_INTAKE_AFTER_CAPTURE", JSON.stringify(trace.slice(-8)));
      throw error;
    } finally {
      for (const restore of restores.reverse()) restore();
      // Sent previews belong to this throwaway chat; unmount only revokes unsent ones.
      const previews = Array.from(host.querySelectorAll<HTMLImageElement>('img[src^="blob:"]'), image => image.src);
      try { if (renderer) flushSync(() => renderer!.unmount()); }
      finally {
        try { ui.dispose(); }
        finally {
          host.remove(); style.remove();
          for (const preview of previews) URL.revokeObjectURL(preview);
          if (previousTheme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = previousTheme;
          try { await page.viewport(before.width, before.height); }
          finally { if (outer) await commands.formViewport(outer.width - 100, outer.height - 120); }
        }
      }
    }
  });
}

for (const width of [390, 1440]) {
  test(`mixed image and track picker preserves the held draft at ${width}px`, async () => {
    const original = navigator.onLine;
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "onLine");
    // Deliberately offline before mounting: deleting the inner fixture control
    // must fail the original nonempty-upload assertion even on an online host.
    await withNavigatorOnline(false, async () => {
      const offline = Object.getOwnPropertyDescriptor(navigator, "onLine");
      await mixedPicker(width, true);
      // Following offline sentinel: an online override must not leak from the case.
      expect(navigator.onLine).toBe(false);
      expect(Object.getOwnPropertyDescriptor(navigator, "onLine")).toEqual(offline);
    });
    expect(navigator.onLine).toBe(original);
    expect(Object.getOwnPropertyDescriptor(navigator, "onLine")).toEqual(descriptor);
  });
  test(`offline mixed picker keeps its draft and resumes the held upload at ${width}px`, async () => {
    const original = navigator.onLine;
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "onLine");
    await mixedPicker(width, false);
    expect(navigator.onLine).toBe(original);
    expect(Object.getOwnPropertyDescriptor(navigator, "onLine")).toEqual(descriptor);
  });
}

test("connectivity cleanup restores the previous offline descriptor after a failing fixture", async () => {
  const original = navigator.onLine;
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "onLine");
  await withNavigatorOnline(false, async () => {
    const offline = Object.getOwnPropertyDescriptor(navigator, "onLine");
    await expect(withNavigatorOnline(true, async () => {
      expect(navigator.onLine).toBe(true);
      throw new Error("intentional fixture failure");
    })).rejects.toThrow("intentional fixture failure");
    expect(navigator.onLine).toBe(false);
    expect(Object.getOwnPropertyDescriptor(navigator, "onLine")).toEqual(offline);
  });
  expect(navigator.onLine).toBe(original);
  expect(Object.getOwnPropertyDescriptor(navigator, "onLine")).toEqual(descriptor);
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
