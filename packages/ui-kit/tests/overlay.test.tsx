import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BottomSheet } from "../src/chrome/BottomSheet.js";
import { createRoot, type Root } from "react-dom/client";
import { Overlay, type OverlayProps } from "../src/chrome/Overlay.js";

const saved = new Map<string, PropertyDescriptor | undefined>();
let win: Window;
let root: Root | undefined;
let host: HTMLDivElement;
beforeAll(() => {
  win = new Window();
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  // happy-dom models dialog state, not geometry. Browser tests own visibility.
  saved.set("rects", Object.getOwnPropertyDescriptor(win.HTMLElement.prototype, "getClientRects"));
  Object.defineProperty(win.HTMLElement.prototype, "getClientRects", { configurable: true, writable: true, value: () => [{ width: 1, height: 1 }] });
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; win.document.body.innerHTML = ""; });
afterAll(() => {
  const rects = saved.get("rects");
  if (rects) Object.defineProperty(win.HTMLElement.prototype, "getClientRects", rects);
  else Reflect.deleteProperty(win.HTMLElement.prototype, "getClientRects");
  saved.delete("rects");
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function render(props: Partial<OverlayProps> = {}) {
  if (!root) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
  const config = { open: true, label: "Raft plan", variant: "sheet", onClose: () => {}, ...props } as OverlayProps;
  act(() => root!.render(<Overlay {...config}><button>Review</button></Overlay>));
  return host.querySelector<HTMLElement>(".bk-overlay")!;
}
test("modal semantics and non-modal region semantics resolve the supplied names", () => {
  // Mutation: aria-modal=false → explicit modal semantics assertion.
  const dialog = render({ role: "alertdialog" });
  expect(dialog.tagName).toBe("DIALOG"); expect(dialog.getAttribute("aria-modal"), "explicit modal semantics").toBe("true");
  expect(dialog.getAttribute("role")).toBe("alertdialog"); expect(dialog.getAttribute("aria-label")).toBe("Raft plan");
  const panel = render({ variant: "panel", modal: false });
  expect(panel.tagName).toBe("SECTION"); expect(panel.hasAttribute("aria-modal")).toBe(false);
  render({ open: false }); expect(host.children).toHaveLength(0);
});
test("Escape and cancel request distinct reasons and cancel is prevented", () => {
  // Mutation: cancel reason='escape' → cancellation reason assertion.
  const reasons: string[] = []; const dialog = render({ onClose: reason => reasons.push(reason) });
  dialog.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
  expect(reasons).toEqual(["escape"]);
  const cancel = new win.Event("cancel", { cancelable: true }); dialog.dispatchEvent(cancel as unknown as Event);
  expect(reasons, "cancellation reason").toEqual(["escape", "close-request"]); expect(cancel.defaultPrevented).toBe(true);
});
test("scrim is any-only, close controls remain available under closerequest, none reopens a self-close", () => {
  // Mutation: remove closedBy any check → restricted scrim assertion.
  const reasons: string[] = [];
  const draw = (closedBy: OverlayProps['closedBy']) => render({ title: "Raft plan", label: undefined, closedBy, onClose: reason => reasons.push(reason) });
  const any = draw("any");
  any.querySelector('.bk-overlay-scrim')!.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event);
  expect(reasons).toEqual(["scrim"]);
  const restricted = draw("closerequest");
  restricted.querySelector('.bk-overlay-scrim')!.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event);
  expect(reasons, "restricted scrim").toEqual(["scrim"]);
  (restricted.querySelector('button[aria-label="Close Raft plan"]') as HTMLElement).click(); expect(reasons.at(-1)).toBe("close-button");
  const locked = draw("none") as HTMLDialogElement;
  expect(locked.querySelector('button[aria-label="Close Raft plan"]')).toBeNull();
  locked.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
  locked.close(); locked.dispatchEvent(new win.Event("close") as unknown as Event);
  expect(locked.open, "locked self-close reopens").toBe(true); expect(reasons).toEqual(["scrim", "close-button"]);
});
test("closing render controls returnFocus and afterClose runs after focus restoration", async () => {
  // Mutation: use opening p.returnFocus instead of latest → closing getter assertion.
  const opener = document.createElement("button"); const destination = document.createElement("button");
  document.body.append(opener, destination); opener.focus(); render();
  let observed: Element | null = null;
  render({ open: false, returnFocus: () => destination, onAfterClose: () => { observed = document.activeElement; } });
  await Promise.resolve();
  expect(document.activeElement, "closing getter").toBe(destination); expect(observed as Element | null).toBe(destination);
});

test("BottomSheet optional dismissal is named and works even without a title", () => {
  // Mutation: require a title for the close row → bare dismissal control assertion.
  const html = renderToStaticMarkup(<BottomSheet onDismiss={() => {}} />);
  host = document.createElement("div"); host.innerHTML = html; document.body.append(host);
  expect(host.querySelector('button[aria-label="Close"]'), 'bare dismissal control').not.toBeNull();
});

test("StrictMode replay and open unmount never report after-close, while a controlled close reports once", async () => {
  const opener = document.createElement("button"); document.body.append(opener); opener.focus();
  let after = 0; let returned = 0;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const draw = (open: boolean, custom = true) => <StrictMode><Overlay open={open} variant="sheet" label="Raft plan"
    returnFocus={custom ? () => { returned++; return opener; } : undefined} onClose={() => {}} onAfterClose={() => { after++; }}><button>Review</button></Overlay></StrictMode>;
  await act(async () => root!.render(draw(true)));
  expect(after, "replay is not a close").toBe(0);
  expect(returned, "replay cancels focus return").toBe(0);
  expect(document.activeElement?.textContent, "replay keeps overlay focus").toBe("Review");
  await act(async () => root!.unmount()); root = undefined;
  expect(returned, "open unmount returns focus").toBe(1);
  expect(document.activeElement).toBe(opener);
  expect(after, "open unmount is not a controlled close").toBe(0);
  root = createRoot(host); await act(async () => root!.render(draw(true)));
  await act(async () => root!.render(draw(false)));
  expect(after, "controlled close reports once").toBe(1);
  expect(returned, "controlled close returns once").toBe(2);
  await act(async () => root!.unmount()); root = createRoot(host); opener.focus();
  await act(async () => root!.render(draw(true, false)));
  await act(async () => root!.render(draw(false, false)));
  expect(document.activeElement, "default return preserves the pre-replay opener").toBe(opener);
});

test("composing Escape dismisses neither a modal nor a destination panel", () => {
  for (const modal of [true, false]) {
    const reasons: string[] = [];
    const overlay = render({ variant: "panel", modal, onClose: reason => reasons.push(reason) });
    overlay.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true }) as unknown as Event);
    expect(reasons, modal ? "modal composing Escape" : "destination composing Escape").toEqual([]);
    overlay.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
    expect(reasons, "ordinary Escape still dismisses").toEqual(["escape"]);
  }
});

test("hidden-subtree warning is development-only and warns once", () => {
  const helper = new URL("../src/internal/dev.ts", import.meta.url).pathname;
  const script = `import { warnOnceDevelopment } from ${JSON.stringify(helper)};
    let warnings = 0; console.warn = () => { warnings++; };
    warnOnceDevelopment("hidden overlay"); warnOnceDevelopment("hidden overlay");
    console.log(warnings);`;
  for (const mode of ["development", "production"]) {
    const child = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, NODE_ENV: mode }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, "diagnostic child completes").toBe(0);
    expect(new TextDecoder().decode(child.stdout).trim(), mode === "production" ? "production warning suppressed" : "development warning once").toBe(mode === "production" ? "0" : "1");
  }
});

test("none retains the panel X while sheets and dialogs remove theirs", () => {
  // Mutation: apply the sheet/dialog close-control rule to panels.
  const reasons: string[] = [];
  for (const variant of ["sheet", "dialog", "panel"] as const) {
    const surface = render({ variant, closedBy: "none", title: "Raft plan", label: undefined, onClose: reason => reasons.push(reason) });
    const close = surface.querySelector<HTMLElement>('[aria-label="Close Raft plan"]');
    if (variant === "panel") {
      expect(close, "locked panel keeps its X").not.toBeNull();
      close!.click();
      expect(reasons, "panel X reports explicit close-button dismissal").toEqual(["close-button"]);
    } else expect(close, "locked sheet/dialog has no X").toBeNull();
  }
});
