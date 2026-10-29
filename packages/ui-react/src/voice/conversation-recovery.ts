/** Local output segmentation only. No remote cancellation or turn-finality claim. */
export function createConversationRecovery() {
  let phase: "audible" | "speaking" | "checking" | "muted" = "audible";
  let quietSince = 0;
  let deadline = 0;
  return {
    get phase() { return phase; },
    suppress(speaking: boolean, now: number) {
      phase = speaking ? "speaking" : "checking";
      quietSince = now;
      deadline = now + 3000;
    },
    endpoint(now: number) {
      if (phase !== "speaking") return;
      phase = "checking"; quietSince = now; deadline = now + 3000;
    },
    observe(bytes: Uint8Array, now: number) {
      // Exact digital silence does not reset the gap. No threshold pretends to
      // establish acoustic attribution. Packet gaps also count as local quiet;
      // delayed old audio can pass after recovery (the accepted tradeoff).
      if (phase === "checking" && bytes.some(byte => byte !== 0)) quietSince = now;
    },
    poll(now: number) {
      if (phase === "checking") {
        // A suspended/delayed timer cannot recover after its deadline.
        if (now >= deadline) phase = "muted";
        else if (now - quietSince >= 300) phase = "audible";
      }
      return phase;
    },
    reset() { phase = "audible"; quietSince = deadline = 0; },
  };
}
