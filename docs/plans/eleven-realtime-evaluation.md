# Eleven Realtime as a third live-conversation engine: evaluation

This is the evaluation for #3100. The question is whether Eleven Realtime v1 Max can
join Gemini Live and GPT-Live behind the existing provider seam
(`LiveConversationSession`, `packages/ui-sdk/src/server/conversation.ts:188-201`)
and (`LiveConversationProvider`, `packages/ui-sdk/src/server/conversation.ts:208-213`),
under the host authority that
[the live-conversation decision](../decisions/live-conversation.md) and
[the voice-permission decision](../decisions/voice-permission.md) set.

**Verdict at the documentation stage: unresolved.** The vendor documentation
covers streaming audio, transcripts, interruption and native tool-call IDs. It
does not establish the decisive capability: a tool call that does not block the
dialogue and whose exact result, returned minutes later, is spoken in a later
reply. One bounded live probe settles it. Until then, do not schedule a
production adapter. If no probe is authorized, close #3100 as unresolved rather
than as unsuitable.

The evidence is vendor documentation and pricing, checked on 2026-11-02, plus
the repository source cited here. There were **zero provider calls, zero
credentials and zero audio samples**. No account, workspace rollout, latency,
recognition quality or audibility was tested. Nothing below qualifies a live
behavior.

## Which ElevenLabs API

Use the **ElevenAgents native WebSocket**
([`/v1/convai/conversation`](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket)),
with an agent in Realtime voice mode and one **client tool**, connected from the
server.

- **Server-owned connection.** The server requests a
  [signed URL](https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get-signed-url)
  with its `xi-api-key` and opens the socket itself. The
  [WebSocket guide](https://elevenlabs.io/docs/eleven-agents/libraries/web-sockets)
  says never to expose the API key client-side. The browser keeps talking only
  to the host, as it does for the other two engines, so no credential reaches
  it.
- **Client tools keep execution in the host.** A `client_tool_call` carries a
  `tool_call_id`. The client answers with `client_tool_result` carrying the same
  `tool_call_id`, a `result` string and `is_error`. ElevenLabs runs nothing for a
  client tool. Webhook tools, MCP servers and system tools such as call transfer
  would let the provider act on its own, so the probe agent configures none of
  them.

**The standalone OpenAI-compatible Realtime endpoint was rejected**
([compatibility guide](https://elevenlabs.io/docs/eleven-agents/guides/openai-realtime-compatibility),
`wss://api.elevenlabs.io/v1/convai/realtime`):

- The guide covers only a browser holding a short-lived client secret. It says
  documentation for server-side OpenAI Realtime SDKs "isn't published yet". That
  is a documentation gap, not proof that a server relay fails. It still means a
  server relay would rest on undocumented behavior.
- It speaks OpenAI's *Realtime* protocol. Our GPT-Live adapter uses the
  different OpenAI Live v1 delegation protocol
  (`ENDPOINT`, `packages/ui-server/src/voice/gpt-live-conversation.ts:7`), so
  swapping the URL would not reuse that adapter.
- Its [session schema](https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/create-client-secret)
  accepts provider-called MCP tools (`server_label`, `server_url`), which the
  issue excludes.
- The guide documents no tool-call or execution-mode semantics. ElevenAgents
  settings such as `execution_mode` cannot be assumed to carry over.

## Model, availability and pricing

| Fact | Source and value |
| --- | --- |
| Model | `eleven_realtime_v1_max`, set as `conversation_config.realtime_model`. "Reasons before it responds, for complex instructions and multi-step tool use." Mini (`eleven_realtime_v1_mini`) is the default. [Realtime models](https://elevenlabs.io/docs/eleven-agents/customization/realtime-models), [models](https://elevenlabs.io/docs/overview/models). |
| Architecture | Cascaded: separate recognition, LLM and speech models, not one fused model ([compatibility guide FAQ](https://elevenlabs.io/docs/eleven-agents/guides/openai-realtime-compatibility)). The pricing page still labels both models "Speech to Speech". |
| Workspace rollout | "Rolling out gradually." An unavailable workspace gets the API error `Realtime models are not available for this workspace.` ([Realtime models](https://elevenlabs.io/docs/eleven-agents/customization/realtime-models)). **Unverified for any workspace.** |
| Residency and compliance | Max: US and EU, plus Zero Retention Mode/HIPAA in the US and EU. Not available in India or Singapore. Mini is not available under Zero Retention Mode. |
| Managed settings | In Realtime mode ElevenLabs picks the LLM, reasoning effort, parallel tool calls, cascade timeout, TTS model and recognition provider. Max needs a token limit of at least 1,024, or none. |
| Model fallback | If the Realtime model is late or fails, "the agent falls back to backup LLMs" ([LLM cascading](https://elevenlabs.io/docs/eleven-agents/customization/llm/llm-cascading)). The cascading guide calls the fallback "automatic and transparent to the end-user", and documents no socket event for it, so the model identity a session actually used is unproven. Whether `backup_llm_config: disabled` turns it off for a Realtime agent is undocumented. |
| Pricing basis | The standard ElevenAgents per-minute rate plus input, cached-input and output tokens at the model's rates ([Realtime models § Pricing](https://elevenlabs.io/docs/eleven-agents/customization/realtime-models#pricing)). |
| Listed rates | [API pricing](https://elevenlabs.io/pricing/api): connected audio $0.080 per additional minute for both models. Max tokens: $1.80 input and $9.00 output per 1M. Mini: $0.20 and $6.00. Burst audio above the concurrency limit costs $0.160 per minute. No cached-input rate is listed. Included plan minutes are labelled estimates. |
| Retention | Transcripts and audio recordings are kept for **2 years by default**. Retention is configurable per agent, and 0 schedules deletion ([retention](https://elevenlabs.io/docs/eleven-agents/customization/privacy/retention)). |

## The seam against the documented protocol

Field names come from the AsyncAPI schema in the
[WebSocket reference](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket)
and the [tool schema](https://elevenlabs.io/docs/eleven-agents/api-reference/tools/create).
"Documented" means the field exists, not that it behaves as described.

| Seam need | ElevenAgents evidence | Profile value it would support |
| --- | --- | --- |
| `ready` with formats | `conversation_initiation_metadata`: `conversation_id`, `agent_output_audio_format`, `user_input_audio_format`. No model field. | Model taken from configuration; actual model unproven because of the fallback. |
| Input transcript | `user_transcript`: `user_transcript` and `event_id` only. No finality, utterance identity, timing or origin. | `unassigned_input_fragment` with finalization unknown. `finalTranscript`: unsupported. |
| Manual endpoint | No client endpoint message. `user_activity` only holds off agent interruptions. | `manualEndpoint`: unsupported. |
| Output transcript and audio | `agent_response` (`response_id`, `event_id`), `agent_chat_response_part` deltas, and `audio` with `event_id`, an `is_final` last-chunk flag and optional character `alignment`. | `outputWordAlignment`: unproven, since alignment is optional. |
| Interruption | `interruption` (only `event_id`), then `agent_response_correction` with the truncated text. | Separate evidence of interruption and of truncation. `remoteOutputCancelAck`: unproven, because there is no client cancel or acknowledgement message. |
| Work request | `client_tool_call`: `tool_name`, `tool_call_id`, `parameters`, `expects_response`. | `work_requested` with `handle = tool_call_id`. The call is not tied to an utterance. |
| Exact result | `client_tool_result`: `tool_call_id` ("ID of the tool call this result corresponds to"), `result`, `is_error`. | `returnWork` keyed on the native handle. There is no acceptance acknowledgement, so `acceptance: "unknown"`. |
| Exact refusal | `client_tool_result` with `error_type: user_rejected`, which "mark[s] the tool as not having been called". | A candidate for `refuseContextualWork`. Unproven. |
| `quiet` or `when-idle` delivery | No delivery or scheduling control on `client_tool_result`. | Cannot honor `ConversationWorkResult.delivery` natively. |
| Withdrawal | No event withdraws a pending client tool call. | `work_withdrawn` is never emitted, and timeouts are undocumented (below). |
| Close | Closing the socket. No remote close acknowledgement is documented. | `closed` with `remote: "unknown"`. Billing counts connected audio, but the docs do not say when a closed session stops counting. |
| Permission speech | No host exact-copy speech path. | `exactPermissionSpeech`: unsupported. |

## The decisive question: nonblocking work with a late, exact result

The issue requires a held lookup to stay pending through three further spoken
exchanges, then return its exact result and have it spoken. The documentation
offers two client-tool behaviors, and each misses half of that:

- **`expects_response: true`:** "calling this tool should block the
  conversation until the client responds with some response which is passed to
  the llm" ([tool schema](https://elevenlabs.io/docs/eleven-agents/api-reference/tools/create)).
  The [client-tools guide](https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools)
  likewise says the agent "will wait for its response and append the response to
  the conversation context". That gives an exact result, but the dialogue blocks.
- **`execution_mode: async`:** "runs the tool in the background without blocking
  - best for long-running operations" (tool schema). ElevenLabs'
  [orchestration article](https://elevenlabs.io/blog/unpacking-elevenagents-orchestration-engine)
  describes Async Mode as for "fire-and-forget operations … where the agent does
  not need to reference the result in its reply". That keeps the dialogue going,
  but does not say a late result is used.

`response_timeout_secs` defaults to 20 and accepts 1 to 120, or -1 to "wait for
the client's response indefinitely (requires expects_response)". Four things are
undocumented, and only a live session can answer them:

1. Whether `execution_mode: async` together with `expects_response: true` is
   accepted, and whether the model keeps holding new spoken exchanges while the
   call is pending.
2. Whether a `client_tool_result` sent after those exchanges is accepted and
   added to the context, and whether it prompts a spoken reply or waits for the
   user to speak.
3. What a pending call does when its timeout expires, when the user interrupts,
   or when the socket closes. Any of these could leave a native handle pending
   with no event for it.
4. Whether a second or stale `client_tool_result` for the same ID is rejected,
   ignored or added to the context.

The fallbacks below would look like success, but none meets the requirement:

- **`contextual_update`** injects text "without interrupting", with no
  `tool_call_id`, so correlation would rest on our wording rather than on a
  native ID. Its `context_id` supersession "dropped from the LLM view" earlier
  updates, which rewrites provider-held history and conflicts with
  [append-only provider history](../decisions/provider-history.md).
- **`user_message`** would make up a user turn that the user never spoke.
- **Filler speech, `pre_tool_speech` and tool-call sounds** cover waiting time.
  They are not continued dialogue.

## Provider-side configuration and disclosure

Unlike the other two engines, an ElevenAgents session runs an **agent stored in
the vendor workspace**: its prompt, voice, tools and retention live there, and
`conversation_initiation_client_data` can override some of them per
conversation. Before any production work, three things need checks and,
probably, rulings:

- Brain must own the agent definition and verify at session start that only the
  one client tool is configured. A webhook, MCP or system tool added in the
  dashboard would bypass host authority.
- The disclosure must state the 2-year default retention of transcripts and
  audio, and the per-agent setting it depends on. Zero Retention Mode is
  available for Max in the US and EU only.
- Opening an epoch with prior chat history needs a mechanism that keeps
  provider history append-only. The documented options are prompt and
  first-message overrides at initiation, plus `contextual_update` without a
  `context_id`. None was evaluated against the startup-context bounds in the
  live-conversation decision.

## The live probe, prepared but not run

The probe is outside the ordinary test suite. It needs a maintainer to supply,
through a protected channel:

- confirmation that the workspace exposes Realtime voice mode, with US or EU
  residency;
- an API key restricted to ElevenAgents;
- explicit approval of the caps below.

**Recommended caps:** Max only. At most 12 sessions, 5 minutes each and 45
connected minutes in total, and a **US$10 spend limit** across connected audio
and tokens. Connected audio alone at the listed $0.080 per minute is $3.60 for
45 minutes, which leaves the rest for Max tokens. Mini is used only if Max fails
a functional step that Mini could plausibly resolve.

**Setup:** one temporary agent with retention set to 0, Realtime voice mode on
`eleven_realtime_v1_max`, the backup LLM disabled if the API accepts that for
a Realtime agent, and one client tool `lookup_ledger(query)` with
`expects_response: true`. The tool runs under each `execution_mode` and with
`response_timeout_secs` of 120 and of -1. The fictional lookup is held by the
host and released on command. It returns one Odysseus fact on the pinned
`2026-07-12` date, for example how many oarsmen are rostered on the Ithaca
ship's ledger.

**Steps, one per acceptance criterion:**

1. Record the workspace error or success, the model the configuration set, the
   residency host and the caps before speaking.
2. Stream server-side audio both ways. Record every `user_transcript` and
   `agent_response`, plus the absence of finality fields.
3. Start the held lookup, complete three further spoken exchanges, release it,
   send `client_tool_result` with the exact `tool_call_id`, and check whether a
   later spoken reply contains the fact. Record local send separately from
   provider acceptance, which is unknown.
4. Exercise these controls: release early, send a mismatched `tool_call_id`, send
   a duplicate result, deliver a result after the socket is replaced, refuse
   with `user_rejected`, interrupt during the pending call, let the timeout
   expire, and close with a call pending.
5. Clean up: close the socket, delete the probe conversations, the tool and the
   agent through the
   [conversation](https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/delete),
   [tool](https://elevenlabs.io/docs/eleven-agents/api-reference/tools/delete) and
   [agent](https://elevenlabs.io/docs/eleven-agents/api-reference/agents/delete)
   delete endpoints, and record the billed usage.

Keep only sanitized event metadata: types, IDs hashed per probe, timing and
first-failure captures. A listener confirms any claim that the fact was spoken.

**Reading the result:** if step 3 succeeds under any configuration and step 4
leaves no pending handle and no stale narration, Eleven Realtime is suitable for
a scheduled adapter. If a late result is refused, ignored or never spoken, it is
unsuitable for the contextual-task path. That holds whatever its other
qualities, and the requirement is not weakened to fit.

## Keyless preparation still open

The issue also asks for an evaluation-only adapter on the existing seam and
deterministic tests with a bounded delayed-task fixture. The tests would release
early, mismatch the native ID and deliver a stale result across epochs. None of
that is built. The mapping table above is its specification. Building it before
the probe would mean writing an adapter for behavior that may not exist, so the
probe goes first. If step 3 succeeds, the adapter and its failing-first tests are
the next unit. No contract, capability or schema change is proposed here.
