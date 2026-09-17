import type { BrainUiRoot } from "../../root.js";
import type { FileState } from "../../stores/file-state.js";
import { Loader2, AlertCircle, Eye, Code, Copy, Check, FolderOpen } from "lucide-react";
import { useState } from "react";
import { useFileStore } from "../../stores/file-store.js";
import { cn } from "../../lib/utils.js";
import { FileViewerMarkdown } from "./file-viewer-markdown.js";
import { FileViewerHtml } from "./file-viewer-html.js";
import { FileViewerRaw } from "./file-viewer-raw.js";
import { FileViewerBinary } from "./file-viewer-binary.js";
import { ShareMenu, type ShareOption } from "../share/share-menu.js";
import { useBrainUiRoot } from "../../root-context.js";
import { fetchAsFile, shareFile, renderAndShare } from "../../lib/share.js";
import { splitFrontmatter } from "../../lib/frontmatter.js";
import { stripMarkdown } from "../../lib/strip-markdown.js";
import { inlineMermaidDiagrams, isMermaidPath } from "../../lib/mermaid.js";
import { MermaidBlock } from "../chat/mermaid-block.js";
import { buildDiagramShareOptions } from "../chat/mermaid-share.js";
import { buildImageShareOptions } from "../images/image-share.js";
import type { FileContentResponse } from "@schlessera/brain-ui-sdk/protocol";

export function FileViewer() {
  const currentPath = useFileStore((s) => s.currentPath);
  const content = useFileStore((s) => s.currentContent);
  const loading = useFileStore((s) => s.contentLoading);
  const error = useFileStore((s) => s.contentError);
  const viewMode = useFileStore((s) => s.viewMode);
  const setViewMode = useFileStore((s) => s.setViewMode);
  const setTreeExpanded = useFileStore((s) => s.setTreeExpanded);

  if (!currentPath) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
        <FolderOpen className="h-8 w-8 text-muted-foreground/40" />
        <span>Select a file from the tree to view it.</span>
      </div>
    );
  }

  const fileName = currentPath.split("/").pop() ?? currentPath;
  const previewAvailable =
    content?.kind === "markdown" ||
    content?.kind === "html" ||
    (content?.kind === "text" && isMermaidPath(content.path));

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        fileName={fileName}
        fullPath={currentPath}
        size={content?.size}
        viewMode={viewMode}
        setViewMode={setViewMode}
        previewAvailable={previewAvailable}
        content={content ?? null}
        onRevealInTree={() => setTreeExpanded(true)}
      />

      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading file...
          </div>
        )}
        {error && (
          <div className="m-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {!loading && !error && content && <ViewerBody content={content} viewMode={viewMode} />}
      </div>
    </div>
  );
}

function ViewerBody({ content, viewMode }: { content: NonNullable<FileState["currentContent"]>; viewMode: "preview" | "raw" }) {
  if (content.kind === "binary") {
    return <FileViewerBinary content={content} />;
  }
  // Standalone mermaid source files (.mmd / .mermaid) preview as a diagram.
  if (viewMode === "preview" && content.kind === "text" && isMermaidPath(content.path)) {
    return (
      <div className="brain-prose max-w-none px-6 py-4">
        <MermaidBlock source={content.content ?? ""} />
      </div>
    );
  }
  if (viewMode === "raw" || (content.kind !== "markdown" && content.kind !== "html")) {
    return <FileViewerRaw content={content.content ?? ""} fileName={content.path} />;
  }
  if (content.kind === "markdown") {
    return <FileViewerMarkdown content={content.content ?? ""} />;
  }
  return <FileViewerHtml content={content.content ?? ""} />;
}

function Toolbar({
  fileName,
  fullPath,
  size,
  viewMode,
  setViewMode,
  previewAvailable,
  content,
  onRevealInTree,
}: {
  fileName: string;
  fullPath: string;
  size?: number;
  viewMode: "preview" | "raw";
  setViewMode: (m: "preview" | "raw") => void;
  previewAvailable: boolean;
  content: FileContentResponse | null;
  onRevealInTree: () => void;
}) {
  const root = useBrainUiRoot();
  const [copied, setCopied] = useState(false);
  const shareOptions = content ? buildFileShareOptions(root, content, fileName) : [];
  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2">
      <button
        onClick={onRevealInTree}
        title="Reveal in tree"
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
      >
        <FolderOpen className="h-3.5 w-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground" title={fullPath}>
          {fileName}
        </div>
        <div className="truncate text-[10px] text-muted-foreground" title={fullPath}>
          {fullPath}
          {size !== undefined && <span className="ml-2">· {formatSize(size)}</span>}
        </div>
      </div>
      <button
        onClick={() => {
          navigator.clipboard.writeText(fullPath);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        title="Copy path"
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {shareOptions.length > 0 && <ShareMenu options={shareOptions} title="Share" />}
      {previewAvailable && (
        <div className="flex items-center rounded-md border border-border bg-background">
          <ModeButton active={viewMode === "preview"} onClick={() => setViewMode("preview")} title="Preview">
            <Eye className="h-3.5 w-3.5" />
          </ModeButton>
          <ModeButton active={viewMode === "raw"} onClick={() => setViewMode("raw")} title="Raw">
            <Code className="h-3.5 w-3.5" />
          </ModeButton>
        </div>
      )}
    </div>
  );
}

function ModeButton({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "flex h-7 w-7 items-center justify-center transition-colors",
        active ? "bg-surface-raised text-primary" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function buildFileShareOptions(root: BrainUiRoot, content: FileContentResponse, fileName: string): ShareOption[] {
  const rawUrl = `${root.apiBase()}/files/content?path=${encodeURIComponent(content.path)}&raw=1`;

  if (content.kind === "binary") {
    // An image gets both: the original bytes, and a lighter re-encode for
    // messaging. The original is first, and nothing is downgraded unasked.
    if (content.mime?.startsWith("image/")) {
      return buildImageShareOptions(root, rawUrl, fileName, {
        mime: content.mime,
        bytes: content.size,
      });
    }
    // A PDF ships as-is: there is no client-side recompression for one.
    if (content.mime === "application/pdf") {
      return [
        {
          id: "file",
          label: "Share file",
          run: async () => {
            const file = await fetchAsFile(root, rawUrl, fileName, content.mime);
            return shareFile(file, { title: fileName });
          },
        },
      ];
    }
    // Non-previewable binary: no share menu (user can still use Download link).
    return [];
  }

  if (content.kind === "markdown") {
    const md = content.content ?? "";
    const { body } = splitFrontmatter(md);
    return [
      {
        id: "md-file",
        label: "Share as .md file",
        hint: "Original markdown source",
        run: async () => {
          const file = new File([md], fileName.endsWith(".md") ? fileName : `${fileName}.md`, {
            type: "text/markdown",
          });
          return shareFile(file, { title: fileName });
        },
      },
      {
        id: "md-text",
        label: "Share body as plain text",
        hint: "Frontmatter dropped, markdown stripped",
        run: async () => {
          const file = new File([stripMarkdown(body)], `${baseName(fileName)}.txt`, {
            type: "text/plain",
          });
          return shareFile(file, { title: fileName });
        },
      },
      {
        id: "md-png",
        label: "Share as image",
        hint: "Rendered PNG snapshot",
        run: async () =>
          renderAndShare(root, {
            // The render page runs without JavaScript — mermaid fences are
            // pre-rendered to inline SVG on the client.
            content: await inlineMermaidDiagrams(body),
            contentType: "markdown",
            format: "png",
            filename: baseName(fileName),
            title: fileName,
          }),
      },
      {
        id: "md-pdf",
        label: "Share as PDF",
        hint: "Vector PDF, A4",
        run: async () =>
          renderAndShare(root, {
            content: await inlineMermaidDiagrams(body),
            contentType: "markdown",
            format: "pdf",
            filename: baseName(fileName),
            title: fileName,
          }),
      },
    ];
  }

  if (content.kind === "html") {
    const html = content.content ?? "";
    return [
      {
        id: "html-file",
        label: "Share as .html file",
        run: async () => {
          const file = new File([html], fileName.endsWith(".html") ? fileName : `${fileName}.html`, {
            type: "text/html",
          });
          return shareFile(file, { title: fileName });
        },
      },
      {
        id: "html-png",
        label: "Share as image",
        run: () =>
          renderAndShare(root, {
            content: html,
            contentType: "html",
            format: "png",
            filename: baseName(fileName),
            title: fileName,
          }),
      },
      {
        id: "html-pdf",
        label: "Share as PDF",
        run: () =>
          renderAndShare(root, {
            content: html,
            contentType: "html",
            format: "pdf",
            filename: baseName(fileName),
            title: fileName,
          }),
      },
    ];
  }

  // A standalone .mmd/.mermaid file is a diagram, so it shares like one — the
  // same PNG/PDF/SVG/source set the in-chat diagram offers, plus its source file.
  if (content.kind === "text" && isMermaidPath(content.path)) {
    const source = content.content ?? "";
    return [
      ...buildDiagramShareOptions(root, source, { filename: baseName(fileName) }),
      {
        id: "mmd-file",
        label: "Share source file",
        hint: "Original .mmd source",
        run: async () =>
          shareFile(new File([source], fileName, { type: "text/plain" }), { title: fileName }),
      },
    ];
  }

  // Raw text / unknown: no share for V1 (user limited to previewable types).
  return [];
}

function baseName(name: string): string {
  return name.replace(/\.[a-z0-9]{1,8}$/i, "");
}
