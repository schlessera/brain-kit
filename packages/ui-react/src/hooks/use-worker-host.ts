import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkerHostStatus } from "@schlessera/brain-ui-sdk/protocol";

import { useBrainUiRoot, useRootStore } from "../root-context.js";
import { activeChat, anyStreaming } from "../stores/chat-state.js";

/**
 * What the server last found about running agent workers on its host
 * (#1632), read from authenticated `/api/status` and re-read when it may have
 * changed: on mount, on each socket open, when a turn was refused for the
 * host, and when any turn ends while the host is known to be unavailable (a
 * fixed host lets that turn run, and the server re-records it).
 *
 * The answer is a report, not a gate. Nothing here stops a send: the server
 * probes the host before every turn and refuses with the same requirement.
 */
export function useWorkerHostStatus() {
  const root = useBrainUiRoot();
  const [status, setStatus] = useState<WorkerHostStatus | null>(null);
  const [checking, setChecking] = useState(false);
  // A slow read must not overwrite a newer one, or a check's answer.
  const latest = useRef(0);
  const socketOpens = useRootStore("connection", (s) => s.socketOpens);
  const streaming = useRootStore("chat", anyStreaming);
  const refused = useRootStore("chat", (s) => activeChat(s).messages.at(-1)?.failure?.errorClass === "worker_host_unsupported");
  const unavailable = status?.ordinary?.available === false;

  const read = useCallback(() => {
    const request = ++latest.current;
    root.api.status().then(
      (s) => { if (request === latest.current) setStatus(s.runtime?.workerHost ?? null); },
      () => { /* signed out, offline or an older server: keep what is known */ },
    );
  }, [root]);

  useEffect(read, [read, socketOpens]);
  useEffect(() => { if (refused) read(); }, [read, refused]);
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current && !streaming && unavailable) read();
    wasStreaming.current = streaming;
  }, [read, streaming, unavailable]);

  const check = useCallback(() => {
    const request = ++latest.current;
    setChecking(true);
    root.api.checkWorkerHost().then(
      (s) => { if (request === latest.current) setStatus(s); },
      () => { /* keep what is known; the notice stays as it was */ },
    ).finally(() => setChecking(false));
  }, [root]);

  return { status, checking, check };
}
