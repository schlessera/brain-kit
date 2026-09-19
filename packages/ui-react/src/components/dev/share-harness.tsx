import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, Send, Trash2 } from "lucide-react";
import {
  DEFAULT_SHARE_TARGET_PATH,
  getShareStore,
  type StoredShare,
} from "@schlessera/brain-ui-sdk/share-target";

/**
 * Dev-only stand-in for the system share sheet.
 *
 * A real share needs an installed PWA, and on Android the intent filters are
 * baked into the WebAPK at install time — so every manifest change costs a
 * reinstall and a wait. This posts the same multipart body to the same path
 * from inside the page, which the service worker handles through exactly the
 * same code path: same handler, same stash, same redirect. Everything except
 * the manifest registration itself can be verified here.
 *
 * Two things to watch:
 *
 *   - The page must be CONTROLLED by the service worker. If it is not, the POST
 *     goes to the network instead, which is what the warning below is for.
 *   - A `fetch()` is not a navigation. Its `mode` is "cors" rather than
 *     "navigate", and it carries the session cookie, which a real cross-site
 *     share never does. So this exercises the handler and the stash faithfully,
 *     but never the browser rendering the landing page — and it cannot tell you
 *     anything about how an UNAUTHENTICATED share behaves.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ShareHarness({
  path = DEFAULT_SHARE_TARGET_PATH,
}: {
  path?: string;
}) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("An article worth keeping");
  const [url, setUrl] = useState("https://example.com/post");
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<StoredShare[]>([]);
  const [controlled, setControlled] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setPending(await getShareStore().list());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      setControlled(false);
      return;
    }
    // Re-read on takeover: the interesting case is a page that starts
    // uncontrolled and gains a worker, which is exactly when a fixed initial
    // reading would leave the warning lying.
    const update = () => setControlled(navigator.serviceWorker.controller !== null);
    update();
    navigator.serviceWorker.addEventListener("controllerchange", update);
    void refresh();
    return () =>
      navigator.serviceWorker.removeEventListener("controllerchange", update);
  }, [refresh]);

  async function send() {
    setError(null);
    setResult(null);
    const form = new FormData();
    if (title) form.set("title", title);
    if (text) form.set("text", text);
    if (url) form.set("url", url);
    for (const file of files) form.append("files", file);

    try {
      // The service worker answers with a 303 and fetch follows it, so the
      // final URL is what the browser would have landed on after a real share
      // — including the ?share= id.
      const response = await fetch(path, { method: "POST", body: form });
      if (response.ok) {
        setResult(response.url);
      } else {
        setError(`${response.status} ${response.statusText}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Refresh either way: a failed send can still have stashed something.
      await refresh();
    }
  }

  async function drop(id: string) {
    await getShareStore().delete(id);
    await refresh();
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6 text-foreground">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Share target harness</h1>
        <p className="text-sm text-muted-foreground">
          Posts a multipart share to <code>{path}</code> from inside the page.
          The service worker handles it exactly as it would a real share.
        </p>
      </header>

      {!controlled && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-raised p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            No service worker controls this page, so the POST goes to the
            network and the server answers with the no-worker fallback rather
            than stashing anything. Load a production build (the worker is
            disabled in dev) and reload once after it installs.
          </span>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <Field label="title" value={title} onChange={setTitle} />
        <Field label="text" value={text} onChange={setText} />
        <Field label="url" value={url} onChange={setUrl} />

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">files</span>
          <input
            type="file"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="text-sm"
          />
        </label>

        <button
          type="button"
          onClick={() => void send()}
          className="flex items-center justify-center gap-2 rounded-lg bg-primary-fill px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          <Send className="h-4 w-4" />
          Share it
        </button>
      </div>

      {error && (
        <p className="rounded-lg border border-destructive/40 bg-destructive-fill/10 p-3 text-sm">
          {error}
        </p>
      )}

      {result && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
          <span className="text-muted-foreground">Landed on</span>
          <code className="break-all">{result}</code>
          <button
            type="button"
            onClick={() => window.location.assign(result)}
            className="self-start rounded-md border border-border px-3 py-1 text-sm"
          >
            Open it
          </button>
        </div>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Stashed shares ({pending.length})</h2>
          <button
            type="button"
            onClick={() => void refresh()}
            className="flex items-center gap-1 text-sm text-muted-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>

        {pending.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing stashed.</p>
        )}

        {pending.map((share) => (
          <div
            key={share.id}
            className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm"
          >
            <div className="flex items-center justify-between gap-2">
              <code className="break-all text-xs text-muted-foreground">
                {share.id}
              </code>
              <button
                type="button"
                onClick={() => void drop(share.id)}
                aria-label="Delete stashed share"
                className="text-muted-foreground"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            {share.title && <div>title: {share.title}</div>}
            {share.text && <div>text: {share.text}</div>}
            {share.url && <div>url: {share.url}</div>}
            {share.files.map((file, i) => (
              <div key={`${file.name}-${i}`} className="text-muted-foreground">
                {file.name} ({file.type || "unknown"}, {formatBytes(file.size)})
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
      />
    </label>
  );
}
