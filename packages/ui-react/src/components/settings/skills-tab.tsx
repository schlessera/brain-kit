import { useCallback, useEffect, useRef, useState } from "react";
import type { SkillDetail, SkillEntry, SkillInstallOutcome } from "../../lib/api-client.js";
import { useBrainUiRoot } from "../../root-context.js";
import { SkillEditor, SkillsList } from "./skills-list.js";

/**
 * Settings → Skills: manage the user's CUSTOM skills — create, edit,
 * enable/disable, remove — plus a read-only view of the built-ins brain-kit
 * ships. Custom skills live in the brain repo's `.agents/skills/` (real
 * directories), so they persist across deployments, ride the repo's git
 * backup, and reach every backend; a save runs `brain skills sync`
 * server-side so the change applies to the next turn without a restart.
 *
 * For guided authoring there is a better surface than this editor: the
 * `add-skill` skill — ask the agent in chat.
 *
 * This is the container (S6): the list request, the `active`-gated reload,
 * every mutation and its generation guard, and the editor's fetch live here;
 * `SkillsList` and `SkillEditor` draw from props.
 */

const TEMPLATE = (name: string) => `---
name: ${name}
description: Use when … (write the TRIGGER, not a summary — this line is how agents decide to load the skill)
---

# ${name}

Instructions for the agent. Keep them imperative and specific.
`;

export function SkillsTab({ active }: { active: boolean }) {
  const root = useBrainUiRoot();
  const api = root.api;
  const lifetime = useRef(0);
  const listRequest = useRef(0);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    name: string;
    content: string;
    isNew: boolean;
    readOnly: boolean;
  } | null>(null);
  const [newName, setNewName] = useState("");
  const [githubSource, setGithubSource] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [outcomes, setOutcomes] = useState<SkillInstallOutcome[] | null>(null);

  const reload = useCallback(async () => {
    const generation = lifetime.current;
    const request = ++listRequest.current;
    const current = () => generation === lifetime.current && request === listRequest.current;
    try {
      const { skills } = await api.skillsList();
      if (!current()) return;
      setSkills(skills);
      setError(null);
    } catch (err) {
      if (current()) setError(err instanceof Error ? err.message : "Could not load skills");
    }
  }, [api]);

  useEffect(() => {
    lifetime.current++;
    setSkills([]);
    setError(null);
    setWarning(null);
    setBusy(null);
    setEditing(null);
    setNewName("");
    setGithubSource("");
    setOverwrite(false);
    setInstalling(false);
    setOutcomes(null);
    if (active) void reload();
    const invalidate = () => { lifetime.current++; };
    return invalidate;
  }, [active, root, reload]);

  async function run(name: string, fn: () => Promise<{ warning?: string } | void>) {
    const generation = lifetime.current;
    setBusy(name);
    setError(null);
    setWarning(null);
    try {
      const result = await fn();
      if (generation !== lifetime.current) return;
      if (result && "warning" in result && result.warning) setWarning(result.warning);
      await reload();
    } catch (err) {
      if (generation === lifetime.current) setError(err instanceof Error ? err.message : "Skill operation failed");
    } finally {
      if (generation === lifetime.current) setBusy(null);
    }
  }

  async function openEditor(entry: SkillEntry) {
    const generation = lifetime.current;
    setBusy(entry.name);
    try {
      const detail: SkillDetail = await api.skillGet(entry.name);
      if (generation !== lifetime.current) return;
      setEditing({
        name: entry.name,
        content: detail.content,
        isNew: false,
        readOnly: entry.source === "builtin",
      });
      setError(null);
    } catch (err) {
      if (generation === lifetime.current) setError(err instanceof Error ? err.message : "Could not load skill");
    } finally {
      if (generation === lifetime.current) setBusy(null);
    }
  }

  function startCreate() {
    const name = newName.trim();
    if (!name) return;
    setEditing({ name, content: TEMPLATE(name), isNew: true, readOnly: false });
    setNewName("");
  }

  async function saveEditor() {
    if (!editing || editing.readOnly) return;
    const generation = lifetime.current;
    const { name, content, isNew } = editing;
    await run(name, async () => {
      const result = isNew
        ? await api.skillCreate(name, content)
        : await api.skillUpdate(name, content);
      if (generation === lifetime.current) setEditing(null);
      return result;
    });
  }

  async function install(fn: () => Promise<{ outcomes: SkillInstallOutcome[]; warning?: string }>) {
    const generation = lifetime.current;
    setInstalling(true);
    setError(null);
    setWarning(null);
    setOutcomes(null);
    try {
      const result = await fn();
      if (generation !== lifetime.current) return;
      setOutcomes(result.outcomes);
      if (result.warning) setWarning(result.warning);
      await reload();
    } catch (err) {
      if (generation === lifetime.current) setError(err instanceof Error ? err.message : "Install failed");
    } finally {
      if (generation === lifetime.current) setInstalling(false);
    }
  }

  if (editing) {
    return (
      <SkillEditor
        name={editing.name}
        content={editing.content}
        isNew={editing.isNew}
        readOnly={editing.readOnly}
        saving={busy !== null}
        error={error}
        onChange={(content) => setEditing({ ...editing, content })}
        onSave={() => void saveEditor()}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <SkillsList
      skills={skills}
      busy={busy}
      installing={installing}
      error={error}
      warning={warning}
      outcomes={outcomes}
      newName={newName}
      githubSource={githubSource}
      overwrite={overwrite}
      onNewName={setNewName}
      onCreate={startCreate}
      onGithubSource={setGithubSource}
      onOverwrite={setOverwrite}
      onInstallZip={(file) => void install(() => api.skillInstallZip(file, overwrite))}
      onInstallGitHub={() => void install(() => api.skillInstallGitHub(githubSource.trim(), overwrite))}
      onOpen={(skill) => void openEditor(skill)}
      onToggle={(skill) => void run(skill.name, () => api.skillSetEnabled(skill.name, !skill.enabled))}
      onRemove={(skill) => {
        if (confirm(`Delete the skill "${skill.name}" permanently?`)) {
          void run(skill.name, () => api.skillRemove(skill.name));
        }
      }}
    />
  );
}
