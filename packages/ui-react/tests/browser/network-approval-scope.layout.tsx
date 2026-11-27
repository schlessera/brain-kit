import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { ClientMessage, NetworkApprovalOffer, NetworkApprovalScope, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { ApprovalCard } from "../../src/components/activity/approval-card.js";
import { approvalOutcome } from "../../src/components/activity/approval-card.js";
import { activeChat, useChatStore } from "../../src/stores/chat-store.js";
import { replyToToolApproval } from "../../src/lib/tool-approval.js";

// The tainted Network card's four authorized choices (#3595) on both
// surfaces, at a phone and a desktop width: every label whole, every target
// 44px, keyboard allow the narrowest, each button sending its own scope.

let renderer: Root | undefined, root: BrainUiRoot | undefined, host: HTMLDivElement | undefined, styles: HTMLStyleElement;
let viewport: { width: number; height: number }, outer: { width: number; height: number } | undefined;
beforeEach(() => { viewport = { width: innerWidth, height: innerHeight }; });
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());
afterEach(async () => { if (renderer) flushSync(() => renderer!.unmount()); root?.dispose(); host?.remove(); renderer = undefined; root = undefined; host = undefined;
  await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
});

const OFFER: NetworkApprovalOffer = { transport: "http", host: "aeaea-"+"circe".repeat(12)+".invalid", port: 8080, scopes: ["once", "origin", "session"] };
const LABELS = ["Allow once", "Allow this origin for this session", "Allow all origins for this session", "Deny"];
const DESCRIPTION = `This session fetched a web page, so content you did not write may be steering it. Allow it to connect to ${OFFER.host}:8080? `
  + `Allowing lets it send data to ${OFFER.host} for the rest of this session without asking again.`;

async function mount(width: number, surface: "transcript" | "actions") {
  outer = await commands.formViewport(width, 900); await page.viewport(width, 900);
  root = createBrainUiRoot({ storage: null, request: async () => { throw new Error("no lookup"); } });
  root.stores.ui.getState().setSingleKeyShortcuts(true);
  const offer = (id: string) => root!.stores.chat.getState().requestToolApproval(null, id, "Network",
    { host: OFFER.host, port: 8080, method: "GET", target: `${OFFER.host}:8080` }, DESCRIPTION, "command", undefined, undefined, undefined, OFFER);
  offer("net-keyboard"); offer("net-wider");
  // The host re-delivers a pending card on reconnect: its scopes stay the same.
  offer("net-wider");
  const replies: ClientMessage[] = [], receipts: string[] = [];
  const send = (message: ClientMessage) => { replies.push(message); return true; };
  const decide = (id: string, approved: boolean, always?: boolean, scope?: NetworkApprovalScope) => replyToToolApproval(root!, null, send, id, approved, always, scope);
  function View() {
    const calls = useChatStore(s => activeChat(s).messages.at(-1)?.toolCalls ?? []);
    if (surface === "transcript") return <><ToolCallTimeline live toolCalls={calls} onApproval={decide} /><textarea data-composer aria-label="continue" /></>;
    return <><h2 data-needs-you-heading tabIndex={-1}>Needs you</h2>{calls.filter(call => call.status === "pending_approval").map(call => <ApprovalCard key={call.id} tool={call} origin="this conversation" keys
      onDecide={(approved, always, scope) => { const { frame, receipt } = approvalOutcome(call, call.id, approved, always, scope); send(frame); receipts.push(receipt.text);
        root!.stores.chat.getState().resolveToolApproval(null, call.id, approved); }} />)}</>;
  }
  host = document.createElement("div"); host.style.cssText = `width:${Math.min(width, 720)}px;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;
  document.body.append(host); renderer = createRoot(host);
  flushSync(() => renderer!.render(<BrainUiProvider root={root!}><View /></BrainUiProvider>));
  return { replies, receipts };
}

for (const width of [320, 1280]) for (const surface of ["transcript", "actions"] as const)
  test(`${width} ${surface}: a tainted Network card offers four whole, 44px choices; keyboard allow is once; a wider one sends its scope`, async () => {
    const { replies, receipts } = await mount(width, surface);
    const cards = [...host!.querySelectorAll<HTMLElement>("[data-approval-card]")];
    expect(cards, "ONE_CARD_PER_REQUEST_AFTER_REDELIVERY").toHaveLength(2);
    for (const card of cards) {
      const buttons = [...card.querySelectorAll<HTMLElement>('[role="button"]')];
      const labels = buttons.map(button => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "");
      for (const label of LABELS) expect(labels.some(text => text.startsWith(label)), `NETWORK_CARD_OFFERS ${label}`).toBe(true);
      expect(labels.some(text => text.startsWith("Always allow")), "NETWORK_CARD_HAS_NO_ALWAYS_ALLOW").toBe(false);
      expect(card.scrollWidth, "NETWORK_CARD_FITS").toBeLessThanOrEqual(card.clientWidth + 1);
      for (const button of buttons) {
        expect(button.getBoundingClientRect().height, "NETWORK_DECISION_TARGET").toBeGreaterThanOrEqual(44);
        expect(button.scrollWidth, "NETWORK_LABEL_WHOLE").toBeLessThanOrEqual(button.clientWidth + 1);
      }
      if (surface === "transcript") expect(card.textContent, "SCOPED_CARD_DROPS_LEGACY_SENTENCE").not.toContain("for the rest of this session without asking again");
      if (surface === "actions") expect(card.textContent, "ACTIONS_CARD_NAMES_THE_TRANSPORT").toContain(`HTTP to ${OFFER.host}:8080`);
    }
    await commands.formViewport(width, Math.ceil(host!.scrollHeight) + 32); await page.viewport(width, Math.ceil(host!.scrollHeight) + 32);
    await page.screenshot({ element: host!, path: `../../.vitest-attachments/network-approval-scope/${surface}-${width}.png` });
    cards[0]!.focus(); await userEvent.keyboard("a");
    await expect.poll(() => replies.length).toBe(1);
    expect(replies[0], "KEYBOARD_ALLOW_IS_ONCE").toEqual({ type: "tool_approval", toolUseId: "net-keyboard", networkScope: "once", channel: "card" });
    const wider = [...host!.querySelectorAll<HTMLElement>('[data-approval-card] [role="button"]')].find(button => (button.getAttribute("aria-label") ?? button.textContent ?? "").startsWith("Allow all origins for this session"))!;
    await userEvent.click(wider);
    await expect.poll(() => replies.length).toBe(2);
    expect(replies[1], "WIDER_BUTTON_SENDS_ITS_SCOPE").toEqual({ type: "tool_approval", toolUseId: "net-wider", networkScope: "session", channel: "card" });
    // Sending claims no scope: only the host's settled outcome names one.
    const scopes = () => activeChat(root!.stores.chat.getState()).messages.flatMap(message => message.toolCalls).map(call => call.approvalNetworkScope ?? null);
    expect(scopes(), "SCOPE_RECEIPT_ONLY_FROM_HOST_OUTCOME").toEqual([null, null]);
    if (surface === "actions") expect(receipts, "ACTIONS_SEND_CLAIMS_NO_SCOPE").toEqual(["Allowed", "Allowed"]);
    expect(host!.querySelectorAll("[data-network-scope-receipt]")).toHaveLength(0);
    // The host grants the once and refuses the session grant it could not commit.
    root!.connection.handleServerMessage({ type: "tool_resolution", toolUseId: "net-keyboard", turnId: "turn-aeaea", outcome: "granted", networkScope: "once" } as ServerMessage);
    root!.connection.handleServerMessage({ type: "tool_resolution", toolUseId: "net-wider", turnId: "turn-aeaea", outcome: "expired", reason: "The network grant could not be recorded." } as ServerMessage);
    expect(scopes(), "HOST_OUTCOME_SETS_THE_SCOPE").toEqual(["once", null]);
    if (surface === "transcript") await expect.poll(() => [...host!.querySelectorAll<HTMLElement>("[data-network-scope-receipt]")].map(row => row.textContent),
      { message: "TRANSCRIPT_RECEIPTS_NAME_THE_SCOPE" }).toEqual(["Allowed once"]);
  });
