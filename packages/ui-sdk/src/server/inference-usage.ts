/** Host-only, bounded inspection of the provider's initial Messages SSE usage. */
export interface InferenceUsage {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}
const MAX_INITIAL_USAGE_BYTES = 64 * 1024;

/** No parsing or await occurs on a chunk's forwarding path. Unknown data is absent. */
export function inferenceUsageObserver(record: (usage: InferenceUsage) => void) {
  const decoder = new TextDecoder();
  let retained = 0, done = false, skipLF = false, event: string | undefined;
  let line: string[] = [], data: string[] = [];
  const frame = () => {
    const label = event, fields = data; event = undefined; data = [];
    if (!fields.length) return;
    let value: any;
    try { value = JSON.parse(fields.join("\n")); } catch { done = true; return; }
    if (value?.type === "ping" && (!label || label === "ping")) return;
    done = true;
    if (value?.type !== "message_start" || (label && label !== "message_start")) return;
    const usage = value?.message?.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
    const result: InferenceUsage = {};
    for (const [source, target] of [["input_tokens", "inputTokens"], ["cache_read_input_tokens", "cacheReadTokens"], ["cache_creation_input_tokens", "cacheCreationTokens"]] as const) {
      const count = usage[source];
      if (count === undefined || count === null) continue;
      if (!Number.isSafeInteger(count) || count < 0) return;
      result[target] = count;
    }
    if (Object.keys(result).length) record(result);
  };
  const endLine = () => {
    const text = line.join(""); line = [];
    if (!text) { frame(); return; }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":"), field = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? "" : text.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value; // SSE: the last event field wins.
    else if (field === "data") data.push(value);
  };
  const parse = (chunk: Uint8Array) => {
    if (done) return;
    try {
      // Consume each decoded character once. No retained-prefix delimiter rescans.
      for (const char of decoder.decode(chunk, { stream: true })) {
        if (skipLF && char === "\n") { skipLF = false; continue; }
        skipLF = char === "\r";
        if (skipLF || char === "\n") endLine(); else line.push(char);
        if (done) break;
      }
    } catch { done = true; /* Diagnostics never break the response. */ }
  };
  return (chunk: Uint8Array) => {
    if (done || retained >= MAX_INITIAL_USAGE_BYTES) return;
    const observed = chunk.subarray(0, MAX_INITIAL_USAGE_BYTES - retained);
    retained += observed.byteLength;
    queueMicrotask(() => parse(observed));
  };
}
