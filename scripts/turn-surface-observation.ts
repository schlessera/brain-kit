/** Runtime observations, independent of the router's predicted choices. */
import { BRIDGE_TOOL_CONTRACTS } from "@schlessera/brain-ui-sdk/server";

export interface ObservedCall { id: string; name: string; input: Record<string, unknown>; accepted: boolean; skill: string | null }
export interface RoundTripUsage {
  id: string; model: string; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number;
  cacheCreation: Record<string, unknown> | null;
}
function tokens(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }

export class TurnObservation {
  readonly calls = new Map<string, ObservedCall>();
  readonly roundTrips = new Map<string, RoundTripUsage>();
  readonly answerParts = new Map<string, string>();
  firstFrameMs: number | null = null;
  firstTextMs: number | null = null;
  completed = false;
  observationError: string | null = null;
  constructor(private readonly started: number, private readonly model: string) {}

  observe(value: unknown, now = performance.now()): void {
    const frame = object(value);
    if (!frame) return;
    if (frame.type === "result") {
      this.completed = frame.subtype === "success";
      return;
    }
    if (frame.type === "stream_event" && frame.parent_tool_use_id === null) {
      const event = object(frame.event);
      if (this.firstFrameMs === null) this.firstFrameMs = now - this.started;
      if (event?.type === "content_block_delta" && object(event.delta)?.type === "text_delta" && this.firstTextMs === null) {
        this.firstTextMs = now - this.started;
      }
    }
    if (frame.type === "assistant" && frame.parent_tool_use_id === null) {
      const message = object(frame.message);
      const usage = object(message?.usage);
      if (typeof message?.id !== "string" || message.model !== this.model || !usage) {
        this.observationError = "Missing assistant usage or unexpected model";
        return;
      }
      const input = tokens(usage.input_tokens), output = tokens(usage.output_tokens);
      const read = tokens(usage.cache_read_input_tokens ?? 0), write = tokens(usage.cache_creation_input_tokens ?? 0);
      if (input === null || output === null || read === null || write === null) {
        this.observationError = "Invalid assistant token usage";
        return;
      }
      this.roundTrips.set(message.id, { id: message.id, model: this.model, inputTokens: input, outputTokens: output,
        cacheReadTokens: read, cacheWriteTokens: write, cacheCreation: object(usage.cache_creation) });
      if (this.firstFrameMs === null) this.firstFrameMs = now - this.started;
      if (!Array.isArray(message.content)) return;
      this.answerParts.set(message.id, message.content.flatMap(raw => {
        const block = object(raw);
        return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
      }).join("\n"));
      for (const raw of message.content) {
        const content = object(raw);
        if (content?.type !== "tool_use" || typeof content.id !== "string" || typeof content.name !== "string") continue;
        const input = object(content.input);
        if (!input) continue;
        this.calls.set(content.id, { id: content.id, name: content.name, input, accepted: false,
          skill: content.name === "Skill" && typeof input.skill === "string" ? input.skill : null });
      }
    }
    // A parsed assistant request alone does not prove execution. Match the
    // actual tool result to its original id and count only successful results.
    if (frame.type === "user" && (frame.parent_tool_use_id === null || frame.parent_tool_use_id === undefined)) {
      const message = object(frame.message);
      if (!Array.isArray(message?.content)) return;
      for (const raw of message.content) {
        const result = object(raw);
        if (result?.type !== "tool_result" || typeof result.tool_use_id !== "string") continue;
        const call = this.calls.get(result.tool_use_id);
        if (!call || result.is_error === true) continue;
        const contract = BRIDGE_TOOL_CONTRACTS.find(tool => `mcp__brain-ui__${tool.name}` === call.name);
        call.accepted = !contract || contract.input.safeParse(call.input).success;
      }
    }
  }

  score(golden: { neededToolGroups: readonly (readonly string[])[]; neededSkill: string | null;
    contentChecks?: { scope: string; patterns: readonly string[] } }) {
    if (!this.completed) return { included: false, neededToolsHit: null, neededSkillHit: null, wrongSkill: null, needlessSkill: null, needlessTool: null };
    const accepted = [...this.calls.values()].filter(call => call.accepted);
    const skills = accepted.flatMap(call => call.skill ? [call.skill] : []);
    const observedTools = accepted.filter(call => call.name !== "Skill" && call.name !== "ToolSearch").map(call => call.name);
    return {
      included: true,
      neededToolsHit: golden.neededToolGroups.length ? golden.neededToolGroups.every(group => group.some(name => observedTools.includes(name))) : null,
      neededSkillHit: golden.neededSkill ? skills.includes(golden.neededSkill) : null,
      wrongSkill: golden.neededSkill ? skills.some(name => name !== golden.neededSkill) : null,
      needlessSkill: golden.neededSkill === null ? skills.length > 0 : null,
      needlessTool: !golden.neededSkill && !golden.neededToolGroups.length ? observedTools.length > 0 : null,
      contentPass: golden.contentChecks ? golden.contentChecks.patterns.every(pattern => new RegExp(pattern, "is").test(
        golden.contentChecks!.scope === "acceptedInputs" ? JSON.stringify(accepted.map(call => call.input))
          : [...this.answerParts.values()].join("\n"))) : null,
    };
  }
}
