import type { GoogleGenAI } from "@google/genai";
import type { ContentPart } from "../../lib/seams.js";

/** Abortable polling wait, including a signal already aborted before registration. */
function wait(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); };
    const aborted = () => { done(); reject(signal.reason); };
    const timer = setTimeout(() => { done(); resolve(); }, 1000);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Concrete Files API lifecycle. Only files created by this request are deleted. */
export async function withVideoFiles(
  ai: Pick<GoogleGenAI, "files">,
  parts: ContentPart[],
  signal: AbortSignal,
  generate: (parts: ContentPart[]) => Promise<string>,
): Promise<string> {
  const uploaded: string[] = [];
  let result: string | undefined;
  let failure: unknown;
  let failed = false;
  const errors: Error[] = [];
  try {
    const prepared: ContentPart[] = [];
    for (const part of parts) {
      signal.throwIfAborted();
      if (part.kind !== "video") { prepared.push(part); continue; }
      if (!part.mimeType.startsWith("video/")) throw new Error("Video requires a video MIME type");
      const { start, end } = part.clip ?? {};
      if ([start, end].some((v) => v !== undefined && (!Number.isFinite(v) || v < 0)) ||
          (end !== undefined && end <= (start ?? 0))) throw new Error("Invalid video clip window");
      if ("uri" in part) { prepared.push(part); continue; }
      let file = await ai.files.upload({
        file: "path" in part ? part.path : new Blob([new Uint8Array(part.data)], { type: part.mimeType }),
        config: { mimeType: part.mimeType, abortSignal: signal },
      });
      if (!file.name) throw new Error("Gemini upload returned no file name; cleanup cannot be confirmed");
      uploaded.push(file.name);
      const name = file.name;
      while (file.state === "PROCESSING") {
        await wait(signal);
        file = await ai.files.get({ name, config: { abortSignal: signal } });
      }
      signal.throwIfAborted();
      if (file.state !== "ACTIVE" || !file.uri) {
        throw new Error(`Gemini video processing did not become ACTIVE (${file.state ?? "unknown"})`);
      }
      prepared.push({ kind: "video", uri: file.uri, mimeType: part.mimeType, ...(part.clip ? { clip: part.clip } : {}) });
    }
    result = await generate(prepared);
  } catch (error) { failure = error; failed = true; }
  finally {
    for (const name of uploaded.reverse()) {
      try {
        await ai.files.delete({ name, config: {
          abortSignal: AbortSignal.timeout(10_000), httpOptions: {
            timeout: 10_000,
            // Override this request's bound transport, preserving its API key
            // while giving deletion a fresh deadline after cancellation.
            fetch: (input, init) => fetch(input, init),
          },
        } });
      } catch {
        errors.push(new Error(`Gemini upload cleanup failed for ${name}; delete it using the Files API. Uploaded files normally expire after 48 hours.`));
      }
    }
  }
  if (errors.length) throw new AggregateError(failed ? [failure, ...errors] : errors,
    `${failed ? "Video request failed; " : ""}${errors.map((error) => error.message).join(" ")}`);
  if (failed) throw failure;
  return result!;
}
