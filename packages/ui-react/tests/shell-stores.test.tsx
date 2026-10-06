// The exported store hooks (#1053) are typed against shell views, but they
// must still read the same stores: the selector form follows the nearest
// provider's root, and the statics follow the default root. The selector case
// renders on the client (server rendering reads a store's initial state), so
// it runs in a child process with happy-dom registered, whose DOM globals never
// reach another test file.
import { describe, expect, test } from "bun:test";

const CHILD_MARKER = "BRAIN_UI_REACT_SHELL_STORES_CHILD";

if (!process.env[CHILD_MARKER]) {
  test("shell store hooks pass in an isolated process", async () => {
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
    if (exitCode !== 0) throw new Error(`Isolated shell store tests failed (${exitCode})\n${stdout}${stderr}`);
    // A child that registered no tests also exits 0.
    expect(`${stdout}${stderr}`).toMatch(/\b3 pass\b/);
  });
} else {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const { createElement } = await import("react");
  const { renderHook } = await import("@testing-library/react");
  const { defaultRoot } = await import("../src/default-root.js");
  const { BrainUiProvider } = await import("../src/root-context.js");
  const { createBrainUiRoot } = await import("../src/root.js");
  const { anyStreaming, hasPendingShare, useShareStore, useUIStore } = await import("../src/index.js");

  describe("shell store hooks", () => {
    test("the selector form reads the provider's root, not the default root", () => {
      const root = createBrainUiRoot({ storage: null });
      root.stores.ui.getState().setActiveView("activity");
      defaultRoot.stores.ui.getState().setActiveView("chat");
      const { result, unmount } = renderHook(() => useUIStore((state) => state.activeView), {
        wrapper: ({ children }) => createElement(BrainUiProvider, { root }, children),
      });
      expect(result.current).toBe("activity");
      unmount();
      root.dispose();
    });

    test("the statics read and follow the default root", () => {
      const share = defaultRoot.stores.share;
      expect(hasPendingShare(useShareStore.getState())).toBe(false);
      const seen: boolean[] = [];
      const stop = useShareStore.subscribe((state) => seen.push(hasPendingShare(state)));
      share.getState().setBusy(true);
      expect(hasPendingShare(useShareStore.getState())).toBe(true);
      stop();
      share.getState().setBusy(false);
      expect(seen).toEqual([true]);
    });

    test("the views accept the full state the package's own code holds", () => {
      expect(anyStreaming(defaultRoot.stores.chat.getState())).toBe(false);
      // @ts-expect-error setState is not part of a shell's surface
      expect(typeof useShareStore.setState).toBe("undefined");
    });
  });
}
