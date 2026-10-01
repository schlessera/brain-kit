import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AskUserFormExchangeCard } from "../../../ui-react/src/components/chat/ask-user-form-card.js";

for (const theme of ["dark", "light"])
  test(`form consumer: shared styles and sticky controls in ${theme}`, async () => {
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "width:320px;height:500px;border:0";
    document.body.append(iframe);
    const doc = iframe.contentDocument!;
    doc.documentElement.dataset.theme = theme;
    doc.body.style.cssText = "margin:0;width:320px";
    const style = doc.createElement("style");
    style.textContent = await commands.formConsumerStyles();
    doc.head.append(style);
    const container = doc.createElement("div");
    doc.body.append(container);
    const root = createRoot(container);
    const sent: unknown[] = [];
    try {
      flushSync(() =>
        root.render(
          <AskUserFormExchangeCard
            requestId="consumer"
            form={{
              prompt: "Crew notes",
              nodes: Array.from({ length: 12 }, (_, i) => ({
                id: `n${i}`,
                kind: "text",
                prompt: `Recollection ${i + 1}`,
                required: false,
              })),
            }}
            onSubmit={(_, answers) => sent.push(answers)}
            onCancel={() => {}}
          />,
        ),
      );
      const win = iframe.contentWindow!;
      const card = container.querySelector<HTMLElement>(".bk-askform")!;
      const header = card.querySelector<HTMLElement>(".bk-form-header")!;
      const footer = card.querySelector<HTMLElement>("[data-form-actions]")!;
      const input = card.querySelector<HTMLTextAreaElement>("textarea")!;
      expect(card.getBoundingClientRect().width).toBe(320);
      expect(win.getComputedStyle(input).minHeight).toBe("44px");
      expect(win.getComputedStyle(header).position).toBe("sticky");
      expect(win.getComputedStyle(footer).position).toBe("sticky");
      expect(card.querySelectorAll("[data-form-actions]")).toHaveLength(1);
      win.scrollTo(0, 400);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(header.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        win.innerHeight + 1,
      );
      flushSync(() => {
        input.value = "Remember the crossing";
        const event = doc.createEvent("Event");
        event.initEvent("input", true, false);
        input.dispatchEvent(event);
      });
      const submit = [
        ...card.querySelectorAll<HTMLElement>('[role="button"]'),
      ].find((el) => el.textContent === "Submit")!;
      flushSync(() => submit.click());
      expect(sent).toEqual([{ n0: "Remember the crossing" }]);
    } finally {
      flushSync(() => root.unmount());
      iframe.remove();
    }
  });
