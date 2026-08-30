import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api } from "../../lib/api-client.js";

/**
 * The user's remembered "always allow" tool grants — accumulated by the
 * approval cards' "Always allow" button, revocable here. Renders nothing
 * while the list is empty: the section only exists once there is something
 * to manage.
 */
export function ToolPermissionsSection({ active }: { active: boolean }) {
  const [tools, setTools] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    api
      .toolPermissions()
      .then(({ tools }) => setTools(tools))
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Could not load tool permissions")
      );
  }, [active]);

  async function revoke(tool: string) {
    setBusy(tool);
    setError(null);
    try {
      const { tools } = await api.toolPermissionRevoke(tool);
      setTools(tools);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke");
    } finally {
      setBusy(null);
    }
  }

  if (tools.length === 0 && !error) return null;

  return (
    <div className="mt-6">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Always-allowed tools
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        These run without an approval card ("Always allow" on a past approval).
        Destructive command confirmations still ask every time.
      </p>
      <ul className="mt-4 flex flex-col gap-1.5">
        {tools.map((tool) => (
          <li
            key={tool}
            className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface px-3 py-2"
          >
            <code className="truncate text-xs text-foreground">{tool}</code>
            <button
              onClick={() => void revoke(tool)}
              disabled={busy === tool}
              title="Ask for approval again"
              className="flex shrink-0 items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-destructive hover:text-destructive disabled:opacity-50"
            >
              <X className="h-3 w-3" />
              Revoke
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
