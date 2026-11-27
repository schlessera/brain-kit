// The host Gmail read tools (#4207), rendered as the ui-kit Gmail components
// (#4210, components #4209).
//
// GLOBAL like the GitHub tools: every backend exposes the same contracts
// under its own spelling, so each renderer is registered under the Pi name
// and the Claude bridge name. A refusal is part of the result schema, so it
// reaches the card and is drawn in the result's own words. Output that is not
// a result envelope (an exception's message, or a result the history
// transport cut) and the results no kit component draws yet (a draft, the
// account's label list) reach the fallback, which is safe for text a
// stranger wrote.
//
// The four write tools are not bound here: they answer `unavailable` until
// the write engine lands (#4211), and their cards are #4216's.

import { useMemo } from "react";
import { parseToolPayload, visibleToolName, type RendererPack, type ToolCallView, type ToolRenderer } from "@schlessera/brain-ui-sdk/client";
import { revealInvisibles } from "@schlessera/brain-ui-kit";
import {
  GMAIL_READ_CONTRACT,
  GMAIL_SEARCH_CONTRACT,
  GMAIL_TOOL_NAMES,
  GOOGLE_RESULT_SCHEMAS,
  type GoogleToolResult,
} from "@schlessera/brain-ui-sdk/tool-contracts";
import { Mail, MailSearch } from "lucide-react";
import { ClampedPre } from "../tool-views.js";
import { GmailReadCard, GmailSearchCard } from "../tool-cards/gmail-cards.js";
import { boundToolNames } from "./bind.js";
import { gmailRowMeta } from "./gmail-mapping.js";

/** Each contract with its result envelope as the payload, as `bind()` parses it. */
const SEARCH = { ...GMAIL_SEARCH_CONTRACT, payload: GOOGLE_RESULT_SCHEMAS[GMAIL_TOOL_NAMES.search] };
const READ = { ...GMAIL_READ_CONTRACT, payload: GOOGLE_RESULT_SCHEMAS[GMAIL_TOOL_NAMES.read] };

/**
 * Output that is not a result envelope, or a result no kit component draws:
 * the words as they came, which may be a sender's. Hidden characters show as
 * their markers, as the kit shows them, and no path in the text becomes a
 * link: a sender's `knowledge/…` is not a file the agent named.
 */
function Fallback({ tool }: { tool: ToolCallView }) {
  const text = useMemo(() => (tool.output ? revealInvisibles(tool.output) : ""), [tool.output]);
  return text ? <ClampedPre text={text} isError={tool.isError} linkify={false} /> : null;
}

const searchResult = (tool: ToolCallView): GoogleToolResult | null => parseToolPayload(SEARCH, tool.output);
const readResult = (tool: ToolCallView): GoogleToolResult | null => parseToolPayload(READ, tool.output);

/** The query as the call sent it: the search page does not carry one. */
function queryOf(tool: ToolCallView): string | null {
  const query = tool.input?.query;
  return typeof query === "string" && query !== "" ? query : null;
}

function SearchOutput({ tool }: { tool: ToolCallView }) {
  const result = searchResult(tool);
  return result ? <GmailSearchCard result={result} query={queryOf(tool)} /> : <Fallback tool={tool} />;
}

function ReadOutput({ tool }: { tool: ToolCallView }) {
  const result = readResult(tool);
  return result ? <GmailReadCard result={result} fallback={<Fallback tool={tool} />} /> : <Fallback tool={tool} />;
}

/** "thread · 5 messages", "message", "draft", "12 labels": what was read, never a word a sender wrote. */
function readSummary(result: GoogleToolResult | null): string | null {
  if (!result?.ok || result.tool !== GMAIL_TOOL_NAMES.read) return null;
  const read = result.result;
  if (read.kind === "thread") return `thread · ${read.messages.length} ${read.messages.length === 1 ? "message" : "messages"}`;
  if (read.kind === "labels") return `${read.labels.length} ${read.labels.length === 1 ? "label" : "labels"}`;
  return read.kind;
}

/**
 * The spellings `bind()` registers that can name a Gmail call: the Pi name and
 * the Claude bridge name, with the row's summary and meta read from the call
 * itself (the effect class is known before any result arrives, and the search
 * query comes from the call's input). The pre-rename `mcp__brain_ui__`
 * spelling is left to the generic renderer: it predates the Gmail tools, so
 * no Gmail call was ever recorded under it, and the detail route accepts only
 * these two names (`READ_TOOL`, `packages/ui-server/src/routes/google-details.ts:32`),
 * so a card under it would offer a rest the route always refuses.
 */
const everySpelling = (contract: typeof SEARCH | typeof READ, renderer: Omit<ToolRenderer, "match">): ToolRenderer[] => {
  const routed = new Set([visibleToolName(contract.name, "pi"), visibleToolName(contract.name, "claude")]);
  return boundToolNames(contract).filter((name) => routed.has(name)).map((match) => ({ match, ...renderer }));
};

export const gmailToolPack: RendererPack = {
  renderers: [
    ...everySpelling(SEARCH, {
      icon: MailSearch,
      label: "Gmail search",
      // The query is model-written: its hidden characters show as markers, as the kit shows them.
      summary: (tool) => {
        const query = queryOf(tool);
        return query === null ? null : `“${revealInvisibles(query)}”`;
      },
      meta: (tool) => gmailRowMeta(searchResult(tool)),
      Output: SearchOutput,
    }),
    ...everySpelling(READ, {
      icon: Mail,
      label: "Gmail",
      summary: (tool) => readSummary(readResult(tool)),
      meta: (tool) => gmailRowMeta(readResult(tool)),
      Output: ReadOutput,
    }),
  ],
};
