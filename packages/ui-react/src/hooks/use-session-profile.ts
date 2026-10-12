import { useEffect, useRef, useState } from "react";
import type { ModelPickerProps } from "@schlessera/brain-ui-kit";
import type { SessionWorkerProfile } from "@schlessera/brain-ui-sdk/protocol";
import { sessionWorkerProfileSchema } from "@schlessera/brain-ui-sdk/schemas";
import { useBrainUiRoot } from "../root-context.js";

/** Only a validated host acknowledgement changes the confirmed choice. */
export function useSessionProfile(sessionId: string | null, draftId: string, online: boolean, running: boolean, supported: boolean, epoch: number) {
  const root = useBrainUiRoot();
  const key = `${root.apiBase()}|${epoch}|${sessionId ? "session" : "draft"}|${sessionId ?? draftId}`;
  const owner = useRef(key); owner.current = key;
  const version = useRef(0);
  const pending = useRef<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{ key: string; facts?: SessionWorkerProfile; saving?: boolean; error?: string }>({ key });
  const current = state.key === key ? state : { key };
  const path = `${root.apiBase()}/${sessionId ? "sessions" : "drafts"}/${encodeURIComponent(sessionId ?? draftId)}/profile`;
  useEffect(() => {
    const generation = ++version.current;
    if (!online || !supported) return;
    const controller = new AbortController();
    void root.request(path, { cache: "no-store", signal: controller.signal }).then(async response => {
      const parsed = sessionWorkerProfileSchema.safeParse(await response.json());
      if (owner.current !== key || version.current !== generation) return;
      if (!response.ok || !parsed.success) { setState({ key, error: "Profile facts are unavailable." }); return; }
      setState({ key, facts: parsed.data });
    }).catch(() => {
      if (owner.current === key && version.current === generation && !controller.signal.aborted) setState({ key, error: "Profile facts are unavailable." });
    });
    return () => controller.abort();
  }, [root, key, path, online, supported, refresh]);
  const save = async (preference: "governed" | "strict") => {
    if (!online || current.saving || pending.current === key || !current.facts) return;
    pending.current = key;
    const generation = ++version.current;
    setState({ ...current, saving: true, error: undefined });
    try {
      const response = await root.request(path, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preference }), cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const parsed = sessionWorkerProfileSchema.safeParse(await response.json());
      if (owner.current !== key || version.current !== generation) return;
      if (!response.ok || !parsed.success || parsed.data.preference !== preference) throw Error("Profile was not confirmed.");
      setState({ key, facts: parsed.data });
    } catch {
      if (owner.current === key && version.current === generation) setState({ ...current, saving: false, error: "Couldn't confirm the change. Your saved choice stays; try again." });
    } finally { if (pending.current === key) pending.current = null; }
  };
  const facts = current.facts;
  const chat: NonNullable<ModelPickerProps["chat"]> = {
    profile: facts ? facts.origin === "voice" || facts.policyProfile === "strict" ? facts.policyProfile : facts.preference : null,
    disabledReason: !online ? "Needs the host." : facts?.origin === "voice" ? "Voice uses this brain's policy"
      : facts?.policyProfile === "strict" ? "Set by this brain's policy." : !facts ? "Profile facts are unavailable." : undefined,
    saving: current.saving, error: current.error, running,
    limits: facts?.limits ?? null, onProfile: preference => { void save(preference); },
  };
  return { chat, profileDraftId: !sessionId && facts?.draftPreferenceStored ? draftId : undefined,
    /** An unconfirmed choice cannot be sent as though its save succeeded. */
    saving: Boolean(current.saving),
    awaitingDraftFacts: !sessionId && supported && !facts,
    refresh: () => { if (!current.saving) setRefresh(value => value + 1); } };
}
