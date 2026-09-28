/**
 * The `show_block` schema's tone lists are the kit's unions, in both
 * directions (D41 §4). The kit exports types and the schema needs runtime
 * lists, so a member added to one and not the other would otherwise drift
 * silently: the schema would admit a colour the kit cannot draw, or the kit
 * would grow a tone the model is never offered. `BlockCard` is typed by the
 * payload, which catches the field shapes; this file catches the enums.
 */

import type {
  ContactKind,
  ContactTone,
  DeltaTone,
  QuoteTone,
  StepListVariant,
  StepState,
  SuggestionChipsProps,
  SuggestionItem,
  Tone,
  ValueTone,
} from "@schlessera/brain-ui-kit";
import type {
  BLOCK_CONTACT_KINDS,
  BLOCK_CONTACT_TONES,
  BLOCK_DELTA_TONES,
  BLOCK_QUOTE_TONES,
  BLOCK_STEP_STATES,
  BLOCK_STEP_VARIANTS,
  BLOCK_TONES,
  BLOCK_VALUE_TONES,
  Block,
} from "@schlessera/brain-ui-sdk/client";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Assert<T extends true> = T;

type Member<L extends readonly string[]> = L[number];

type TonesMatch = Assert<Equal<Member<typeof BLOCK_TONES>, Tone>>;
type ValueTonesMatch = Assert<Equal<Member<typeof BLOCK_VALUE_TONES>, ValueTone>>;
type DeltaTonesMatch = Assert<Equal<Member<typeof BLOCK_DELTA_TONES>, DeltaTone>>;
type StepVariantsMatch = Assert<Equal<Member<typeof BLOCK_STEP_VARIANTS>, StepListVariant>>;
type StepStatesMatch = Assert<Equal<Member<typeof BLOCK_STEP_STATES>, StepState>>;
type QuoteTonesMatch = Assert<Equal<Member<typeof BLOCK_QUOTE_TONES>, QuoteTone>>;
type ContactKindsMatch = Assert<Equal<Member<typeof BLOCK_CONTACT_KINDS>, ContactKind>>;
type ContactTonesMatch = Assert<Equal<Member<typeof BLOCK_CONTACT_TONES>, ContactTone>>;

/*
 * `suggestions` (#40, D48) is the one block not drawn by the kit component it
 * mirrors — the app's closing row draws it — so `BlockCard`'s typing cannot
 * catch a drift. Its payload is the DATA projection of `SuggestionChips`: the
 * item carries every `SuggestionItem` field except `onClick` (a callback) and
 * `tone` (a suggestion never carries an effect, so it is never amber), and the
 * block carries the row's `label`. Keys equal in both directions, so a field
 * added to the kit fails here until it is carried or excluded by name.
 */
type SuggestionsBlock = Extract<Block, { kind: "suggestions" }>;
type SuggestionItemKeysMatch = Assert<
  Equal<keyof SuggestionsBlock["items"][number], keyof Omit<SuggestionItem, "onClick" | "tone">>
>;
type SuggestionRowKeysMatch = Assert<
  Equal<Exclude<keyof SuggestionsBlock, "kind" | "items">, keyof Pick<SuggestionChipsProps, "label">>
>;
// The label is the prompt itself, so the kit's string is the payload's string.
type SuggestionLabelMatches = Assert<Equal<SuggestionsBlock["items"][number]["label"], SuggestionItem["label"]>>;

export type {
  SuggestionItemKeysMatch,
  SuggestionRowKeysMatch,
  SuggestionLabelMatches,
  TonesMatch,
  ValueTonesMatch,
  DeltaTonesMatch,
  StepVariantsMatch,
  StepStatesMatch,
  QuoteTonesMatch,
  ContactKindsMatch,
  ContactTonesMatch,
};
