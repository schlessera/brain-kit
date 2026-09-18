import { Callout, Label, ListRow, Surface } from "@schlessera/brain-ui-kit";

/**
 * The always-allowed tools, rendered from props (S7, the `settings`
 * directory). The design's settings screen is `Label` + `Surface(pad=0)` +
 * grouped `ListRow`s "exercising all four trailing slots"; a grant is a
 * mono-titled row whose trailing action is *Revoke*. The kit's trailing
 * action is decorative — "the row carries the handler" — so tapping the row
 * revokes, and the row dims while the revoke is in flight.
 * `ToolPermissionsSection` is the container that owns the request.
 */
export interface ToolPermissionsListProps {
  tools: string[];
  /** The tool whose revoke is in flight. */
  busy: string | null;
  error: string | null;
  onRevoke: (tool: string) => void;
}

export function ToolPermissionsList(p: ToolPermissionsListProps) {
  return (
    <div className="mt-6 flex flex-col gap-2">
      <Label text="Always-allowed tools" icon="capability" />
      <p className="text-xs text-muted-foreground">
        These run without an approval card ("Always allow" on a past approval).
        Destructive command confirmations still ask every time. Tap one to ask
        for approval again.
      </p>
      {p.tools.length > 0 && (
        <Surface pad={0}>
          {p.tools.map((tool, i) => (
            <ListRow
              key={tool}
              variant="group"
              mono
              icon="capability"
              iconTone="amber"
              title={tool}
              actionLabel={p.busy === tool ? "Revoking…" : "Revoke"}
              dim={p.busy === tool}
              last={i === p.tools.length - 1}
              onClick={p.busy === tool ? undefined : () => p.onRevoke(tool)}
            />
          ))}
        </Surface>
      )}
      {p.error && (
        <div role="alert">
          <Callout tone="red" variant="banner" icon="failed" mono text={p.error} />
        </div>
      )}
    </div>
  );
}
