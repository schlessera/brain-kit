import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Download, Loader2, Pencil, Plus, Power, Trash2, Upload, X } from "lucide-react";
import type { SkillDetail, SkillEntry, SkillInstallOutcome } from "../../lib/api-client.js";
import { useBrainUiRoot } from "../../root-context.js";
import { cn } from "../../lib/utils.js";

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

  const custom = skills.filter((s) => s.source === "custom");
  const builtin = skills.filter((s) => s.source === "builtin");

  if (editing) {
    return (
      <div className="flex h-full flex-col p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-foreground">
            {editing.isNew ? "New skill" : editing.name}
            {editing.readOnly && (
              <span className="ml-2 text-[11px] text-muted-foreground">built-in · read-only</span>
            )}
          </h3>
          <div className="flex gap-2">
            {!editing.readOnly && (
              <button
                onClick={() => void saveEditor()}
                disabled={busy !== null}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:brightness-110 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Save
              </button>
            )}
            <button
              onClick={() => setEditing(null)}
              className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-3 w-3" />
              Close
            </button>
          </div>
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <textarea
          value={editing.content}
          readOnly={editing.readOnly}
          onChange={(e) => setEditing({ ...editing, content: e.target.value })}
          spellCheck={false}
          className="mt-3 min-h-0 flex-1 resize-none rounded-lg border border-border-subtle bg-background p-3 font-mono text-xs text-foreground focus:border-primary focus:outline-none"
        />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Your skills
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Custom skills live in your brain repo (<code>.agents/skills/</code>) — they
        survive redeployments, ride the repo's backups, and apply to every
        backend. For guided authoring, ask the agent in chat to{" "}
        <span className="font-medium text-foreground">add a skill</span> — the
        built-in <code>add-skill</code> skill walks through design and setup.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value.toLowerCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") startCreate();
          }}
          placeholder="new-skill-name (kebab-case)"
          className="min-w-0 flex-1 rounded-md border border-border-subtle bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
        <button
          onClick={startCreate}
          disabled={!newName.trim()}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:brightness-110 disabled:opacity-50"
        >
          <Plus className="h-3 w-3" />
          Create
        </button>
      </div>

      <div className="mt-3 rounded-lg border border-border-subtle bg-surface p-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Install
        </p>
        <div className="mt-2 flex items-center gap-2">
          <label
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary hover:text-primary",
              installing && "pointer-events-none opacity-50"
            )}
          >
            <Upload className="h-3 w-3" />
            Upload .zip
            <input
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void install(() => api.skillInstallZip(file, overwrite));
              }}
            />
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            overwrite existing
          </label>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            value={githubSource}
            onChange={(e) => setGithubSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && githubSource.trim() && !installing) {
                void install(() => api.skillInstallGitHub(githubSource.trim(), overwrite));
              }
            }}
            placeholder="GitHub: owner/repo or https://github.com/…/tree/main/skills"
            className="min-w-0 flex-1 rounded-md border border-border-subtle bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
          <button
            onClick={() =>
              void install(() => api.skillInstallGitHub(githubSource.trim(), overwrite))
            }
            disabled={installing || !githubSource.trim()}
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
          >
            {installing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
            Install
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          A skill is any folder with a SKILL.md; one source may carry several.
          Private repos use the server's GITHUB_TOKEN.
        </p>
        {outcomes && (
          <ul className="mt-2 flex flex-col gap-1">
            {outcomes.map((o, i) => (
              <li key={`${o.name}-${i}`} className="text-[11px]">
                {o.status === "skipped" ? (
                  <span className="text-muted-foreground">
                    ✗ {o.name} — {o.reason}
                  </span>
                ) : (
                  <span className="text-primary">
                    ✓ {o.name} {o.status === "replaced" ? "replaced" : "installed"}
                    {typeof o.files === "number" ? ` (${o.files} file${o.files === 1 ? "" : "s"})` : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {warning && <p className="mt-2 text-xs text-muted-foreground">{warning}</p>}

      <ul className="mt-4 flex flex-col gap-2">
        {custom.length === 0 && (
          <li className="rounded-lg border border-dashed border-border-subtle p-3 text-xs text-muted-foreground">
            No custom skills yet.
          </li>
        )}
        {custom.map((skill) => (
          <li
            key={skill.name}
            className={cn(
              "rounded-lg border border-border-subtle bg-surface p-3",
              !skill.enabled && "opacity-60"
            )}
          >
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">
                  {skill.name}
                  {!skill.enabled && (
                    <span className="ml-2 text-[11px] text-muted-foreground">disabled</span>
                  )}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {skill.warning ? `⚠ ${skill.warning}` : skill.description}
                </p>
              </div>
              <button
                onClick={() => void openEditor(skill)}
                disabled={busy !== null}
                title="Edit SKILL.md"
                className="rounded-md border border-border-subtle p-1.5 text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() =>
                  void run(skill.name, () => api.skillSetEnabled(skill.name, !skill.enabled))
                }
                disabled={busy !== null}
                title={skill.enabled ? "Disable (all backends)" : "Enable"}
                className={cn(
                  "rounded-md border border-border-subtle p-1.5 transition-colors disabled:opacity-50",
                  skill.enabled
                    ? "text-primary hover:border-primary"
                    : "text-muted-foreground hover:border-primary hover:text-primary"
                )}
              >
                {busy === skill.name ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Power className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                onClick={() => {
                  if (confirm(`Delete the skill "${skill.name}" permanently?`)) {
                    void run(skill.name, () => api.skillRemove(skill.name));
                  }
                }}
                disabled={busy !== null}
                title="Delete permanently"
                className="rounded-md border border-border-subtle p-1.5 text-muted-foreground transition-colors hover:border-destructive hover:text-destructive disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h3 className="mt-6 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Built-in skills
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Shipped by brain-kit and its modules; managed by <code>brain skills sync</code>.
        A custom skill with the same name overrides a built-in.
      </p>
      <ul className="mt-3 flex flex-col gap-1.5">
        {builtin.map((skill) => (
          <li
            key={skill.name}
            className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-foreground">{skill.name}</p>
              <p className="truncate text-[11px] text-muted-foreground">{skill.description}</p>
            </div>
            <button
              onClick={() => void openEditor(skill)}
              disabled={busy !== null}
              title="View SKILL.md"
              className="shrink-0 rounded-md border border-border-subtle px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
            >
              View
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
