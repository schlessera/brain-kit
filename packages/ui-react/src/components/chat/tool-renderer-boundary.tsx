import { useRef, type ReactNode } from "react";
import { useBrainUiRoot } from "../../root-context.js";
import type { ToolCall } from "../../stores/chat-store.js";
import { ErrorBoundary } from "../layout/error-boundary.js";

/**
 * One tool call's view behind its own error boundary. The renderer seam runs
 * third-party code during render; when it throws, `children(true)` renders
 * the call with the generic renderer instead of unmounting the whole app.
 *
 * A new tool-call object (status, input or output changed) resets the
 * boundary, so the renderer gets another try on every update. The error is
 * reported once per mounted call, not once per update that throws again.
 */
export function ToolRendererBoundary({ toolCall, children }: {
  toolCall: ToolCall;
  children: (failed: boolean) => ReactNode;
}) {
  const root = useBrainUiRoot();
  const reported = useRef(false);
  return (
    <ErrorBoundary
      resetKeys={[toolCall]}
      onError={(error) => {
        if (reported.current) return;
        reported.current = true;
        console.error(`The renderer for the ${toolCall.name} tool failed; showing the generic view.`, error);
        root.stores.connection.getState().reportError(
          "TOOL_RENDERER_FAILED",
          `The view for the ${toolCall.name} tool failed and fell back to the generic view.`
        );
      }}
      fallback={() => children(true)}
    >
      {children(false)}
    </ErrorBoundary>
  );
}
