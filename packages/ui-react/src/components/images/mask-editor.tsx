import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, RotateCcw, X } from "lucide-react";

import { useBrainUiRoot } from "../../root-context.js";
import { useMaskStore } from "../../stores/mask-store.js";

/**
 * Paint-over-the-image mask editor.
 *
 * The agent cannot know which part of a picture someone means, so it asks. The
 * user paints; this produces a PNG the same size as the source image in which
 * **painted pixels are fully transparent** and everything else is opaque —
 * the convention OpenAI's edit endpoint reads, so the bytes go through to the
 * API unmodified.
 *
 * Painting happens on a display-sized canvas and is scaled to the image's true
 * pixel dimensions on export, so a mask drawn on a phone still lines up with a
 * 4K source.
 */

interface Stroke {
  points: { x: number; y: number }[];
  /** Brush width in display pixels. */
  width: number;
}

export function MaskEditor({
  onSubmit,
  onCancel,
}: {
  onSubmit: (requestId: string, maskPngBase64: string) => void;
  onCancel: (requestId: string, message: string) => void;
}) {
  const root = useBrainUiRoot();
  const request = useMaskStore((s) => s.request);
  const close = useMaskStore((s) => s.close);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [brush, setBrush] = useState(48);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rawUrl = request
    ? `${root.apiBase()}/files/content?path=${encodeURIComponent(request.imagePath)}&raw=1`
    : null;

  // Reset per request: a second mask on a different image must not inherit the
  // first one's strokes.
  useEffect(() => {
    setStrokes([]);
    setDrawing(false);
    setLoaded(false);
    setError(null);
  }, [root, request?.requestId, rawUrl]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // The painted region is shown as a translucent wash so the user can still
    // see what is underneath it while deciding.
    ctx.save();
    ctx.strokeStyle = "rgba(239, 68, 68, 0.55)";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokes) {
      ctx.lineWidth = stroke.width;
      ctx.beginPath();
      stroke.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      // A single tap is a dot, not a zero-length line.
      if (stroke.points.length === 1) ctx.lineTo(stroke.points[0].x + 0.01, stroke.points[0].y);
      ctx.stroke();
    }
    ctx.restore();
  }, [strokes]);

  useEffect(redraw, [redraw, loaded]);

  const pointFrom = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  if (!request) return null;

  const submit = () => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    if (strokes.length === 0) {
      setError("Paint over the area you want changed first.");
      return;
    }

    // Export at the source image's real dimensions, not the display size.
    const out = document.createElement("canvas");
    out.width = img.naturalWidth;
    out.height = img.naturalHeight;
    const ctx = out.getContext("2d");
    if (!ctx) {
      setError("This browser could not produce the mask.");
      return;
    }
    const scale = out.width / canvas.width;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    // Painted area becomes a hole: alpha 0 is what marks it editable.
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0,0,0,1)";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokes) {
      ctx.lineWidth = stroke.width * scale;
      ctx.beginPath();
      stroke.points.forEach((p, i) =>
        i === 0 ? ctx.moveTo(p.x * scale, p.y * scale) : ctx.lineTo(p.x * scale, p.y * scale)
      );
      if (stroke.points.length === 1) {
        ctx.lineTo(stroke.points[0].x * scale + 0.01, stroke.points[0].y * scale);
      }
      ctx.stroke();
    }

    const dataUrl = out.toDataURL("image/png");
    onSubmit(request.requestId, dataUrl.slice(dataUrl.indexOf(",") + 1));
    close();
  };

  const cancel = () => {
    onCancel(request.requestId, "The user closed the mask editor");
    close();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-3 p-3 text-sm text-white">
        <div className="min-w-0">
          <div className="font-medium">Mark the area to change</div>
          <div className="truncate text-white/70">
            {request.instruction ?? request.imagePath}
          </div>
        </div>
        <button
          type="button"
          onClick={cancel}
          aria-label="Cancel"
          className="rounded p-2 hover:bg-white/10"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        {rawUrl && (
          <img
            key={rawUrl}
            ref={imageRef}
            src={rawUrl}
            alt=""
            className="hidden"
            onLoad={(e) => {
              const img = e.currentTarget;
              const canvas = canvasRef.current;
              if (canvas) {
                // Cap the working canvas so a 4K source stays responsive to draw on.
                const maxEdge = 1400;
                const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
                canvas.width = Math.round(img.naturalWidth * scale);
                canvas.height = Math.round(img.naturalHeight * scale);
              }
              setLoaded(true);
            }}
            onError={() => setError(`Could not load ${request.imagePath}`)}
          />
        )}
        <canvas
          ref={canvasRef}
          className="max-h-full max-w-full touch-none rounded shadow-lg"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setDrawing(true);
            setStrokes((prev) => [...prev, { points: [pointFrom(e)], width: brush }]);
          }}
          onPointerMove={(e) => {
            if (!drawing) return;
            const p = pointFrom(e);
            setStrokes((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last) next[next.length - 1] = { ...last, points: [...last.points, p] };
              return next;
            });
          }}
          onPointerUp={() => setDrawing(false)}
          onPointerCancel={() => setDrawing(false)}
        />
      </div>

      {error && <div className="px-3 pb-1 text-center text-sm text-red-300">{error}</div>}

      <div className="flex items-center gap-3 p-3">
        <label className="flex flex-1 items-center gap-2 text-xs text-white/80">
          Brush
          <input
            type="range"
            min={8}
            max={160}
            value={brush}
            onChange={(e) => setBrush(Number(e.target.value))}
            className="flex-1"
          />
        </label>
        <button
          type="button"
          onClick={() => setStrokes((prev) => prev.slice(0, -1))}
          disabled={strokes.length === 0}
          className="rounded p-2 text-white hover:bg-white/10 disabled:opacity-40"
          aria-label="Undo"
        >
          <RotateCcw className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => setStrokes([])}
          disabled={strokes.length === 0}
          className="rounded p-2 text-white hover:bg-white/10 disabled:opacity-40"
          aria-label="Clear"
        >
          <Eraser className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!loaded}
          className="rounded bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          Use this area
        </button>
      </div>
    </div>
  );
}
