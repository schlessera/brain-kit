import { Toggle } from "@schlessera/brain-ui-kit";
import { BellOff } from "lucide-react";

/**
 * What push looks like — nothing about how it is obtained. `PushToggle` is
 * the container that owns the browser permission, the service worker, the
 * server binding and every cancellation guard; this is the S6 split of its
 * presentation into a view that renders from props alone.
 *
 * The permission model is THREE-state, not a bare switch: once the browser
 * prompt is denied, Chrome silently ignores every further in-page request,
 * so `blocked` says where the real switch lives instead of drawing one that
 * does nothing. Where the platform has no push at all (an in-browser iOS
 * tab), `unsupported` explains rather than hides.
 *
 * The switch is the kit's `Toggle`, named "Push notifications" — the name is
 * what it switches, `aria-checked` is its state, and `disabled` is the
 * subscription mid-flight (the design's fourth state, kept as a named switch
 * rather than a vanished one).
 */
export type PushState = "unsupported" | "not-asked" | "blocked" | "subscribed" | "unsubscribed";

export interface PushSwitchProps {
  state: PushState;
  busy: boolean;
  onToggle: () => void;
}

export function PushSwitch({ state, busy, onToggle }: PushSwitchProps) {
  if (state === "unsupported") {
    return (
      <div
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60"
        title="This browser has no web push. On iOS, install the app to the home screen (iOS 16.4+)."
      >
        <BellOff className="h-3.5 w-3.5" />
        No push here
      </div>
    );
  }
  if (state === "blocked") {
    return (
      <div
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
        title="Notifications are blocked at the browser level. Allow them in this site's browser settings, then reload."
      >
        <BellOff className="h-3.5 w-3.5 text-destructive" />
        Blocked in browser settings
      </div>
    );
  }
  const on = state === "subscribed";
  return (
    <label
      className="flex items-center gap-2 text-[11px] text-muted-foreground"
      title={on ? "Push notifications are on for this device" : "Get a push notification when background work fails"}
    >
      <span>{on ? "Push on" : "Push"}</span>
      <Toggle on={on} tone="amber" label="Push notifications" disabled={busy} onClick={onToggle} />
    </label>
  );
}
