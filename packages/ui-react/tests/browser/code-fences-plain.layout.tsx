import { afterEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainMarkdown } from "../../src/components/chat/brain-markdown.js";

let renderer: Root | undefined, root: BrainUiRoot | undefined, host: HTMLDivElement | undefined, styles: HTMLStyleElement | undefined;
const clipboardBefore = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const themeBefore = document.documentElement.dataset.theme;
let viewport = { width: innerWidth, height: innerHeight }, outer: { width: number; height: number } | undefined;
afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount()); root?.dispose(); host?.remove(); styles?.remove();
  await commands.codeHighlightFailure(false); document.documentElement.dataset.theme = themeBefore;
  if (clipboardBefore) Object.defineProperty(navigator, "clipboard", clipboardBefore); else Reflect.deleteProperty(navigator, "clipboard");
  await page.viewport(viewport.width,viewport.height); if (outer) await commands.formViewport(outer.width-100,outer.height-120);
});
test("before highlighting and after a real lazy-module failure, streamed fences keep exact copy in both themes and widths", async () => {
  await commands.codeHighlightFailure(true);
  styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles);
  root = createBrainUiRoot({ storage: null }); host = document.createElement("div"); document.body.append(host); renderer = createRoot(host);
  const partial = 'echo "Circe"'; const complete = partial + '\nbrain search "Scylla" --path knowledge/' + 'Scylla'.repeat(30) + ' --final-argument';
  const writes: string[] = [];
  Object.defineProperty(navigator,"clipboard",{ configurable:true, value:{writeText:(value:string)=>{writes.push(value);return Promise.resolve();}} });
  flushSync(() => renderer!.render(<BrainUiProvider root={root!}><BrainMarkdown content={'```bash\n'+partial}/></BrainUiProvider>));
  const card = host.querySelector('[data-kit-code-block]')!; expect(card).not.toBeNull();
  expect(card.querySelector('pre')!.textContent?.trimEnd()).toBe(partial);
  expect(host.querySelectorAll('[class*="hljs-"]')).toHaveLength(0);
  await userEvent.click(card.querySelector('button')!); expect(writes).toEqual([partial]);
  await expect.poll(() => commands.codeHighlightFailureCount(), { message: "the actual lazy request failed" }).toBeGreaterThan(0);
  for (const width of [320,1280]) for (const theme of ["dark","light"]) {
    outer ??= await commands.formViewport(width,800); await commands.formViewport(width,800); await page.viewport(width,800); document.documentElement.dataset.theme=theme;
    host.style.cssText=`width:${Math.min(width,720)}px;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;
    flushSync(() => renderer!.render(<BrainUiProvider root={root!}><BrainMarkdown content={'```bash\n'+complete+'\n```'}/></BrainUiProvider>));
    expect(host.querySelector('[data-kit-code-block]'),"streaming preserves the component").toBe(card);
    expect(host.querySelectorAll('[class*="hljs-"]')).toHaveLength(0);
    const pre=card.querySelector('pre')!; expect(pre.textContent?.trimEnd()).toBe(complete); expect(pre.scrollWidth).toBeLessThanOrEqual(pre.clientWidth+1);
    await userEvent.click(card.querySelector('button')!); expect(writes.at(-1)).toBe(complete);
  }
});
