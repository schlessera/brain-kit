/** Fixture-only SDK stderr evidence, including failures before workerStarted. */
import { nativeReceipt } from "../../../../scripts/native-test-receipts";
import { nativeTestHead, redactNativeDiagnosticAssignments, redactNativeDiagnosticMessage } from "../../../../scripts/test-native-guard";
import { createRedactor } from "../../../compute-boat/src/redact";
import { redactCredentials } from "../../../ui-server/src/activity/runtime-status";

export const SDK_STDERR_WINDOW_BYTES = 16 * 1024;
export function captureNativeSdkStderr(secrets: readonly string[]) {
  const redactor = createRedactor(undefined);
  for (const secret of secrets) redactor.add(secret);
  let first = Buffer.alloc(0), tail = Buffer.alloc(0), observedBytes = 0, flushed = false;
  const scrub = (value: string) => redactNativeDiagnosticMessage(redactCredentials(redactNativeDiagnosticAssignments(redactor.text(value.replace(/^[ \t]*(?:Args|Arguments|argv|Env|Environment):[^\n]*(?:\n|$)/gim, "[redacted startup metadata]\n")))))
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/(?:~\/|\/)[^\s"'<>),;]*/g, "[redacted path]");
  return {
    stderr(data: string): void {
      if (flushed) return;
      const bytes = Buffer.from(data); observedBytes += bytes.length;
      const keep = Math.min(bytes.length, SDK_STDERR_WINDOW_BYTES - first.length);
      if (keep > 0) first = Buffer.concat([first, bytes.subarray(0, keep)]);
      tail = Buffer.concat([tail, bytes.subarray(-SDK_STDERR_WINDOW_BYTES)]).subarray(-SDK_STDERR_WINDOW_BYTES);
    },
    flush(): void {
      if (flushed) return; flushed = true;
      let beginning = first.toString("utf8"), ending = tail.toString("utf8");
      // Drop cut lines rather than emitting a partial credential at a bound.
      if (observedBytes > first.length) beginning = beginning.slice(0, Math.max(0, beginning.lastIndexOf("\n")));
      if (observedBytes > tail.length) ending = ending.slice(ending.indexOf("\n") < 0 ? ending.length : ending.indexOf("\n") + 1);
      nativeReceipt({ kind: "native-fixture-sdk-stderr", head: nativeTestHead(), observedBytes,
        retainedBytes: first.length + tail.length, truncated: observedBytes > SDK_STDERR_WINDOW_BYTES,
        first: scrub(beginning), tail: scrub(ending) });
      first = Buffer.alloc(0); tail = Buffer.alloc(0);
    },
  };
}
