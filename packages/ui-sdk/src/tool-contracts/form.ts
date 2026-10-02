import { z } from "zod";
import { defineToolComponentContract } from "./contract.js";

/** Host-owned limits; roots count as depth one. */
export interface AskUserFormLimits {
  maxDepth: number;
  maxNodes: number;
  maxOptions: number;
}
export const ASK_USER_FORM_DEFAULT_LIMITS: Readonly<AskUserFormLimits> =
  Object.freeze({ maxDepth: 3, maxNodes: 12, maxOptions: 8 });
const limitsSchema = z.object({
  maxDepth: z.number().int().positive().safe(),
  maxNodes: z.number().int().positive().safe(),
  maxOptions: z.number().int().min(2).safe(),
});
export function resolveAskUserFormLimits(
  overrides: Partial<AskUserFormLimits> = {},
): AskUserFormLimits {
  return limitsSchema.parse({ ...ASK_USER_FORM_DEFAULT_LIMITS, ...overrides });
}
const option = z.object({
  label: z.string().min(1).max(40),
  description: z.string().max(120).optional(),
  preview: z.string().max(4000).optional(),
});
const item = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  detail: z.string().max(200).optional(),
  link: z.string().max(2000).optional(),
});
const common = {
  id: z.string().min(1).max(64),
  prompt: z.string().min(1).max(300),
  header: z.string().min(1).max(12).optional(),
  required: z
    .boolean()
    .optional()
    .describe("Default true. Only visible required nodes must be completed."),
  showIf: z
    .object({
      node: z.string().min(1).max(64),
      anyOf: z.array(z.string().min(1).max(40)).min(1),
    })
    .optional()
    .describe(
      "An earlier single/multi node. Match selected option labels; Other never reveals branches.",
    ),
};
export const ASK_USER_FORM_NODE_SCHEMA = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("single"),
    options: z.array(option).min(2),
  }),
  z.object({
    ...common,
    kind: z.literal("multi"),
    options: z.array(option).min(2),
  }),
  z.object({
    ...common,
    kind: z.literal("scale"),
    scale: z.array(option).min(2).max(8),
    items: z.array(item).min(1).max(30),
    notes: z.boolean().optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("rank"),
    items: z.array(item).min(2).max(15),
    cutoff: z.number().int().min(1).max(15).optional(),
  }),
  z.object({ ...common, kind: z.literal("text") }),
]);
export const ASK_USER_FORM_INPUT_SCHEMA = z.object({
  prompt: z.string().min(1).max(300),
  nodes: z.array(ASK_USER_FORM_NODE_SCHEMA).min(1),
});
export type AskUserFormNode = z.infer<typeof ASK_USER_FORM_NODE_SCHEMA>;
export type AskUserFormInput = z.infer<typeof ASK_USER_FORM_INPUT_SCHEMA>;
export type AskUserFormSpec = AskUserFormInput;
export interface AskUserFormSingleAnswer {
  value: string;
  other?: boolean;
}
export interface AskUserFormMultiAnswer {
  values: string[];
  other?: string;
}
export interface AskUserFormScaleAnswer {
  answers: Record<string, string>;
  skipped: string[];
  notes?: Record<string, string>;
}
export interface AskUserFormRankAnswer {
  order: string[];
  unchanged: boolean;
}
export type AskUserFormAnswer =
  | AskUserFormSingleAnswer
  | AskUserFormMultiAnswer
  | AskUserFormScaleAnswer
  | AskUserFormRankAnswer
  | string;
export type AskUserFormAnswers = Record<string, AskUserFormAnswer>;
export interface AskUserFormPayload {
  answers: AskUserFormAnswers;
  visibleNodes: string[];
}
export const ASK_USER_FORM_ANSWER_SCHEMA = z.union([
  z.object({ value: z.string().max(4000), other: z.boolean().optional() }),
  z.object({
    values: z.array(z.string().max(40)),
    other: z.string().max(4000).optional(),
  }),
  z.object({
    answers: z.record(z.string(), z.string().max(40)),
    skipped: z.array(z.string()),
    notes: z.record(z.string(), z.string().max(280)).optional(),
  }),
  z.object({ order: z.array(z.string()), unchanged: z.boolean() }),
  z.string().max(280),
]);
export const ASK_USER_FORM_PAYLOAD_SCHEMA = z.looseObject({
  answers: z.record(z.string(), ASK_USER_FORM_ANSWER_SCHEMA),
  visibleNodes: z.array(z.string()),
}) satisfies z.ZodType<AskUserFormPayload>;
export const ASK_USER_FORM_TOOL_NAME = "ask_user_form";
export const ASK_USER_FORM_DESCRIPTION =
  "Ask related conditional questions in one editable card. Supply a flat nodes list of single, multi, scale, rank or short text questions. showIf references only an earlier single/multi node and matches its offered option labels. Hidden answers never appear in the result; visibleNodes distinguishes skipped from hidden. Host defaults: depth 3, 12 nodes, 8 options (configurable). Scale: 1-30 items, 2-8 options; rank: 2-15 items. For independent questions use ask_user; for one list use ask_user_list or ask_user_rank. Never use this for permission prompts.";
export const ASK_USER_FORM_CONTRACT = defineToolComponentContract({
  name: ASK_USER_FORM_TOOL_NAME,
  description: ASK_USER_FORM_DESCRIPTION,
  input: ASK_USER_FORM_INPUT_SCHEMA,
  payload: ASK_USER_FORM_PAYLOAD_SCHEMA,
  brief: (name) =>
    `- **Conditional questions belong in one card.** Call \`${name}\` with flat nodes and earlier-node showIf conditions; act only on its returned visible answers.`,
});

/** Validate the whole request before the host opens a card. */
export function askUserFormSpec(
  input: AskUserFormInput,
  overrides: Partial<AskUserFormLimits> = {},
): AskUserFormSpec {
  const limits = resolveAskUserFormLimits(overrides);
  const spec = ASK_USER_FORM_INPUT_SCHEMA.parse(input);
  if (spec.nodes.length > limits.maxNodes)
    throw new Error(`ask_user_form: maxNodes is ${limits.maxNodes}.`);
  const earlier = new Map<string, AskUserFormNode>();
  const depths = new Map<string, number>();
  for (const node of spec.nodes) {
    if (earlier.has(node.id))
      throw new Error("ask_user_form: node ids must be unique.");
    const options =
      node.kind === "single" || node.kind === "multi"
        ? node.options
        : node.kind === "scale"
          ? node.scale
          : [];
    if (options.length > limits.maxOptions)
      throw new Error(`ask_user_form: maxOptions is ${limits.maxOptions}.`);
    if (new Set(options.map((o) => o.label)).size !== options.length)
      throw new Error("ask_user_form: option labels must be unique.");
    if (node.kind === "single" || node.kind === "multi") {
      if (options.some((o) => o.label.toLowerCase() === "other"))
        throw new Error(
          "ask_user_form: Other is supplied by the UI, not an offered option.",
        );
    }
    if (node.kind === "scale" || node.kind === "rank") {
      if (new Set(node.items.map((i) => i.id)).size !== node.items.length)
        throw new Error("ask_user_form: item ids must be unique.");
      if (
        node.kind === "rank" &&
        node.cutoff !== undefined &&
        node.cutoff > node.items.length
      )
        throw new Error("ask_user_form: cutoff cannot exceed the item count.");
    }
    let depth = 1;
    if (node.showIf) {
      const parent = earlier.get(node.showIf.node);
      if (!parent)
        throw new Error(
          "ask_user_form: showIf must reference an earlier node.",
        );
      if (parent.kind !== "single" && parent.kind !== "multi")
        throw new Error("ask_user_form: showIf parent must be single/multi.");
      if (
        node.showIf.anyOf.some(
          (label) => !parent.options.some((option) => option.label === label),
        )
      )
        throw new Error(
          "ask_user_form: showIf must name an offered option; Other cannot reveal a branch.",
        );
      depth = depths.get(parent.id)! + 1;
    }
    if (depth > limits.maxDepth)
      throw new Error(`ask_user_form: maxDepth is ${limits.maxDepth}.`);
    earlier.set(node.id, node);
    depths.set(node.id, depth);
  }
  return spec;
}
/** Visible ids in input order, including unanswered optional nodes. */
export function askUserFormVisibleNodes(
  spec: AskUserFormSpec,
  answers: AskUserFormAnswers,
): string[] {
  const visible = new Set<string>();
  const nodes = new Map(spec.nodes.map((node) => [node.id, node]));
  for (const node of spec.nodes) {
    if (!node.showIf) {
      visible.add(node.id);
      continue;
    }
    const parent = nodes.get(node.showIf.node);
    if (!parent || !visible.has(parent.id)) continue;
    const answer = Object.hasOwn(answers, parent.id)
      ? answers[parent.id]
      : undefined;
    if (!answer || typeof answer === "string") continue;
    const selected =
      parent.kind === "single" && "value" in answer && !answer.other
        ? [answer.value]
        : parent.kind === "multi" && "values" in answer
          ? answer.values
          : [];
    if (node.showIf.anyOf.some((label) => selected.includes(label)))
      visible.add(node.id);
  }
  return [...visible];
}

/** Canonical value, or absent for an empty choice/text. Hidden values are never inspected. */
function normalizedAnswer(
  node: AskUserFormNode,
  raw: AskUserFormAnswer | undefined,
): AskUserFormAnswer | undefined {
  if (raw === undefined) {
    // Keeping the suggested order is an explicit valid submission without moves.
    return node.kind === "rank"
      ? { order: node.items.map((item) => item.id), unchanged: true }
      : undefined;
  }
  const shapeIndex = { single: 0, multi: 1, scale: 2, rank: 3, text: 4 }[
    node.kind
  ];
  const answer = ASK_USER_FORM_ANSWER_SCHEMA.options[shapeIndex]!.parse(raw);
  const invalid = () => {
    throw new Error(`ask_user_form: invalid answer for ${node.id}.`);
  };
  if (node.kind === "text")
    return typeof answer === "string" ? answer.trim() || undefined : invalid();
  if (typeof answer === "string") return invalid();
  if (node.kind === "single") {
    if (!("value" in answer)) return invalid();
    const value = answer.value.trim();
    if (!value) return undefined;
    if (answer.other) return { value, other: true };
    if (!node.options.some((option) => option.label === answer.value))
      return invalid();
    return { value: answer.value };
  }
  if (node.kind === "multi") {
    if (
      !("values" in answer) ||
      new Set(answer.values).size !== answer.values.length ||
      answer.values.some(
        (value) => !node.options.some((option) => option.label === value),
      )
    )
      return invalid();
    const other = answer.other?.trim();
    return answer.values.length || other
      ? { values: [...answer.values], ...(other ? { other } : {}) }
      : undefined;
  }
  if (node.kind === "rank") {
    if (!("order" in answer)) return invalid();
    const initial = node.items.map((item) => item.id);
    if (
      answer.order.length !== initial.length ||
      new Set(answer.order).size !== initial.length ||
      answer.order.some((id) => !initial.includes(id))
    )
      return invalid();
    return {
      order: [...answer.order],
      unchanged: initial.every((id, i) => answer.order[i] === id),
    };
  }
  if (!("answers" in answer)) return invalid();
  const pairs: [string, string][] = [],
    notes: [string, string][] = [],
    skipped: string[] = [];
  for (const item of node.items) {
    const value = Object.hasOwn(answer.answers, item.id)
      ? answer.answers[item.id]
      : undefined;
    if (
      value !== undefined &&
      node.scale.some((option) => option.label === value)
    )
      pairs.push([item.id, value]);
    else skipped.push(item.id);
    const note =
      node.notes && answer.notes && Object.hasOwn(answer.notes, item.id)
        ? answer.notes[item.id]?.trim().slice(0, 280)
        : undefined;
    if (note) notes.push([item.id, note]);
  }
  return {
    answers: Object.fromEntries(pairs),
    skipped,
    ...(notes.length ? { notes: Object.fromEntries(notes) } : {}),
  };
}
/** Required scale nodes need every row; optional nodes may be left blank or partial. */
export function askUserFormNodeComplete(
  node: AskUserFormNode,
  answer: AskUserFormAnswer | undefined,
): boolean {
  try {
    const value = normalizedAnswer(node, answer);
    return (
      value !== undefined &&
      (node.kind !== "scale" ||
        (typeof value !== "string" &&
          "skipped" in value &&
          value.skipped.length === 0))
    );
  } catch {
    return false;
  }
}
/** Recompute visibility at the trust boundary; never trust client visible ids or unchanged. */
export function askUserFormPayload(
  spec: AskUserFormSpec,
  result: Pick<AskUserFormPayload, "answers">,
): AskUserFormPayload {
  const visibleNodes = askUserFormVisibleNodes(spec, result.answers);
  const visible = new Set(visibleNodes);
  const pairs: [string, AskUserFormAnswer][] = [];
  for (const node of spec.nodes) {
    if (!visible.has(node.id)) continue;
    const raw = Object.hasOwn(result.answers, node.id)
      ? result.answers[node.id]
      : undefined;
    const value = normalizedAnswer(node, raw);
    if (node.required !== false && !askUserFormNodeComplete(node, value))
      throw new Error(`ask_user_form: required answer missing for ${node.id}.`);
    if (value !== undefined) pairs.push([node.id, value]);
  }
  return { answers: Object.fromEntries(pairs), visibleNodes };
}
