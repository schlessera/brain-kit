/** Existing root request transport, with actual XHR upload progress for saved
 * recordings. Fetch remains the ordinary path. Root auth guards wrap both. */
export type ProgressRequestInit = RequestInit & { onUploadProgress?: (percent: number) => void };
export function browserRequest(url: string, init?: ProgressRequestInit): Promise<Response> {
  if (!init?.onUploadProgress) return fetch(url, init);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => init.signal?.removeEventListener("abort", abort);
    xhr.open(init.method ?? "GET", url);
    xhr.withCredentials = init.credentials === "include";
    new Headers(init.headers).forEach((value, name) => xhr.setRequestHeader(name, value));
    xhr.upload.onprogress = event => { if (event.lengthComputable) init.onUploadProgress!(Math.round(event.loaded / event.total * 100)); };
    xhr.onload = () => {
      cleanup();
      const headers = new Headers();
      for (const line of xhr.getAllResponseHeaders().trim().split(/\r?\n/)) {
        const at = line.indexOf(":"); if (at > 0) headers.append(line.slice(0, at), line.slice(at + 1).trim());
      }
      resolve(new Response(xhr.responseText, { status: xhr.status, headers }));
    };
    xhr.onerror = () => { cleanup(); reject(new TypeError("Upload connection lost")); };
    xhr.onabort = () => { cleanup(); reject(new DOMException("Upload stopped", "AbortError")); };
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.signal?.aborted) { cleanup(); reject(new DOMException("Upload stopped", "AbortError")); return; }
    xhr.send(init.body as XMLHttpRequestBodyInit);
  });
}
