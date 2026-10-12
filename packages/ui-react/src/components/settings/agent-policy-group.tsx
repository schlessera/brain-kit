import { useEffect, useRef, useState } from "react";
import { Button, Callout, Disclosure, Placeholder, Surface } from "@schlessera/brain-ui-kit";
import type { AgentPolicyRead } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainApi, useBrainUiRoot } from "../../root-context.js";
import { rememberFileEntry } from "../../lib/file-entry-focus.js";

/** Read-only facts: the host's admission reader and actual resource-limit report. */
export function AgentPolicyGroup({ active }: { active: boolean }) {
  const api = useBrainApi(), root = useBrainUiRoot();
  const [facts, setFacts] = useState<AgentPolicyRead | null>(null), [error, setError] = useState("");
  const generation = useRef(0), owner = useRef(root.authLock.epoch());
  useEffect(() => {
    const token = ++generation.current, controller = new AbortController(); owner.current = root.authLock.epoch();
    setFacts(null); setError("");
    if (active) void api.agentPolicy(controller.signal).then(result => {
      if (token === generation.current && owner.current === root.authLock.epoch()) setFacts(result);
    }, () => { if (!controller.signal.aborted && token === generation.current && owner.current === root.authLock.epoch()) setError("Could not read this brain's enforcing policy. Open Settings again to check."); });
    const invalidate = () => { generation.current++; controller.abort(); }; return invalidate;
  }, [api, active, root]);
  const warning = facts?.errors.length
    ? `The policy file does not validate: ${facts.errors.join("; ")}. ${facts.source === "last_valid" ? `Enforcing the last valid version ${facts.hash}.` : "No valid policy has been loaded; built-in defaults apply."}`
    : facts?.source === "default" ? "No policy file. Built-in defaults apply." : "";
  return <section data-agent-policy className="my-5 min-w-0 space-y-2" style={{ overflowWrap: "anywhere" }}>
    <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agent policy</h4>
    {error ? <Callout tone="gold" variant="banner" text={error} /> : !facts ? <Placeholder variant="loading" lines={3} /> : <>
      {warning && <Callout tone="gold" variant="banner" icon="failed" text={warning} />}
      {facts.warnings.map(text => <Callout key={text} tone="gold" variant="banner" text={text} />)}
      <Surface emphasis="hairline">
        <div className="min-w-0 space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-2"><code className="min-w-0 flex-1 text-xs">{facts.path}</code>
            <Button label="Open" ariaLabel="Open governance policy" tone="quiet" size="md" block={false} style={{ minHeight: 44 }} onClick={() => {
              if (owner.current !== root.authLock.epoch()) return;
              const opener = document.activeElement; if (opener instanceof HTMLElement) rememberFileEntry(root, opener, opener.matches(":focus-visible"));
              root.stores.ui.getState().openPanel("files"); void root.stores.file.getState().openFile(facts.path);
            }} /></div>
          <p className="font-mono text-xs">Enforcing version: {facts.hash ?? "built-in defaults"}</p>
          <p className="text-xs">Policy minimum — Interactive: {facts.profiles.interactive} · Voice: {facts.profiles.voice}</p>
          <div className="[&_[role=button]]:min-h-11"><Disclosure label="Enforcing limits and protected paths">
            <p className="text-xs">Only reported enforcing limits are shown.</p>
            {facts.workerLimits ? <ul className="space-y-1 text-xs">
              {facts.workerLimits.enforced.map(limit => <li key={`${limit.limit}:${limit.source}`}>{limit.limit}: {limit.value} ({limit.source}{["data", "file_size", "memory"].includes(limit.limit) ? ", bytes" : limit.limit === "cpu" ? ", CPUs" : ""})</li>)}
              {facts.workerLimits.absent.map(limit => <li key={`${limit.limit}:${limit.source}`}>{limit.limit}: not enforced — {limit.reason}</li>)}
            </ul> : <p className="text-xs">Worker resource limits: not reported.</p>}
            <ul className="space-y-1 font-mono text-xs" aria-label="Protected paths">{facts.protectedPaths.map(path => <li key={path}>{path}</li>)}</ul>
          </Disclosure></div>
        </div>
      </Surface>
    </>}
  </section>;
}
