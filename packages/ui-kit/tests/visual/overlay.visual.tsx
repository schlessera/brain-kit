/// <reference types="@vitest/browser-playwright" />
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { Overlay, type OverlayProps, type OverlayVariant } from "../../src/chrome/Overlay.js";
import { Button } from "../../src/primitives/Button.js";
import { contrast, parse } from "../_contrast.js";
import "../../src/styles.css";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const viewport = { width: innerWidth, height: innerHeight };
let outer: { width: number; height: number } | undefined;
const theme = document.documentElement.dataset.theme;
afterEach(async () => {
  if (root) flushSync(() => root!.unmount()); root = undefined; host?.remove(); host = undefined;
  if (theme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  await commands.dictationMotion("no-preference");
  await page.viewport(viewport.width, viewport.height);
  if (outer) {
    await commands.formViewport(outer.width - 100, outer.height - 120);
    // The host page sets screenshot scale too; iframe restoration alone leaks.
    const restored = await commands.formViewport(outer.width - 100, outer.height - 120);
    expect(restored, "overlay fixture restores outer viewport").toEqual(outer);
  }
  outer = undefined;
});
async function mount(children: React.ReactNode, width = 1280, height = 800) {
  const previous = await commands.formViewport(width, height);
  await page.viewport(width, height);
  outer ??= previous;
  await commands.dictationMotion("reduce");
  host = document.createElement("div"); host.style.cssText = 'width:100%;height:100%;background:var(--bk-color-canvas);color:var(--bk-color-ink)';
  document.body.append(host); root = createRoot(host); flushSync(() => root!.render(children));
}
const q = (selector: string) => host!.querySelector<HTMLElement>(selector)!;
function Harness(p: Partial<Pick<OverlayProps, "variant" | "closedBy" | "initialFocus" | "returnFocus" | "modal">> = {}) {
  const [open, setOpen] = useState(false);
  return <><button data-opener="" onClick={() => setOpen(true)}>Open raft plan</button>
    <Overlay label="Raft plan" variant="sheet" {...p} open={open} onClose={() => setOpen(false)}>
      <button data-first="">Read plan</button><button data-autofocus="">Review mast</button><button data-last="">Review yard</button>
    </Overlay></>;
}
async function open() { await userEvent.click(q('[data-opener]')); await expect.poll(() => Boolean(q('.bk-overlay'))).toBe(true); }

test("focus moves to data-autofocus on open", async () => {
  // Mutation: omit initial focus call → initial focus assertion.
  await mount(<Harness />); await open();
  expect(document.activeElement, "initial focus").toBe(q('[data-autofocus]'));
});
test("Tab and Shift+Tab wrap and ten forward Tabs never leave the surface", async () => {
  // Mutation: disable Tab branch → forward/reverse wrap assertions.
  await mount(<Harness />); await open(); q('[data-last]').focus();
  await userEvent.keyboard('{Tab}'); expect(document.activeElement, "forward wrap").toBe(q('[data-first]'));
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}'); expect(document.activeElement, "reverse wrap").toBe(q('[data-last]'));
  for (let i = 0; i < 10; i++) { await userEvent.keyboard('{Tab}'); expect(q('.bk-overlay-surface').contains(document.activeElement), "tab containment").toBe(true); }
});
test("Escape closes only the top nested overlay and returns each opener", async () => {
  // Mutation: remove modal ownership/consumption guard and stopPropagation → bottom escape count assertion.
  const reasons: string[] = [];
  function Stack() {
    const [panel, setPanel] = useState(false); const [sheet, setSheet] = useState(false); const [dialog, setDialog] = useState(false);
    return <><button data-opener="" onClick={() => setPanel(true)}>Open Sessions</button>
      <Overlay open={panel} variant="panel" modal={false} label="Sessions" onClose={() => { reasons.push('panel'); setPanel(false); }}>
        <button data-sheet-opener="" onClick={() => setSheet(true)}>Open raft plan</button>
        <Overlay open={sheet} variant="sheet" label="Raft plan" onClose={() => { reasons.push('sheet'); setSheet(false); }}>
          <button data-dialog-opener="" onClick={() => setDialog(true)}>Review plan</button>
          <Overlay open={dialog} variant="dialog" label="Review plan" onClose={() => { reasons.push('dialog'); setDialog(false); }}><button>Done</button></Overlay>
        </Overlay>
      </Overlay></>;
  }
  await mount(<Stack />); await open(); await userEvent.click(q('[data-sheet-opener]')); await userEvent.click(q('[data-dialog-opener]'));
  await userEvent.keyboard('{Escape}'); expect(reasons, "bottom escape count").toEqual(['dialog']);
  expect(document.activeElement, "dialog opener").toBe(q('[data-dialog-opener]'));
  await userEvent.keyboard('{Escape}'); expect(reasons).toEqual(['dialog', 'sheet']); expect(document.activeElement).toBe(q('[data-sheet-opener]'));
  await userEvent.keyboard('{Escape}'); expect(reasons).toEqual(['dialog', 'sheet', 'panel']); expect(document.activeElement).toBe(q('[data-opener]'));
});
test("close returns focus to the opener after inert is removed", async () => {
  // Mutation: disable focus return → returned opener assertion.
  await mount(<Harness />); await open(); await userEvent.keyboard('{Escape}');
  expect(document.activeElement, "returned opener").toBe(q('[data-opener]'));
});
test("scrim dismissal obeys any, closerequest and none", async () => {
  // Mutation: scrim allows closerequest → restricted scrim assertion.
  for (const closedBy of ['any', 'closerequest', 'none'] as const) {
    await mount(<Harness closedBy={closedBy} />); await open();
    await userEvent.click(q('.bk-overlay-scrim'), { position: { x: 4, y: 4 } });
    expect(Boolean(q('.bk-overlay')), "restricted scrim").toBe(closedBy !== 'any');
    flushSync(() => root!.unmount()); root = undefined; host!.remove(); host = undefined;
  }
});
test("native modal makes the background inert and locks scrolling", async () => {
  // Mutation: showModal→show → native modal/inert assertion.
  await mount(<Harness />); await open();
  expect(q('dialog').matches(':modal'), "native modal").toBe(true);
  q('[data-opener]').focus(); expect(document.activeElement, "background cannot focus").toBe(q('[data-autofocus]'));
  const r = q('[data-opener]').getBoundingClientRect();
  expect(document.elementFromPoint(r.left + 2, r.top + 2), "background hit is scrim").toBe(q('.bk-overlay-scrim'));
  expect(getComputedStyle(document.documentElement).overflow).toBe('hidden');
});
test("destination keeps marked navigation operable by hit and Tab, and content inert", async () => {
  // Mutation: mark branches with keepLive → live tab assertion.
  await mount(<><aside><nav data-bk-keep-live="" style={{position:'fixed',bottom:0,height:60,width:'100%'}}><button data-live="">Chat</button></nav></aside><main><Harness variant="panel" modal={false} /></main></>, 320, 640);
  await open();
  expect(q('[data-opener]').inert, "content inert").toBe(true);
  q('[data-last]').focus(); await userEvent.keyboard('{Tab}');
  // Chromium may expose body at the document boundary; the next stop is live nav.
  if (document.activeElement === document.body) await userEvent.keyboard('{Tab}');
  expect(document.activeElement, "live tab").toBe(q('[data-live]'));
  const r = q('[data-live]').getBoundingClientRect(); expect(document.elementFromPoint(r.left + 2, r.top + 2), "live hit").toBe(q('[data-live]'));
  const panel = q('.bk-overlay-surface').getBoundingClientRect(); expect(panel.bottom, "above bar").toBe(580);
});
test("Chromium self-close is re-opened when dismissal is forbidden", async () => {
  // Mutation: omit showModal in close handler → locked dialog reopens assertion.
  await mount(<Harness closedBy="none" />); await open();
  await userEvent.keyboard('{Escape}'); expect(q('dialog')?.matches(':modal'), "locked Escape stays open").toBe(true);
  (q('dialog') as HTMLDialogElement).close();
  await expect.poll(() => q('dialog').matches(':modal'), { message: "locked dialog reopens" }).toBe(true);
});
test("a hidden modal is closed and reports the developer error", async () => {
  // Mutation: omit hidden-subtree guard → hidden dialog not open assertion.
  const errors: unknown[] = []; const original = console.warn; console.warn = (...args) => { errors.push(args); };
  try { await mount(<div style={{display:'none'}}><Overlay open variant="dialog" label="Hidden plan" onClose={() => {}}><button>Done</button></Overlay></div>);
    expect((q('dialog') as HTMLDialogElement).open, "hidden dialog not open").toBe(false); expect(errors).toHaveLength(1);
  } finally { console.warn = original; }
});

const scenes = ['sheet', 'dialog', 'dialog-top', 'fullscreen', 'panel', 'panel-destination'] as const;
for (const variant of scenes) for (const width of [320,1280]) for (const mode of ['dark','light']) {
  test(`geometry and baseline: overlay-${variant}-${mode}-${width}`, async () => {
    // Mutation: scale every surface to .8 → named shape assertion in each scene.
    document.documentElement.dataset.theme = mode;
    const kind: OverlayVariant = variant.startsWith('dialog') ? 'dialog' : variant.startsWith('panel') ? 'panel' : variant as OverlayVariant;
    await mount(<Overlay open variant={kind} title="Odysseus reviews the mast and yard for the raft on Ogygia" size={kind === 'panel' ? 'md' : undefined} modal={variant !== 'panel-destination'} placement={variant === 'dialog-top' ? 'top' : undefined} onClose={() => {}}>
      {kind === 'fullscreen' && <Button label="Close raft plan" style={{minHeight:44}} onClick={() => {}} />}
      <p>Odysseus is building the raft on Ogygia.</p><p>Reviewed on <time dateTime="2026-07-12">2026-07-12</time>.</p>
      <Button label="Review mast and yard" onClick={() => {}} />
    </Overlay>, width, width === 320 ? 640 : 800);
    expect(window.frameElement!.getBoundingClientRect().width, 'overlay iframe is painted at full scale').toBe(width);
    const surface = q('.bk-overlay-surface'); const r = surface.getBoundingClientRect();
    if (kind === 'fullscreen') { expect(r.width, "shape width").toBe(width); expect(r.height).toBe(innerHeight); }
    else if (kind === 'panel') { expect(r.width, "shape width").toBe(width === 320 ? 320 : 480); expect(r.bottom).toBe(innerHeight - (variant === 'panel-destination' && width === 320 ? 60 : 0)); }
    else if (variant === 'dialog-top') expect(r.top, "shape top").toBe(110);
    else if (kind === 'sheet' || width === 320) expect(r.bottom, "shape bottom").toBe(innerHeight);
    else { expect(r.width, "shape width").toBe(480); expect(Math.abs(r.left - (width - r.right))).toBeLessThanOrEqual(1); expect(Math.abs(r.top - (innerHeight-r.bottom))).toBeLessThanOrEqual(1); }
    expect(document.documentElement.scrollWidth, 'no sideways scroll').toBe(width);
    expect(q('.bk-overlay').getAnimations({subtree:true}), 'reduced motion').toEqual([]);
    const title = q('[aria-labelledby]'); expect(document.getElementById(title.getAttribute('aria-labelledby')!)!.textContent!.length).toBeGreaterThan(0);
    if (kind === 'fullscreen') {
      const close = surface.querySelector<HTMLElement>('[role="button"]')!;
      expect(close.textContent, 'fullscreen has a visible close control').toContain('Close raft plan');
      expect(close.getBoundingClientRect().height, 'fullscreen close target').toBeGreaterThanOrEqual(44);
    }
    // Set a real pointer scene independently of earlier keyboard behaviour cases.
    await userEvent.click(surface, { position: { x: r.width / 2, y: r.height - 5 } });
    await expect(document.body).toMatchScreenshot(`overlay-${variant}-${mode}-${width}`);
  });
}
test("close controls have 44px corner reach and computed title contrast in both themes", async () => {
  // Mutation: shrink close control to 36px → close target width assertion.
  for (const mode of ['dark','light']) {
    document.documentElement.dataset.theme = mode;
    await mount(<Overlay open variant="dialog" title="Raft plan" onClose={() => {}}><button>Done</button></Overlay>,320,640);
    const button = q('button[aria-label="Close Raft plan"]'); const r = button.getBoundingClientRect();
    expect(r.width, 'close target width').toBeGreaterThanOrEqual(44); expect(r.height).toBeGreaterThanOrEqual(44);
    for (const x of [r.left+1,r.right-1]) for (const y of [r.top+1,r.bottom-1]) expect(button.contains(document.elementFromPoint(x,y)), 'corner hit').toBe(true);
    const title = document.getElementById(q('dialog').getAttribute('aria-labelledby')!)!;
    expect(contrast(parse(getComputedStyle(title).color).rgb,parse(getComputedStyle(q('.bk-overlay-surface')).backgroundColor).rgb), 'computed contrast').toBeGreaterThanOrEqual(4.5);
    flushSync(() => root!.unmount()); root=undefined; host!.remove(); host=undefined;
  }
});
test("entry motion is absent under reduce and the sheet has one surface animation otherwise", async () => {
  // Mutation: remove reduced-motion media guard → reduced animation list assertion.
  await mount(<Harness />); await open();
  expect(q('.bk-overlay').getAnimations({subtree:true}), 'reduced animation list').toEqual([]);
  await userEvent.keyboard('{Escape}'); await commands.dictationMotion('no-preference');
  await open(); expect(q('.bk-overlay-surface').getAnimations(), 'one surface entry').toHaveLength(1);
});


test("initialFocus takes priority over data-autofocus", async () => {
  // Mutation: remove initialFocus selection → explicit initial focus assertion.
  function Explicit() {
    const target = useRef<HTMLButtonElement>(null);
    return <Overlay open variant="sheet" label="Raft plan" initialFocus={target} onClose={() => {}}>
      <button data-autofocus="">Read plan</button><button ref={target} data-explicit="">Review yard</button>
    </Overlay>;
  }
  await mount(<Explicit />);
  expect(document.activeElement, 'explicit initial focus').toBe(q('[data-explicit]'));
});
test("returnFocus false in the closing render leaves focus for the caller", async () => {
  // Mutation: read opening returnFocus → closing false assertion.
  function FalseReturn() {
    const [open, setOpen] = useState(false); const [restore, setRestore] = useState(true);
    return <><button data-opener="" onClick={() => setOpen(true)}>Open plan</button>
      <Overlay open={open} variant="sheet" label="Raft plan" returnFocus={restore} onClose={() => { setRestore(false); setOpen(false); }}><button>Done</button></Overlay>
    </>;
  }
  await mount(<FalseReturn />); await open(); await userEvent.keyboard('{Escape}');
  expect(document.activeElement, 'closing false').toBe(document.body);
});
test("sheet, dialog and panel switch only at the ruled width boundaries", async () => {
  // Mutation: dialog breakpoint 900→480 → dialog below 900 assertion.
  for (const width of [479,480,767,768,899,900]) for (const kind of ['sheet','dialog','panel'] as const) {
    await mount(<Overlay open variant={kind} title="Raft plan" onClose={() => {}}><button>Done</button></Overlay>,width,800);
    const r = q('.bk-overlay-surface').getBoundingClientRect();
    if (kind === 'dialog' && width < 900) expect(r.bottom, 'dialog below 900').toBe(800);
    if (kind === 'dialog' && width >= 900) expect(Math.abs(r.top-(800-r.bottom)), 'dialog at 900').toBeLessThanOrEqual(1);
    if (kind === 'sheet') expect(r.width, 'sheet at 480').toBe(width < 480 ? width : Math.min(560,width-32));
    if (kind === 'panel') expect(r.width, 'panel at 768').toBe(width < 768 ? width : 320);
    flushSync(() => root!.unmount()); root=undefined; host!.remove(); host=undefined;
  }
});

test("refused Chromium self-close reopens any dialog, restores focus and requests dismissal exactly once", async () => {
  const reasons: string[] = [];
  await mount(<Overlay open variant="dialog" label="Raft plan" closedBy="any" onClose={reason => reasons.push(reason)}>
    <button>Read plan</button><input data-autofocus="" aria-label="Mast notes" />
  </Overlay>);
  const dialog = q('dialog') as HTMLDialogElement;
  // CloseWatcher anti-abuse emits a non-cancelable cancel, then a native close.
  dialog.dispatchEvent(new Event('cancel', { cancelable: false }));
  const closed = new Promise<void>(resolve => dialog.addEventListener('close', () => resolve(), { once: true }));
  dialog.close();
  await closed;
  expect(reasons, "self-close requests once").toHaveLength(1);
  expect(reasons, "one close-request reason").toEqual(['close-request']);
  expect(dialog.open, "refused self-close remains open").toBe(true);
  expect(dialog.matches(':modal'), "refused self-close remains modal").toBe(true);
  expect(document.activeElement, "self-close restores initial focus").toBe(q('[data-autofocus]'));
  await userEvent.keyboard('mast and yard');
  expect((q('input') as HTMLInputElement).value, "reopened dialog accepts typing").toBe('mast and yard');
});

test("destination observes late siblings and releases an inert ancestor for a newly opened modal", async () => {
  const reasons: string[] = [];
  function Scene({ showModal = false }: { showModal?: boolean }) {
    const [panel, setPanel] = useState(true); const [dismissed, setDismissed] = useState(false);
    return <><main data-background=""><button>Read transcript</button>
      <Overlay open={showModal && !dismissed} variant="dialog" label="Mast notes" onClose={() => { reasons.push('modal'); setDismissed(true); }}>
        <input data-modal-input="" aria-label="Mast notes" />
      </Overlay>
    </main><Overlay open={panel} variant="panel" modal={false} label="Sessions" onClose={() => { reasons.push('panel'); setPanel(false); }}>
      <button data-panel-action="">Review sessions</button>
    </Overlay></>;
  }
  await mount(<Scene />);
  expect(q('[data-background]').inert, "background starts inert").toBe(true);
  const late = document.createElement('button'); late.textContent = 'Late transcript action'; host!.append(late);
  await expect.poll(() => late.inert, { message: "inserted sibling becomes inert" }).toBe(true);
  // A credential arrives in a branch
  // already marked inert by the destination; it opens before observer delivery.
  flushSync(() => root!.render(<Scene showModal />));
  expect(q('[data-background]').inert, "new modal ancestor is live synchronously").toBe(false);
  const input = q('[data-modal-input]') as HTMLInputElement;
  expect(document.activeElement, "new modal receives focus").toBe(input);
  expect(q('dialog').matches(':modal'), "new modal uses top layer").toBe(true);
  await userEvent.keyboard('mast and yard');
  expect(input.value, "new modal accepts typing").toBe('mast and yard');
  await userEvent.keyboard('{Escape}');
  expect(reasons, "Escape closes modal only").toEqual(['modal']);
  expect(q('[data-destination]'), "destination remains open").not.toBeNull();
  expect(q('[data-background]').inert, "closed modal branch becomes inert again").toBe(true);
  q('[data-panel-action]').focus(); await userEvent.keyboard('{Escape}');
  expect(reasons).toEqual(['modal', 'panel']);
  expect(late.inert, "observer marks released on panel close").toBe(false);
});

test("titled sheets and dialogs focus the first body control before the header close", async () => {
  for (const variant of ['sheet', 'dialog'] as const) {
    await mount(<Overlay open variant={variant} title="Raft plan" onClose={() => {}}><input aria-label="Mast notes" /></Overlay>);
    expect(document.activeElement, "body control precedes header close").toBe(q('input'));
    flushSync(() => root!.unmount()); root = undefined; host!.remove(); host = undefined;
  }
});
