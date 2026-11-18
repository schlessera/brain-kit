import { useEffect, useState } from "react";
import preview from "#.storybook/preview";
import { expect, waitFor, within } from "storybook/test";
import { TurnError } from "../../../ui-react/src/components/chat/turn-error.js";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";
import { bounds, ConsumerDocument, consumerStyled, target } from "./_consumer-parity.js";

const message = { id: "fixture", role: "assistant" as const, content: "", toolCalls: [], parts: [], isStreaming: false, timestamp: 0,
  failure: { errorClass: "invalid_request", status: 400, message: "Provider rejected this request." } };

function Review() {
  const [root] = useState(() => createBrainUiRoot({ storage: null }));
  useEffect(() => () => root.dispose(), [root]);
  // TurnError and its dialog are ui-react's: without its stylesheet the
  // dialog paints dimmed under its own backdrop, its textarea is a bare
  // browser box and Copy is clipped (#3748).
  // The chat column's width, stated: the preview centres its root's children,
  // so without one the consumer document shrink-wraps to its padding and the
  // card collapses to 0px wide and 3600px tall, drawn as a lone red rule.
  return <ConsumerDocument><div style={{ width: "min(640px, calc(100vw - 32px))" }}>
    <BrainUiProvider root={root}><TurnError message={message} latest /></BrainUiProvider>
  </div></ConsumerDocument>;
}
const meta = preview.meta({ title: "Conversation/TurnErrorReview", component: Review });

/** The card the dialog opens from is laid out at a readable width. */
async function cardLaidOut(canvasElement: HTMLElement) {
  const card = canvasElement.querySelector<HTMLElement>(".bk-turn-error")!;
  await expect(card.getBoundingClientRect().width, "the turn error card has a column to sit in").toBeGreaterThanOrEqual(280);
  await bounds(card, "turn error card");
}

export const Copy = meta.story({
  render: () => <Review />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await consumerStyled();
    await cardLaidOut(canvasElement);
    const opener = canvas.getByRole("button", { name: "Copy details" });
    await userEvent.click(opener);
    const body = within(canvasElement.ownerDocument.body);
    const dialog = body.getByRole("dialog", { name: "What will be copied" });
    await waitFor(() => expect(within(dialog).getByRole("textbox", { name: "Exact outgoing text" })).toBeVisible());
    await target(await within(dialog).findByRole("button", { name: "Copy" }), "copy dialog Copy");
    await bounds(dialog, "copy dialog");
  },
});
export const Report = meta.story({
  render: () => <Review />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await consumerStyled();
    await cardLaidOut(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Report a bug" }));
    const dialog = within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "What will be sent" });
    await expect(dialog.textContent).toContain("Opening the issue sends this text to GitHub before you submit");
    await waitFor(() => expect(within(dialog).getByRole("textbox", { name: "Exact outgoing text" })).toBeVisible());
    await bounds(dialog, "report dialog");
  },
});
