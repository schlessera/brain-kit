import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";
import { BrainUiProvider, useRootStore } from "../../../ui-react/src/root-context.js";
import { MessageBubble } from "../../../ui-react/src/components/chat/message-bubble.js";

const SESSION = "ithaca-chat";
const PARTIAL = "The fleet is still crossing the harbour.";
const noop = () => {};

function Transcript() {
  const buffer = useRootStore("chat", state =>
    state.activeSessionId === null ? state.draft : state.buffers[state.activeSessionId]);
  return <>{buffer?.messages.map(message => (
    <div key={message.id} data-message-role={message.role}>
      <MessageBubble message={message} onToolApproval={noop} onAskUserSubmit={noop}
        onAskUserCancel={noop} onAskUserListSubmit={noop} />
    </div>
  ))}</>;
}

for (const theme of ["dark", "light"]) {
  for (const width of [320, 1440]) {
    test(`frame refusals preserve the live reply in ${theme} at ${width}px`, async () => {
      const iframe = document.createElement("iframe");
      iframe.style.cssText = `width:${width}px;height:640px;border:0`;
      document.body.append(iframe);
      const doc = iframe.contentDocument!;
      doc.documentElement.dataset.theme = theme;
      doc.body.style.cssText = "margin:0";
      const style = doc.createElement("style");
      style.textContent = await commands.formConsumerStyles();
      doc.head.append(style);
      const container = doc.createElement("div");
      doc.body.append(container);
      const ui = createBrainUiRoot({ storage: null });
      const react = createRoot(container);
      try {
        const chat = ui.stores.chat.getState();
        chat.setMessages(SESSION, []);
        chat.setActiveSession(SESSION);
        chat.addUserMessage(SESSION, "How is the crossing going?");
        chat.startAssistantMessage(SESSION, "active");
        ui.connection.handleServerMessage({ type: "text_delta", sessionId: SESSION, turnId: "active", text: PARTIAL });
        ui.connection.flushChatDeltas();
        flushSync(() => react.render(<BrainUiProvider root={ui}><Transcript /></BrainUiProvider>));
        expect(container.querySelectorAll('[data-message-role="assistant"]')).toHaveLength(1);
        expect(container.textContent).toContain(PARTIAL);
        expect(ui.stores.chat.getState().buffers[SESSION].messages[1].isStreaming).toBe(true);

        for (const code of ["RATE_LIMITED", "PARSE_ERROR"]) {
          flushSync(() => ui.connection.handleServerMessage({ type: "error", code, message: "Frame refused" }));
          expect(container.querySelectorAll('[data-message-role="assistant"]')).toHaveLength(1);
          expect(container.querySelectorAll("[data-turn-failure]")).toHaveLength(0);
          expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
          expect(container.textContent).toContain(PARTIAL);
          expect(ui.stores.chat.getState().buffers[SESSION].messages[1].isStreaming).toBe(true);
          expect(ui.stores.connection.getState().lastError).toMatchObject({ code, message: "Frame refused" });
        }

        flushSync(() => {
          ui.connection.handleServerMessage({ type: "text_delta", sessionId: SESSION, turnId: "active", text: " Still sailing." });
          ui.connection.flushChatDeltas();
        });
        expect(container.textContent).toContain(PARTIAL + " Still sailing.");

        flushSync(() => ui.connection.handleServerMessage({
          type: "error", code: "agent_error", sessionId: SESSION, turnId: "active", message: "Provider unavailable",
          failure: { errorClass: "server_error", status: 500, message: "Provider unavailable" },
        }));
        expect(container.querySelectorAll('[data-message-role="assistant"]')).toHaveLength(1);
        expect(container.querySelectorAll("[data-turn-failure]")).toHaveLength(1);
        expect(container.textContent).toContain("The provider failed to complete this request.");
        expect(ui.stores.chat.getState().buffers[SESSION].messages[1].isStreaming).toBe(false);

        flushSync(() => {
          chat.setActiveSession(null);
          chat.startDraftTurn();
          chat.addUserMessage(null, "How is the crossing going?");
          ui.connection.handleServerMessage({
            type: "error", code: "CLAUDE_AUTH", message: "Check the subscription configuration",
            failure: { errorClass: "subscription_required", message: "Check the subscription configuration", authAction: "check_config" },
          });
        });
        expect(container.querySelectorAll("[data-turn-failure]")).toHaveLength(1);
        expect(container.textContent).toContain("for whoever runs this server");
        expect(ui.stores.chat.getState().draft!.messages[1].failure?.authAction).toBe("check_config");
      } finally {
        flushSync(() => react.unmount());
        ui.dispose();
        iframe.remove();
      }
    });
  }
}
