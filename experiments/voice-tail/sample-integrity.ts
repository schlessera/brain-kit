/** Evaluation fixture analyzer: compare every sample, including both silence edges.
 * The caller supplies the actual scheduled frame offset; no alignment search,
 * normalization, trimming or tolerance for missing/repeated PCM is performed.
 */
export function compareScheduledSamples(actual: Float32Array, expected: Float32Array, start: number) {
  if (!Number.isSafeInteger(start) || start < 0 || start + expected.length > actual.length) throw new Error("Scheduled signal is outside the captured interval");
  let mismatches = 0, firstMismatch = -1, maxError = 0;
  for (let i = 0; i < actual.length; i++) {
    const wanted = i >= start && i < start + expected.length ? expected[i - start]! : 0;
    const error = Math.abs(actual[i]! - wanted);
    if (!Number.isFinite(error) || error !== 0) {
      mismatches++; if (firstMismatch < 0) firstMismatch = i;
      maxError = Math.max(maxError, error);
    }
  }
  return { compared: actual.length, mismatches, firstMismatch, maxError, startupSamples: start, finishSamples: actual.length - start - expected.length };
}
