import { useEffect, useRef, useState, type RefObject } from "react";
import type { PDFPageProxy, RenderTask } from "pdfjs-dist";
import { useBrainUiRoot } from "../../root-context.js";
import { closePdf, openPdf, type PdfDocument } from "../../lib/pdf.js";
import { ZoomViewer } from "../viewer/zoom-viewer.js";
import { BinaryMeta, type BinaryPreviewProps } from "./binary-preview.js";
import { ViewerLoading } from "./file-viewer-frame.js";

/**
 * A PDF drawn by pdf.js, one canvas per page, scrolled like any other file.
 *
 * Only pages near the viewport hold a canvas. The rest are empty boxes of the
 * right shape, so the scrollbar is honest from the start and a long document
 * does not keep every page's pixels in memory, which iOS punishes by
 * reloading the tab. Tapping a page opens it in the zoom viewer, the same
 * move an image or a diagram makes: the file panel scrolls, so pinch-zoom
 * inside it would have to take the gestures scrolling needs.
 *
 * The browser's own viewer (`<iframe>`/`<object>` on the raw URL) is not an
 * option: Android Chrome offers a download instead of rendering one, iOS
 * shows a single page that does not scroll, and the raw route forbids
 * framing (`frame-ancestors 'none'`).
 */
export function PdfPreview({ content, rawUrl, filename, onUnsupported }: BinaryPreviewProps) {
  const root = useBrainUiRoot();
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const unsupported = useRef(onUnsupported);
  unsupported.current = onUnsupported;

  useEffect(() => {
    let cancelled = false;
    let opened: PdfDocument | null = null;
    setDoc(null);
    openPdf(rawUrl, root.config.pdfWorkerUrl).then(
      (loaded) => {
        if (cancelled) {
          closePdf(loaded);
          return;
        }
        opened = loaded;
        setDoc(loaded);
      },
      () => {
        if (!cancelled) unsupported.current();
      }
    );
    return () => {
      cancelled = true;
      if (opened) closePdf(opened);
    };
    // mtime: a regenerated file keeps its path and URL, and must still redraw.
  }, [rawUrl, content.mtime, root]);

  const pages = doc?.numPages;
  return (
    <div className="flex flex-col items-center gap-3 px-3 py-4" aria-label={`PDF preview: ${filename}`}>
      <BinaryMeta
        content={content}
        rawUrl={rawUrl}
        filename={filename}
        detail={pages === undefined ? undefined : `${pages} ${pages === 1 ? "page" : "pages"}`}
      />
      {doc ? <PdfPages doc={doc} filename={filename} /> : <div className="w-full"><ViewerLoading /></div>}
    </div>
  );
}

function PdfPages({ doc, filename }: { doc: PdfDocument; filename: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  const width = useWidth(listRef);
  // Height over width of page 1, the shape every page takes until it is drawn.
  const [ratio, setRatio] = useState<number | null>(null);
  const [zoomed, setZoomed] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void doc.getPage(1).then((page) => {
      const { width: w, height: h } = page.getViewport({ scale: 1 });
      if (!cancelled) setRatio(h / w);
    });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  return (
    <div ref={listRef} className="flex w-full max-w-3xl flex-col gap-3">
      {width > 0 &&
        ratio !== null &&
        Array.from({ length: doc.numPages }, (_, i) => (
          <PdfPage
            key={i + 1}
            doc={doc}
            pageNumber={i + 1}
            width={width}
            placeholderRatio={ratio}
            onOpen={() => setZoomed(i + 1)}
          />
        ))}
      {zoomed !== null && (
        <PdfPageViewer doc={doc} pageNumber={zoomed} filename={filename} onClose={() => setZoomed(null)} />
      )}
    </div>
  );
}

function PdfPage({
  doc,
  pageNumber,
  width,
  placeholderRatio,
  onOpen,
}: {
  doc: PdfDocument;
  pageNumber: number;
  width: number;
  placeholderRatio: number;
  onOpen: () => void;
}) {
  const boxRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const near = useNearViewport(boxRef);
  const [ratio, setRatio] = useState(placeholderRatio);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!near || !canvas) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    void doc.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      // Device pixels, so text stays sharp on a phone; 3x is the densest screen worth drawing for.
      const scale = (width / base.width) * Math.min(window.devicePixelRatio || 1, 3);
      task = draw(page, canvas, scale);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, width, near]);

  return (
    <button
      ref={boxRef}
      type="button"
      onClick={onOpen}
      aria-label={`Page ${pageNumber} of ${doc.numPages}, open zoomed`}
      className="block w-full cursor-zoom-in overflow-hidden rounded border border-border bg-white"
      style={{ aspectRatio: `1 / ${ratio}` }}
    >
      {near && <canvas ref={canvasRef} aria-hidden="true" className="block h-full w-full" />}
    </button>
  );
}

/** CSS pixels per PDF point: 96 per inch on screen, 72 in the file. */
const CSS_PX_PER_POINT = 96 / 72;
/** iOS Safari refuses to draw a canvas above this many pixels. */
const MAX_CANVAS_PIXELS = 16_777_216;

/**
 * One page in the zoom viewer, laid out at its printed size and drawn at up
 * to three times that, so zooming in stays sharp until well past the width
 * of a phone.
 */
function PdfPageViewer({
  doc,
  pageNumber,
  filename,
  onClose,
}: {
  doc: PdfDocument;
  pageNumber: number;
  filename: string;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    void doc.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(CSS_PX_PER_POINT * 3, Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height)));
      task = draw(page, canvas, scale);
      setSize({ width: base.width * CSS_PX_PER_POINT, height: base.height * CSS_PX_PER_POINT });
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber]);

  return (
    <ZoomViewer onClose={onClose} refitKey={size} label={`${filename}, page ${pageNumber} of ${doc.numPages}`}>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="block bg-white"
        style={size ? { width: size.width, height: size.height } : undefined}
      />
    </ZoomViewer>
  );
}

function draw(page: PDFPageProxy, canvas: HTMLCanvasElement, scale: number): RenderTask {
  const viewport = page.getViewport({ scale });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task = page.render({ canvas, viewport });
  // A cancelled render rejects; that is the cleanup working, not a failure.
  task.promise.catch(() => {});
  return task;
}

/** The element's content width in CSS pixels, kept current as the panel resizes. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Whether the element is within a screen's height of the visible area. */
function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry?.isIntersecting ?? false), {
      rootMargin: "100% 0px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return near;
}
