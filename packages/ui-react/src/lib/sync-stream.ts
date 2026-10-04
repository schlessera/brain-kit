/** Consume the sync route's complete SSE events; disconnect never proves job cancellation. */
export async function readSyncResult(response: Response): Promise<{ success: boolean; message: string }> {
  const incomplete = (reason: string, cause?: unknown) => new Error(`Sync result incomplete: ${reason}`, { cause });
  if (response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream" || !response.body) {
    throw incomplete("expected an event stream");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let line = "";
  let skipLF = false;
  let data: string[] = [];

  function consumeLine(): { success: boolean; message: string } | undefined {
    const current = line;
    line = "";
    if (current === "") {
      if (data.length === 0) return;
      const payload = data.join("\n");
      data = [];
      let event: unknown;
      try { event = JSON.parse(payload); }
      catch (cause) { throw incomplete("malformed event data", cause); }
      if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "done") return;
      if (!("success" in event) || typeof event.success !== "boolean" || !("text" in event) || typeof event.text !== "string") {
        throw incomplete("malformed terminal event");
      }
      return { success: event.success, message: event.text };
    }
    if (current.startsWith(":")) return;
    const colon = current.indexOf(":");
    const field = colon === -1 ? current : current.slice(0, colon);
    let value = colon === -1 ? "" : current.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
  }

  try {
    while (true) {
      const chunk = await reader.read().catch((cause: unknown) => {
        throw incomplete("transport failed before a terminal event", cause);
      });
      if (chunk.done) throw incomplete("stream ended before a complete terminal event");
      // TextDecoder preserves split UTF-8 characters and strips the leading BOM.
      // CRLF, CR and LF delimit lines even when the pair spans byte chunks.
      for (const char of decoder.decode(chunk.value, { stream: true })) {
        if (skipLF) {
          skipLF = false;
          if (char === "\n") continue;
        }
        if (char === "\r" || char === "\n") {
          skipLF = char === "\r";
          const result = consumeLine();
          if (result) return result;
        } else {
          line += char;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
