/**
 * #4212: a restricted chat's Gmail allowances inside the chat's safety notice
 * (`SessionSafety`), in the chat column as the Chat page lays it out, at a
 * phone and a desktop width in both themes. The list must sit inside the
 * notice without widening the column, Revoke must name the granting card, and
 * the list must show the host's fresh read afterwards. Captures are review
 * images for the placement sign-off, not baselines.
 */
import { expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { SafetyHistoryProjection } from "@schlessera/brain-ui-sdk/protocol";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { SessionSafety } from "../../src/components/chat/safety-indicator.js";
import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import type { ChatMessage } from "../../src/stores/chat-store.js";

const SESSION = "ithaca", ODYSSEUS = "odysseus@example.com";
const noop = () => {};
const message: ChatMessage = { id: "odysseus-answer", turnId: "voyage", role: "assistant", content: "Archived the suitors' letters and saved a draft to Telemachus.",
  isStreaming: false, timestamp: new Date(2026, 6, 12, 9, 40).getTime(), toolCalls: [], parts: [{ kind: "text", text: "Archived the suitors' letters and saved a draft to Telemachus." }] };
const projection: SafetyHistoryProjection = {
  session: { sessionId: SESSION, historyOwnerId: SESSION, historyGeneration: "0" }, evidenceRevision: "1", unresolvedCount: 1, earliestUnresolvedId: null,
  pendingCount: 0, restriction: "restricted", reasons: ["unresolved"], coverage: { detectorVersion: 1, state: "complete", epochs: [], exclusions: [] },
};
const allowance = (card: string, operation: string, entity: string, remaining: number, until: Date) => ({
  session_id: SESSION, principal_id: "owner-odysseus", brain_id: "brain-ithaca", account_identity: ODYSSEUS, operation, entity, host_epoch: "epoch-1",
  policy_hash: "policy-1", granted_card_id: card, granted_at: until.getTime() - 86_400_000, expires_at: until.getTime(), remaining_items: remaining,
});
const ALLOWANCES = [
  allowance("card-ithaca", "gmail.modify", "archive", 84, new Date(2026, 6, 12, 18, 2)),
  allowance("card-ithaca", "gmail.modify", "mark_read", 84, new Date(2026, 6, 12, 18, 2)),
  allowance("card-drafts", "gmail.draft.save", "drafts", 3, new Date(2026, 6, 12, 21, 40)),
];

for (const width of [320, 1280]) for (const theme of ["dark", "light"] as const) {
  test(`restricted chat: Gmail allowances in the safety notice at ${width} ${theme}`, async ctx => {
    const before = { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme };
    // The fixtures' clock: "until 18:02" is today.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 12, 9, 41));
    const outer = await commands.formViewport(width, 900);
    await page.viewport(width, 900);
    document.documentElement.dataset.theme = theme;
    const style = document.createElement("style"); style.textContent = await commands.formConsumerStyles(); document.head.append(style);
    const host = document.createElement("div"); host.style.cssText = "background:var(--bk-color-canvas);color:var(--bk-color-ink)"; document.body.append(host);
    let allowances = ALLOWANCES;
    const sent: Array<{ path: string; method: string; body: unknown }> = [];
    const ui = createBrainUiRoot({ storage: null, request: async (url, init) => {
      const path = new URL(String(url), location.href).pathname;
      sent.push({ path, method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (path.endsWith(`/sessions/${SESSION}/google/allowances`)) return Response.json({ allowances });
      if (path.endsWith(`/sessions/${SESSION}/google/allowances/revoke`)) {
        const { id } = JSON.parse(String(init?.body)) as { id: string };
        allowances = allowances.filter(row => row.granted_card_id !== id);
        return Response.json({ revoked: true });
      }
      return Response.json({ providers: [] });
    } });
    ui.stores.chat.setState({ activeSessionId: SESSION, buffers: { [SESSION]: { messages: [message], isStreaming: false, askUser: null, lastTouched: message.timestamp } } });
    ui.stores.safety.setState({ supported: true, status: "ready", reason: null, projection, normal: false });
    const react = createRoot(host);
    ctx.onTestFinished(async () => {
      flushSync(() => react.unmount()); ui.dispose(); host.remove(); style.remove();
      vi.useRealTimers();
      if (before.theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = before.theme;
      await page.viewport(before.width, before.height); await commands.formViewport(outer.width - 100, outer.height - 120);
    });
    // The Chat page's scroller and reading column (`chat-page.tsx`), holding the notice above the conversation.
    flushSync(() => react.render(<BrainUiProvider root={ui}>
      <div className="px-4 pb-6 pt-10 md:px-6 @min-[888px]:pt-0">
        <div data-reading-column className="mx-auto max-w-3xl divide-y divide-border/20">
          <SessionSafety />
          <MessageBubble message={message} journalVisible={false} onToolApproval={noop} onAskUserSubmit={noop} onAskUserCancel={noop} onAskUserListSubmit={noop} />
        </div>
      </div>
    </BrainUiProvider>));
    await expect.poll(() => document.querySelector("[data-google-allowances]")?.getAttribute("data-google-allowances")).toBe("ready");

    const column = host.querySelector<HTMLElement>("[data-reading-column]")!;
    const notice = host.querySelector<HTMLElement>("[data-session-safety]")!;
    const list = notice.querySelector<HTMLElement>("[data-google-allowances]")!;
    expect(notice.contains(list), "GOOGLE_CHAT_INSIDE_SAFETY_NOTICE").toBe(true);
    const revokes = () => [...list.querySelectorAll<HTMLElement>("[data-bk-button][role=button]")];
    expect(revokes().map(button => button.getAttribute("aria-label")), "GOOGLE_CHAT_BROWSER_ROWS").toEqual(["Revoke Archive and Mark as read", "Revoke Save drafts"]);
    expect([...list.querySelectorAll("[data-google-meta]")].map(node => node.textContent)).toEqual(["84 of 100 changes left · until 18:02", "3 of 100 changes left · until 21:40"]);

    // No horizontal overflow: not the page, not the column, not the notice, not a row.
    const fits = () => {
      const c = column.getBoundingClientRect(), n = notice.getBoundingClientRect();
      return {
        page: document.documentElement.scrollWidth <= innerWidth,
        column: n.left >= c.left - 0.5 && n.right <= c.right + 0.5 && column.scrollWidth <= column.clientWidth + 0.5,
        list: list.scrollWidth <= list.clientWidth + 0.5,
        rows: [...list.querySelectorAll<HTMLElement>("li[data-google-target]")].every(row => { const r = row.getBoundingClientRect(); return r.left >= n.left - 0.5 && r.right <= n.right + 0.5; }),
      };
    };
    expect(fits(), "GOOGLE_CHAT_NO_HORIZONTAL_OVERFLOW").toEqual({ page: true, column: true, list: true, rows: true });
    if (width === 1280) expect(column.getBoundingClientRect().width, "the desktop reading column").toBe(768);

    const tall = Math.ceil(host.scrollHeight + 16);
    await commands.formViewport(width, tall); await page.viewport(width, tall);
    await page.screenshot({ element: host, path: `../../.vitest-attachments/google-standing/chat-${theme}-${width}.png` });
    expect(fits(), "GOOGLE_CHAT_NO_HORIZONTAL_OVERFLOW (tall)").toEqual({ page: true, column: true, list: true, rows: true });

    // Revoke names the card; the list then shows the host's fresh read.
    await userEvent.click(page.getByRole("button", { name: "Revoke Save drafts", exact: true }));
    await expect.poll(() => revokes().length).toBe(1);
    expect(sent.filter(row => row.path.includes("/google/allowances")).map(row => [row.method, row.path, row.body]), "GOOGLE_CHAT_BROWSER_REVOKE_THEN_READ").toEqual([
      ["GET", `/api/sessions/${SESSION}/google/allowances`, undefined],
      ["POST", `/api/sessions/${SESSION}/google/allowances/revoke`, { id: "card-drafts" }],
      ["GET", `/api/sessions/${SESSION}/google/allowances`, undefined],
    ]);
    expect(document.activeElement?.getAttribute("aria-label"), "GOOGLE_CHAT_BROWSER_FOCUS_PREVIOUS").toBe("Revoke Archive and Mark as read");
  });
}

// #4212 round 2: the kit's failed and partial states inside the safety notice
// at a phone width. The failed state must draw the red error box and Try
// again, and claim nothing is loading; the partial state must draw the count
// notice under the cards and never "Nothing is allowed". Neither may widen the
// column.
const CALENDAR_CARD = allowance("card-calendar", "calendar.event.create", "events", 100, new Date(2026, 6, 12, 21, 40));
for (const [kind, answer] of [
  ["failed", () => Response.json({ error: "Internal" }, { status: 500 })],
  ["partial", () => Response.json({ allowances: [...ALLOWANCES, CALENDAR_CARD] })],
] as const) for (const theme of ["dark", "light"] as const) {
  test(`restricted chat: Gmail allowances, ${kind}, in the safety notice at 320 ${theme}`, async ctx => {
    const width = 320;
    const before = { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 12, 9, 41));
    const outer = await commands.formViewport(width, 900);
    await page.viewport(width, 900);
    document.documentElement.dataset.theme = theme;
    const style = document.createElement("style"); style.textContent = await commands.formConsumerStyles(); document.head.append(style);
    const host = document.createElement("div"); host.style.cssText = "background:var(--bk-color-canvas);color:var(--bk-color-ink)"; document.body.append(host);
    const ui = createBrainUiRoot({ storage: null, request: async url => {
      const path = new URL(String(url), location.href).pathname;
      if (path.endsWith(`/sessions/${SESSION}/google/allowances`)) return answer();
      return Response.json({ providers: [] });
    } });
    ui.stores.chat.setState({ activeSessionId: SESSION, buffers: { [SESSION]: { messages: [message], isStreaming: false, askUser: null, lastTouched: message.timestamp } } });
    ui.stores.safety.setState({ supported: true, status: "ready", reason: null, projection, normal: false });
    const react = createRoot(host);
    ctx.onTestFinished(async () => {
      flushSync(() => react.unmount()); ui.dispose(); host.remove(); style.remove();
      vi.useRealTimers();
      if (before.theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = before.theme;
      await page.viewport(before.width, before.height); await commands.formViewport(outer.width - 100, outer.height - 120);
    });
    flushSync(() => react.render(<BrainUiProvider root={ui}>
      <div className="px-4 pb-6 pt-10 md:px-6 @min-[888px]:pt-0">
        <div data-reading-column className="mx-auto max-w-3xl divide-y divide-border/20">
          <SessionSafety />
          <MessageBubble message={message} journalVisible={false} onToolApproval={noop} onAskUserSubmit={noop} onAskUserCancel={noop} onAskUserListSubmit={noop} />
        </div>
      </div>
    </BrainUiProvider>));
    await expect.poll(() => document.querySelector("[data-google-allowances]")?.getAttribute("data-google-allowances")).toBe(kind === "failed" ? "failed" : "ready");

    const column = host.querySelector<HTMLElement>("[data-reading-column]")!;
    const notice = host.querySelector<HTMLElement>("[data-session-safety]")!;
    const list = notice.querySelector<HTMLElement>("[data-google-allowances]")!;
    expect(list.textContent, "GOOGLE_CHAT_BROWSER_NO_EMPTY_CLAIM").not.toContain("Nothing is allowed");
    if (kind === "failed") {
      expect(list.querySelector("[aria-busy]"), "GOOGLE_CHAT_BROWSER_FAILED_NOT_BUSY").toBeNull();
      expect(list.querySelector("[data-google-failed]")?.textContent).toContain("Couldn't load this chat's allowances.");
      expect(notice.contains(page.getByRole("button", { name: "Try again" }).element()), "Try again sits in the notice").toBe(true);
    } else {
      expect(list.querySelector("[data-google-unshown]")?.textContent, "GOOGLE_CHAT_BROWSER_PARTIAL").toBe("1 allowance in this chat can't be shown here. It still applies.");
      const rows = [...list.querySelectorAll<HTMLElement>("li[data-google-target]")];
      expect(rows).toHaveLength(2);
      expect(list.querySelector("[data-google-unshown]")!.getBoundingClientRect().top, "the notice is under the cards").toBeGreaterThanOrEqual(rows.at(-1)!.getBoundingClientRect().bottom);
    }
    const fits = () => {
      const c = column.getBoundingClientRect(), n = notice.getBoundingClientRect();
      return {
        page: document.documentElement.scrollWidth <= innerWidth,
        column: n.left >= c.left - 0.5 && n.right <= c.right + 0.5 && column.scrollWidth <= column.clientWidth + 0.5,
        list: list.scrollWidth <= list.clientWidth + 0.5,
        children: [...list.querySelectorAll<HTMLElement>("*")].every(node => { const r = node.getBoundingClientRect(); return r.width === 0 || (r.left >= n.left - 0.5 && r.right <= n.right + 0.5); }),
      };
    };
    expect(fits(), "GOOGLE_CHAT_STATE_NO_HORIZONTAL_OVERFLOW").toEqual({ page: true, column: true, list: true, children: true });
    const tall = Math.ceil(host.scrollHeight + 16);
    await commands.formViewport(width, tall); await page.viewport(width, tall);
    await page.screenshot({ element: host, path: `../../.vitest-attachments/google-standing/chat-${kind}-${theme}-${width}.png` });
  });
}
