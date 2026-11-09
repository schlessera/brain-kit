import preview from "#.storybook/preview";
import { atWidth, viewportAt } from "../_viewports.js";
import { useEffect, useState } from "react";
import { expect, fn, waitFor, within } from "storybook/test";
import type { AskUserQuestion } from "@schlessera/brain-ui-sdk/protocol";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";
import { AskUserCard } from "../../../ui-react/src/components/chat/ask-user-card.js";
import { ConsumerDocument, consumerViewport, painted, bounds, accessible } from "./_consumer-parity.js";

const HARBOUR = "Ithaca — Ἰθάκη";
const questions: AskUserQuestion[] = [{ question: "Which harbour first?", header: "Harbour", multiSelect: false, options: [{ label: HARBOUR, description: "Home" }, { label: "Pylos", description: "Nestor’s court" }] }];

/** The actual consumer `AskUserCard`, whose Other field and Submit the
 * answer-delivery runtime drives at 320px dark and 1280px light. */
function AnswerTheme({ onSubmit }: { width: number; onSubmit: (requestId: string, answers: Record<string, string>) => void }) {
  const [root] = useState(() => createBrainUiRoot({ storage: null, request: async input => {
    throw new Error(`Unexpected answer fixture request: ${String(input)}`);
  } }));
  useEffect(() => () => root.dispose(), [root]);
  return <ConsumerDocument><BrainUiProvider root={root}>
    <AskUserCard requestId="odysseus-harbour" questions={questions} onSubmit={onSubmit} onCancel={() => {}} />
  </BrainUiProvider></ConsumerDocument>;
}

const firstCall = (spy: unknown) => (spy as { mock: { calls: unknown[][] } }).mock.calls[0]!.slice(0, 2);

const meta = preview.meta({
  title: "Conversation/Answer theme", component: AnswerTheme,
  parameters: { layout: "fullscreen" }, beforeEach: consumerViewport,
  args: { width: 320, onSubmit: fn() },
  globals: viewportAt(320),
});

export const Phone = meta.story({
  play: async ({ args, userEvent, globals }) => {
    await painted(args.width, globals.theme);
    const screen = within(document.body);
    await userEvent.click(screen.getByRole("radio", { name: /Other/ }));
    const field = screen.getByRole("textbox", { name: "Your own answer" });
    const submit = screen.getByRole("button", { name: "Submit" });
    await expect(getComputedStyle(field).colorScheme, "Other field paints the selected theme").toBe(globals.theme);
    await expect(submit).toHaveAttribute("aria-disabled", "true");
    await userEvent.type(field, "Scheria — Σχερίη");
    await expect(submit).not.toHaveAttribute("aria-disabled");
    await expect(submit.getBoundingClientRect().height, "Other Submit target height").toBeGreaterThanOrEqual(44);
    const well = field.closest<HTMLElement>(".bk-field")!;
    await bounds(well, "Other field");
    await bounds(submit, "Other Submit");
    // The kit card's meta-level contrast gap is the selected option's detail
    // line; the typed answer and the enabled Submit carry no such exception.
    await accessible(well);
    await accessible(submit);
    await userEvent.click(submit);
    await waitFor(() => expect(args.onSubmit).toHaveBeenCalledTimes(1));
    await expect(firstCall(args.onSubmit)).toEqual(["odysseus-harbour", { "Which harbour first?": "Scheria — Σχερίη" }]);
  },
});
export const Desktop = Phone.extend(atWidth(1280));
