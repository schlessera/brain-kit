import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { useShareIntake } from "../../src/hooks/use-share-intake.js";
import { handleShareTargetRequest } from "../../../ui-sdk/src/client/share-target-handler.js";
import { persistShareClaim } from "../../src/lib/share-intake.js";
import { fileToAttachment } from "../../src/lib/image-attachments.js";

// Real hook, transport and stores. Only the backend's announcement timing is
// controlled by the test; IndexedDB, images, upload and host echo are native.
const root = createBrainUiRoot({ storage: localStorage, storagePrefix: "odysseus-share-draft" });
root.stores.connection.getState().setVpnStatus("connected", "odysseus-ithaca");
root.connection.connect();
let intake: ReturnType<typeof useShareIntake>;
function Review() {
  intake = useShareIntake();
  useEffect(() => () => root.dispose(), []);
  return <main>Odysseus share draft proof</main>;
}
createRoot(document.getElementById("app")!).render(<BrainUiProvider root={root}><Review /></BrainUiProvider>);

async function image(name: string, colour: string) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d")!;
  context.fillStyle = colour; context.fillRect(0, 0, 64, 64);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/png"));
  return new File([blob], name, { type: "image/png" });
}
const proof = {
  connected: () => root.stores.connection.getState().wsStatus === "connected",
  async stash() {
    const form = new FormData();
    form.set("text", `Penelope keeps the original loom plan. ${new URL(location.href).searchParams.get("scenario")}`);
    form.set("files", await image("loom.png", "#2266aa"));
    const response = await handleShareTargetRequest(new Request(`${location.origin}/share-target`, { method: "POST", body: form }));
    persistShareClaim(new URL(response.headers.get("Location")!).searchParams.get("share")!);
  },
  confirm: () => { void intake.confirm(root.stores.share.getState().queue[0]!); },
  async sendB() {
    const chat = root.stores.chat.getState();
    chat.clearMessages();
    const imageB = await fileToAttachment(await image("provisions.png", "#aa6622"));
    if ("error" in imageB) throw new Error(imageB.error);
    const requestId = crypto.randomUUID();
    chat.addUserMessage(null, "Ask Penelope about provisions", "typed", [{ previewUrl: imageB.previewUrl, mediaType: imageB.attachment.mediaType }], { requestId });
    chat.startAssistantMessage(null, undefined, requestId);
    const draftId = chat.startDraftTurn();
    if (!root.connection.send({ type: "chat_message", text: "Ask Penelope about provisions", source: "typed", requestId, draftId, attachments: [imageB.attachment] })) throw new Error("B send refused");
    return draftId;
  },
  navigate: () => { root.stores.chat.getState().clearMessages(); root.stores.chat.getState().setActiveSession("odysseus-existing"); },
  async previews() {
    const samples: Record<string, { width: number; pixel: number[] }> = {};
    for (const [id, buffer] of Object.entries(root.stores.chat.getState().buffers)) {
      const url = buffer.messages[0]?.attachments?.[0]?.previewUrl;
      if (!url) continue;
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0, 1, 1);
      samples[id] = { width: bitmap.width, pixel: [...context.getImageData(0, 0, 1, 1).data] };
      bitmap.close();
    }
    return samples;
  },
  state: () => {
    const chat = root.stores.chat.getState();
    return { pending: chat.pendingDraftId, active: chat.activeSessionId, draft: chat.draft, detached: chat.detachedDrafts, buffers: chat.buffers,
      queue: root.stores.share.getState().queue.length, busy: root.stores.share.getState().busy, error: root.stores.share.getState().error };
  },
};
Object.assign(window, { shareDraft: proof });
window.addEventListener("pagehide", () => root.dispose(), { once: true });
