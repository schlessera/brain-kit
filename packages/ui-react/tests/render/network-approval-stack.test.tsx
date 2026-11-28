/**
 * Component + store proofs for #4967 and #3595 UI:
 * - Pinned stack above composer for the open chat only, grouped by origin;
 * - Zero synthetic `Network` rows added to transcript messages;
 * - DOM node persistence across 5 same-id revision updates + 500ms arming;
 * - Host-owned outcomes (`Sending…` -> `tool_resolution` -> one-line receipt);
 * - Other chat's pending approval excluded from open stack, counted in Actions;
 * - Mobile soft-keyboard collapse;
 * - Keyboard shortcut `a` picks narrowest choice (`once`);
 * - Chat header active network grants + revoke;
 * - Activity approval card scope labels + revision echo + unadvertised refusal.
 */
import { registerNetworkApprovalStackDom, unregisterNetworkApprovalStackDom } from "./network-approval-stack-dom.js";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ClientMessage, NetworkApprovalOffer } from "@schlessera/brain-ui-sdk/protocol";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { openRestoredCards } from "../../src/lib/restored-approvals.js";
import { snapshotSource } from "../../src/lib/handoff.js";
import { replyToNetworkApproval } from "../../src/lib/tool-approval.js";
import { pendingApprovals } from "../../src/stores/chat-store.js";
import { ChatApprovalStack } from "../../src/components/chat/approval-stack.js";
import { NetworkApprovalReceipts } from "../../src/components/chat/network-receipts.js";
import { NetworkGrantsBar } from "../../src/components/chat/network-grants-bar.js";
import { ApprovalCard, approvalOutcome } from "../../src/components/activity/approval-card.js";

beforeAll(registerNetworkApprovalStackDom);
afterEach(() => {
  cleanup();
});
afterAll(unregisterNetworkApprovalStackDom);

function offer(host: string, overrides: Partial<NetworkApprovalOffer> = {}): NetworkApprovalOffer {
  return {
    transport: "http",
    scheme: "https",
    host,
    port: 443,
    scopes: ["once", "origin", "session"],
    classes: ["web_fetch"],
    ...overrides,
  };
}

describe("network approval stack (#4967, #3595)", () => {
  test("4 parallel requests render one stack with 4 grouped cards, Allow all 4 sites, and zero synthetic Network rows in transcript", () => {
    const root = createBrainUiRoot({ storage: null });
    const sent: ClientMessage[] = [];
    const send = (msg: ClientMessage) => { sent.push(msg); return true; };
    const chat = root.stores.chat.getState();
    chat.setActiveSession("ithaca");
    chat.startAssistantMessage("ithaca", "turn-1");

    for (const [i, host] of ["ithaca.example", "pylos.example", "sparta.example", "ogygia.example"].entries()) {
      chat.requestToolApproval(
        "ithaca",
        `net-${i + 1}`,
        "Network",
        { host, port: 443, method: "GET", protocol: "https:" },
        `Allow ${host}?`,
        "command",
        false,
        "turn-1",
        undefined,
        { origin: `https://${host}:443`, revision: `rev-${i + 1}`, network: offer(host) }
      );
    }

    const view = render(
      <BrainUiProvider root={root}>
        <ChatApprovalStack send={send} armingMs={0} />
      </BrainUiProvider>
    );

    try {
      // Zero synthetic `Network` rows in transcript messages!
      const msgs = root.stores.chat.getState().buffers["ithaca"]!.messages;
      expect(msgs.flatMap((m) => m.toolCalls), "NO_SYNTHETIC_NETWORK_ROWS").toEqual([]);

      // One stack with 4 grouped cards and "Allow all 4 sites for this chat".
      expect(view.container.querySelectorAll("[data-network-approval-group]"), "FOUR_GROUPED_CARDS").toHaveLength(4);
      const allowAll = view.getByText("Allow all 4 sites for this chat");
      fireEvent.click(allowAll);
      expect(sent, "ALLOW_ALL_SENDS_SESSION_SCOPE").toEqual([
        {
          type: "tool_approval",
          toolUseId: "net-1",
          turnId: "turn-1",
          revision: "rev-1",
          networkScope: "session",
          channel: "card",
        },
      ]);
    } finally {
      root.dispose();
    }
  });

  test("DOM node persists across 5 revision updates; click during arming is ignored; click after arming applies", async () => {
    const root = createBrainUiRoot({ storage: null });
    const sent: ClientMessage[] = [];
    const send = (msg: ClientMessage) => { sent.push(msg); return true; };
    const chat = root.stores.chat.getState();
    chat.setActiveSession("ithaca");

    chat.requestToolApproval(
      "ithaca",
      "net-stable",
      "Network",
      { host: "ithaca.example", port: 443, method: "GET", protocol: "https:" },
      "Allow ithaca.example?",
      "command",
      false,
      "turn-1",
      undefined,
      { origin: "https://ithaca.example:443", revision: "rev-0", network: offer("ithaca.example") }
    );

    const view = render(
      <BrainUiProvider root={root}>
        <ChatApprovalStack send={send} armingMs={80} />
      </BrainUiProvider>
    );

    try {
      const initialNode = view.container.querySelector('[data-network-approval-group="https://ithaca.example:443"]');
      expect(initialNode).not.toBeNull();

      // 5 consecutive revision updates under the same toolUseId must keep the exact same DOM node!
      for (let r = 1; r <= 5; r++) {
        act(() => {
          root.stores.chat.getState().requestToolApproval(
            "ithaca",
            "net-stable",
            "Network",
            { host: "ithaca.example", port: 443, method: "GET", protocol: "https:" },
            `Updated allow ithaca.example? (#${r})`,
            "command",
            false,
            "turn-1",
            undefined,
            { origin: "https://ithaca.example:443", revision: `rev-${r}`, network: offer("ithaca.example") }
          );
        });
        const currentNode = view.container.querySelector('[data-network-approval-group="https://ithaca.example:443"]');
        expect(currentNode, `DOM_NODE_PERSISTS_REV_${r}`).toBe(initialNode);
      }

      // Immediately after the 5th update we are inside the arming window: buttons are aria-disabled and clicks are ignored!
      const allowOnceDuringArming = view.getByRole("button", { name: "Allow once for ithaca.example" });
      expect(allowOnceDuringArming.getAttribute("aria-disabled"), "ARMED_ARIA_DISABLED").toBe("true");
      fireEvent.click(allowOnceDuringArming);
      expect(sent, "ARMING_IGNORES_CLICK").toEqual([]);

      // Wait for arming window to finish, then click!
      await act(async () => { await Bun.sleep(110); });
      const allowOnceReady = view.getByRole("button", { name: "Allow once for ithaca.example" });
      expect(allowOnceReady.getAttribute("aria-disabled")).toBeNull();
      fireEvent.click(allowOnceReady);
      expect(sent, "POST_ARMING_CLICK_APPLIES_LATEST_REVISION").toEqual([
        {
          type: "tool_approval",
          toolUseId: "net-stable",
          turnId: "turn-1",
          revision: "rev-5",
          networkScope: "once",
          channel: "card",
        },
      ]);
    } finally {
      root.dispose();
    }
  });

  test("after a click the card shows Sending… until tool_resolution settles it; expired and unknown show truthful receipts, never approved", () => {
    const root = createBrainUiRoot({ storage: null });
    const sent: ClientMessage[] = [];
    const send = (msg: ClientMessage) => { sent.push(msg); return true; };
    const chat = root.stores.chat.getState();
    chat.setActiveSession("ithaca");

    chat.requestToolApproval(
      "ithaca",
      "net-unknown",
      "Network",
      { host: "ithaca.example", port: 443, method: "GET", protocol: "https:" },
      "Allow ithaca.example?",
      "command",
      false,
      "turn-1",
      undefined,
      { origin: "https://ithaca.example:443", revision: "rev-1", network: offer("ithaca.example") }
    );
    chat.requestToolApproval(
      "ithaca",
      "net-expired",
      "Network",
      { host: "pylos.example", port: 443, method: "GET", protocol: "https:" },
      "Allow pylos.example?",
      "command",
      false,
      "turn-1",
      undefined,
      { origin: "https://pylos.example:443", revision: "rev-2", network: offer("pylos.example") }
    );

    const view = render(
      <BrainUiProvider root={root}>
        <ChatApprovalStack send={send} armingMs={0} />
        <NetworkApprovalReceipts />
      </BrainUiProvider>
    );

    try {
      fireEvent.click(view.getByRole("button", { name: "Allow once for ithaca.example" }));
      const cardEl = view.container.querySelector('[data-network-approval-group="https://ithaca.example:443"] [data-kit-network-approval-card]');
      expect(cardEl?.getAttribute("data-network-state"), "SHOWS_SENDING_BEFORE_HOST_RESOLUTION").toBe("sending");
      expect(view.getAllByText("Sending…").length).toBeGreaterThanOrEqual(1);

      // Host answers `unknown`: card leaves stack and renders truthful closed receipt, NEVER approved!
      act(() => {
        root.stores.chat.getState().applyToolResolution({
          type: "tool_resolution",
          toolUseId: "net-unknown",
          outcome: "unknown",
          sessionId: "ithaca",
          turnId: "turn-1",
        });
      });
      expect(view.container.querySelector('[data-network-approval-group="https://ithaca.example:443"]')).toBeNull();
      expect(view.getByText("This request had already closed — nothing ran")).toBeTruthy();

      // Host answers `expired` with `operation_cancelled`: leaves stack, renders one withdrawn receipt line.
      act(() => {
        root.stores.chat.getState().applyToolResolution({
          type: "tool_resolution",
          toolUseId: "net-expired",
          outcome: "expired",
          expiryCause: "operation_cancelled",
          sessionId: "ithaca",
          turnId: "turn-1",
          reason: "The network request stopped waiting.",
        });
      });
      expect(view.container.querySelectorAll("[data-network-approval-group]")).toHaveLength(0);
      expect(view.container.querySelectorAll("[data-network-receipt-id]"), "EXACTLY_ONE_RECEIPT_PER_TERMINAL_CARD").toHaveLength(2);
      expect(view.getByText(/Withdrawn · pylos\.example stopped waiting/)).toBeTruthy();
    } finally {
      root.dispose();
    }
  });

  test("grouped 3 connections on one origin + once sends oldest id only; keyboard `a` picks narrowest choice (`once`); other chat stays out of open stack and in Actions", () => {
    const root = createBrainUiRoot({ storage: null });
    const sent: ClientMessage[] = [];
    const send = (msg: ClientMessage) => { sent.push(msg); return true; };
    const chat = root.stores.chat.getState();
    chat.setActiveSession("ithaca");

    for (const id of ["g-1", "g-2", "g-3"]) {
      chat.requestToolApproval(
        "ithaca",
        id,
        "Network",
        { host: "ithaca.example", port: 443, method: "GET", protocol: "https:" },
        "Allow ithaca.example?",
        "command",
        false,
        "turn-1",
        undefined,
        { origin: "https://ithaca.example:443", revision: "rev-g", network: offer("ithaca.example") }
      );
    }
    // Pending approval in ANOTHER chat ("pylos") whose buffer is already loaded.
    chat.setMessages("pylos", []);
    chat.requestToolApproval(
      "pylos",
      "other-1",
      "Network",
      { host: "secret.example", port: 443, method: "GET", protocol: "https:" },
      "Allow secret.example?",
      "command",
      false,
      "turn-other",
      undefined,
      { origin: "https://secret.example:443", revision: "rev-other", network: offer("secret.example") }
    );

    const view = render(
      <BrainUiProvider root={root}>
        <ChatApprovalStack send={send} armingMs={0} />
      </BrainUiProvider>
    );

    try {
      // Open chat stack shows ONLY ithaca.example grouped (3 connections), NEVER secret.example from pylos!
      expect(view.getByText("ithaca.example · 3 connections waiting")).toBeTruthy();
      expect(view.queryByText(/secret\.example/)).toBeNull();
      // Actions selector counts all 4 pending approvals across both chats (including pylos!).
      const allPending = pendingApprovals(root.stores.chat.getState());
      expect(allPending.some((p) => p.key === "pylos" && p.tool.id === "other-1"), "OTHER_CHAT_COUNTED_IN_ACTIONS").toBe(true);
      expect(allPending).toHaveLength(4);

      // Keyboard `a` on the focused card picks narrowest choice (`once`) on the oldest request (`g-1`)!
      const groupEl = view.container.querySelector('[data-network-approval-group="https://ithaca.example:443"]') as HTMLElement;
      fireEvent.keyDown(groupEl, { key: "a" });
      expect(sent, "KEYBOARD_A_PICKS_NARROWEST_ONCE_ON_OLDEST").toEqual([
        {
          type: "tool_approval",
          toolUseId: "g-1",
          turnId: "turn-1",
          revision: "rev-g",
          networkScope: "once",
          channel: "card",
        },
      ]);
    } finally {
      root.dispose();
    }
  });

  test("mobile soft-keyboard collapses stack to count bar; grants bar lists and revokes grants; Activity approvalOutcome enforces advertised scopes", async () => {
    const revokes: string[] = [];
    const root = createBrainUiRoot({
      storage: null,
      request: async (url, init) => {
        if (init?.method === "DELETE") {
          revokes.push(url);
          return Response.json({ revoked: true, grantId: "ng_1" });
        }
        return Response.json({
          sessionId: "ithaca",
          grants: [
            {
              grantId: "ng_1",
              scope: "origin",
              origin: "https://ithaca.example:443",
              host: "ithaca.example",
              port: 443,
              scheme: "https",
              transport: "http",
              grantedClasses: ["web_fetch"],
              suspended: false,
              createdAt: 1,
            },
          ],
        });
      },
    });
    const chat = root.stores.chat.getState();
    chat.setActiveSession("ithaca");
    chat.requestToolApproval(
      "ithaca",
      "m-1",
      "Network",
      { host: "ithaca.example", port: 443, method: "GET", protocol: "https:" },
      "Allow ithaca.example?",
      "command",
      false,
      "turn-1",
      undefined,
      { origin: "https://ithaca.example:443", revision: "rev-m", network: offer("ithaca.example") }
    );

    // Simulate mobile viewport with soft keyboard open.
    const realWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const realHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    const realVV = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const listeners = new Set<() => void>();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        height: 460,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      },
    });

    try {
      const view = render(
        <BrainUiProvider root={root}>
          <NetworkGrantsBar />
          <ChatApprovalStack send={() => true} armingMs={0} />
        </BrainUiProvider>
      );
      await act(async () => { await Bun.sleep(20); });

      const stackEl = view.container.querySelector("[data-kit-approval-stack]") as HTMLElement;
      expect(stackEl.getAttribute("data-collapsed"), "MOBILE_KEYBOARD_COLLAPSES_STACK").toBe("true");
      expect(view.getByText("Network: ithaca.example")).toBeTruthy();

      fireEvent.click(view.getByRole("button", { name: "Revoke network grant for ithaca.example" }));
      await act(async () => { await Bun.sleep(20); });
      expect(revokes.some((u) => u.includes("/sessions/ithaca/network-grants/ng_1"))).toBe(true);

      // Activity approvalOutcome: managed reference or missing tool refuses unadvertised scope (frame: null, never legacy fallback)!
      const managedOutcome = approvalOutcome(
        {
          id: "gh-1",
          name: "Network",
          input: { host: "api.github.com", port: 443 },
          inputJson: "{}",
          status: "pending_approval",
          approvalRevision: "rev-gh",
          approvalOrigin: "managed:connect://api.github.com:443",
          approvalNetwork: offer("api.github.com", { managedReference: true, scopes: ["once"] }),
        },
        "gh-1",
        true,
        false,
        "origin"
      );
      expect(managedOutcome.frame, "UNADVERTISED_SCOPE_REFUSED_NO_FRAME").toBeNull();
      expect(approvalOutcome(undefined, "missing-1", true, false, "session").frame, "MISSING_TOOL_SCOPED_REFUSED").toBeNull();

      // Activity ApprovalCard renders four scope buttons for non-managed origin offer.
      const decided: Array<[boolean, string | undefined]> = [];
      const activityView = render(
        <BrainUiProvider root={root}>
          <ApprovalCard
            tool={{
              id: "act-1",
              name: "Network",
              input: { host: "pylos.example", port: 443 },
              inputJson: "{}",
              status: "pending_approval",
              approvalRevision: "rev-act",
              approvalOrigin: "https://pylos.example:443",
              approvalNetwork: offer("pylos.example"),
            }}
            origin="session pylos"
            keys={true}
            onDecide={(approved, _always, scope) => decided.push([approved, scope])}
          />
        </BrainUiProvider>
      );
      expect(activityView.getByText("Allow once")).toBeTruthy();
      expect(activityView.getByText("Allow pylos.example for this chat")).toBeTruthy();
      expect(activityView.getByText("Allow all sites for this chat")).toBeTruthy();
      expect(activityView.getByText("Deny")).toBeTruthy();
      fireEvent.keyDown(activityView.container.querySelector("[data-approval-card]")!, { key: "a" });
      expect(decided, "ACTIVITY_KEYBOARD_A_PICKS_ONCE").toEqual([[true, "once"]]);

      // Restored Network approvals join openRestoredCards / close / reopen / revoke,
      // and replyToNetworkApproval refuses unadvertised scopes when network metadata is absent.
      const root2 = createBrainUiRoot({ storage: null });
      try {
        const chat2 = root2.stores.chat.getState();
        chat2.setActiveSession("pylos");
        chat2.requestToolApproval(
          "pylos",
          "net-restored-1",
          "Network",
          { host: "pylos.example", port: 443 },
          "Allow pylos.example?",
          "command",
          false,
          "turn-9",
          undefined,
          { origin: "https://pylos.example:443", revision: "rev-r1", network: offer("pylos.example", { scopes: ["session", "origin"] }) }
        );
        expect(openRestoredCards(root2.stores.chat.getState().buffers["pylos"])).toEqual([
          { toolUseId: "net-restored-1", turnId: "turn-9" },
        ]);
        chat2.closeRestoredApprovals("pylos", [{ toolUseId: "net-restored-1", closure: "unlisted" }]);
        expect(openRestoredCards(root2.stores.chat.getState().buffers["pylos"])).toHaveLength(1);
        chat2.reopenRestoredApprovals("pylos", ["net-restored-1"]);
        expect(root2.stores.chat.getState().buffers["pylos"]!.networkApprovals![0]!.readOnly).toBeUndefined();
        chat2.revokeRestoredApprovals();
        expect(root2.stores.chat.getState().buffers["pylos"]!.networkApprovals![0]!.readOnly).toBe("revoked");
        expect(openRestoredCards(root2.stores.chat.getState().buffers["pylos"])).toEqual([]);

        const sent2: ClientMessage[] = [];
        expect(
          replyToNetworkApproval(
            root2,
            "pylos",
            (m) => { sent2.push(m); return true; },
            { toolUseId: "net-no-meta", revision: "rev-0", network: undefined },
            { approved: true, scope: "session" }
          ),
          "UNADVERTISED_WITHOUT_METADATA_REFUSED"
        ).toBe(false);
        expect(sent2).toEqual([]);
      } finally {
        root2.dispose();
      }
    } finally {
      if (realWidth) Object.defineProperty(window, "innerWidth", realWidth);
      if (realHeight) Object.defineProperty(window, "innerHeight", realHeight);
      if (realVV) Object.defineProperty(window, "visualViewport", realVV);
      else Reflect.deleteProperty(window, "visualViewport");
      root.dispose();
    }
  });

  test("pendingApprovals is referentially stable for useShallow, snapshotSource counts networkApprovals, and origin-only cards use unscoped Allow", () => {
    const root = createBrainUiRoot({ storage: null });
    const sent: ClientMessage[] = [];
    const send = (msg: ClientMessage) => { sent.push(msg); return true; };
    const chat = root.stores.chat.getState();
    chat.setActiveSession("ithaca");
    chat.requestToolApproval(
      "ithaca",
      "net-origin-only",
      "Network",
      { host: "legacy.example", port: 443 },
      "Allow legacy.example?",
      "command",
      false,
      "turn-legacy",
      undefined,
      { origin: "https://legacy.example:443", revision: "rev-legacy" }
    );

    const view = render(
      <BrainUiProvider root={root}>
        <ChatApprovalStack send={send} armingMs={0} />
      </BrainUiProvider>
    );

    try {
      // 1. Referential stability for ActivityPage's useShallow((s) => pendingApprovals(s).map((a) => a.tool)).
      const snap1 = pendingApprovals(root.stores.chat.getState());
      const snap2 = pendingApprovals(root.stores.chat.getState());
      expect(snap1).toHaveLength(1);
      expect(snap1[0]!.tool, "PENDING_APPROVAL_TOOL_STABLE_REF").toBe(snap2[0]!.tool);

      // 2. Handoff snapshot counts open networkApprovals.
      expect(snapshotSource(root.stores.chat.getState().buffers["ithaca"]).pendingApprovals, "HANDOFF_COUNTS_NETWORK_APPROVALS").toBe(1);

      // 3. Origin-only card without network.scopes renders a working unscoped Allow button (no dead scoped buttons).
      expect(view.queryByRole("button", { name: /Allow once/i })).toBeNull();
      expect(view.queryByRole("button", { name: /for this chat/i })).toBeNull();
      const allowBtn = view.getByRole("button", { name: "Allow legacy.example" });
      fireEvent.click(allowBtn);
      expect(sent, "LEGACY_UNSCOPED_ALLOW_SENT").toEqual([
        {
          type: "tool_approval",
          toolUseId: "net-origin-only",
          turnId: "turn-legacy",
          revision: "rev-legacy",
          channel: "card",
        },
      ]);
      // Once marked sending, pendingApprovals emits a fresh ToolCall ref with approvalSending: true.
      const snap3 = pendingApprovals(root.stores.chat.getState());
      expect(snap3[0]!.tool).not.toBe(snap1[0]!.tool);
      expect(snap3[0]!.tool.approvalSending).toBe(true);

      // 4. Activity ApprovalCard handles empty scopes ([]) and sending state on unscoped Network cards.
      let activityDecided = 0;
      const activityView = render(
        <BrainUiProvider root={root}>
          <ApprovalCard
            tool={{
              ...snap3[0]!.tool,
              approvalNetwork: offer("legacy.example", { scopes: [] }),
            }}
            origin="Chat"
            keys={false}
            onDecide={() => { activityDecided++; }}
          />
        </BrainUiProvider>
      );
      const sendingAllow = activityView.getByRole("button", { name: "Sending…" });
      expect(sendingAllow.getAttribute("aria-disabled"), "UNSCOPED_ACTIVITY_ALLOW_DISABLED_WHEN_SENDING").toBe("true");
      fireEvent.click(sendingAllow);
      expect(activityDecided, "UNSCOPED_ACTIVITY_SENDING_CLICK_INERT").toBe(0);

      // 5. Upgrading a provisional receipt preserves originLabel (both bound session and draft buffer).
      act(() => {
        chat.applyToolResolution({
          type: "tool_resolution",
          toolUseId: "net-origin-only",
          outcome: "expired",
          expiryCause: "turn_ended",
          sessionId: "ithaca",
          turnId: "turn-legacy",
          reason: "Provisional",
        });
        chat.applyToolResolution({
          type: "tool_resolution",
          toolUseId: "net-origin-only",
          outcome: "expired",
          expiryCause: "operation_cancelled",
          sessionId: "ithaca",
          turnId: "turn-legacy",
        });
      });
      const upgraded = root.stores.chat.getState().buffers["ithaca"]!.networkReceipts!.find((r) => r.toolUseId === "net-origin-only")!;
      expect(upgraded.originLabel, "PROVISIONAL_UPGRADE_PRESERVES_ORIGIN_LABEL").toBe("legacy.example");
      expect(upgraded.reason).toBe("Withdrawn · legacy.example stopped waiting");

      // Draft buffer provisional upgrade (msg.sessionId undefined).
      act(() => {
        chat.requestToolApproval(
          null,
          "net-draft-1",
          "Network",
          { host: "draft.example", port: 443 },
          "Allow draft.example?",
          "command",
          false,
          "turn-draft",
          undefined,
          { origin: "https://draft.example:443", revision: "rev-d1", network: offer("draft.example") }
        );
        chat.applyToolResolution({
          type: "tool_resolution",
          toolUseId: "net-draft-1",
          outcome: "expired",
          expiryCause: "turn_ended",
          turnId: "turn-draft",
        });
        chat.applyToolResolution({
          type: "tool_resolution",
          toolUseId: "net-draft-1",
          outcome: "expired",
          expiryCause: "operation_cancelled",
          turnId: "turn-draft",
        });
      });
      const draftUpgraded = root.stores.chat.getState().draft!.networkReceipts!.find((r) => r.toolUseId === "net-draft-1")!;
      expect(draftUpgraded.originLabel, "DRAFT_UPGRADE_PRESERVES_ORIGIN_LABEL").toBe("draft.example");
      expect(draftUpgraded.reason).toBe("Withdrawn · draft.example stopped waiting");
    } finally {
      root.dispose();
    }
  });

  test("reconnect history replay preserves network state, live re-delivery clears readOnly:unlisted, and grant revoke uses live store state and catches failures", async () => {
    const root = createBrainUiRoot({ storage: null });
    const chat = root.stores.chat.getState();
    chat.setActiveSession("ithaca");
    chat.requestToolApproval(
      "ithaca",
      "net-reconnect-1",
      "Network",
      { host: "ithaca.example", port: 443 },
      "Allow ithaca.example?",
      "command",
      false,
      "turn-1",
      undefined,
      { origin: "https://ithaca.example:443", revision: "rev-1", network: offer("ithaca.example") }
    );
    chat.applyToolResolution({
      type: "tool_resolution",
      toolUseId: "net-done-1",
      outcome: "granted",
      networkScope: "origin",
      grantedByGrant: true,
      sessionId: "ithaca",
      turnId: "turn-1",
      reason: "Allowed for ithaca.example",
    });

    // 1. setMessages during reconnect preserves networkApprovals and networkReceipts.
    chat.setMessages("ithaca", [{ id: "m1", role: "user", content: "Sail", parts: [], isStreaming: false, timestamp: 1, toolCalls: [] }]);
    expect(root.stores.chat.getState().buffers["ithaca"]!.networkApprovals, "REPLAY_PRESERVES_NETWORK_APPROVALS").toHaveLength(1);
    expect(root.stores.chat.getState().buffers["ithaca"]!.networkReceipts, "REPLAY_PRESERVES_NETWORK_RECEIPTS").toHaveLength(1);

    // 2. Live re-delivery clears readOnly: "unlisted" so the card is interactive again.
    chat.closeRestoredApprovals("ithaca", [{ toolUseId: "net-reconnect-1", closure: "unlisted" }]);
    expect(root.stores.chat.getState().buffers["ithaca"]!.networkApprovals![0]!.readOnly).toBe("unlisted");
    chat.requestToolApproval(
      "ithaca",
      "net-reconnect-1",
      "Network",
      { host: "ithaca.example", port: 443 },
      "Allow ithaca.example?",
      "command",
      false,
      "turn-1",
      undefined,
      { origin: "https://ithaca.example:443", revision: "rev-1", network: offer("ithaca.example") }
    );
    expect(root.stores.chat.getState().buffers["ithaca"]!.networkApprovals![0]!.readOnly, "REDELIVERY_CLEARS_UNLISTED_READONLY").toBeUndefined();
    expect(pendingApprovals(root.stores.chat.getState()), "REDELIVERED_CARD_VISIBLE_IN_PENDING").toHaveLength(1);

    // 3. NetworkGrantsBar revoke merges against latest store state and handles failures cleanly.
    const grant1 = { grantId: "g-1", scope: "origin" as const, origin: "https://ithaca.example:443", host: "ithaca.example", port: 443, scheme: "https" as const, transport: "http" as const, grantedClasses: ["web_fetch"], createdAt: 1, suspended: false };
    const grant2 = { grantId: "g-2", scope: "origin" as const, origin: "https://pylos.example:443", host: "pylos.example", port: 443, scheme: "https" as const, transport: "http" as const, grantedClasses: ["web_fetch"], createdAt: 2, suspended: false };
    chat.setNetworkGrants("ithaca", [grant1]);
    let resolveDelete!: () => void;
    let shouldFail = false;
    root.api.listNetworkGrants = async (sid) => ({ sessionId: sid, grants: root.stores.chat.getState().networkGrants["ithaca"] ?? [] });
    root.api.revokeNetworkGrant = async (_sid, grantId) => {
      if (shouldFail) throw new Error("network down");
      await new Promise<void>((r) => { resolveDelete = r; });
      return { revoked: true, grantId };
    };
    const barView = render(
      <BrainUiProvider root={root}>
        <NetworkGrantsBar />
      </BrainUiProvider>
    );
    try {
      // Let initial mount listNetworkGrants settle before simulating revoke + concurrent WS update.
      await act(async () => { await Promise.resolve(); });
      fireEvent.click(barView.getByRole("button", { name: "Revoke network grant for ithaca.example" }));
      // Concurrent WS update adds g-2 while DELETE g-1 is in flight.
      act(() => {
        root.stores.chat.getState().setNetworkGrants("ithaca", [grant1, grant2]);
      });
      await act(async () => {
        resolveDelete();
        await Promise.resolve();
      });
      expect(
        root.stores.chat.getState().networkGrants["ithaca"]?.map((g) => g.grantId),
        "CONCURRENT_GRANT_SURVIVES_STALE_REVOKE_CLOSURE"
      ).toEqual(["g-2"]);

      // Failed revoke is caught cleanly and leaves g-2 intact.
      shouldFail = true;
      await act(async () => {
        fireEvent.click(barView.getByRole("button", { name: "Revoke network grant for pylos.example" }));
        await Promise.resolve();
      });
      expect(
        root.stores.chat.getState().networkGrants["ithaca"]?.map((g) => g.grantId),
        "FAILED_REVOKE_LEAVES_GRANT_INTACT"
      ).toEqual(["g-2"]);
    } finally {
      root.dispose();
    }
  });
});
