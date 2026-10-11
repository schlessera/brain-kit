import { Button, Callout } from "@schlessera/brain-ui-kit";

import { useWorkerHostStatus } from "../../hooks/use-worker-host.js";
import { ProseLink } from "./prose-link.js";

/** The hosting guide's section on what a container needs for agent workers. */
export const WORKER_HOST_DOCS_URL =
  "https://github.com/schlessera/brain-kit/blob/main/docs/hosting/agent-workers.md#running-the-server-in-a-docker-container";

export interface WorkerHostNoticeViewProps {
  /** The probe's named requirement, as a refused turn names it. */
  requirement: string;
  checking: boolean;
  onCheck: () => void;
}

/**
 * The standing notice above the composer while the server's host cannot run
 * agent turns (#1632). It names what the host lacks, links the fix and offers
 * a re-check. The composer stays usable: a turn sent anyway is refused by the
 * server with the same requirement.
 */
export function WorkerHostNoticeView({ requirement, checking, onCheck }: WorkerHostNoticeViewProps) {
  return (
    <div className="mb-2 flex items-start gap-2" role="status" data-worker-host-notice="">
      <div className="min-w-0 flex-1">
        <Callout tone="amber" variant="boxed" icon="attention">
          <strong className="font-semibold text-foreground">This server can't run agent turns.</strong>{" "}
          Its host lacks what the agent sandbox needs: <span data-worker-host-requirement="">{requirement}</span>.{" "}
          <ProseLink href={WORKER_HOST_DOCS_URL}>Fix the host</ProseLink>
        </Callout>
      </div>
      <Button label={checking ? "Checking…" : "Check again"} tone="quiet" size="sm" block={false} disabled={checking}
        style={{ minHeight: 44 }} onClick={onCheck} />
    </div>
  );
}

/** The notice, drawn only while the latest probe says the ordinary worker cannot run. */
export function WorkerHostNotice() {
  const { status, checking, check } = useWorkerHostStatus();
  const ordinary = status?.ordinary;
  if (!ordinary || ordinary.available) return null;
  return <WorkerHostNoticeView requirement={ordinary.requirement} checking={checking} onCheck={check} />;
}
