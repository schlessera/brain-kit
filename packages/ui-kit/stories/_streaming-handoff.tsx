import { useState } from "react";
import { expect, waitFor } from "storybook/test";
import { StreamingAnswer } from "../src/conversation/StreamingAnswer.js";

const TOKENS = ["Circe named", " them in order,", " on the morning", " we sailed from Aeaea."];

/** The populated first-token fixture used by the story and native clock controls. */
export function StreamingHandoff() {
  const [count, setCount] = useState(0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
      <button type="button" onClick={() => setCount(n => Math.min(TOKENS.length, n + 1))}>Token</button>
      <StreamingAnswer phase="writing" target="drafting" elapsed="2.0s" text={TOKENS.slice(0, count).join("")} />
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
  // This story has one prose frame. Start its clock when the first text and
  // outgoing ghost commit, and stop it at actual removal. Input orchestration
  // and later assertion/polling work cannot consume the component's budget.
  const frame = prose()!;
  let arrived: number | undefined;
  let removed: number | undefined;
  const observer = new MutationObserver(() => {
    const now = performance.now();
    if (arrived === undefined && !frame.hasAttribute("aria-busy") && frame.querySelector(".bk-ghost-tail") && frame.querySelector(".bk-ghost-out")) arrived = now;
    if (arrived !== undefined && removed === undefined && !frame.querySelector(".bk-ghost, .bk-ghost-out")) removed = now;
  });
  observer.observe(frame, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-busy"] });
  try {
    await userEvent.click(token);
    // The first token is shorter than the ghost; nothing below it moves.
    await expect((await canvas.findByText("~$0.03 so far")).getBoundingClientRect().top).toBeCloseTo(stopTop, 0);
    // Behind, not below: the first line of text starts where the ghost did.
    const firstChar = canvasElement.querySelector(".bk-ghost-tail")!.getBoundingClientRect();
    await expect(Math.abs(firstChar.top - ghostTop)).toBeLessThanOrEqual(6);
    await expect(prose()).toBeNull();
    await waitFor(() => expect(canvasElement.querySelectorAll(".bk-ghost, .bk-ghost-out")).toHaveLength(0), {
      timeout: 1000,
      interval: 20,
    });
    // Missing transition observations must fail, rather than become a zero.
    await expect(arrived).toBeDefined();
    await expect(removed).toBeDefined();
    await expect(removed! - arrived!).toBeLessThan(700);

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
    observer.disconnect();
  }
}
