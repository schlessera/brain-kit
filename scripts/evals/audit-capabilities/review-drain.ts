/** Do not finish a review while an owned native process still holds its pipes. */
export async function drainReviewChild(child: { kill(signal: "SIGKILL"): boolean }, closed: Promise<void>, graceMs = 5_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([closed.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), graceMs); })]);
  clearTimeout(timer);
  if (drained) return { forcedKill: false };
  child.kill("SIGKILL");
  await closed; // True close includes native stdout EOF / decoder flush.
  return { forcedKill: true };
}
