export function nativeModelReply(call?: { name: string; input: Record<string, unknown>; id: string }): Response {
  const events: unknown[] = [{ type: "message_start", message: { id: "msg_ithaca", type: "message", role: "assistant", model: "claude-probe", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: call ? { type: "tool_use", id: call.id, name: call.name, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text: "Done." } },
    { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
  return new Response(events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
