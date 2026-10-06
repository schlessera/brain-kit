// The shared row's keyboard evidence (D52 §3, #1002): the composer focused,
// a coarse pointer and a visual viewport a keyboard has shortened, and the
// composer's drawn line count, including changes no event reports. Runs in a
// child process with happy-dom registered, so its DOM globals never reach
// another test file.
import { expect, test } from "bun:test";

const CHILD_MARKER = "BRAIN_UI_REACT_SOFT_KEYBOARD_CHILD";

if (!process.env[CHILD_MARKER]) {
  test("soft keyboard evidence passes in an isolated process", async () => {
    const proc = Bun.spawn(["bun", "test", import.meta.path, "--timeout", "30000"], {
      cwd: import.meta.dir,
      env: { ...process.env, [CHILD_MARKER]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`Isolated soft keyboard tests failed (${exitCode})\n${stdout}${stderr}`);
    expect(`${stdout}${stderr}`).toMatch(/\b3 pass\b/);
  });
} else {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { act, renderHook } = await import("@testing-library/react");
  const { useSoftKeyboard } = await import("../src/hooks/use-soft-keyboard.js");

  // A phone: a coarse pointer, and a visual viewport the test can shorten.
  window.matchMedia = ((query: string) => ({ matches: query.includes("coarse"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  const viewport = Object.assign(new EventTarget(), { height: window.innerHeight });
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });

  function composer(lines: { value: number }) {
    const field = document.createElement("textarea");
    field.setAttribute("data-composer", "");
    field.style.lineHeight = "20px";
    Object.defineProperty(field, "scrollHeight", { get: () => lines.value * 20, configurable: true });
    document.body.append(field);
    return field;
  }
  const settle = (ms = 10) => act(() => new Promise((r) => setTimeout(r, ms)));

  test("open needs the composer focused and the viewport shortened by a keyboard", async () => {
    const lines = { value: 1 };
    const field = composer(lines);
    const { result, unmount } = renderHook(() => useSoftKeyboard());
    await act(async () => { field.focus(); });
    await settle();
    expect(result.current.open, "focused, but the viewport is whole").toBe(false);
    viewport.height = window.innerHeight - 300;
    await act(async () => { viewport.dispatchEvent(new Event("resize")); });
    expect(result.current.open).toBe(true);
    await act(async () => { field.blur(); });
    await settle();
    expect(result.current.open, "the composer lost focus").toBe(false);
    unmount();
    field.remove();
    viewport.height = window.innerHeight;
  });

  test("a composer that grows past three lines is counted as it types", async () => {
    const lines = { value: 1 };
    const field = composer(lines);
    const { result, unmount } = renderHook(() => useSoftKeyboard());
    await act(async () => { field.focus(); });
    await settle();
    lines.value = 4;
    await act(async () => { field.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(result.current.composerLines).toBe(4);
    unmount();
    field.remove();
  });

  test("a value cleared with no event, as an accepted send does, is counted again", async () => {
    const lines = { value: 4 };
    const field = composer(lines);
    const { result, unmount } = renderHook(() => useSoftKeyboard());
    await act(async () => { field.focus(); });
    await settle();
    expect(result.current.composerLines).toBe(4);
    lines.value = 1;
    await settle(400);
    expect(result.current.composerLines, "re-read while focused").toBe(1);
    unmount();
    field.remove();
  });
}
