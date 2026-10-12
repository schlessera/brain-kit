/**
 * The open conversation's side of link promotion (#1698): the host saved the
 * turn's answer linking promoted copies, and says which destinations changed
 * (`message_links`). The streamed text is rewritten with the function the
 * backend used, so it comes out as the saved text, and the classified blocks
 * anchored to the streamed text follow it.
 */
import { rewriteLinkDestinationsWithEdits } from "@schlessera/brain-ui-sdk/internal/client";
export { rebaseMessageBlocks as rebaseBlocks } from "@schlessera/brain-ui-sdk/internal/client";

/** Each streamed text rewritten with every link the host has named so far. */
export function rewriteTexts(texts: readonly string[], links: Readonly<Record<string, string>>) {
  const map = new Map(Object.entries(links));
  return texts.map((text) => rewriteLinkDestinationsWithEdits(text, (destination) => map.get(destination) ?? destination));
}
