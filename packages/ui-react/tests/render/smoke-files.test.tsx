// Render smoke tests for the file tree, frontmatter, supporting files and search results: mount the components in happy-dom and
// assert the DOM they produce. Fixtures are minimal and keyless; nothing here
// touches the network. Shared setup: ./smoke-harness.tsx.
//
// The DOM module import MUST stay first: it registers the happy-dom globals
// before the component module bodies run (./dom.ts explains why, and why
// `screen` must not be used).
import { registerSmokeFilesDom, unregisterSmokeFilesDom } from "./smoke-files-dom.js";
registerSmokeFilesDom();

import { installSmokeHarness, changeControlledInput, render, supportingInput } from "./smoke-harness.js";
import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { FileTree } from "../../src/components/files/file-tree.js";
import { FileTreeView, TreeRow, fileKind } from "../../src/components/files/file-tree-view.js";
import { FrontmatterChips } from "../../src/components/files/frontmatter-chips.js";
import { FrontmatterPanel } from "../../src/components/files/frontmatter-panel.js";
import { ViewerEmpty, ViewerToolbar, formatSize } from "../../src/components/files/file-viewer-frame.js";
import { SearchPanel } from "../../src/components/quick-actions/search-modal.js";
import { registerBuiltinRenderers } from "../../src/components/chat/renderers/index.js";
import { BlockCard as SupportingFilesCard } from "../../src/components/chat/tool-cards/block-card.js";
import { registerBuiltinRenderers as registerSupportingRenderers } from "../../src/components/chat/renderers/index.js";
import type { Block as SupportingBlock } from "@schlessera/brain-ui-sdk/client";

installSmokeHarness(unregisterSmokeFilesDom);

/* ── S7 (files): the tree renders from props; the container reads the store ─ */

describe("FileTree on the kit FileRow", () => {
  test("a row is a kit FileRow: kind from the name, folder state from expansion, error with a retry", () => {
    expect(fileKind("notes", true, false)).toBe("folder");
    expect(fileKind("notes", true, true)).toBe("open");
    expect(fileKind("a.md", false, false)).toBe("file");
    expect(fileKind("map.PNG", false, false)).toBe("image");

    const onClick = mock(() => {}); const onRetry = mock(() => {});
    const view = render(
      <FileTreeView state="ready">
        <TreeRow name="notes" kind="open" depth={0} active={false} loading={true} highlighted={false} error="Permission denied" onClick={onClick} onRetry={onRetry}>
          <TreeRow name="a.md" kind="file" depth={1} active={true} loading={false} highlighted={false} onClick={onClick} />
        </TreeRow>
      </FileTreeView>,
    );
    const folder = view.getByRole("treeitem", { name: /notes/ });
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByText("loading…")).toBeTruthy();
    const file = view.getByRole("treeitem", { name: /a\.md/ });
    expect(file.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(file);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(view.getByText("Permission denied")).toBeTruthy();
    fireEvent.click(view.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    view.unmount();

    const failed = render(<FileTreeView state="error" error="offline" onRetry={onRetry} />);
    expect(failed.getByText("Files unreadable")).toBeTruthy();
    expect(failed.getByText("offline")).toBeTruthy();
    failed.unmount();
    const loading = render(<FileTreeView state="loading" />);
    expect(loading.getByLabelText("Loading files")).toBeTruthy();
    loading.unmount();
  });

  test("the container reads the store: expansion, the active file, and clicks go to the store's actions", () => {
    const root = createBrainUiRoot({ storage: null, config: { backendUrl: "https://alpha.example" } });
    const toggled: string[] = []; const opened: string[] = [];
    root.stores.file.setState({
      dirCache: { "": [{ name: "notes", path: "notes", type: "dir" }, { name: "readme.md", path: "readme.md", type: "file" }], notes: [{ name: "a.md", path: "notes/a.md", type: "file" }] },
      expandedDirs: new Set(["notes"]),
      currentPath: "notes/a.md",
      toggleDir: async (path) => { toggled.push(path); },
      openFile: async (path) => { opened.push(path); },
    });
    const view = render(<BrainUiProvider root={root}><FileTree /></BrainUiProvider>);
    try {
      expect(view.getByRole("treeitem", { name: /notes/ }).getAttribute("aria-expanded")).toBe("true");
      expect(view.getByRole("treeitem", { name: /a\.md/ }).getAttribute("aria-selected")).toBe("true");
      fireEvent.click(view.getByRole("treeitem", { name: /notes/ }));
      expect(toggled).toEqual(["notes"]);
      fireEvent.click(view.getByRole("treeitem", { name: /readme/ }));
      expect(opened).toEqual(["readme.md"]);
      act(() => { root.stores.file.setState({ expandedDirs: new Set() }); });
      expect(view.queryByRole("treeitem", { name: /a\.md/ })).toBeNull();
    } finally { view.unmount(); root.dispose(); }
  });
});

describe("frontmatter chips and the viewer frame", () => {
  test("frontmatter is one kv chip per value behind a disclosure the store controls", () => {
    const onOpenChange = mock((_o: boolean) => {});
    const fields = [{ key: "type", value: "talk" }, { key: "tags", value: "[a, b]", list: ["a", "b"] }, { key: "status", value: "" }, { key: "extra", value: "x" }];
    const open = render(<FrontmatterChips fields={fields} open onOpenChange={onOpenChange} />);
    expect(open.getByText("type: talk")).toBeTruthy();
    expect(open.getByText("tags: a")).toBeTruthy();
    expect(open.getByText("tags: b")).toBeTruthy();
    expect(open.getByText("status: —")).toBeTruthy();
    const summary = open.getByRole("button", { name: /frontmatter · 4 fields/ });
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(summary);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    open.unmount();

    const closed = render(<FrontmatterChips fields={fields} open={false} onOpenChange={onOpenChange} />);
    expect(closed.queryByText("type: talk")).toBeNull();
    expect(closed.getByText("type, tags, status…")).toBeTruthy();
    closed.unmount();

    const none = render(<FrontmatterChips fields={[]} open onOpenChange={onOpenChange} />);
    expect(none.container.textContent).toBe("");
    none.unmount();

    const root = createBrainUiRoot({ storage: null, config: { backendUrl: "https://alpha.example" } });
    root.stores.file.setState({ frontmatterCollapsed: true });
    const panel = render(<BrainUiProvider root={root}><FrontmatterPanel fields={fields.slice(0, 1)} /></BrainUiProvider>);
    try {
      expect(panel.queryByText("type: talk")).toBeNull();
      fireEvent.click(panel.getByRole("button", { name: /frontmatter/ }));
      expect(root.stores.file.getState().frontmatterCollapsed).toBe(false);
      expect(panel.getByText("type: talk")).toBeTruthy();
    } finally { panel.unmount(); root.dispose(); }
  });

  test("the toolbar's mode switch is a kit FilterRow, and the empty frame says what to do", () => {
    const onMode = mock((_m: "preview" | "raw") => {}); const onCopyPath = mock(() => {}); const onReveal = mock(() => {});
    const view = render(
      <ViewerToolbar fileName="a.md" fullPath="notes/a.md" size={2048} mode="preview" previewAvailable copied={false} share={<span>share-menu</span>}
        onMode={onMode} onCopyPath={onCopyPath} onReveal={onReveal} />,
    );
    expect(view.getByText("notes/a.md")).toBeTruthy();
    expect(view.getByText(/2 KB/)).toBeTruthy();
    expect(view.getByText("share-menu")).toBeTruthy();
    expect(view.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(view.getByRole("tab", { name: "Raw" }));
    expect(onMode).toHaveBeenCalledWith("raw");
    fireEvent.click(view.getByTitle("Copy path"));
    expect(onCopyPath).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByTitle("Reveal in tree"));
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(view.queryByRole("link", { name: "Open in new tab" })).toBeNull();
    view.unmount();

    // An HTML file opens its sandboxed preview route in a new tab, without an opener.
    const html = render(<ViewerToolbar fileName="beacon.html" fullPath="voyage/beacon.html" mode="preview" previewAvailable copied={false} share={null}
      openInTab="/api/files/html?path=voyage%2Fbeacon.html" onMode={onMode} onCopyPath={onCopyPath} onReveal={onReveal} />);
    const tab = html.getByRole("link", { name: "Open in new tab" });
    expect(tab.getAttribute("href")).toBe("/api/files/html?path=voyage%2Fbeacon.html");
    expect(tab.getAttribute("target")).toBe("_blank");
    expect(tab.getAttribute("rel")).toBe("noopener");
    html.unmount();

    const raw = render(<ViewerToolbar fileName="x.bin" fullPath="x.bin" mode="raw" previewAvailable={false} copied share={null} onMode={onMode} onCopyPath={onCopyPath} onReveal={onReveal} />);
    expect(raw.queryByRole("tab")).toBeNull();
    raw.unmount();

    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(3 * 1024 * 1024)).toBe("3 MB");
    const empty = render(<ViewerEmpty />);
    expect(empty.getByText("No file open")).toBeTruthy();
    empty.unmount();
  });
});

describe("supporting answer files", () => {
  for (const [backend, name] of [["pi", "show_block"], ["claude", "mcp__brain-ui__show_block"]] as const) {
    test(`${backend} renders the echoed nonempty supporting list through RelatedFiles`, () => {
      const root = createBrainUiRoot({ storage: null });
      registerSupportingRenderers(root.renderers);
      const tool = { id: "supporting-files", name, input: supportingInput, output: JSON.stringify(supportingInput) };
      const Output = root.renderers.resolve(tool, backend)!.Output!;
      const view = render(<BrainUiProvider root={root}><Output tool={tool} /></BrainUiProvider>);
      expect(supportingInput.block.items).toHaveLength(2);
      expect([...view.container.querySelectorAll('.bk-row[role="button"]')].map(row => row.textContent)).toEqual([
        "knowledge/scylla.mdNames the cost in men.", "people/circe.mdGives the directions for the crossing.",
      ]);
      expect(view.container.textContent).not.toContain("4,812");
      root.dispose();
    });
  }
  test("static supporting lists retain both complete reasons without controls or requests", () => {
    const requested: string[] = [];
    const root = createBrainUiRoot({ storage: null, request: async url => { requested.push(String(url)); throw new Error("unexpected request"); } });
    const view = render(<BrainUiProvider root={root}><SupportingFilesCard block={supportingInput.block} isStatic /></BrainUiProvider>);
    expect(view.container.textContent).toContain("Gives the directions for the crossing.");
    expect(view.queryAllByRole("button")).toHaveLength(0);
    expect(requested).toEqual([]);
    root.dispose();
  });
});

describe("supporting file navigation and fallback", () => {
  test("activation opens only the supplied file in its provider root; missing files keep the existing readable error", async () => {
    const aRequests: string[] = [], bRequests: string[] = [];
    const root = createBrainUiRoot({ storage: null, config: { backendUrl: "https://alpha.example" }, request: async url => {
      aRequests.push(String(url));
      const request = new URL(String(url));
      if (request.pathname.endsWith("/files/content") && request.searchParams.get("path") === "knowledge/scylla.md") return Response.json({ path: "knowledge/scylla.md", kind: "markdown", content: "# Scylla" });
      return Response.json({ error: "File not found" }, { status: 404 });
    } });
    const other = createBrainUiRoot({ storage: null, config: { backendUrl: "https://beta.example" }, request: async url => { bRequests.push(String(url)); throw new Error("wrong root"); } });
    const block = { kind: "files", items: [{ path: "knowledge/scylla.md" }, { path: "knowledge/missing.md" }] } as SupportingBlock;
    try {
      const view = render(<BrainUiProvider root={root}><SupportingFilesCard block={block} /></BrainUiProvider>);
      fireEvent.click(view.getByRole("button", { name: /knowledge\/scylla.md/ }));
      await waitFor(() => expect(root.stores.file.getState().currentContent).toMatchObject({ path: "knowledge/scylla.md" }));
      expect(root.stores.ui.getState().filePanelOpen).toBe(true);
      expect(aRequests).toHaveLength(2);
      expect(aRequests.every(url => new URL(url).origin === "https://alpha.example")).toBe(true);
      fireEvent.click(view.getByRole("button", { name: /knowledge\/missing.md/ }));
      await waitFor(() => expect(root.stores.file.getState().contentError).toBe("File not found."));
      expect(aRequests).toHaveLength(4);
      expect(aRequests.slice(2).every(url => new URL(url).searchParams.get("path") === "knowledge/missing.md")).toBe(true);
      expect(bRequests).toEqual([]);
      expect(view.container.textContent).not.toContain("0.98");
      expect(view.container.textContent).not.toContain("the file the question was about");
    } finally { root.dispose(); other.dispose(); }
  });

  test("unsafe supporting paths stay readable and every activation sends nothing", () => {
    const requested: string[] = [];
    const root = createBrainUiRoot({ storage: null, request: async url => { requested.push(String(url)); throw new Error("unexpected request"); } });
    const paths = ["../people/circe.md", "knowledge/../people/circe.md", "https://ithaca.example/scylla", "//ithaca.example/scylla", "/people/circe.md", "C:\\scylla.md", "knowledge/scylla.md?raw=1", "knowledge/./scylla.md"];
    try {
      const block = { kind: "files", items: paths.map(path => ({ path, reason: "Supporting claim." })) } as SupportingBlock;
      const view = render(<BrainUiProvider root={root}><SupportingFilesCard block={block} /></BrainUiProvider>);
      expect(paths).toHaveLength(8);
      expect(view.queryAllByRole("button")).toHaveLength(0);
      for (const path of paths) fireEvent.click(view.getByText(path));
      expect(requested).toEqual([]);
      expect(view.container.textContent).toContain("https://ithaca.example/scylla");
    } finally { root.dispose(); }
  });

  for (const [backend, name] of [["pi", "show_block"], ["claude", "mcp__brain-ui__show_block"]] as const) {
    test(`${backend} keeps malformed supporting output readable without controls`, () => {
      const root = createBrainUiRoot({ storage: null }); registerSupportingRenderers(root.renderers);
      try {
        const tool = { id: "malformed-files", name, input: {}, output: '{"block":{"kind":"files","items":"broken"}}' };
        const Output = root.renderers.resolve(tool, backend)!.Output!;
        const view = render(<BrainUiProvider root={root}><Output tool={tool} /></BrainUiProvider>);
        expect(view.container.textContent).toContain('"items":"broken"');
        expect(view.container.querySelectorAll('.bk-row[role="button"]')).toHaveLength(0);
      } finally { root.dispose(); }
    });
  }
});

describe("SearchResultCard integration", () => {
  const hit = { path: "knowledge/scylla.md", title: "Scylla crossing", type: "note", score: 0.75,
    snippet: "Row past >>>Scylla<<< and avoid >>>six heads<<<." };

  test("Search panel renders real score and every highlighted segment through the kit card", async () => {
    const ui = createBrainUiRoot({ storage: null, request: async () => Response.json({ results: [hit], warnings: ["FTS only"] }) });
    const mounted = render(<BrainUiProvider root={ui}><SearchPanel open onClose={() => {}} /></BrainUiProvider>);
    try {
      changeControlledInput(mounted.getByPlaceholderText("Search your brain...") as HTMLInputElement, "Scylla");
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
      expect([...mounted.container.querySelectorAll("mark")].map(mark => mark.textContent)).toEqual(["Scylla", "six heads"]);
      expect(mounted.getByText("0.75")).toBeTruthy();
      expect(mounted.getByText("FTS only")).toBeTruthy();
      expect(mounted.getByText("Scylla crossing")).toBeTruthy();
    } finally { mounted.unmount(); ui.dispose(); }
  });

  for (const [backend, name, output] of [
    ["claude", "mcp__brain__brain_search", JSON.stringify({ results: [hit], warnings: ["FTS only"] })],
    ["pi", "brain_search", "> FTS only\n- knowledge/scylla.md — Scylla crossing [note]\n    Row past >>>Scylla<<< and avoid >>>six heads<<<."],
  ] as const) {
    test(`${backend}: actual registered search output renders cards and opens only its provider root`, () => {
      const ui = createBrainUiRoot({ storage: null });
      const opened: string[] = [];
      ui.stores.file.setState({ openFile: async path => { opened.push(path); } });
      registerBuiltinRenderers(ui.renderers);
      const tool = { id: "search-proof", name, input: { query: "Scylla" }, output };
      const Output = ui.renderers.resolve(tool, backend)!.Output!;
      const mounted = render(<BrainUiProvider root={ui}><Output tool={tool} /></BrainUiProvider>);
      try {
        expect([...mounted.container.querySelectorAll("mark")].map(mark => mark.textContent)).toEqual(["Scylla", "six heads"]);
        expect(mounted.getByText("FTS only")).toBeTruthy();
        if (backend === "claude") expect(mounted.getByText("0.75")).toBeTruthy();
        else expect(mounted.queryByText("0.94")).toBeNull();
        fireEvent.click(mounted.getByTitle("knowledge/scylla.md"));
        expect(opened).toEqual(["knowledge/scylla.md"]);
        expect(ui.stores.ui.getState().filePanelOpen).toBe(true);
      } finally { mounted.unmount(); ui.dispose(); }
    });
  }
});

describe("SearchResultCard adversarial output", () => {
  function show(output: string, isError = false) {
    const ui = createBrainUiRoot({ storage: null });
    registerBuiltinRenderers(ui.renderers);
    const tool = { id: "hostile-search", name: "brain_search", input: {}, output, isError };
    const Output = ui.renderers.resolve(tool, "pi")!.Output!;
    const view = render(<BrainUiProvider root={ui}><Output tool={tool} /></BrainUiProvider>);
    return { ui, view };
  }
  test("unsafe results remain visible but cannot open a file", () => {
    const { ui, view } = show(JSON.stringify({ results: [{ path: "../secret.md", title: "Untrusted path", snippet: "visible evidence" }], warnings: [] }));
    const opened: string[] = [];
    ui.stores.file.setState({ openFile: async path => { opened.push(path); } });
    try {
      expect(view.getByText("Untrusted path")).toBeTruthy();
      expect(view.queryByRole("button")).toBeNull();
      fireEvent.click(view.getByTitle("../secret.md"));
      expect(opened).toEqual([]);
      expect(ui.stores.ui.getState().filePanelOpen).toBe(false);
      expect(view.queryByText("0.94")).toBeNull();
    } finally { view.unmount(); ui.dispose(); }
  });
  for (const [output, isError] of [["Search refused", true], ["old server prose", false], ["- knowledge/scylla.md — Scylla [note]\n… [truncated 12 bytes]", false]] as const) {
    test(`fallback retains the original result: ${output}`, () => {
      const { ui, view } = show(output, isError);
      try {
        expect(view.container.querySelector("[data-search-result-card]")).toBeNull();
        expect(view.container.textContent).toContain(output);
      } finally { view.unmount(); ui.dispose(); }
    });
  }
});
