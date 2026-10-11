// A link or image into scratch whose file is gone reads as expired, not as a
// 404 (#1657). The store asks the server with a HEAD on the raw route; only a
// 404 under `.brain/scratch/` counts. Everything else keeps today's behaviour.
// The rendering tests run in a child process with happy-dom registered, so
// its DOM globals never reach another test file.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import React from "react";

import { createBrainUiRoot, type BrainUiRoot } from "../src/root.js";
import { scratchPath } from "../src/stores/file-state.js";

const CHILD_MARKER = "BRAIN_UI_REACT_EXPIRED_SCRATCH_CHILD";
const pdf = ".brain/scratch/raft/overview.pdf";
const png = ".brain/scratch/raft/hull.png";
const roots: BrainUiRoot[] = [];

type Call = { url: string; method: string };

function rootWith(status: (path: string, method: string) => number | Error) {
  const calls: Call[] = [];
  const root = createBrainUiRoot({
    storage: null,
    request: async (url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      const path = new URL(url, "http://localhost").searchParams.get("path") ?? "";
      const answer = status(path, method);
      if (answer instanceof Error) throw answer;
      const body = answer === 404 ? { error: "not_found" }
        : answer === 200 ? (path.endsWith(".md") ? { path, kind: "markdown", size: 7, mtime: 0, content: "# Raft\n" } : { path, kind: "binary", size: 1, mtime: 0 })
        : { error: "internal_error" };
      return new Response(method === "HEAD" ? null : JSON.stringify(body), { status: answer, headers: { "Content-Type": "application/json" } });
    },
  });
  roots.push(root);
  return { root, calls, file: root.stores.file };
}

if (!process.env[CHILD_MARKER]) {
  afterEach(() => { for (const root of roots.splice(0)) root.dispose(); });

  describe("which references count as scratch", () => {
    test("a file inside the scratch area, written either way", () => {
      expect(scratchPath(pdf)).toBe(pdf);
      expect(scratchPath(`./${pdf}`)).toBe(pdf);
    });

    for (const other of ["notes/raft.md", ".brain/scratch/", ".brain/scratch/raft/", ".brain/scratchy/a.pdf",
      ".brain/scratch/../notes/raft.md", "brain/scratch/a.pdf", undefined]) {
      test(`not ${String(other)}`, () => expect(scratchPath(other)).toBeNull());
    }
  });

  describe("the existence check", () => {
    test("a 404 marks the scratch file expired, through one HEAD", async () => {
      const { calls, file } = rootWith(() => 404);
      await Promise.all([file.getState().checkScratchFile(pdf), file.getState().checkScratchFile(`./${pdf}`)]);
      expect(file.getState().scratchFiles).toEqual({ [pdf]: "expired" });
      expect(calls).toEqual([{ url: `/api/files/content?path=${encodeURIComponent(pdf)}&raw=1`, method: "HEAD" }]);
      await file.getState().checkScratchFile(pdf);
      expect(calls).toHaveLength(1);
    });

    test("a file that is there, or over the size cap, is present", async () => {
      for (const status of [200, 413]) {
        const { file } = rootWith(() => status);
        await file.getState().checkScratchFile(pdf);
        expect(file.getState().scratchFiles).toEqual({ [pdf]: "present" });
      }
    });

    test("a server fault or a failed request is not evidence, and is asked again later", async () => {
      for (const answer of [500, 401, new TypeError("offline")]) {
        const { calls, file } = rootWith(() => answer);
        await file.getState().checkScratchFile(pdf);
        expect(file.getState().scratchFiles).toEqual({});
        await file.getState().checkScratchFile(pdf);
        expect(calls).toHaveLength(2);
      }
    });

    test("a reference outside scratch is never checked", async () => {
      const { calls, file } = rootWith(() => 404);
      await file.getState().checkScratchFile("notes/raft.md");
      expect(calls).toEqual([]);
      expect(file.getState().scratchFiles).toEqual({});
    });
  });

  describe("opening a file", () => {
    test("a cleared scratch file is expired, not an error", async () => {
      const { file } = rootWith(() => 404);
      await file.getState().openFile(pdf);
      expect(file.getState()).toMatchObject({ contentExpired: true, contentError: null, contentLoading: false });
      expect(file.getState().scratchFiles).toEqual({ [pdf]: "expired" });
    });

    test("a missing file outside scratch is still not found", async () => {
      const { file } = rootWith(() => 404);
      await file.getState().openFile("notes/gone.md");
      expect(file.getState()).toMatchObject({ contentExpired: false, contentError: "File not found." });
    });

    test("opening the next file clears the expired state", async () => {
      const { file } = rootWith((path) => (path === pdf ? 404 : 200));
      await file.getState().openFile(pdf);
      await file.getState().openFile("notes/raft.md");
      expect(file.getState()).toMatchObject({ contentExpired: false, contentError: null, currentPath: "notes/raft.md" });
    });
  });

  test("the chat and viewer render the expired states in an isolated process", async () => {
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
    if (exitCode !== 0) throw new Error(`Isolated expired-link render tests failed (${exitCode})\n${stdout}${stderr}`);
    // A child that registered no tests also exits 0.
    expect(`${stdout}${stderr}`).toMatch(/\b6 pass\b/);
  }, 60_000);
} else {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
  const { BrainUiProvider } = await import("../src/root-context.js");
  const { BrainMarkdown } = await import("../src/components/chat/brain-markdown.js");
  const { FileViewer } = await import("../src/components/files/file-viewer.js");

  const show = (root: BrainUiRoot, node: React.ReactNode) => render(<BrainUiProvider root={root}>{node}</BrainUiProvider>);

  afterEach(() => {
    cleanup();
    for (const root of roots.splice(0)) root.dispose();
  });
  afterAll(async () => { await GlobalRegistrator.unregister(); });

  describe("the chat", () => {
    test("a cleared scratch link keeps its words, is inert and is named expired", async () => {
      const { root, calls } = rootWith(() => 404);
      const { container } = show(root, <BrainMarkdown content={`Read [the raft overview](${pdf}) and ${pdf}.`} fileLinks />);
      // Until the answer arrives the link is an ordinary one.
      expect(container.querySelectorAll("a.brain-file-link")).toHaveLength(2);
      await waitFor(() => expect(container.querySelectorAll("a")).toHaveLength(0));
      const expired = screen.getAllByRole("link", { name: /expired$/ });
      expect(expired.map((node) => node.textContent)).toEqual(["the raft overview expired", `${pdf} expired`]);
      for (const node of expired) expect(node.getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByRole("link", { name: "the raft overview expired" })).toBe(expired[0]!);
      // Two references, one file, one question.
      expect(calls.filter((call) => call.method === "HEAD")).toHaveLength(1);
    });

    test("a scratch image that fails to load and is gone becomes a placeholder named expired", async () => {
      const { root } = rootWith(() => 404);
      const { container } = show(root, <BrainMarkdown content={`![Hull of the raft](${png})`} fileLinks />);
      const img = container.querySelector("img")!;
      expect(img.getAttribute("src")).toBe(`/api/files/content?path=${encodeURIComponent(png)}&raw=1`);
      fireEvent.error(img);
      const placeholder = await screen.findByRole("img", { name: "Hull of the raft, expired" });
      expect(container.querySelector("img")).toBeNull();
      expect(placeholder.textContent).toBe("Hull of the raftexpired");
    });

    test("an untitled expired image is still named", async () => {
      const { root } = rootWith(() => 404);
      const { container } = show(root, <BrainMarkdown content={`![](./${png})`} fileLinks />);
      fireEvent.error(container.querySelector("img")!);
      await screen.findByRole("img", { name: "Image, expired" });
    });

    test("a present scratch file, and an image that failed for another reason, stay as they are", async () => {
      const { root, file } = rootWith((path) => (path === png ? 500 : 200));
      const { container } = show(root, <BrainMarkdown content={`[Overview](${pdf}) ![Hull](${png})`} fileLinks />);
      await waitFor(() => expect(file.getState().scratchFiles[pdf]).toBe("present"));
      fireEvent.error(container.querySelector("img")!);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(container.querySelector("a.brain-file-link")?.getAttribute("href")).toBe(`#/files/${pdf}`);
      expect(container.querySelector("img")).not.toBeNull();
      expect(container.textContent).not.toContain("expired");
    });

    test("a missing file outside scratch keeps the ordinary link and is never checked", async () => {
      const { root, calls } = rootWith(() => 404);
      const { container } = show(root, <BrainMarkdown content="[Gone](notes/gone.md) ![Gone](assets/gone.png)" fileLinks />);
      fireEvent.error(container.querySelector("img")!);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls.filter((call) => call.url.includes("/files/content"))).toEqual([]);
      expect(screen.getByRole("link", { name: "Gone" }).getAttribute("href")).toBe("#/files/notes/gone.md");
      expect(container.querySelector("img")).not.toBeNull();
      expect(container.textContent).not.toContain("expired");
    });
  });

  test("the viewer shows a cleared scratch file as expired, calmly", async () => {
    const { root, file } = rootWith(() => 404);
    show(root, <FileViewer />);
    await file.getState().openFile(pdf);
    await screen.findByText("This file has expired");
    expect(screen.queryByText("File not found.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
}
