import { SHARE_MAX_FILES, SHARE_MAX_TOTAL_BYTES, TRACK_MAX_FILE_BYTES, type SharedFileMeta } from "@schlessera/brain-ui-sdk/protocol";
import { sharedFileMetaSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { BrainUiRoot } from "../root.js";

// The parser's UTF-8 input cap is smaller than the generic share-file cap.
export const TRACK_MAX_BYTES = TRACK_MAX_FILE_BYTES;
export type TrackUploadState = "picked" | "uploading" | "parsing" | "paused" | "failed" | "ready";
export interface PendingTrack {
  id: string;
  file: File;
  name: string;
  state: TrackUploadState;
  meta?: SharedFileMeta;
  error?: string;
}
export const trackReady = (track: PendingTrack) => track.state === "ready" && !!track.meta;
export const trackPending = (track: PendingTrack) => ["picked", "uploading", "parsing", "paused"].includes(track.state);
export function trackDisplayName(name: string): string {
  return Array.from(name.replace(/[\p{Cc}\p{Cf}]/gu, "")).slice(0, 100).join("") || "Unnamed track";
}
export function trackBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export function trackStatus(track: PendingTrack): string {
  switch (track.state) {
    case "picked": return "waiting to upload";
    case "uploading": return "uploading…";
    case "parsing": return "reading track…";
    case "paused": return "waiting for connection";
    case "failed": return track.error ?? "upload failed";
    case "ready": {
      const summary = track.meta?.summary;
      if (!summary || summary.status === "no_line") return "no track line in file";
      const metres = summary.measurements.distance.value;
      const distance = metres === null ? "distance unknown" : metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;
      return `${distance} · ${summary.shape === "one_way" ? "one way" : summary.shape}${summary.partial ? " · usable sections only" : ""}`;
    }
  }
}

/** Concrete multipart queue for this composer. Originals stay in File objects until ready. */
export function createTrackUploads(request: BrainUiRoot["request"], apiBase: string, changed: () => void) {
  let files: PendingTrack[] = [];
  let online = true;
  let disposed = false;
  const running = new Map<string, AbortController>();
  const notify = () => { if (!disposed) changed(); };
  function update(id: string, patch: Partial<PendingTrack>) {
    files = files.map(file => file.id === id ? { ...file, ...patch } : file);
    notify();
  }
  async function upload(track: PendingTrack, controller: AbortController) {
    update(track.id, { state: "uploading", error: undefined });
    const form = new FormData();
    form.append("files", track.file, track.file.name);
    try {
      const response = await request(`${apiBase}/track-upload`, { method: "POST", body: form, signal: controller.signal });
      if (controller.signal.aborted || !files.some(file => file.id === track.id)) return;
      update(track.id, { state: "parsing" });
      const body = await response.json() as { files?: unknown[]; error?: string; message?: string };
      if (controller.signal.aborted || !files.some(file => file.id === track.id)) return;
      if (!response.ok) {
        const reason = response.status === 422 ? "Not a supported track. Use GPX, KML or GeoJSON; ordinary JSON, PDF, CSV, KMZ, FIT and TCX aren't supported."
          : response.status === 413 ? `Too large. Tracks up to ${trackBytes(TRACK_MAX_BYTES)} each.`
          : `The host refused it (${response.status}).`;
        update(track.id, { state: "failed", error: reason });
        return;
      }
      const parsed = sharedFileMetaSchema.safeParse(body.files?.[0]);
      if (!parsed.success || !parsed.data.detected || !parsed.data.summary) throw new Error("invalid_track_response");
      update(track.id, { state: "ready", meta: parsed.data });
    } catch {
      if (!controller.signal.aborted) update(track.id, { state: "failed", error: "Upload failed: the host didn't answer. Retry when connected." });
    } finally {
      running.delete(track.id);
      pump();
    }
  }
  function pump() {
    if (!online || disposed) return;
    for (const file of files) {
      if (running.size >= 2) break;
      if (file.state !== "picked" || running.has(file.id)) continue;
      const controller = new AbortController();
      running.set(file.id, controller);
      void upload(file, controller);
    }
  }
  return {
    get files() { return files; },
    add(incoming: File[], otherCount = 0, otherBytes = 0): string[] {
      const errors: string[] = [];
      let bytes = files.reduce((sum, file) => sum + file.file.size, otherBytes);
      for (const file of incoming) {
        const name = trackDisplayName(file.name);
        if (file.size > TRACK_MAX_BYTES) { errors.push(`${name}: too large. Tracks up to ${trackBytes(TRACK_MAX_BYTES)} each.`); continue; }
        if (files.length + otherCount >= SHARE_MAX_FILES) { errors.push(`${name}: too many files. Up to ${SHARE_MAX_FILES} in one message.`); continue; }
        if (bytes + file.size > SHARE_MAX_TOTAL_BYTES) { errors.push(`${name}: message is too large. Up to ${trackBytes(SHARE_MAX_TOTAL_BYTES)} together.`); continue; }
        files = [...files, { id: crypto.randomUUID(), file, name, state: online ? "picked" : "paused" }];
        bytes += file.size;
      }
      notify(); pump(); return errors;
    },
    /** Warm auth restore: these are host references, not a re-upload. */
    restore(references: readonly SharedFileMeta[]) {
      files = references.map((meta) => ({ id: crypto.randomUUID(), file: new File([], meta.name), name: trackDisplayName(meta.name), state: "ready", meta }));
      notify();
    },
    remove(id: string) {
      running.get(id)?.abort();
      files = files.filter(file => file.id !== id);
      notify(); pump();
    },
    retry(id: string) {
      if (files.find(file => file.id === id)?.state !== "failed") return;
      update(id, { state: online ? "picked" : "paused", error: undefined }); pump();
    },
    setOnline(value: boolean) {
      online = value;
      if (!value) {
        for (const controller of running.values()) controller.abort();
        files = files.map(file => trackPending(file) ? { ...file, state: "paused" } : file);
      } else files = files.map(file => file.state === "paused" ? { ...file, state: "picked" } : file);
      notify(); pump();
    },
    dispose() { disposed = true; for (const controller of running.values()) controller.abort(); },
  };
}
