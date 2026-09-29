import { Callout } from "@schlessera/brain-ui-kit";
import type { LocalExchangeState } from "../../stores/chat-state.js";

/**
 * Says so when a locally answered command is not part of its session (#582).
 * Every other state draws nothing: a kept answer looks like any other, and a
 * draft's is sent with the message that starts the conversation.
 */
export function LocalExchangeNote({ exchange }: { exchange: LocalExchangeState }) {
  if (exchange.saved !== "unsaved") return null;
  return (
    <div data-local-exchange-unsaved="">
      <Callout tone="gold" variant="plain">
        <strong>Not saved to this conversation.</strong>{" "}
        {exchange.reason ? `${exchange.reason} ` : ""}The agent will not see these figures, and a
        reload will not show them.
      </Callout>
    </div>
  );
}
