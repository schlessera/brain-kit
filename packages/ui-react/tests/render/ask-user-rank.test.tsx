import { unregisterAskUserRankDom } from "./ask-user-rank-dom.js";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { AskUserRankExchangeCard } from "../../src/components/chat/ask-user-rank-card.js";
import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import { flushChatDeltas, handleServerMessage } from "../../src/hooks/use-websocket.js";
import { useChatStore } from "../../src/stores/chat-store.js";
import { useUIStore } from "../../src/stores/ui-store.js";
import type { AskUserRankSpec, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";

afterEach(cleanup);
afterAll(unregisterAskUserRankDom);
beforeEach(() => {
  flushChatDeltas();
  useChatStore.setState({ buffers: {}, draft: null, pendingDraftId: null, activeSessionId: null, runStates: {} });
  useUIStore.setState({ singleKeyShortcuts: true });
});
const RANK: AskUserRankSpec = { prompt: "Which first?", items: Array.from({ length: 6 }, (_, i) => ({ id: `id-${i}`, label: `Journey ${i}` })) };
const IDS = RANK.items.map((item) => item.id);
const noop = () => {};
function mount(rank = RANK) {
  const sent: { order: string[]; unchanged: boolean }[] = [];
  const view = render(<AskUserRankExchangeCard requestId="r" rank={rank} onSubmit={(_, order, unchanged) => sent.push({ order, unchanged })} onCancel={noop} />);
  return { ...view, sent };
}
describe("ranking exchange", () => {
  test("six items keep their initial order explicitly, with one header and action row", () => {
    const view = mount();
    expect(view.container.querySelectorAll("[data-rank-row]")).toHaveLength(6);
    expect(view.container.querySelectorAll("[data-rank-head]")).toHaveLength(1);
    expect(view.container.querySelectorAll("[data-rank-actions]")).toHaveLength(1);
    fireEvent.click(view.getByRole("button", { name: "Keep this order" }));
    expect(view.sent).toEqual([{ order: IDS, unchanged: true }]);
  });
  test("tap pickup and placement are sufficient for any move and replace the action row", () => {
    const view = mount();
    fireEvent.click(view.getByRole("button", { name: "Journey 5, position 6 of 6" }));
    expect(view.queryByRole("button", { name: "Keep this order" })).toBeNull();
    expect(view.container.querySelectorAll("[data-rank-actions]")).toHaveLength(1);
    fireEvent.click(view.getByRole("button", { name: "Journey 0, position 1 of 6" }));
    expect(view.getByRole("button", { name: "Journey 5, position 1 of 6" })).toBeDefined();
    expect(view.container.querySelector("[aria-live]")?.textContent).toBe("Journey 5 moved to 1 of 6.");
    fireEvent.click(view.getByRole("button", { name: "Submit order" }));
    expect(view.sent).toEqual([{ order: [IDS[5]!, ...IDS.slice(0, 5)], unchanged: false }]);
  });
  test("keyboard pickup, arrows and drop retain row focus; Escape restores the original order", () => {
    const view = mount();
    const pick = view.getByRole("button", { name: "Journey 2, position 3 of 6" });
    act(() => pick.focus());
    fireEvent.keyDown(pick, { key: " " });
    fireEvent.keyDown(pick, { key: "ArrowUp" });
    fireEvent.keyDown(pick, { key: "ArrowUp" });
    expect(document.activeElement).toBe(pick);
    expect(pick.getAttribute("aria-label")).toBe("Journey 2, position 1 of 6, picked up");
    fireEvent.keyDown(pick, { key: "Escape" });
    expect(pick.getAttribute("aria-label")).toBe("Journey 2, position 3 of 6");
    expect(view.container.querySelector("[aria-live]")?.textContent).toBe("Move cancelled. Journey 2 stays at 3.");
    fireEvent.keyDown(pick, { key: "Alt", altKey: true });
    fireEvent.keyDown(pick, { key: "ArrowUp", altKey: true });
    fireEvent.click(view.getByRole("button", { name: "Submit order" }));
    expect(view.sent[0]?.order).toEqual([IDS[0]!, IDS[2]!, IDS[1]!, ...IDS.slice(3)]);
  });
  test("cutoff marks the boundary, announces the displaced row and returns every id", () => {
    const view = mount({ ...RANK, cutoff: 2 });
    fireEvent.click(view.getByRole("button", { name: "Journey 5, position 6 of 6, not ranked" }));
    fireEvent.click(view.getByRole("button", { name: "Journey 0, position 1 of 6" }));
    expect(view.container.querySelector("[aria-live]")?.textContent).toContain("Journey 1 dropped below the top 2");
    expect(view.container.textContent).toContain("only your top 2 count");
    fireEvent.click(view.getByRole("button", { name: "Submit order" }));
    expect(view.sent[0]?.order).toHaveLength(6);
  });
  test("Reset and Undo restore their exact orders; returning to the initial order says Keep", () => {
    const view = mount();
    const pick = view.getByRole("button", { name: "Journey 2, position 3 of 6" });
    fireEvent.keyDown(pick, { key: "1" });
    expect([...view.container.querySelectorAll<HTMLElement>("[data-rank-row]")].map((row) => row.dataset.rankRow)).toEqual([IDS[2]!, IDS[0]!, IDS[1]!, ...IDS.slice(3)]);
    fireEvent.click(view.getByRole("button", { name: "Reset" }));
    expect([...view.container.querySelectorAll<HTMLElement>("[data-rank-row]")].map((row) => row.dataset.rankRow)).toEqual(IDS);
    expect(view.getByRole("button", { name: "Keep this order" })).toBeDefined();
    fireEvent.click(view.getByRole("button", { name: /Undo/ }));
    expect([...view.container.querySelectorAll<HTMLElement>("[data-rank-row]")].map((row) => row.dataset.rankRow)).toEqual([IDS[2]!, IDS[0]!, IDS[1]!, ...IDS.slice(3)]);
    expect(view.getByRole("button", { name: "Submit order" })).toBeDefined();
    fireEvent.keyDown(pick, { key: "3" });
    expect(view.getByRole("button", { name: "Keep this order" })).toBeDefined();
  });
  test("the settings switch disables letters and digits while arrow controls remain", () => {
    useUIStore.setState({ singleKeyShortcuts: false });
    const view = mount();
    const pick = view.getByRole("button", { name: "Journey 2, position 3 of 6" });
    fireEvent.keyDown(pick, { key: "1" });
    expect(view.getByRole("button", { name: "Keep this order" })).toBeDefined();
    fireEvent.keyDown(pick, { key: "ArrowUp", altKey: true });
    expect(view.getByRole("button", { name: "Submit order" })).toBeDefined();
  });
  test("answered history renders the persisted order through the real handler and message bubble", () => {
    const order = [IDS[2]!, IDS[0]!, IDS[5]!, IDS[1]!, IDS[3]!, IDS[4]!];
    const history: SessionHistoryMessage = { role: "assistant", content: "", toolCalls: [{ id: "tool-1", name: "mcp__brain-ui__ask_user_rank", input: RANK as unknown as Record<string, unknown>, output: JSON.stringify({ order, unchanged: false }), isError: false }] };
    act(() => handleServerMessage({ type: "session_history", sessionId: "s", messages: [history] }));
    const message = useChatStore.getState().buffers.s!.messages[0]!;
    expect(message.askUserExchanges?.[0]?.order).toEqual(order);
    const view = render(<MessageBubble message={message} onToolApproval={noop} onAskUserSubmit={noop} onAskUserListSubmit={noop} onAskUserCancel={noop} />);
    expect(view.container.querySelector("[data-state=answered]")).not.toBeNull();
    expect([...view.container.querySelectorAll(".bk-rank-label")].map((node) => node.textContent)).toEqual(order.map((id) => RANK.items.find((item) => item.id === id)!.label));
    expect(view.container.textContent).toContain("Ranked 6");
  });
});
