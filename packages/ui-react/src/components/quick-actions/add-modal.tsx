import { useState, useEffect, useRef } from "react";
import { SlidePanel } from "../layout/slide-panel.js";
import { useBrainApi } from "../../root-context.js";
import { AddForm, type AddState as State } from "./add-form.js";

/** Split the tags field on commas; empties dropped so "a,,b," is clean. */
function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * The container (S6): the draft, `brain add`, `brain index` and the
 * `operation.epoch` guard live here; `AddForm` draws from props. The epoch
 * is bumped on open, on close, on "Add another" and on every request, so a
 * response from a form the user has already left cannot land in the one
 * they are looking at.
 */
export function AddPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const api = useBrainApi();
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("");
  const [tags, setTags] = useState("");
  const [state, setState] = useState<State>("editing");
  const [error, setError] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const [indexed, setIndexed] = useState<boolean | undefined>();
  const [indexing, setIndexing] = useState(false);
  const operation = useRef({ epoch: 0 }).current;
  // Types already in the brain, offered as completions — `brain add` accepts
  // any string, so this is a hint list, not a closed set.
  const [knownTypes, setKnownTypes] = useState<string[]>([]);

  const contentRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    operation.epoch++;
    setKnownTypes([]);
    setSavedPath("");
    setIndexed(undefined);
    setIndexing(false);
    setContent("");
    setTitle("");
    setType("");
    setTags("");
    setError("");
    setState("editing");

    const t = setTimeout(() => contentRef.current?.focus(), 120);

    let cancelled = false;
    api
      .brainStats()
      .then((s) => {
        if (!cancelled) setKnownTypes(Object.keys(s.byType).sort());
      })
      .catch(() => {
        // Completions are a nicety; a failed stats call must not block adding.
      });

    return () => {
      operation.epoch++;
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, operation, api]);

  async function handleSave() {
    const body = content.trim();
    if (!body || (state !== "editing" && state !== "error")) return;
    const current = ++operation.epoch;

    setState("saving");
    setError("");
    try {
      const result = await api.brainAdd(body, {
        type: type.trim() || undefined,
        title: title.trim() || undefined,
        tags: parseTags(tags).length ? parseTags(tags) : undefined,
      });
      if (current !== operation.epoch) return;
      setSavedPath(result.path ?? "");
      setIndexed(result.indexed);
      setError(result.indexed === false ? result.indexError || "Indexing failed." : "");
      setState("saved");
    } catch (err: any) {
      if (current !== operation.epoch) return;
      setError(err?.message || "Add failed");
      setState("error");
    }
  }

  async function retryIndex() {
    if (indexing) return;
    const current = ++operation.epoch;
    setIndexing(true);
    setError("");
    try {
      await api.brainIndex();
      if (current === operation.epoch) setIndexed(true);
    } catch (err) {
      if (current === operation.epoch) setError(err instanceof Error ? err.message : "Indexing failed.");
    } finally {
      if (current === operation.epoch) setIndexing(false);
    }
  }

  function handleAddAnother() {
    operation.epoch++;
    setSavedPath("");
    setIndexed(undefined);
    setIndexing(false);
    setContent("");
    setTitle("");
    setType("");
    setTags("");
    setState("editing");
    setTimeout(() => contentRef.current?.focus(), 0);
  }

  return (
    <SlidePanel open={open} onClose={onClose} title="Add to brain" wide>
      <AddForm
        state={state}
        draft={{ content, title, type, tags }}
        knownTypes={knownTypes}
        error={error}
        savedPath={savedPath}
        indexed={indexed}
        indexing={indexing}
        contentRef={contentRef}
        onDraft={(patch) => {
          if (patch.content !== undefined) setContent(patch.content);
          if (patch.title !== undefined) setTitle(patch.title);
          if (patch.type !== undefined) setType(patch.type);
          if (patch.tags !== undefined) setTags(patch.tags);
        }}
        onSave={() => void handleSave()}
        onRetryIndex={() => void retryIndex()}
        onAddAnother={handleAddAnother}
        onClose={onClose}
      />
    </SlidePanel>
  );
}
