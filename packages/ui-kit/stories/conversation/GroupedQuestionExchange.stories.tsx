import { useEffect, useState } from "react";
import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";
import { BrainUiProvider, useBrainUiRoot } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";
import { useChatStore } from "../../../ui-react/src/stores/chat-store.js";
import { MessageBubble } from "../../../ui-react/src/components/chat/message-bubble.js";
import { takeComposerTextAsAnswer } from "../../../ui-react/src/components/chat/ask-user-typed.js";
import { groupedQuestions } from "../../fixtures/actions.js";
import { Composer } from "../../src/chrome/Composer.js";
import { overflowing, stage, wide } from "../_stage.js";

const sent = fn();

/** A deterministic agent frame traverses the production handler, store,
 * transcript binding and composer. No model or server credentials involved. */
function ChatFixture() {
  const [root] = useState(() => createBrainUiRoot({ storage: null }));
  useEffect(() => () => root.dispose(), [root]);
  return <BrainUiProvider root={root}><Transcript /></BrainUiProvider>;
}

function Transcript() {
  const root = useBrainUiRoot();
  const messages = useChatStore((s) => s.draft?.messages);
  const [text, setText] = useState("");
  return <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
    <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => {
      root.stores.chat.getState().startAssistantMessage(null);
      root.connection.handleServerMessage({ type: "ask_user_request", requestId: "group-fixture", questions: groupedQuestions.slice(0, 2) });
    }}>Deliver agent request fixture</button>
    <div data-chat-transcript style={{ maxHeight: 400, overflowY: "auto" }}>
      {messages?.map((message) => <MessageBubble key={message.id} message={message} onToolApproval={() => {}} onAskUserListSubmit={() => {}}
        onAskUserSubmit={(requestId, answers, annotations) => {
          sent({ type: "ask_user_response", requestId, answers, ...(annotations ? { annotations } : {}) });
          root.stores.chat.getState().submitAskUserAnswers(null, requestId, answers, annotations);
        }} onAskUserCancel={(requestId) => root.stores.chat.getState().cancelAskUser(null, requestId)} />)}
    </div>
    <Composer placeholder="Message the crew" value={text} onChange={setText} onSend={(value) => {
      if (!takeComposerTextAsAnswer(root.stores.chat.getState(), null, value, sent)) sent({ type: "chat", content: value });
      setText("");
    }} />
  </div>;
}

const meta = preview.meta({ title: "Conversation/Grouped question exchange", component: ChatFixture, decorators: [stage], parameters: { stageWidth: 320 } });

export const PhoneChat = meta.story({
  render: () => <ChatFixture />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const composer = canvas.getByRole("textbox", { name: "Message the crew" });
    await userEvent.click(composer);
    await userEvent.click(canvas.getByRole("button", { name: "Deliver agent request fixture" }));
    await expect(document.activeElement).toBe(composer);
    await expect(canvas.getAllByText(/needs your input/)).toHaveLength(1);
    await expect(canvasElement.querySelectorAll("[data-group-actions]")).toHaveLength(1);
    // Sending ordinary composer text does not consume or reset the exchange.
    await userEvent.type(composer, "keep the plan visible{Enter}");
    await expect(sent).toHaveBeenCalledWith({ type: "chat", content: "keep the plan visible" });
    await expect(canvas.getByText("0 of 2 answered")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Go to unanswered" }));
    await expect(sent).toHaveBeenCalledTimes(1);
    await expect(canvasElement.querySelectorAll('[aria-invalid="true"]')).toHaveLength(2);
    await userEvent.click(canvas.getByRole("radio", { name: /Along the coast/ }));
    await userEvent.click(canvas.getByRole("checkbox", { name: /The crew/ }));
    await expect(canvas.getAllByRole("button", { name: "Submit" })).toHaveLength(1);
    await userEvent.click(canvas.getByRole("button", { name: "Submit" }));
    await expect(sent).toHaveBeenCalledTimes(2);
    await expect(sent).toHaveBeenLastCalledWith({ type: "ask_user_response", requestId: "group-fixture", answers: {
      [groupedQuestions[0]!.question]: "Along the coast", [groupedQuestions[1]!.question]: "The crew",
    }, annotations: { [groupedQuestions[0]!.question]: { preview: groupedQuestions[0]!.options[0]!.preview } } });
    await expect(canvas.getAllByText("Answered · 2 questions")).toHaveLength(1);
    await expect(canvasElement.querySelector("[data-group-live]")?.textContent ?? "").toBe("All 2 answered. Submitted.");
    await expect(canvas.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument();
    await expect(overflowing(canvasElement)).toEqual([]);
  },
});
export const DesktopChat = PhoneChat.extend({ parameters: wide });
/** The same transcript without an automatic play, for manual inspection. */
export const PhonePreview = meta.story({ render: () => <ChatFixture /> });
