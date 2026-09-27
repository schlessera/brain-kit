// A previewer whose file the browser cannot play falls back to the download
// card (#529): the table picks a previewer by MIME type, and a WebM that this
// browser cannot decode is still a WebM. Runs in a child process with
// happy-dom registered, so its DOM globals never reach another test file.
import { afterAll, expect, test } from "bun:test";

const CHILD_MARKER = "BRAIN_UI_REACT_BINARY_FALLBACK_CHILD";

if (!process.env[CHILD_MARKER]) {
  test("media fallback passes in an isolated process", async () => {
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
    if (exitCode !== 0) throw new Error(`Isolated media fallback tests failed (${exitCode})\n${stdout}${stderr}`);
  });
} else {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const { cleanup, fireEvent, render } = await import("@testing-library/react");
  const { BrainUiProvider } = await import("../src/root-context.js");
  const { createBrainUiRoot } = await import("../src/root.js");
  const { FileViewerBinary } = await import("../src/components/files/file-viewer-binary.js");

  const root = createBrainUiRoot({ storage: null });
  const binary = (path: string, mime: string) => ({ path, kind: "binary" as const, size: 4096, mtime: 0, mime });
  const view = (path: string, mime: string) => (
    <BrainUiProvider root={root}>
      <FileViewerBinary content={binary(path, mime)} />
    </BrainUiProvider>
  );

  for (const [element, path, mime] of [
    ["video", "clip.webm", "video/webm"],
    ["audio", "memo.wav", "audio/wav"],
  ] as const) {
    test(`a ${element} the browser cannot play shows the download card, and the next file gets its own try`, () => {
      const { container, rerender } = render(view(path, mime));
      const media = container.querySelector(element);
      expect(media).not.toBeNull();
      expect(container.textContent).not.toContain("Preview not available");

      fireEvent.error(media!);

      expect(container.querySelector(element)).toBeNull();
      expect(container.textContent).toContain("Preview not available");
      expect(container.querySelector("a[download]")?.getAttribute("download")).toBe(path);

      rerender(view(`other-${path}`, mime));
      expect(container.querySelector(element)).not.toBeNull();
      expect(container.textContent).not.toContain("Preview not available");
    });
  }

  afterAll(async () => {
    cleanup();
    root.dispose();
    await GlobalRegistrator.unregister();
  });
}
