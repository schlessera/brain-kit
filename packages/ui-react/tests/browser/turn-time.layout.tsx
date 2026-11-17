/// <reference types="@vitest/browser-playwright" />
// The chat turn header's time stamp (#3730): the transcript's only visible
// "when". It is meaningful text, so it is read in order, takes no tab stop and
// meets 4.5:1 at full strength. Rendered through the real MessageBubble and
// TurnHeader in ui-react's compiled stylesheet, at both widths and in both
// themes.
import { afterAll, beforeAll, expect, test, type TestContext } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import axe from "axe-core";
import type { ReactNode } from "react";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import { TurnHeader } from "../../src/components/chat/transcript-turn.js";
import type { ChatMessage } from "../../src/stores/chat-state.js";

const AT = Date.parse("2026-07-12T09:00:00Z");
const turn = (id: string, role: ChatMessage["role"], content: string, minutes: number): ChatMessage =>
  ({ id, role, content, toolCalls: [], parts: [{ kind: "text", text: content }], isStreaming: false, timestamp: AT + minutes * 60_000 });
const TURNS = [
  turn("you", "user", "How many oars are left on the black ship?", 0),
  turn("brain", "assistant", "Forty-four oars, after the storm off Ismarus.", 1),
];

let styles: HTMLStyleElement;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => { styles.remove(); delete document.documentElement.dataset.theme; });

async function scene(ctx: TestContext, width: number, theme: "dark" | "light", content: ReactNode) {
  const previous = { width: innerWidth, height: innerHeight };
  const outer = await commands.formViewport(width, 720);
  await page.viewport(width, 720);
  document.documentElement.dataset.theme = theme;
  const ui = createBrainUiRoot({ storage: null });
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;width:${width}px;height:720px;padding:16px;box-sizing:border-box;background:var(--bk-color-canvas);color:var(--bk-color-ink);overflow:auto`;
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<BrainUiProvider root={ui}>{content}</BrainUiProvider>));
  ctx.onTestFinished(async () => { flushSync(() => root.unmount()); ui.dispose(); host.remove(); await page.viewport(previous.width, previous.height); await commands.formViewport(outer.width - 100, outer.height - 120); });
  return host;
}

const transcript = <>{TURNS.map(message => <MessageBubble key={message.id} message={message} onToolApproval={() => {}}
  onAskUserSubmit={() => {}} onAskUserCancel={() => {}} onAskUserListSubmit={() => {}} />)}</>;

function times(host: HTMLElement) {
  const spans = [...host.querySelectorAll<HTMLElement>("[data-turn-time]")];
  expect(spans, "a time in the user turn and in the brain turn").toHaveLength(2);
  return spans;
}

/** axe `color-contrast` on exactly these elements; every one is measured and passes 4.5:1. */
async function textContrast(ctx: TestContext, elements: HTMLElement[], label: string) {
  const result = await axe.run(elements, { runOnly: { type: "rule", values: ["color-contrast"] } });
  expect(result.violations.flatMap(v => v.nodes.map(n => n.failureSummary)), `axe color-contrast: ${label}`).toEqual([]);
  expect(result.incomplete.flatMap(v => v.nodes.map(n => n.target.join(" "))), `axe could measure every ${label}`).toEqual([]);
  const measured = result.passes.flatMap(v => v.nodes).map(n => n.any[0]!.data as { fgColor: string; bgColor: string; contrastRatio: number });
  expect(measured, `every ${label} was measured`).toHaveLength(elements.length);
  for (const { contrastRatio } of measured) expect(contrastRatio, JSON.stringify(measured)).toBeGreaterThanOrEqual(4.5);
  for (const element of elements) expect(getComputedStyle(element).opacity, `no opacity on the ${label} itself`).toBe("1");
  ctx.annotate(`${label}: ${measured.map(m => `${m.fgColor} on ${m.bgColor} = ${m.contrastRatio}:1`).join("; ")}`);
}

for (const theme of ["dark", "light"] as const) for (const width of [320, 1280]) {
  test(`turn header time meets text contrast (${theme}, ${width})`, async ctx => {
    const host = await scene(ctx, width, theme, transcript);
    await textContrast(ctx, times(host), `time stamp (${theme}, ${width})`);
  });

  // #3765: the speaker name leads the header in the speaker's tone, at full strength.
  test(`turn header speaker name meets text contrast (${theme}, ${width})`, async ctx => {
    const host = await scene(ctx, width, theme, transcript);
    const names = times(host).map(time => time.parentElement!.querySelector<HTMLElement>(":scope > span")!);
    expect(names.map(name => name.textContent), "the user and the brain turn's names").toEqual(["You", "Brain"]);
    await textContrast(ctx, names, `speaker name (${theme}, ${width})`);
  });
}

// One theme per width: visibility, exposure and reading order take no
// theme-specific class; the contrast cases above own the themes.
for (const width of [320, 1280]) {
  test(`turn time is visible and exposed (${width})`, async ctx => {
    const host = await scene(ctx, width, "dark", transcript);
    for (const [index, span] of times(host).entries()) {
      const message = TURNS[index]!;
      const expected = new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      expect(span.textContent, "the existing when string, unchanged").toBe(expected);
      expect(span.checkVisibility({ opacityProperty: true, visibilityProperty: true }), "painted").toBe(true);
      expect(span.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(span.closest('[aria-hidden="true"]'), "read by screen readers").toBeNull();
      expect(span.closest("[inert]")).toBeNull();
      expect(span.tabIndex, "no tab stop of its own").toBe(-1);
      expect(span.querySelector("a,button,[tabindex]")).toBeNull();
      const header = span.parentElement!;
      const text = header.textContent!;
      const who = index === 0 ? "You" : "Brain";
      expect(text.toLowerCase().indexOf(expected.toLowerCase()), "read after the speaker").toBeGreaterThan(text.toLowerCase().indexOf(who.toLowerCase()));
    }
  });
}

// A long speaker, an effort note and a long time at the narrowest width: the
// hairline gives way first, then the header wraps; the time is never squeezed.
test("a long turn header at 320 keeps the whole time visible", async ctx => {
  const when = "12 July 2026, 09:00:00 AM";
  const host = await scene(ctx, 320, "light", <TurnHeader tone="user" who="Odysseus, son of Laertes" effort="effort high → medium (backend)" when={when} />);
  const span = host.querySelector<HTMLElement>("[data-turn-time]")!;
  const header = span.parentElement!;
  const hairline = header.querySelector<HTMLElement>(".h-px")!;
  expect(document.documentElement.scrollWidth, "no horizontal page overflow").toBeLessThanOrEqual(innerWidth);
  expect(header.scrollWidth, "no header overflow").toBeLessThanOrEqual(header.clientWidth);
  expect(span.textContent).toBe(when);
  const box = span.getBoundingClientRect();
  expect(box.right, "inside the viewport").toBeLessThanOrEqual(innerWidth);
  expect(span.scrollWidth, "not truncated").toBeLessThanOrEqual(span.clientWidth);
  expect(span.getClientRects().length, "not squeezed onto several lines").toBe(1);
  expect(box.height, "one line").toBeLessThanOrEqual(parseFloat(getComputedStyle(span).lineHeight) + 1);
  expect(box.top, "the header wrapped the time onto its own line").toBeGreaterThan(header.querySelector("span")!.getBoundingClientRect().bottom - 1);
  expect(hairline.getBoundingClientRect().width, "the hairline gave way").toBeLessThan(box.width);
});
