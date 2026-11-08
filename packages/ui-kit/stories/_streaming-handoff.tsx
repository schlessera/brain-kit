import { useState } from "react";
import { expect, waitFor } from "storybook/test";
import { StreamingAnswer } from "../src/conversation/StreamingAnswer.js";
import { TextButton } from "../src/primitives/TextButton.js";
import { FADE_MS, FRAMES_AFTER_FADE, watchHandoff } from "./_handoff-clock.js";

const TOKENS = ["Circe named", " them in order,", " on the morning", " we sailed from Aeaea."];

/** The populated first-token fixture used by the story and native clock controls. */
export function StreamingHandoff() {
  const [count, setCount] = useState(0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
      <TextButton label="Token" onClick={() => setCount(n => Math.min(TOKENS.length, n + 1))} style={{ alignSelf: "flex-start" }} />
      <StreamingAnswer phase="writing" target="drafting" elapsed="2.0s" cost="~$0.03 so far" text={TOKENS.slice(0, count).join("")} />
    </div>
  );
}

export async function playStreamingHandoff({canvas, canvasElement, userEvent}: {
  canvasElement: HTMLElement;
  canvas: {
    findByText(text: string): Promise<HTMLElement>;
    findByRole(role: string, options: {name: string}): Promise<HTMLElement>;
  };
  userEvent: {click(element: Element): Promise<void>};
}) {
  const prose = () => canvasElement.querySelector<HTMLElement>('[aria-busy="true"]');
  await expect(canvasElement.querySelectorAll(".bk-ghost")).toHaveLength(3);
  await expect(prose()).not.toBeNull();
  const ghostTop = canvasElement.querySelector(".bk-ghost")!.getBoundingClientRect().top;
  const stopTop = (await canvas.findByText("~$0.03 so far")).getBoundingClientRect().top;

  const token = await canvas.findByRole("button", { name: "Token" });
  // This story has one prose frame. Its handoff is counted on the page's own
  // clock, from the commit of the first text over the outgoing ghost to the
  // ghost's removal (#3417): input orchestration, later polling and a stalled
  // runner cannot consume the component's budget, but a held ghost still fails.
  const handoff = watchHandoff(prose()!, frame => !frame.hasAttribute("aria-busy") && frame.querySelector(".bk-ghost-tail") !== null && frame.querySelector(".bk-ghost-out") !== null);
  try {
    await userEvent.click(token);
    // The first token is shorter than the ghost; nothing below it moves.
    await expect((await canvas.findByText("~$0.03 so far")).getBoundingClientRect().top).toBeCloseTo(stopTop, 0);
    // Behind, not below: the first line of text starts where the ghost did.
    const firstChar = canvasElement.querySelector(".bk-ghost-tail")!.getBoundingClientRect();
    await expect(Math.abs(firstChar.top - ghostTop)).toBeLessThanOrEqual(6);
    await expect(prose()).toBeNull();
    await handoff.settled;
    handoff.observe();
    // Missing transition observations must fail, rather than become a zero.
    await expect(handoff.arrived, "the first text committed over its outgoing ghost").toBe(true);
    await expect(handoff.fadeMs, "the outgoing ghost's fade, in animation time").toBeLessThanOrEqual(FADE_MS);
    await expect(handoff.framesAfterFade, "frames rendered with the ghost after its fade ended").toBeLessThanOrEqual(FRAMES_AFTER_FADE);
    await expect(handoff.removed, "the outgoing ghost was removed").toBe(true);
    await expect(canvasElement.querySelectorAll(".bk-ghost, .bk-ghost-out")).toHaveLength(0);

    for (let i = 1; i < TOKENS.length; i++) await userEvent.click(token);
    const tail = [...canvasElement.querySelectorAll<HTMLElement>(".bk-ghost-tail")];
    await expect(tail).toHaveLength(9);
    // Just landed: the newest character is still settling.
    await expect(Number(getComputedStyle(tail[tail.length - 1]!).opacity)).toBeLessThan(1);
    await expect(tail.map((t) => t.textContent).join("")).toBe(TOKENS.join("").slice(-9));
    // A timer can run before Chromium paints the animation's final frame.
    // Wait for the rendered result, while still rejecting a tail that stalls.
    await waitFor(async () => {
      for (const t of tail) await expect(getComputedStyle(t).opacity).toBe("1");
    }, { timeout: 1000, interval: 20 });
  } finally {
    handoff.dispose();
  }
}
