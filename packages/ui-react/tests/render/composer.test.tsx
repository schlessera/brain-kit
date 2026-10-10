import { unregisterComposerDom } from "./composer-dom.js";
import { afterAll, afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { Composer } from "../../src/components/chat/composer.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { PendingAttachment } from "../../src/lib/image-attachments.js";

const roots: BrainUiRoot[] = [];
afterEach(() => { cleanup(); for (const root of roots.splice(0)) root.dispose(); });
afterAll(unregisterComposerDom);

const SESSION = "odysseus-ogygia";
const TEXT = "Check the raft lashings before leaving Ogygia.";
const OTHER = "Penelope should review the Ithaca harbour fee.";
const image: PendingAttachment = {
  name: "ogygia-raft.gif", previewUrl: "data:image/gif;base64,R0lGODlh",
  attachment: { mediaType: "image/gif", data: "R0lGODlh" }, bytes: 6,
};
function fixture(ack = true, session: string | null = SESSION) {
  const root = createBrainUiRoot({ storage: null, request: async () => Response.json({ providers: [], backends: {} }) });
  roots.push(root);
  root.stores.connection.setState({ wsStatus: "connected", chatRequestAck: ack });
  root.stores.chat.getState().setActiveSession(session);
  // The session's history is here: a session still restoring takes no send (#1328).
  if (session) root.stores.chat.getState().setMessages(session, []);
  return root;
}
function mount(root = fixture(), admit = true) {
  const frames: ClientMessage[] = [];
  const draw = () => <BrainUiProvider root={root}><Composer send={msg => { frames.push(msg); return admit; }} /></BrainUiProvider>;
  const view = render(draw());
  const field = () => view.getByRole("textbox") as HTMLTextAreaElement;
  return { root, view, frames, field, remount: () => { view.rerender(draw()); }, type: (value: string) => {
    // The existing render harness uses the field's change prop because
    // happy-dom does not drive React's synthetic input tracker. Everything
    // after onChange runs in the mounted, real Composer (no module mocks).
    const node = field(); node.focus();
    const key = Object.keys(node).find(key => key.startsWith("__reactProps$"))!;
    const props = (node as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[key]!;
    act(() => props.onChange({ target: { value } }));
  }, send: () => fireEvent.click(within(view.container.querySelector<HTMLElement>("[data-composer]")!).getByRole("button", { name: "Send" })) };
}
const tick = () => act(() => new Promise(resolve => setTimeout(resolve, 0)));

for (const ack of [true, false]) {
  test(`send ${ack ? "with receipts" : "legacy"} sends trimmed text to the session and clears the draft`, async () => {
    const m = mount(fixture(ack)); await tick();
    m.type(`  ${TEXT}  `);
    expect(m.field().value.trim()).toBe(TEXT);
    m.send();
    expect(m.frames).toHaveLength(1);
    expect(m.frames[0]).toMatchObject({ type: "chat_message", text: TEXT, sessionId: SESSION, source: "typed" });
    expect(m.field().value).toBe("");
    if (ack) expect((m.frames[0] as Extract<ClientMessage, { type: "chat_message" }>).requestId).toBeTruthy();
    const messages = m.root.stores.chat.getState().buffers[SESSION]!.messages;
    expect(messages.find(message => message.role === "user")?.content).toBe(TEXT);
  });
}

test("failed transport restores text and images, withdraws the optimistic turn, and reports CHAT_NOT_SENT", async () => {
  const root = fixture();
  const drafts = root.stores.drafts.getState();
  drafts.edit(drafts.idFor(SESSION), SESSION, { text: TEXT, attachments: [image] });
  const m = mount(root, false); await tick();
  expect(m.view.getByRole("img", { name: image.name })).toBeTruthy();
  m.send();
  expect(m.field().value).toBe(TEXT);
  expect(m.view.queryByRole("img", { name: image.name })).not.toBeNull();
  expect(root.stores.connection.getState().lastError).toMatchObject({ code: "CHAT_NOT_SENT", message: "The message could not be sent. Your draft is kept." });
  expect(root.stores.chat.getState().buffers[SESSION]!.messages).toEqual([]);
  expect(m.frames).toHaveLength(1);
  expect(m.frames[0]).toMatchObject({ text: TEXT, attachments: [image.attachment] });
});

test("offline send is refused while the draft stays editable and nothing is sent", async () => {
  const m = mount(); await tick(); m.type(TEXT);
  act(() => m.root.stores.connection.setState({ wsStatus: "disconnected" }));
  const button = m.view.getByRole("button", { name: /Send/ });
  expect(button.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(button);
  expect(m.frames).toEqual([]);
  expect(m.field().value).toBe(TEXT);
  m.type(OTHER); expect(m.field().value).toBe(OTHER);
});

test("a saved session draft reappears on mount and after unmount", async () => {
  const root = fixture();
  root.stores.drafts.getState().restoreLocal([{ draftId: "raft-draft", sessionId: SESSION, text: TEXT,
    attachments: [], editedAt: Date.parse("2026-07-12T09:00:00Z"), host: null }]);
  const first = mount(root); await tick();
  expect(first.field().value).toBe(TEXT);
  first.type(OTHER); first.view.unmount();
  const second = mount(root); await tick();
  expect(second.field().value).toBe(OTHER);
  expect(second.frames).toEqual([]);
});

test("switching sessions restores each session's draft without crossing their contents", async () => {
  const root = fixture();
  const drafts = root.stores.drafts.getState();
  drafts.restoreLocal([
    { draftId: "raft-draft", sessionId: SESSION, text: TEXT, attachments: [], editedAt: 1, host: null },
    { draftId: "port-draft", sessionId: "odysseus-ithaca", text: OTHER, attachments: [image], editedAt: 1, host: null },
  ]);
  const m = mount(root); await tick();
  expect(m.field().value).toBe(TEXT);
  m.type(`${TEXT} Athena will guide the passage.`);
  act(() => root.stores.chat.getState().setActiveSession("odysseus-ithaca"));
  expect(m.field().value).toBe(OTHER);
  expect(m.view.queryByRole("img", { name: image.name })).not.toBeNull();
  act(() => root.stores.chat.getState().setActiveSession(SESSION));
  expect(m.field().value).toBe(`${TEXT} Athena will guide the passage.`);
  expect(m.view.queryByRole("img", { name: image.name }) === null).toBe(true);
  expect(m.frames).toEqual([]);
});

test("send combines nonempty typed and dictated drafts and marks the message as dictated", async () => {
  const root = fixture(); root.stores.voice.setState({ reviewText: "Athena says the wind is favourable." });
  const m = mount(root); await tick(); m.type(TEXT); m.send();
  expect(m.frames[0]).toMatchObject({ text: `${TEXT}\nAthena says the wind is favourable.`, source: "voice-dictate" });
  expect(m.field().value).toBe("");
  expect(m.view.queryByText("Athena says the wind is favourable.") === null).toBe(true);
});
