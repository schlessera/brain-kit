import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainMarkdown } from "../../src/components/chat/brain-markdown.js";
import { contrast, parse } from "../../../ui-kit/tests/_contrast.js";

let renderer: Root | undefined, root: BrainUiRoot | undefined, host: HTMLDivElement | undefined, styles: HTMLStyleElement;
let viewport: { width: number; height: number }, outer: { width: number; height: number }, themeBefore: string | undefined;
beforeEach(() => { viewport = { width: innerWidth, height: innerHeight }; themeBefore = document.documentElement.dataset.theme; });
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());
afterEach(async () => { if (renderer) flushSync(() => renderer!.unmount()); root?.dispose(); host?.remove(); renderer = undefined; root = undefined; host = undefined;
  document.documentElement.dataset.theme = themeBefore; await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
});
const command = 'brain search "Scylla" --path knowledge/' + 'Scylla'.repeat(30) + ' --final-argument';
const javascript = '// The crossing remains visible.\nfunction crossing(crew) {\n  const guide = "Circe";\n  return crew === 24 && true ? /scylla/i : null;\n}';
const diff = '- Risk six men.\n+ Keep the crossing visible.';
const markdown = '```js\n' + javascript + '\n```\n\n```diff\n' + diff + '\n```\n\n```\n' + command + '\n```';
for (const width of [320,1280]) for (const theme of ["dark","light"]) {
  test(`${theme} ${width}: real highlighted fences meet 4.5:1, wrap every argument and keep a 44px head copy target`, async () => {
    outer = await commands.formViewport(width, 900); await page.viewport(width, 900); document.documentElement.dataset.theme = theme;
    root = createBrainUiRoot({ storage: null, request: async () => { throw new Error("no code lookup"); } });
    host = document.createElement("div"); host.style.cssText = `width:${Math.min(width,720)}px;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;
    document.body.append(host); renderer = createRoot(host);
    flushSync(() => renderer!.render(<BrainUiProvider root={root}><BrainMarkdown content={markdown}/></BrainUiProvider>));
    await expect.poll(() => host!.querySelectorAll('.hljs-keyword').length).toBeGreaterThan(0);
    const blocks = [...host.querySelectorAll<HTMLElement>('[data-kit-code-block]')]; expect(blocks).toHaveLength(3);
    const tokens = [...host.querySelectorAll<HTMLElement>('pre span[class*="hljs-"]')]; expect(tokens.length).toBeGreaterThan(10);
    for (const category of ["keyword","string","number","literal","title","comment","addition","deletion"]) {
      expect(host.querySelectorAll(`.hljs-${category}`).length, `nonempty ${category} fixture`).toBeGreaterThan(0);
    }
    const classes = new Set<string>();
    for (const token of tokens) {
      for (const name of token.classList) if (name.startsWith("hljs-")) classes.add(name);
      const code = token.closest('[data-kit-code-block]')!;
      const fg = parse(getComputedStyle(token).color), bg = parse(getComputedStyle(code).backgroundColor);
      expect(fg.alpha).toBe(1); expect(bg.alpha).toBe(1);
      expect(contrast(fg.rgb,bg.rgb), `${theme} ${token.className} computed code contrast`).toBeGreaterThanOrEqual(4.5);
    }
    expect(classes.size).toBeGreaterThanOrEqual(8);
    expect(getComputedStyle(host.querySelector('.hljs-keyword')!).color).not.toBe(getComputedStyle(host.querySelector('.hljs-string')!).color);
    expect(getComputedStyle(host.querySelector('.hljs-comment')!).fontStyle).toBe("italic");
    for (const block of blocks) {
      const pre = block.querySelector('pre')!; const button = block.querySelector('button')!;
      expect(pre.scrollWidth, "all code is readable without horizontal scrolling").toBeLessThanOrEqual(pre.clientWidth + 1);
      expect(button.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      expect(button.getBoundingClientRect().bottom, "copy has its own head space").toBeLessThanOrEqual(pre.getBoundingClientRect().top + 1);
      expect(getComputedStyle(button).opacity).toBe("1");
    }
    const pre = blocks[2]!.querySelector('pre')!; expect(pre.textContent?.trimEnd()).toBe(command);
    const text = pre.querySelector('code')!.firstChild!; const range = document.createRange(); range.setStart(text,command.indexOf('--final-argument')); range.setEnd(text,command.length);
    for (const box of range.getClientRects()) { expect(box.left).toBeGreaterThanOrEqual(pre.getBoundingClientRect().left); expect(box.right).toBeLessThanOrEqual(pre.getBoundingClientRect().right + 1); }
    expect(blocks[2]!.firstElementChild!.textContent).toBe("");
    const copy = blocks[2]!.querySelector('button')!;
    copy.focus(); expect(document.activeElement).toBe(copy);
    const ring = parseFloat(getComputedStyle(copy).outlineWidth) + parseFloat(getComputedStyle(copy).outlineOffset);
    expect(ring, "visible keyboard focus ring").toBeGreaterThan(0);
    expect(copy.getBoundingClientRect().top - ring, "full focus ring stays inside the clipped shell").toBeGreaterThanOrEqual(blocks[2]!.getBoundingClientRect().top);
    expect(copy.getBoundingClientRect().right + ring).toBeLessThanOrEqual(blocks[2]!.getBoundingClientRect().right);
    await commands.formViewport(width,Math.ceil(host.scrollHeight)+32); await page.viewport(width,Math.ceil(host.scrollHeight)+32);
    await page.screenshot({ element: host, path: `../../.vitest-attachments/code-fences/${theme}-${width}.png` });
  });
}
