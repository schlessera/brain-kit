/** One result boundary, claimed synchronously by dispatch or an interruption. */
const DEFERRED_OBSERVATION_MS = 50;

export function deferredObservation(start: (confirmed?: { stopped: boolean }) => Promise<void>) {
  const done = Promise.withResolvers<void>();
  let claimed = false;
  const timer = setTimeout(() => claim(), DEFERRED_OBSERVATION_MS);
  timer.unref?.();
  // A result's caller owns the error. The deadline must never reject unhandled.
  void done.promise.catch(() => {});
  function claim(confirmed?: { stopped: boolean }): Promise<void> {
    if (!claimed) {
      claimed = true;
      clearTimeout(timer);
      try { void start(confirmed).then(done.resolve, done.reject); }
      catch (error) { done.reject(error); }
    }
    return done.promise;
  }
  return { done: done.promise, claim };
}

/** Exact single-call Messages continuation. Unknown protocols keep the prior verdict fence. */
export function followsToolResult(path: string, body: Uint8Array, toolUseId: string): boolean {
  if (path !== "/v1/messages") return false;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (value.stream !== true || !Array.isArray(value.tools) || !value.tools.length || !Array.isArray(value.messages)) return false;
    const [assistant, user] = value.messages.slice(-2);
    if (assistant?.role !== "assistant" || user?.role !== "user" || !Array.isArray(assistant.content) || !Array.isArray(user.content)) return false;
    const calls = assistant.content.filter((block: { type?: string }) => block?.type === "tool_use");
    return calls.length === 1 && calls[0].id === toolUseId && user.content.length === 1
      && user.content[0]?.type === "tool_result" && user.content[0].tool_use_id === toolUseId;
  } catch { return false; }
}
