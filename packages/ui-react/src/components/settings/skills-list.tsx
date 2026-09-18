import { Button, Placeholder } from "@schlessera/brain-ui-kit";
import { Loader2, Pencil, Power, Trash2, Upload } from "lucide-react";
import type { SkillEntry, SkillInstallOutcome } from "../../lib/api-client.js";
import { cn } from "../../lib/utils.js";

/**
 * Settings → Skills, rendered from props (S6). `SkillsTab` is the container:
 * it owns the list request, the `active`-gated reload, every mutation and its
 * generation guard, and the editor's fetch; these two views own what is on
 * screen. `SkillsList` is the list with its create and install rows;
 * `SkillEditor` is the one-file editor that replaces it while a skill is open.
 *
 * Text fields stay native (the kit has no text input); the create, install,
 * save and close buttons are the kit's `Button`. The per-row edit / enable /
 * delete controls stay native icon buttons: they are titled, and the kit has
 * no icon-only button. The zip picker is a native file input behind a label.
 *
 * `busy` names the skill whose mutation is in flight, or `"*"` for none in
 * particular — the container passes the skill name it is working on, and
 * every row control is inert while any is running, as before.
 */
export interface SkillsListProps {
  skills: SkillEntry[];
  /** The skill a mutation is running for, or null. */
  busy: string | null;
  installing: boolean;
  error: string | null;
  warning: string | null;
  outcomes: SkillInstallOutcome[] | null;
  newName: string;
  githubSource: string;
  overwrite: boolean;
  onNewName: (value: string) => void;
  onCreate: () => void;
  onGithubSource: (value: string) => void;
  onOverwrite: (value: boolean) => void;
  onInstallZip: (file: File) => void;
  onInstallGitHub: () => void;
  onOpen: (skill: SkillEntry) => void;
  onToggle: (skill: SkillEntry) => void;
  onRemove: (skill: SkillEntry) => void;
}

export function SkillsList(p: SkillsListProps) {
  const custom = p.skills.filter((s) => s.source === "custom");
  const builtin = p.skills.filter((s) => s.source === "builtin");
  const locked = p.busy !== null;
  const canInstall = !p.installing && p.githubSource.trim().length > 0;

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
          value={p.newName}
          onChange={(e) => p.onNewName(e.target.value.toLowerCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter" && p.newName.trim()) p.onCreate();
          }}
          placeholder="new-skill-name (kebab-case)"
          className="min-w-0 flex-1 rounded-md border border-border-subtle bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
        <Button label="Create" icon="add" tone="primary" size="sm" block={false} disabled={!p.newName.trim()} onClick={p.onCreate} />
      </div>

      <div className="mt-3 rounded-lg border border-border-subtle bg-surface p-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Install
        </p>
        <div className="mt-2 flex items-center gap-2">
          <label
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary hover:text-primary",
              p.installing && "pointer-events-none opacity-50",
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
                if (file) p.onInstallZip(file);
              }}
            />
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={p.overwrite} onChange={(e) => p.onOverwrite(e.target.checked)} />
            overwrite existing
          </label>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            value={p.githubSource}
            onChange={(e) => p.onGithubSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canInstall) p.onInstallGitHub();
            }}
            placeholder="GitHub: owner/repo or https://github.com/…/tree/main/skills"
            className="min-w-0 flex-1 rounded-md border border-border-subtle bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
          {p.installing ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-hidden /> : null}
          <Button label="Install" icon="install" tone="ghost" size="sm" block={false} disabled={!canInstall} onClick={p.onInstallGitHub} />
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          A skill is any folder with a SKILL.md; one source may carry several.
          Private repos use the server's GITHUB_TOKEN.
        </p>
        {p.outcomes && (
          <ul className="mt-2 flex flex-col gap-1">
            {p.outcomes.map((o, i) => (
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

      {p.error && <p className="mt-2 text-xs text-destructive">{p.error}</p>}
      {p.warning && <p className="mt-2 text-xs text-muted-foreground">{p.warning}</p>}

      <ul className="mt-4 flex flex-col gap-2">
        {custom.length === 0 && (
          <li>
            <Placeholder variant="empty" message="No custom skills yet." icon="steps" pad={10} />
          </li>
        )}
        {custom.map((skill) => (
          <li key={skill.name} className="rounded-lg border border-border-subtle bg-surface p-3">
            {/* A disabled skill is not faded (design-feedback §4): its state
                word says so, at full contrast. */}
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
                type="button"
                onClick={() => p.onOpen(skill)}
                disabled={locked}
                title="Edit SKILL.md"
                className="rounded-md border border-border-subtle p-1.5 text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => p.onToggle(skill)}
                disabled={locked}
                title={skill.enabled ? "Disable (all backends)" : "Enable"}
                className={cn(
                  "rounded-md border border-border-subtle p-1.5 transition-colors disabled:opacity-50",
                  skill.enabled
                    ? "text-primary hover:border-primary"
                    : "text-muted-foreground hover:border-primary hover:text-primary",
                )}
              >
                {p.busy === skill.name ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Power className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => p.onRemove(skill)}
                disabled={locked}
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
            <span title="View SKILL.md" className="flex shrink-0">
              <Button label="View" tone="quiet" size="sm" block={false} disabled={locked} onClick={() => p.onOpen(skill)} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface SkillEditorProps {
  name: string;
  content: string;
  isNew: boolean;
  readOnly: boolean;
  /** A save is in flight. */
  saving: boolean;
  error: string | null;
  onChange: (content: string) => void;
  onSave: () => void;
  onClose: () => void;
}

export function SkillEditor(p: SkillEditorProps) {
  return (
    <div className="flex h-full flex-col p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">
          {p.isNew ? "New skill" : p.name}
          {p.readOnly && (
            <span className="ml-2 text-[11px] text-muted-foreground">built-in · read-only</span>
          )}
        </h3>
        <div className="flex gap-2">
          {!p.readOnly && (
            <Button label={p.saving ? "Saving…" : "Save"} icon="confirm" tone="primary" size="sm" block={false} disabled={p.saving} onClick={p.onSave} />
          )}
          <Button label="Close" icon="dismiss" tone="quiet" size="sm" block={false} onClick={p.onClose} />
        </div>
      </div>
      {p.error && <p className="mt-2 text-xs text-destructive">{p.error}</p>}
      <textarea
        value={p.content}
        readOnly={p.readOnly}
        aria-label="SKILL.md"
        onChange={(e) => p.onChange(e.target.value)}
        spellCheck={false}
        className="mt-3 min-h-0 flex-1 resize-none rounded-lg border border-border-subtle bg-background p-3 font-mono text-xs text-foreground focus:border-primary focus:outline-none"
      />
    </div>
  );
}
