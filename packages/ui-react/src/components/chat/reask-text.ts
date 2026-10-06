/**
 * The ordinary message that carries a rank or form answer when it can no
 * longer answer its question: a reopened card's reask, and `Copy answer` /
 * `Send as message` on a closed or expired one (#910).
 */
import type { AskUserFormSpec, AskUserRankSpec } from "@schlessera/brain-ui-sdk/protocol";

export function rankReaskMessage(rank: Pick<AskUserRankSpec, "prompt" | "items" | "cutoff">, order: string[]): string {
  const labels = new Map(rank.items.map((item) => [item.id, item.label]));
  return [
    `Answering “${rank.prompt}”:`,
    ...order.map((id, index) => `${index + 1}. ${labels.get(id)}`),
    ...(rank.cutoff ? [`Only the top ${rank.cutoff} matter.`] : []),
  ].join("\n");
}

export function formReaskMessage(form: Pick<AskUserFormSpec, "prompt">, result: unknown): string {
  return `Answering “${form.prompt}”: ${JSON.stringify(result)}`;
}
