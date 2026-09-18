import { useEffect, useRef, useState } from "react";
import { useBrainApi } from "../../root-context.js";
import { ToolPermissionsList } from "./tool-permissions-list.js";

/**
 * The user's remembered "always allow" tool grants — accumulated by the
 * approval cards' "Always allow" button, revocable here. Renders nothing
 * while the list is empty: the section only exists once there is something
 * to manage. This is the container (S7); `ToolPermissionsList` draws the
 * rows on the kit.
 */
export function ToolPermissionsSection({ active }: { active: boolean }) {
  const api = useBrainApi();
  const lifetime = useRef(0);
  const [tools, setTools] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const generation = ++lifetime.current;
    const current = () => generation === lifetime.current;
    setTools([]);
    setError(null);
    setBusy(null);
    if (active) {
      api.toolPermissions()
        .then(({ tools }) => { if (current()) setTools(tools); })
        .catch((err) => {
          if (current()) setError(err instanceof Error ? err.message : "Could not load tool permissions");
        });
    }
    const invalidate = () => { lifetime.current++; };
    return invalidate;
  }, [active, api]);

  async function revoke(tool: string) {
    const generation = lifetime.current;
    setBusy(tool);
    setError(null);
    try {
      const { tools } = await api.toolPermissionRevoke(tool);
      if (generation === lifetime.current) setTools(tools);
    } catch (err) {
      if (generation === lifetime.current) setError(err instanceof Error ? err.message : "Could not revoke");
    } finally {
      if (generation === lifetime.current) setBusy(null);
    }
  }

  if (tools.length === 0 && !error) return null;

  return <ToolPermissionsList tools={tools} busy={busy} error={error} onRevoke={(tool) => void revoke(tool)} />;
}
