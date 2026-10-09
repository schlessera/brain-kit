import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryFallback {
  error: unknown;
  info: ErrorInfo | null;
  /** Catches since the reset keys last changed, this one included. */
  failures: number;
  /** Clear the error and remount the children; `failures` is kept. */
  reset: () => void;
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Any change (Object.is per element) clears the error and the failure count. */
  resetKeys?: readonly unknown[];
  onError?: (error: unknown, info: ErrorInfo) => void;
  fallback: (state: ErrorBoundaryFallback) => ReactNode;
}

type State = { error: unknown; caught: boolean; info: ErrorInfo | null; failures: number; generation: number; keys: readonly unknown[] };

const changed = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]));

/**
 * The one error boundary class in ui-react. React only catches render errors
 * in a class component; everything else (the tool-row fallback, page and root
 * screens) is a `fallback` over this.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null, caught: false, info: null, failures: 0, generation: 0, keys: this.props.resetKeys ?? [] };

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: State): Partial<State> | null {
    const keys = props.resetKeys ?? [];
    if (!changed(keys, state.keys)) return null;
    // Healthy children keep their state; only a failed subtree remounts.
    return { keys, error: null, caught: false, info: null, failures: 0, generation: state.caught ? state.generation + 1 : state.generation };
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error, caught: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.setState((s) => ({ info, failures: s.failures + 1 }));
    this.props.onError?.(error, info);
  }

  private reset = () => {
    this.setState((s) => ({ error: null, caught: false, info: null, generation: s.generation + 1 }));
  };

  render() {
    const { caught, error, info, failures, generation } = this.state;
    if (caught) {
      // componentDidCatch counts after the first fallback render.
      return this.props.fallback({ error, info, failures: Math.max(failures, 1), reset: this.reset });
    }
    return <Fragment key={generation}>{this.props.children}</Fragment>;
  }
}
