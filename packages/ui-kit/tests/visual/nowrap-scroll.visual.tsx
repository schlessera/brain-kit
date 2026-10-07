/// <reference types="@vitest/browser-playwright" />
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import "../../src/styles.css";
import { CodeBlock } from "../../src/blocks/CodeBlock.js";
import { SuggestionChips } from "../../src/conversation/SuggestionChips.js";

let root: Root | undefined, host: HTMLDivElement | undefined, fonts: HTMLStyleElement;
beforeAll(async () => {
  await page.viewport(1440, 1000);
  fonts = document.createElement("style"); fonts.textContent = await commands.rankFooterFonts(); document.head.append(fonts);
  await Promise.all(['400 11px "JetBrains Mono"', '500 11.5px "Plus Jakarta Sans"'].map(f => document.fonts.load(f)));
  await document.fonts.ready;
});
afterEach(() => { if (root) flushSync(() => root!.unmount()); host?.remove(); root = undefined; host = undefined; });
afterAll(() => { fonts.remove(); });
const code = 'brain reindex --path voyage/ --force --json --include ' + 'omens/'.repeat(24) + ' --final-argument';
function mount(width: number, theme: string, content: React.ReactNode) {
  host = document.createElement("div"); host.style.width = `${width}px`; host.dataset.theme = theme; document.body.append(host);
  root = createRoot(host); flushSync(() => root!.render(content));
}
function tailBounds(el: HTMLElement) {
  const node = el.firstChild!; const r = document.createRange(); const length = node.textContent!.length;
  r.setStart(node, length - 16); r.setEnd(node, length); return r.getBoundingClientRect();
}
for (const theme of ["dark", "light"]) for (const width of [320,390,720,1280]) {
  test(`code keyboard reaches final argument ${theme} ${width}`, async () => {
    mount(width, theme, <CodeBlock code={code} wrap={false} />);
    const pre = host!.querySelector("pre")!;
    expect(pre.textContent).toBe(code); expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
    await userEvent.tab();
    await userEvent.keyboard('{ArrowRight>100/}');
    await expect.poll(() => pre.scrollLeft, {timeout: 3000}).toBeGreaterThan(0);
    await expect.poll(() => tailBounds(pre).right, {timeout: 3000}).toBeLessThanOrEqual(pre.getBoundingClientRect().right + 1);
    expect(document.activeElement).toBe(pre);
    expect(pre).toHaveAccessibleName("Code");
  });
  test(`chips keyboard and pointer reach every callback ${theme} ${width}`, async () => {
    const clicks = [vi.fn(), vi.fn(), vi.fn()];
    const labels = ["What happened since leaving Troy?", "Who is still owed an offering?", "What did I promise Penelope? ".repeat(8)];
    mount(width, theme, <SuggestionChips wrap={false} items={labels.map((label,i) => ({label,onClick:clicks[i]}))} />);
    const chips = [...host!.querySelectorAll<HTMLElement>('[role="button"]')];
    expect(chips).toHaveLength(3); expect(chips.map(c => c.textContent)).toEqual(labels);
    const row = chips[0]!.parentElement!;
    expect(row.scrollWidth).toBeGreaterThan(row.clientWidth);
    await userEvent.tab();
    for (let i=0;i<3;i++) { await userEvent.tab(); expect(document.activeElement).toBe(chips[i]); await userEvent.keyboard('{Enter}'); expect(clicks[i]).toHaveBeenCalledTimes(1); }
    await userEvent.keyboard('{Shift>}{Tab}{Tab}{Tab}{/Shift}');
    expect(document.activeElement).toBe(row);
    await userEvent.keyboard('{ArrowRight>100/}');
    await expect.poll(() => row.scrollLeft, {timeout:3000}).toBeGreaterThan(0);
    await userEvent.click(page.getByRole("button",{name:labels[2],exact:true}));
    expect(clicks[2]).toHaveBeenCalledTimes(2);
    expect(getComputedStyle(row).overflowX).toBe("auto");
    expect(chips[2]!.scrollWidth).toBeLessThanOrEqual(chips[2]!.clientWidth + 1);
  });
  test(`default wrapping mode still wraps ${theme} ${width}`, () => {
    mount(width, theme, <CodeBlock code="brain reindex --path voyage/ --force --json" />);
    const pre=host!.querySelector("pre")!;expect(getComputedStyle(pre).whiteSpace).toBe("pre-wrap");expect(pre.hasAttribute("tabindex")).toBe(false);
    expect(pre.textContent).toBe("brain reindex --path voyage/ --force --json");
  });
}

// Native touch panning is checked independently of keyboard/focus scrolling.
for (const theme of ["dark", "light"]) for (const kind of ["code", "chips"]) {
  test(`native touch pan reveals hidden ${kind} ${theme}`, async () => {
    mount(320, theme, kind === "code" ? <CodeBlock wrap={false} code={code} /> : <SuggestionChips wrap={false} items={Array.from({length:4},(_,i)=>({label:`Ithaca crossing ${i}: ${"voyage ".repeat(10)}`}))} />);
    const scroll = kind === "code" ? host!.querySelector("pre")! : host!.firstElementChild!.lastElementChild as HTMLElement;
    const b=scroll.getBoundingClientRect(); const start={x:b.right-25,y:b.top+Math.min(15,b.height/2)};
    await commands.rankTouch("touchStart",[start]);
    for (const dx of [20,60,100,180,240]) await commands.rankTouch("touchMove",[{x:start.x-dx,y:start.y}]);
    await commands.rankTouch("touchEnd",[]);
    await expect.poll(()=>scroll.scrollLeft,{timeout:3000}).toBeGreaterThan(0);
    expect(getComputedStyle(scroll).overflowX).toBe("auto");
  });
}

for (const theme of ["dark", "light"]) {
  test(`no-wrap printed cost and disabled reason fit the chip ${theme}`, async () => {
    const click = vi.fn();
    mount(320, theme, <SuggestionChips wrap={false} items={[{
      label: "Show me the other landfalls ".repeat(8), cost: "spends 2 credits",
      disabled: true, why: "needs the host", onClick: click,
    }]} />);
    const chip = host!.querySelector<HTMLElement>('[role="button"]')!;
    expect(chip.textContent).toContain("spends 2 credits");
    expect(chip.textContent).toContain("needs the host");
    expect(chip.getBoundingClientRect().width).toBeLessThanOrEqual(320);
    expect(chip.scrollWidth).toBeLessThanOrEqual(chip.clientWidth + 1);
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(click).not.toHaveBeenCalled();
  });
}
