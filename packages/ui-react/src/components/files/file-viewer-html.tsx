/**
 * The interactive HTML preview (#1084). The file is loaded from
 * `/api/files/html`, whose CSP `sandbox` directive gives the document an
 * opaque origin; this iframe's own sandbox repeats the restriction. Scripts
 * run, but the page cannot reach the app's DOM, cookies, storage or API.
 *
 * Never add `allow-same-origin`: with `allow-scripts` it would let the file
 * remove its own sandbox. Never add `allow-popups`, `allow-forms`,
 * `allow-downloads` or `allow-top-navigation` either. The maintainer ruling
 * and its accepted residual risks are on #1084.
 *
 * The opaque origin also puts its scroll position out of the parent's reach.
 * A press of Files (D52 N3) returns it to the top of the file by loading the
 * same `src` again (`data-html-preview`, `components/files/file-panel.tsx`).
 */
export const HTML_PREVIEW_SANDBOX = "allow-scripts";

export function FileViewerHtml({ src }: { src: string }) {
  return (
    <iframe
      sandbox={HTML_PREVIEW_SANDBOX}
      data-html-preview=""
      src={src}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
      title="HTML preview"
    />
  );
}
