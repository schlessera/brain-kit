import { expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { installFaultNetwork, type FaultNetwork } from "./offline/fault-network.ts";

// A reload that kept the selected session's id and none of its transcript
// (#1328), in the real ChatPage: the welcome screen must not show while the
// next message would go into that session, every dispatch path stays shut
// until its history arrives, and a restoration that fails says so, with
// Retry and New chat. The store, connection and composer are the real ones;
// only the host is scripted.

const OGYGIA = "ogygia-raft";
const HISTORY = [
  { role: "user", content: "Is the raft lashed for the crossing?", toolCalls: [] },
  { role: "assistant", content: "Calypso checked every knot at dawn.", toolCalls: [] },
];
const DRAFT = "Shall we sail tonight?";

interface Scene { ui: BrainUiRoot; net: FaultNetwork; host: HTMLElement }

async function scene(ctx: { onTestFinished(fn: () => unknown): void }, width: number): Promise<Scene> {
  const before = { width: innerWidth, height: innerHeight };
  const outer = await commands.formViewport(width, 800);
  await page.viewport(width, 800);
  const net = installFaultNetwork({ routes: () => Response.json({ entries: [], providers: [], backends: {}, slugs: {}, models: [], sessions: [] }) });
  const ui = createBrainUiRoot({ storage: null, request: net.request });
  const style = document.createElement("style");
  style.textContent = await commands.formConsumerStyles();
  document.head.append(style);
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
  document.body.append(host);
  const renderer = createRoot(host);
  ctx.onTestFinished(async () => {
    flushSync(() => renderer.unmount());
    ui.dispose(); net.restore(); host.remove(); style.remove();
    await page.viewport(before.width, before.height);
    await commands.formViewport(outer.width - 100, outer.height - 120);
  });
  // What a reload leaves: the selected id, an empty buffer, no history.
  ui.stores.chat.getState().setActiveSession(OGYGIA);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><ChatPage /></BrainUiProvider>));
  ui.connection.connect();
  await expect.poll(() => net.socket()?.readyState).toBe(1);
  net.socket()!.deliver({ type: "status", status: "idle" });
  return { ui, net, host };
}

const field = (s: Scene) => s.host.querySelector<HTMLTextAreaElement>("[data-composer] textarea")!;
const chatMessages = (s: Scene) => s.net.frames
  .filter((f) => typeof f.data === "string")
  .map((f) => JSON.parse(f.data as string) as { type: string; sessionId?: string; text?: string })
  .filter((f) => f.type === "chat_message");
const resumes = (s: Scene) => s.net.socket()!.frames("session_resume");

/** Every way the composer sends: Enter in the field, and the Send button. */
async function trySend(s: Scene) {
  field(s).focus();
  await userEvent.keyboard("{Enter}");
  const send = s.host.querySelector<HTMLElement>('[data-composer] [aria-label^="Send"]');
  if (send) await userEvent.click(send, { force: true });
}

for (const width of [390, 1280]) {
  test(`${width}: restoring, not welcome, until the history arrives; sending waits, the draft stays`, async (ctx) => {
    const s = await scene(ctx, width);
    expect(resumes(s), "the selected session's history is asked for").toEqual([{ type: "session_resume", sessionId: OGYGIA }]);
    await expect.poll(() => s.host.querySelector('[data-restoration="restoring"]')?.textContent ?? "").toContain("Restoring conversation");
    expect(s.host.querySelector("[data-welcome]"), "the welcome screen is not shown").toBeNull();
    expect(s.host.textContent).not.toContain("What do you need to know?");

    await userEvent.fill(field(s), DRAFT);
    await trySend(s);
    expect(chatMessages(s), "nothing is sent into the unseen session").toEqual([]);
    // A disabled send leaves Enter to the field, as offline does: the words stay.
    expect(field(s).value.trimEnd(), "the draft is kept").toBe(DRAFT);
    expect(s.host.querySelector("[data-composer]")!.textContent, "the composer says why").toContain("restoring this conversation");

    s.net.socket()!.deliver({ type: "session_info", sessionId: OGYGIA, isNew: false });
    s.net.socket()!.deliver({ type: "session_history", sessionId: OGYGIA, messages: HISTORY });
    s.net.socket()!.deliver({ type: "status", sessionId: OGYGIA, status: "idle" });
    await expect.poll(() => s.host.textContent).toContain("Calypso checked every knot at dawn.");
    expect(s.host.querySelector("[data-restoration]")).toBeNull();
    expect(chatMessages(s), "recovery sends nothing by itself").toEqual([]);
    expect(field(s).value.trimEnd()).toBe(DRAFT);

    await trySend(s);
    await expect.poll(() => chatMessages(s)).toHaveLength(1);
    expect(chatMessages(s)[0]).toMatchObject({ text: DRAFT, sessionId: OGYGIA });
  });

  test(`${width}: a failed restoration offers Retry and New chat; New chat starts a conversation without the old id`, async (ctx) => {
    const s = await scene(ctx, width);
    await userEvent.fill(field(s), DRAFT);
    s.net.socket()!.deliver({ type: "error", code: "SESSION_LOAD_ERROR", message: "transcript unreadable", sessionId: OGYGIA });
    await expect.poll(() => s.host.querySelector('[data-restoration="failed"]')?.textContent ?? "").toContain("Couldn’t restore this conversation");
    expect(s.host.querySelector("[data-welcome]")).toBeNull();
    expect(s.ui.stores.chat.getState().activeSessionId, "the selection is kept").toBe(OGYGIA);
    await trySend(s);
    expect(chatMessages(s)).toEqual([]);
    expect(field(s).value.trimEnd()).toBe(DRAFT);

    await page.getByRole("button", { name: "Retry" }).click();
    expect(resumes(s), "Retry asks for the history again").toHaveLength(2);
    await expect.poll(() => s.host.querySelector("[data-restoration]")?.getAttribute("data-restoration")).toBe("restoring");
    expect(chatMessages(s), "Retry reads only").toEqual([]);

    s.net.socket()!.deliver({ type: "error", code: "SESSION_LOAD_ERROR", message: "transcript unreadable", sessionId: OGYGIA });
    await expect.poll(() => s.host.querySelector("[data-restoration]")?.getAttribute("data-restoration")).toBe("failed");
    await page.getByRole("button", { name: "New chat" }).last().click();
    await expect.poll(() => s.host.querySelector("[data-welcome]")).not.toBeNull();
    expect(s.ui.stores.chat.getState().activeSessionId).toBeNull();
    expect(field(s).value, "a new chat opens its own empty draft").toBe("");

    await userEvent.fill(field(s), "A new voyage plan.");
    await trySend(s);
    await expect.poll(() => chatMessages(s)).toHaveLength(1);
    expect(chatMessages(s)[0]!.text).toBe("A new voyage plan.");
    expect(chatMessages(s)[0], "a new chat's send names no session").not.toHaveProperty("sessionId");

    // History for the abandoned selection arrives late: it takes nothing back.
    s.net.socket()!.deliver({ type: "session_history", sessionId: OGYGIA, messages: HISTORY });
    s.net.socket()!.deliver({ type: "status", sessionId: OGYGIA, status: "idle" });
    await new Promise((done) => setTimeout(done, 100));
    expect(s.ui.stores.chat.getState().activeSessionId).toBeNull();
    expect(s.host.textContent).not.toContain("Calypso checked every knot at dawn.");
  });
}
