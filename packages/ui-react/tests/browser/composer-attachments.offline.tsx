// Real image decode, FileReader, object URLs and native file/paste events on
// the mounted Composer. No network: all requests use the root's fixture transport.
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES } from "@schlessera/brain-ui-sdk/protocol";
import { Composer } from "../../src/components/chat/composer.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { tracksFor, trackKey } from "../../src/lib/draft-tracks.js";

const scenes: { host: HTMLDivElement; renderer: Root; root: BrainUiRoot }[] = [];
let styles: HTMLStyleElement;
beforeAll(async () => {
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterEach(() => {
  for (const s of scenes.splice(0)) {
    flushSync(() => s.renderer.unmount()); s.root.dispose(); s.host.remove();
  }
});
afterAll(() => styles.remove());

function mount() {
  const uploads: File[] = [];
  const root = createBrainUiRoot({ storage: null, request: async (input, init) => {
    if (String(input).endsWith("/track-upload")) {
      uploads.push((init!.body as FormData).get("files") as File);
      return Response.json({ error: "unsupported_track" }, { status: 422 });
    }
    return Response.json({ providers: [], backends: {} });
  } });
  root.stores.connection.setState({ wsStatus: "connected", chatRequestAck: true });
  root.stores.chat.getState().setActiveSession("odysseus-ogygia");
  // Its history is here: a session still restoring takes no send (#1328).
  root.stores.chat.getState().setMessages("odysseus-ogygia", []);
  const host = document.createElement("div"); document.body.append(host);
  const renderer = createRoot(host);
  const frames: ClientMessage[] = [];
  scenes.push({ host, renderer, root });
  flushSync(() => renderer.render(<BrainUiProvider root={root}><Composer send={msg => { frames.push(msg); return true; }} /></BrainUiProvider>));
  const field = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
  const images = () => [...host.querySelectorAll<HTMLImageElement>("[data-composer] img")];
  const send = () => host.querySelector<HTMLElement>('[data-composer] [aria-label="Send"]')!.click();
  return { root, host, frames, uploads, field, images, send };
}
type Scene = ReturnType<typeof mount>;

// Same native canvas/File/DataTransfer recipe as session-drafts.pointer.tsx.
async function png(name: string, color: string) {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!; ctx.fillStyle = color; ctx.fillRect(0, 0, 64, 64);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/png"));
  return new File([blob], name, { type: "image/png" });
}
async function pick(s: Scene, name: string, color: string) {
  const file = await png(name, color);
  expect(file.size, "the picked image is nonempty").toBeGreaterThan(0);
  return pickFiles(s, [file]);
}
async function pickFiles(s: Scene, files: File[]) {
  // Let the mounted composer's initial draft and transport effects settle.
  await new Promise(resolve => setTimeout(resolve, 0));
  const transfer = new DataTransfer(); for (const file of files) transfer.items.add(file);
  const input = s.host.querySelector<HTMLInputElement>('input[accept="image/*"]:not([capture])')!;
  input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  return input;
}
// Decoding several images on a loaded CI runner takes seconds, not the default poll second.
const waitForImages = (s: Scene, count: number) => expect.poll(() => s.images().length, { message: "composer attachment previews", timeout: 15_000 }).toBe(count);

test("picking images adds decoded previews and resets the picker for another selection", async () => {
  const s = mount(); const input = await pick(s, "ogygia-raft.png", "#e09f3e");
  await waitForImages(s, 1);
  expect(input.value).toBe("");
  const preview = s.images()[0]!; await preview.decode();
  expect(preview.alt).toBe("ogygia-raft.png"); expect(preview.naturalWidth).toBe(64);
  await pick(s, "ithaca-port.png", "#5bb5a2"); await waitForImages(s, 2);
  expect(s.images().map(img => img.alt)).toEqual(["ogygia-raft.png", "ithaca-port.png"]);
  expect(s.frames).toEqual([]);
});

test("removing an image removes only its preview and keeps the draft and other image", async () => {
  const s = mount(); await userEvent.fill(s.field(), "Review the raft lashings.");
  await pick(s, "ogygia-raft.png", "#e09f3e"); await waitForImages(s, 1);
  await pick(s, "ithaca-port.png", "#5bb5a2"); await waitForImages(s, 2);
  s.host.querySelector<HTMLElement>('[aria-label="Remove ogygia-raft.png"]')!.click();
  await waitForImages(s, 1);
  expect(s.images().map(img => img.alt)).toEqual(["ithaca-port.png"]);
  expect(s.field().value).toBe("Review the raft lashings."); expect(s.frames).toEqual([]);
});

test("sending images carries nonempty decoded bytes with the text and clears previews", async () => {
  const s = mount(); await userEvent.fill(s.field(), "Inspect the raft before leaving Ogygia.");
  await pick(s, "ogygia-raft.png", "#e09f3e"); await waitForImages(s, 1);
  await pick(s, "ithaca-port.png", "#5bb5a2"); await waitForImages(s, 2);
  const draft = s.root.stores.drafts.getState();
  const expected = draft.drafts[draft.idFor("odysseus-ogygia")]!.attachments.map(a => a.attachment);
  expect(expected).toHaveLength(2);
  for (const image of expected) { expect(image.mediaType).toBe("image/jpeg"); expect(atob(image.data).length).toBeGreaterThan(0); }
  // Distinct coloured fixtures catch duplication as well as dropped images.
  expect(expected[0]!.data).not.toBe(expected[1]!.data);
  s.send();
  expect(s.frames).toHaveLength(1);
  expect(s.frames[0]).toMatchObject({ type: "chat_message", text: "Inspect the raft before leaving Ogygia.", sessionId: "odysseus-ogygia", attachments: expected });
  await waitForImages(s, 0); expect(s.field().value).toBe("");
});

test("pasted images can be sent without text", async () => {
  const s = mount(); const transfer = new DataTransfer(); transfer.items.add(await png("ogygia-raft.png", "#e09f3e"));
  expect(transfer.files[0]!.size).toBeGreaterThan(0);
  s.field().dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  await waitForImages(s, 1);
  expect(s.field().value).toBe(""); s.send();
  expect(s.frames).toHaveLength(1);
  const frame = s.frames[0] as Extract<ClientMessage, { type: "chat_message" }>;
  expect(frame.text).toBe(""); expect(frame.attachments).toHaveLength(1);
  expect(atob(frame.attachments![0]!.data).length).toBeGreaterThan(0);
  await waitForImages(s, 0);
});

test("picking too many images shows the message limit error and keeps previews at the cap", async () => {
  const s = mount();
  const files = await Promise.all(Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, (_, i) => png(`raft-${i}.png`, "#e09f3e")));
  await pickFiles(s, files);
  await waitForImages(s, MAX_IMAGES_PER_MESSAGE);
  await expect.poll(() => s.host.textContent, { timeout: 15_000 }).toContain(`raft-${MAX_IMAGES_PER_MESSAGE}.png: not added (message limit reached)`);
  expect(s.images()).toHaveLength(MAX_IMAGES_PER_MESSAGE);
  expect(s.images().map(img => img.alt)).toEqual(files.slice(0, MAX_IMAGES_PER_MESSAGE).map(file => file.name));
  expect(s.frames).toEqual([]);
});

test("an oversized image is rejected with its inline error and no preview or send", async () => {
  const s = mount();
  await userEvent.fill(s.field(), "Review the raft notice.");
  await pickFiles(s, [new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "ogygia-raft.gif", { type: "image/gif" })]);
  await expect.poll(() => s.host.textContent, { timeout: 15_000 }).toContain("ogygia-raft.gif: GIF too large (max 4.0 MB)");
  expect(s.images()).toHaveLength(0);
  expect(s.uploads).toEqual([]); expect(s.frames).toEqual([]);
});

test("an undecodable image is rejected with its inline error and no preview or send", async () => {
  const s = mount();
  await userEvent.fill(s.field(), "Review the raft notice.");
  await pickFiles(s, [new File(["This is a raft notice, not PNG bytes."], "ogygia-raft.png", { type: "image/png" })]);
  await expect.poll(() => s.host.textContent, { timeout: 15_000 }).toContain("ogygia-raft.png: couldn't read this image (unsupported format?)");
  expect(s.images()).toHaveLength(0);
  expect(s.uploads).toEqual([]); expect(s.frames).toEqual([]);
});

test("a non-image file goes to track uploads instead of image attachments and sends no message", async () => {
  const s = mount(); const text = "The Ithaca harbour notice.";
  await userEvent.fill(s.field(), "Review the harbour notice.");
  await pickFiles(s, [new File([text], "ithaca-notice.txt", { type: "text/plain" })]);
  const drafts = s.root.stores.drafts.getState();
  const tracks = tracksFor(s.root, trackKey("odysseus-ogygia", drafts.originOf(drafts.idFor("odysseus-ogygia")))).uploads;
  await expect.poll(() => tracks.files.length, { message: "the non-image reaches the track upload queue" }).toBe(1);
  expect(tracks.files[0]!.name).toBe("ithaca-notice.txt");
  expect(await tracks.files[0]!.file.text()).toBe(text);
  await expect.poll(() => s.host.textContent).toContain("ithaca-notice.txt");
  expect(s.images()).toHaveLength(0); expect(s.frames).toEqual([]);
});
