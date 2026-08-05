export function FileViewerHtml({ content }: { content: string }) {
  return (
    <iframe
      sandbox=""
      srcDoc={content}
      className="h-full w-full border-0 bg-white"
      title="HTML preview"
    />
  );
}
