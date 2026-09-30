import { useEffect, useState } from "react";
import preview from "#.storybook/preview";
import { expect, within } from "storybook/test";
import { TurnError } from "../../../ui-react/src/components/chat/turn-error.js";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";

const message = { id: "fixture", role: "assistant" as const, content: "", toolCalls: [], parts: [], isStreaming: false, timestamp: 0,
  failure: { errorClass: "invalid_request", status: 400, message: "Provider rejected this request." } };

function Review() {
  const [root] = useState(() => createBrainUiRoot({ storage: null }));
  useEffect(() => () => root.dispose(), [root]);
  return <BrainUiProvider root={root}><TurnError message={message} latest /></BrainUiProvider>;
}
const meta = preview.meta({ title: "Conversation/TurnErrorReview", component: Review });

export const Copy = meta.story({
  render: () => <Review />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const opener = canvas.getByRole("button", { name: "Copy details" });
    await userEvent.click(opener);
    const body = within(canvasElement.ownerDocument.body);
    const dialog = body.getByRole("dialog", { name: "What will be copied" });
    await expect(within(dialog).getByRole("textbox", { name: "Exact outgoing text" })).toBeVisible();
    await expect(within(dialog).getByRole("button", { name: "Copy" }).getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  },
});
export const Report = meta.story({
  render: () => <Review />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Report a bug" }));
    const dialog = within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "What will be sent" });
    await expect(dialog.textContent).toContain("Opening the issue sends this text to GitHub before you submit");
    await expect(within(dialog).getByRole("textbox", { name: "Exact outgoing text" })).toBeVisible();
  },
});
