import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button, EmptyState } from "@schlessera/brain-ui-kit";
import { PROTOCOL_REV } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { useUIStore } from "../../stores/ui-store.js";
import type { ActiveView } from "../../stores/ui-state.js";
import { subscribeUpdateHolds, updateHeld } from "../../lib/update-holds.js";
import { hasUnsentText } from "../../hooks/use-service-worker-updates.js";
import { isStaleChunk, markReload, readReloadMarker, staleChunkReloadDecision, type StaleChunkDecision } from "../../lib/lazy-chunk.js";
import { providerMessageInclusion } from "../../lib/turn-failure.js";
import { CLIENT_RELEASE } from "../../lib/stats/software.js";
import { CHAT_REVIEW_COPY, DiagnosticReview, type ReviewCopy } from "../report/diagnostic-review.js";
import { ErrorBoundary, type ErrorBoundaryFallback } from "./error-boundary.js";

/** The visible name of each page (the activity view is labelled Actions, D52). */
const PAGE_NAMES: Record<ActiveView, string> = { chat: "Chat", graph: "Graph", activity: "Actions" };

const PAGE_REVIEW_COPY: ReviewCopy = {
  ...CHAT_REVIEW_COPY,
  footnote: "Left out by default: the error message, component names, file paths, hostnames, and anything from your notes or conversations. Redaction is best effort; read the text before you paste it anywhere.",
};

export interface PageBoundaryProps {
  children: ReactNode;
  /** Test hook: observe a reload without navigating. */
  reload?: () => void;
}

/**
 * The boundary inside `AppShell`'s `<main>` (#1377). A page that throws, or a
 * lazy chunk a deploy has replaced, is answered in place of the page while
 * the rail, tab bar and dialogs stay usable. Changing the view or the root
 * (an account switch) resets it.
 */
export function PageBoundary({ children, reload }: PageBoundaryProps) {
  const root = useBrainUiRoot();
  const view = useUIStore((s) => s.activeView);
  return (
    <ErrorBoundary
      resetKeys={[view, root]}
      onError={(error) => console.error(`[boundary:page] The ${PAGE_NAMES[view]} page failed.`, error)}
      fallback={(state) => <PageFallback {...state} view={view} reload={reload} />}
    >
      {children}
    </ErrorBoundary>
  );
}

function doReload(reload: (() => void) | undefined) {
  markReload(sessionStorageOrNull());
  if (reload) reload();
  else window.location.reload();
}

function sessionStorageOrNull(): Storage | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
}

/** True while a reload would lose work: the same guard as the service-worker update. */
function useHeld(): boolean {
  const root = useBrainUiRoot();
  const [held, setHeld] = useState(() => updateHeld(root) || hasUnsentText());
  useEffect(() => subscribeUpdateHolds(root, () => setHeld(updateHeld(root) || hasUnsentText())), [root]);
  return held;
}

/**
 * Where focus goes when a fallback appears: to its title, unless the person is
 * typing elsewhere or working in a dialog. Then focus stays, and a one-off
 * alert carries the title instead.
 */
function useFocusDecision(): [boolean, RefObject<HTMLDivElement | null>] {
  const box = useRef<HTMLDivElement>(null);
  const [moveFocus] = useState(() => {
    if (typeof document === "undefined") return true;
    const active = document.activeElement;
    if (!active || active === document.body) return true;
    if (box.current?.contains(active)) return true;
    const editable = active.matches("input, textarea, [contenteditable=''], [contenteditable='true']");
    const inDialog = Boolean(active.closest("dialog[open], [role='dialog']"));
    return !(editable || inDialog);
  });
  return [moveFocus, box];
}

function PageFallback({ error, info, failures, reset, view, reload }: ErrorBoundaryFallback & { view: ActiveView; reload?: () => void }) {
  return isStaleChunk(error)
    ? <StaleChunkFallback view={view} reload={reload} />
    : <PageErrorFallback error={error} info={info} failures={failures} reset={reset} view={view} reload={reload} />;
}

function FallbackLayout({ children, box }: { children: ReactNode; box: RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={box} data-page-fallback className="flex flex-1 items-center justify-center overflow-y-auto p-4">
      <div className="flex w-full max-w-[320px] flex-col items-stretch">{children}</div>
    </div>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-[18px] flex flex-col gap-2">{children}</div>;
}

const TALL = { minHeight: 44 } as const;

function GoToChat({ view, primary }: { view: ActiveView; primary?: boolean }) {
  const press = useUIStore((s) => s.pressDestination);
  if (view === "chat") return null;
  return <Button tone={primary ? "primary" : "ghost"} size="md" icon="chat" label="Go to Chat" center style={TALL} onClick={() => press("chat")} />;
}

function decide(held: boolean): StaleChunkDecision {
  return staleChunkReloadDecision({
    online: typeof navigator === "undefined" || navigator.onLine !== false,
    held,
    marker: readReloadMarker(sessionStorageOrNull()),
    now: Date.now(),
  });
}

function StaleChunkFallback({ view, reload }: { view: ActiveView; reload?: () => void }) {
  const page = PAGE_NAMES[view];
  const held = useHeld();
  // Decided once on mount; a hold going idle later does not reload under the
  // reader. Only coming back online re-runs the decision.
  const [decision, setDecision] = useState<StaleChunkDecision>(() => decide(held));
  const [moveFocus, box] = useFocusDecision();
  const reloaded = useRef(false);

  useEffect(() => {
    if (decision !== "auto" || reloaded.current) return;
    reloaded.current = true;
    doReload(reload);
  }, [decision, reload]);

  useEffect(() => {
    if (decision !== "offline") return;
    const online = () => setDecision(decide(held));
    window.addEventListener("online", online, { once: true });
    return () => window.removeEventListener("online", online);
  }, [decision, held]);

  const copy = {
    auto: { title: "A new version is ready", body: `Brain was updated since this page opened. Reloading to bring in ${page}.` },
    manual: { title: "A new version is ready", body: `Brain was updated since this page opened. Reload to bring in ${page}.` },
    held: { title: "A new version is ready", body: `Brain was updated since this page opened. ${page} needs a reload, and reloading now would lose what you haven't sent in Chat.` },
    looped: { title: `${page} didn't load`, body: `The app reloaded, but ${page} still couldn't be downloaded. The server may be mid-update. Try again in a minute.` },
    offline: { title: "You're offline", body: `${page} hasn't been downloaded to this device yet. It loads when you're back online.` },
  }[decision];

  return (
    <FallbackLayout box={box}>
      <EmptyState icon="install" tone="amber" title={copy.title} body={copy.body} meta="" minHeight={0} pad={0} focusTitle={moveFocus && decision !== "auto"} />
      {decision === "auto" ? <p role="status" className="bk-sr-only">Reloading to load the new version.</p> : null}
      {!moveFocus && decision !== "auto" ? <p role="alert" className="bk-sr-only">{copy.title}</p> : null}
      <Actions>
        {decision === "offline" ? <GoToChat view={view} primary /> : (
          <>
            <Button tone="primary" size="md" icon="install" center style={TALL}
              label={decision === "looped" ? "Reload" : "Reload now"}
              subtitle={decision === "held" ? "Unsent work will be lost" : undefined}
              ariaLabel={decision === "held" ? "Reload now, unsent work will be lost" : undefined}
              onClick={() => doReload(reload)} />
            {decision === "auto" || decision === "manual" ? null : <GoToChat view={view} />}
          </>
        )}
      </Actions>
    </FallbackLayout>
  );
}

/** Component names from a React component stack: identifiers only, never paths or URLs. */
export function componentNames(stack: string | null | undefined, limit = 12): string[] {
  if (!stack) return [];
  const names: string[] = [];
  for (const line of stack.split("\n")) {
    const match = /^\s*(?:at\s+)?([A-Za-z_$][\w$]*)/.exec(line.replace(/^\s*in\s+/, ""));
    if (match && match[1] !== "at" && !names.includes(match[1]!)) names.push(match[1]!);
    if (names.length >= limit) break;
  }
  return names;
}

function PageErrorFallback({ error, info, failures, reset, view, reload }: ErrorBoundaryFallback & { view: ActiveView; reload?: () => void }) {
  const page = PAGE_NAMES[view];
  const held = useHeld();
  const repeated = failures >= 2;
  const [moveFocus, box] = useFocusDecision();
  const [reviewing, setReviewing] = useState(false);
  const errorName = error instanceof Error && error.name ? error.name : "Error";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  const body = [
    "brain-kit page failure",
    `protocol: ${PROTOCOL_REV}`,
    `client: ${CLIENT_RELEASE}`,
    `surface: ${view}`,
    "kind: render",
    `error: ${errorName}`,
    `failures: ${failures}`,
    `time: ${new Date().toISOString()}`,
  ].join("\n");
  const title = `${page} stopped working`;

  return (
    <FallbackLayout box={box}>
      <EmptyState icon="failed" tone="red" title={title}
        body={repeated ? "It failed again. Reloading the app usually clears this." : "An error stopped this page from drawing. The rest of Brain still works."}
        meta="" minHeight={0} pad={0} focusTitle={moveFocus} />
      {!moveFocus ? <p role="alert" className="bk-sr-only">{title}</p> : null}
      <Actions>
        {repeated ? (
          <Button tone="primary" size="md" icon="retry" label="Reload app" center style={TALL}
            subtitle={held ? "Unsent work will be lost" : undefined}
            ariaLabel={held ? "Reload app, unsent work will be lost" : undefined}
            onClick={() => doReload(reload)} />
        ) : (
          <Button tone="primary" size="md" icon="retry" label="Try again" center style={TALL} onClick={reset} />
        )}
        <GoToChat view={view} />
        <span data-fallback-action="copy" className="contents">
          <Button tone="quiet" size="md" icon="copy" label="Copy details" center style={TALL} onClick={() => setReviewing(true)} />
        </span>
      </Actions>
      {reviewing ? (
        <DiagnosticReview mode="copy" initialBody={body} defaultIssueTitle={`Page failure: ${page}`} copy={PAGE_REVIEW_COPY}
          inclusions={[
            { id: "message", label: "Add error message for review", build: () => providerMessageInclusion("Error message", message) },
            { id: "components", label: "Add component names", build: () => {
              const names = componentNames(info?.componentStack);
              return names.length ? `components: ${names.join(" › ")}` : null;
            } },
          ]}
          onClose={() => setReviewing(false)}
          returnFocus={() => box.current?.querySelector<HTMLElement>("[data-fallback-action='copy'] [role='button']")?.focus()} />
      ) : null}
    </FallbackLayout>
  );
}
