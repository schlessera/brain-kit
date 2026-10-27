/** EVALUATION ONLY (#3053). Local segmentation; never cancellation/finality. */
export function createInterruptionRecovery(changed: (phase: "open" | "speaking" | "waiting" | "manual") => void) {
  let phase: "open" | "speaking" | "waiting" | "manual" = "open";
  let silentMs = 0;
  let deadline = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function set(next: typeof phase) { if (phase !== next) { phase = next; changed(next); } }
  function reset() { clearTimeout(timer); timer = undefined; silentMs = 0; deadline = 0; set("open"); }
  return {
    held: () => phase !== "open",
    speaking() { clearTimeout(timer); timer = undefined; silentMs = 0; deadline = 0; set("speaking"); },
    endpoint() {
      if (phase !== "speaking") return;
      // Start a fresh, non-extending monotonic wall deadline after the unchanged
      // local 700 ms input endpoint. Pre-endpoint output is not evidence.
      silentMs = 0; deadline = performance.now() + 3000; set("waiting");
      timer = setTimeout(() => { timer = undefined; if (phase === "waiting") set("manual"); }, 3000);
    },
    drop(bytes: Uint8Array, rate: number) {
      if (phase === "open") return false;
      if (phase !== "waiting") return true;
      // A delayed event-loop timer cannot reopen output after its deadline.
      if (performance.now() >= deadline) { clearTimeout(timer); timer = undefined; set("manual"); return true; }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      // Exact digital zero only. Count decoded stream duration, not elapsed
      // packet time. A stall/EOF supplies zero samples and proves nothing.
      for (let offset = 0; offset < bytes.byteLength; offset += 2) {
        if (view.getInt16(offset, true) === 0) silentMs += 1000 / rate;
        else silentMs = 0;
        if (silentMs + 1e-8 >= 300) { reset(); break; }
      }
      // Drop the entire qualifying chunk too; never retain a hidden audio queue.
      return true;
    },
    manual() { if (phase === "manual") reset(); },
    reset,
  };
}
