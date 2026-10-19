/** Retain partial fixture output without changing its decoded final bytes. */
import { writeFileSync } from "node:fs";
export async function retainFixtureStream(stream: ReadableStream<Uint8Array>, path: string): Promise<{ text: string; failure?: { error: unknown } }> {
  const decoder = new TextDecoder(); let text = "", failure: { error: unknown } | undefined;
  const retain = () => { try { writeFileSync(path, text); } catch (error) { failure ??= { error }; } };
  retain();
  for await (const chunk of stream) { text += decoder.decode(chunk, { stream: true }); retain(); }
  text += decoder.decode(); retain();
  // The owner observes write failure only after joining child exit and both
  // streams, just as its previous final artifact write did.
  return { text, ...(failure ? { failure } : {}) };
}
