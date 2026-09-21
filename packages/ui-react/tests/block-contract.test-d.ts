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

export type {
  TonesMatch,
  ValueTonesMatch,
  DeltaTonesMatch,
  StepVariantsMatch,
  StepStatesMatch,
  QuoteTonesMatch,
  ContactKindsMatch,
  ContactTonesMatch,
};
