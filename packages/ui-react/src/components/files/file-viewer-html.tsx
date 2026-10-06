/**
 * The HTML preview, sandboxed with no permissions, so its document has an
 * opaque origin and its scroll position is out of the parent's reach. A
 * press of Files (D52 N3) returns it to the top of the file by loading the
 * same `srcdoc` again (`data-html-preview`, `components/files/file-panel.tsx`).
 */
export function FileViewerHtml({ content }: { content: string }) {
  return (
    <iframe
      sandbox=""
      data-html-preview=""
      srcDoc={content}
      className="h-full w-full border-0 bg-white"
      title="HTML preview"
    />
  );
}
