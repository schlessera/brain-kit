import { Component, type ReactNode } from "react";
import { useBrainUiRoot } from "../../root-context.js";
import type { ToolCall } from "../../stores/chat-store.js";

/**
 * One tool call's view behind its own error boundary. The renderer seam runs
 * third-party code during render; when it throws, `children(true)` renders
 * the call with the generic renderer instead of unmounting the whole app.
 */
export function ToolRendererBoundary({ toolCall, children }: {
  toolCall: ToolCall;
  children: (failed: boolean) => ReactNode;
}) {
  const root = useBrainUiRoot();
  return (
    <Boundary
      toolCall={toolCall}
      onError={(error) => {
        console.error(`The renderer for the ${toolCall.name} tool failed; showing the generic view.`, error);
        root.stores.connection.getState().reportError(
          "TOOL_RENDERER_FAILED",
          `The view for the ${toolCall.name} tool failed and fell back to the generic view.`
        );
      }}
    >
      {children}
    </Boundary>
  );
}

type BoundaryProps = {
  toolCall: ToolCall;
  onError: (error: unknown) => void;
  children: (failed: boolean) => ReactNode;
};
type BoundaryState = { failed: boolean; toolCall: ToolCall };

/**
 * A new tool-call object (status, input or output changed) resets the
 * boundary, so the renderer gets another try on every update. The error is
 * reported once per mounted call, not once per update that throws again.
 */
class Boundary extends Component<BoundaryProps, BoundaryState> {
  private reported = false;
  state: BoundaryState = { failed: false, toolCall: this.props.toolCall };

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.toolCall === state.toolCall ? null : { failed: false, toolCall: props.toolCall };
  }

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    if (this.reported) return;
    this.reported = true;
    this.props.onError(error);
  }

  render() {
    return this.props.children(this.state.failed);
  }
}
