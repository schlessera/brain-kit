import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
/** A complete, independently identified synthetic Messages API response. */
export function usageEvents(sessionId: string, model: string, input: number, output: number, read = 0, write = 0): SDKMessage[] {
  return [
    { type: "stream_event", session_id: sessionId, event: { type: "message_start", message: {
      id: `msg_${crypto.randomUUID()}`, model, usage: { input_tokens: input, output_tokens: 0,
        cache_read_input_tokens: read, cache_creation_input_tokens: write },
    } } },
    { type: "stream_event", session_id: sessionId, event: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: output } } },
    { type: "stream_event", session_id: sessionId, event: { type: "message_stop" } },
  ] as unknown as SDKMessage[];
}
