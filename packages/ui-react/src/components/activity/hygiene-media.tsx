import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { z } from "zod";
import { FILE_SIZE_CAP_BYTES, type HygieneMediaPlan, type HygieneMediaProbe, type HygieneMediaReceipt, type HygieneMediaRefusal, type InboxActionItem, type InboxOption } from "@schlessera/brain-ui-sdk/protocol";
import { Button, Callout, TextButton, color, font } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import { useInboxStore } from "../../stores/inbox-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { ApiRequestError } from "../../lib/api-client.js";
import { isEditableTarget, singleKey } from "../../lib/single-key.js";
import { ImageViewer } from "../images/image-viewer.js";
import type { HygieneController } from "./hygiene-review.js";

/**
 * A media finding in hygiene review (#2782): the file with a bounded preview,
 * its facts, and the five decisions (#1777 rev 4 §8, rev 5 §8.1, rev 6 §5).
 * The host owns eligibility, plans and effects; this card shows them, starts a
 * preview on choice, renders only the latest one and applies only a current one.
 */

// A display projection only: the host's `next` media detail (cli.md, `hygiene next`).
const mediaDisplay = z.object({
  path: z.string(),
  severity: z.string().nullable().optional(),
  media: z
    .object({
      source: z.enum(["content", "scratch"]),
      classes: z.array(z.string()),
      bytes: z.number(),
      sha256: z.string(),
      links: z.object({ state: z.string(), conversations: z.number() }),
    })
    .optional(),
  invalidation: z
    .object({ disposition: z.string(), dispositionOn: z.string().nullable(), changed: z.array(z.string()) })
    .nullable()
    .optional(),
});

type Kind = "image" | "video" | "audio" | "pdf" | "none";
/** What the raw files route can serve with a playable type (`MIME_BY_EXT`, rev 4 §0). */
const KINDS: Record<string, Kind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image", ico: "image", svg: "image",
  mp4: "video", webm: "video", mp3: "audio", wav: "audio", pdf: "pdf",
};
const MIMES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
};
const NOUN: Record<Kind, string> = { image: "image", video: "video", audio: "audio", pdf: "document", none: "file" };

function mediaSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const extension = (path: string) => {
  const name = baseName(path), dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};
const typeLabel = (path: string) => {
  const ext = extension(path), kind = KINDS[ext] ?? "none";
  return `${ext === "jpg" ? "JPEG" : (ext || "unknown").toUpperCase()} ${NOUN[kind]}`;
};
function duration(ms: number) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function probeLine(p: HygieneMediaProbe | null | undefined) {
  if (!p) return null;
  const parts = [p.width !== null && p.height !== null ? `${p.width} × ${p.height}` : null, p.durationMs !== null ? duration(p.durationMs) : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** The five decisions, in the card's order (rev 4 §4.2). */
const ROWS = ["media-persist", "media-persist-rule", "media-move", "media-keep-copy", "media-delete"] as const;
type Row = (typeof ROWS)[number];
const ACTION: Record<Row, string> = {
  "media-persist": "PERSIST", "media-persist-rule": "PERSIST · BROADER RULE", "media-move": "MOVE",
  "media-keep-copy": "KEEP A PERMANENT COPY", "media-delete": "DELETE",
};
const SHORT: Record<Row, string> = {
  "media-persist": "Persist here", "media-persist-rule": "Persist with a broader rule", "media-move": "Move to a final location",
  "media-keep-copy": "Keep a permanent copy", "media-delete": "Delete",
};
const needsText = (row: Row) => row === "media-move" || row === "media-keep-copy" || row === "media-persist-rule";

/** A named refusal in words (rev 4 §9, cli.md `hygiene media`). Never a code alone when the code is known. */
function refusalText(r: HygieneMediaRefusal, name = "this file"): string {
  switch (r.code) {
    case "share-staged": return "Finish or discard the share first.";
    case "not-final-location": return "Choose a folder outside .brain, workspaces and context/hygiene.";
    case "pinned-scratch": return "Linked from a conversation. Keep a copy instead.";
    case "pins-unknown": return "Conversation links can't be checked right now.";
    case "not-linked-scratch": return "No conversation links this scratch file. Move it instead.";
    case "destination-required": return "Enter a destination to see what changes.";
    case "not-contained": return "Choose a path inside this brain.";
    case "exists": return "Something is already at that path. Nothing is overwritten.";
    case "name-collision": return "A file with nearly the same name is already in that folder.";
    case "secret-name": return "That name looks like a secret, so sync would never commit it.";
    case "ref-unsupported": return `${r.path ? `${r.path}${r.line ? `:${r.line}` : ""} points` : "A note points"} to ${name} in a form that isn't updated automatically. Change it yourself, then check again.`;
    case "not-expressible": return "This file has no exact rule. Persist it with a broader rule instead.";
    case "ignore-adjustment-required": return `An ignore rule still wins over this file${r.path ? `: ${r.path.split("\n").join(", ")}` : ""}.`;
    case "pattern-mismatch": return "That rule doesn't match this file.";
    case "invalid-pattern": return "That isn't a rule media.track accepts.";
    case "config-not-literal": return "brain.config.ts doesn't hold plain lists, so it can't be edited here.";
    case "config-invalid": return "brain.config.ts wouldn't load after this change, so nothing was changed.";
    case "inventory-too-large":
      return r.limit === "preview"
        ? "This preview is larger than one update can carry, so it isn't shown. Nothing was changed."
        : r.limit === "notes"
        ? `This brain has more notes than one check reads (${r.effective?.toLocaleString("en-US") ?? "the limit"}), so not every link can be checked. Nothing was changed.`
        : `The link check stopped at its ${r.limit ?? "size"} limit, so not every link can be checked. Nothing was changed.`;
    case "inventory-unscannable": return `${r.path ?? "A note"} couldn't be read, so not every link can be checked. Nothing was changed.`;
    case "capture-capacity": return "Not enough room to keep Undo data. Nothing was changed.";
    case "exdev": return "That folder is on another file system. Move works within one only.";
    case "preview-busy": return "Another device is checking a file. Try again in a moment.";
    case "plan-unavailable": case "stale": case "not-detected": return "File changed since this was shown.";
    case "stale-approval": return "brain.config.ts changed since you approved. Nothing was written. Review the new preview and approve again.";
    case "approval-required": return "This rule needs your approval first.";
    default: return `Refused: ${r.code.replace(/-/g, " ")}.`;
  }
}

const FRAME = 160;
const mono = (size = 11): CSSProperties => ({ fontFamily: font.mono, fontSize: size, color: color.inkMute, overflowWrap: "anywhere" });

/**
 * The bounded preview (rev 5 §8.1): one request for an image when the card is
 * shown, nothing for scratch video/audio or LARGE until Load, nothing at all
 * past the raw route's cap or for a type it cannot serve playable.
 */
function MediaFrame({ path, bytes, large, scratch, probe, name, frameButton }: {
  path: string; bytes: number; large: boolean; scratch: boolean; probe: HygieneMediaProbe | null | undefined; name: string;
  frameButton: RefObject<HTMLButtonElement | null>;
}) {
  const root = useBrainUiRoot();
  const ext = extension(path), kind = KINDS[ext] ?? "none";
  const raw = `${root.apiBase()}/files/content?path=${encodeURIComponent(path)}&raw=1`;
  const overCap = bytes > FILE_SIZE_CAP_BYTES;
  const deferred = !overCap && (large || (scratch && (kind === "video" || kind === "audio")));
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [viewing, setViewing] = useState(false);
  const label = typeLabel(path);
  const dims = probeLine(probe);
  const tile = (text: string, action?: ReactNode) => (
    <div data-media-tile="" className="flex flex-col items-center justify-center gap-2 rounded-[10px] p-3 text-center"
      style={{ minHeight: FRAME, border: `1px dashed ${color.edge}`, background: color.canvas }}>
      <span style={mono(11)}>{text}</span>
      {action}
    </div>
  );
  if (failed) return tile("Couldn't load preview");
  if (overCap) return tile(`${label} · ${mediaSize(bytes)} · Too large to preview here`);
  if (kind === "none") return tile(`${label} · ${mediaSize(bytes)} · No preview here`);
  if (kind === "pdf")
    return tile(`${label} · ${mediaSize(bytes)}`, (
      <TextButton label="Open in Files" onClick={() => {
        root.stores.ui.getState().openPanel("files");
        void root.stores.file.getState().openFile(path);
      }} />
    ));
  if (deferred && !loaded)
    return tile(`${label} · ${mediaSize(bytes)}${scratch ? " · scratch" : ""}`, (
      <Button tone="ghost" size="md" block={false} reach label={large ? `Load preview (${mediaSize(bytes)})` : "Load preview"}
        ariaLabel={`Load preview of ${name}`} onClick={() => setLoaded(true)} />
    ));
  if (kind === "video")
    return (
      <div data-media-frame="" className="overflow-hidden rounded-[10px]" style={{ border: `1px solid ${color.edge}`, background: color.canvas }}>
        <video src={raw} controls preload="metadata" playsInline aria-label={`${name}, ${label}`} onError={() => setFailed(true)}
          style={{ display: "block", width: "100%", height: FRAME, objectFit: "contain" }} />
      </div>
    );
  if (kind === "audio")
    return (
      <div data-media-frame="" className="rounded-[10px] p-2" style={{ border: `1px solid ${color.edge}` }}>
        <audio src={raw} controls preload="none" aria-label={`${name}, ${label}`} onError={() => setFailed(true)} style={{ width: "100%" }} />
      </div>
    );
  return (
    <div data-media-frame="" className="relative overflow-hidden rounded-[10px]"
      style={{ height: FRAME, border: `1px solid ${color.edge}`, background: `repeating-conic-gradient(${color.raised} 0% 25%, ${color.canvas} 0% 50%) 50% / 16px 16px` }}>
      <img src={raw} alt={`${name}${dims ? `, ${dims}` : ""}`} loading={scratch || deferred ? "eager" : "lazy"} onError={() => setFailed(true)}
        style={{ display: "block", width: "100%", height: "100%", objectFit: "contain" }} />
      <button
        // raw-button: kit — a chip painted over the image and the viewer's focus return target; TextButton takes no surface paint
        ref={frameButton} type="button" data-media-preview="" className="bk-hit absolute bottom-2 right-2 rounded-md px-2 py-1"
        aria-label={`Preview ${name}, ${label}${dims ? `, ${dims}` : ""}`}
        style={{ ...mono(11), color: color.ink, background: color.surface, border: `1px solid ${color.edge}` }}
        onClick={() => setViewing(true)}>⤢ Preview</button>
      {viewing ? (
        <ImageViewer src={raw} alt={`${name}${dims ? `, ${dims}` : ""}`} filename={name} mime={MIMES[ext]} bytes={bytes}
          onClose={() => {
            setViewing(false);
            requestAnimationFrame(() => frameButton.current?.focus());
          }} />
      ) : null}
    </div>
  );
}

type Preview =
  | { state: "checking"; requestId: string; row: Row; text: string }
  | { state: "done"; requestId: string; row: Row; text: string; refusals: HygieneMediaRefusal[]; plan: HygieneMediaPlan | null; probe?: HygieneMediaProbe | null }
  | { state: "failed"; requestId: string; row: Row; text: string; message: string };

/** The plan an option now carries for exactly this choice, or null. */
function planFor(option: InboxOption | undefined, row: Row, text: string): HygieneMediaPlan | null {
  const plan = option?.media;
  if (!plan) return null;
  if (row === "media-persist-rule") return plan.pattern === text ? plan : null;
  if (row === "media-move" || row === "media-keep-copy") return option?.effect.kind === "hygiene" && option.effect.destination === text ? plan : null;
  return plan;
}

function commitLabel(row: Row | null, plan: HygieneMediaPlan | null, name: string, unavailable: boolean) {
  if (!row) return "Apply";
  if (unavailable) return `${SHORT[row].replace(/ to a final location| with a broader rule| a permanent copy| here/, "")} unavailable`;
  if (row === "media-persist") return `Persist ${name}`;
  if (row === "media-persist-rule") return plan?.matches ? `Approve rule for ${plan.matches.track.count} file${plan.matches.track.count === 1 ? "" : "s"} and future matches` : "Approve rule";
  if (row === "media-move") {
    const n = plan?.rewrites.length ?? 0;
    return n ? `Move and update ${n} link${n === 1 ? "" : "s"}` : `Move ${name}`;
  }
  if (row === "media-keep-copy") return `Keep a copy of ${name}`;
  return `Delete ${name}`;
}

/** The preview region's lines for a current plan (rev 3 §6, rev 4 §5.4/§8.3). */
function PlanLines({ row, plan, name, source }: { row: Row; plan: HygieneMediaPlan; name: string; source: string }) {
  const line = (key: string, text: ReactNode, style: CSSProperties = {}) => <div key={key} style={{ ...mono(11), ...style }}>{text}</div>;
  const out: ReactNode[] = [];
  const bytes = plan.files.find((f) => f.role === "source")?.bytes ?? plan.copy?.bytes ?? 0;
  if (plan.destination) {
    out.push(line("from", `${row === "media-keep-copy" ? "copy " : ""}${source}`, { color: color.ink }));
    out.push(line("to", `→ ${plan.destination} · new file · destination free`, { color: color.ink }));
  } else out.push(line("from", source, { color: color.ink }));
  if (plan.copy) out.push(line("sha", `sha ${plan.copy.sha256.slice(0, 7)} · ${mediaSize(plan.copy.bytes)} · checked after copy`));
  for (const [i, r] of plan.rewrites.entries()) {
    out.push(line(`rw${i}`, `${r.note}:${r.line}`));
    out.push(line(`rb${i}`, `− ${r.before}`, { color: "var(--bk-red-ink)" }));
    out.push(line(`ra${i}`, `+ ${r.after}`, { color: "var(--bk-teal-ink)" }));
  }
  for (const [i, b] of plan.blockers.entries()) out.push(line(`b${i}`, `${b.note}:${b.line} · ${b.kind} → ${b.target} · not updated`));
  if (row === "media-delete") {
    if (!plan.references.complete) out.push(line("refs", "references not fully checked"));
    else if (plan.references.count > 0) out.push(line("refs", `${plan.references.count} reference${plan.references.count === 1 ? "" : "s"} will point to a missing file`));
    if (plan.links.state === "linked")
      out.push(line("linked", `Those ${plan.links.conversations} conversation${plan.links.conversations === 1 ? "" : "s"} will show a missing file`));
    else if (plan.links.state === "unknown") out.push(line("linked", "Conversation links couldn't be checked"));
  }
  if (plan.configDiff) {
    const added = plan.configDiff.track.after.filter((p) => !plan.configDiff!.track.before.includes(p));
    const removed = plan.configDiff.ignore.before.filter((p) => !plan.configDiff!.ignore.after.includes(p));
    for (const p of added) out.push(line(`t${p}`, <>{baseName(plan.configDiff.path)} media.track: <span style={{ color: "var(--bk-teal-ink)" }}>+ "{p}"</span>{plan.scope === "exact" ? " (exact file)" : ""}</>));
    for (const p of removed) out.push(line(`i${p}`, <>{baseName(plan.configDiff.path)} media.ignore: <span style={{ color: "var(--bk-red-ink)" }}>− "{p}"</span></>));
  } else if (row !== "media-delete" && plan.resultClass === "TRACK") out.push(line("tracked", "already tracked · no config change"));
  for (const m of [plan.matches?.track, plan.matches?.ignore ?? undefined]) {
    if (!m) continue;
    out.push(line(`m${m.pattern}`, `${m.anyFolder ? "Matches in any folder" : "Matches"}: ${m.largest.map((f) => `${f.path}${f.bytes !== null ? ` ${mediaSize(f.bytes)}` : ""}`).join(" · ")}${m.count > m.largest.length ? ` · ${m.count - m.largest.length} more` : ""}`));
    out.push(line(`f${m.pattern}`, m.anyFolder ? `Future files named ${m.pattern} anywhere will be committed by sync.` : "Future matching files will be committed by sync."));
  }
  if (row === "media-keep-copy") {
    out.push(line("two", `two copies remain · +${mediaSize(bytes)} on disk`));
    out.push(line("orig", plan.links.state === "linked"
      ? `original stays in scratch while ${plan.links.conversations} conversation${plan.links.conversations === 1 ? "" : "s"} link it; it can be pruned after they're gone`
      : "original stays in scratch under its current pins"));
  }
  if (row !== "media-delete" && plan.resultClass === "TRACK") out.push(line("git", `next sync commits ${mediaSize(bytes)} to Git history`));
  if (plan.captureBytes > 0 || row === "media-keep-copy") out.push(line("undo", "Undo keeps rollback data, which may be cleared early when space is needed"));
  if (row === "media-move" || row === "media-delete") out.push(line("outside", "Links from outside this brain (sites, other apps, chat history) can't be updated."));
  void name;
  return <>{out}</>;
}

/** The media effect's result recorded on the card, when it did not resolve it. */
function outcomeOf(item: InboxActionItem) {
  const o = item.hygiene?.outcome;
  return o && ["stale", "refused", "check_failed"].includes(o.status) ? o : undefined;
}

export function MediaFinding({ item, controller: c }: { item: InboxActionItem; controller: HygieneController }) {
  const root = useBrainUiRoot();
  const replicated = useInboxStore((s) => s.items[item.id]);
  const ready = replicated?.queue === "actions" && replicated.version === item.version && replicated.status === item.status;
  const flight = useInboxStore((s) => s.inFlight[item.id]);
  const online = useInboxStore((s) => s.online);
  const keys = useUIStore((s) => s.singleKeyShortcuts);
  const parsed = mediaDisplay.safeParse(item.hygiene?.finding);
  const f = parsed.success ? parsed.data : { path: item.payload.detail };
  const detail = "media" in f ? f.media : undefined;
  const name = baseName(f.path);
  const scratch = detail?.source === "scratch" || f.path.startsWith(".brain/scratch/");
  const shared = f.path.startsWith(".brain-ui/inbox/");
  const links = detail?.links;
  const linkState: "linked" | "unlinked" | "unknown" =
    links && links.conversations > 0 ? "linked" : scratch && links?.state !== "complete" ? "unknown" : "unlinked";
  const n = links?.conversations ?? 0;
  const large = detail?.classes.includes("LARGE") ?? false;
  const options = new Map(item.options.map((o) => [o.id, o]));
  const rows = ROWS.filter((r) => options.has(r) && !(r === "media-keep-copy" && linkState === "unlinked"));
  /** Why a row is unavailable (rev 4 §4.2); unavailable rows stay listed with their reason. */
  function unavailable(row: Row): string | null {
    if (shared) return "Finish or discard the share first.";
    if (row === "media-persist" && scratch)
      return linkState === "unlinked" ? "Scratch is temporary. Move it to a permanent folder." : "Scratch is temporary. Keep a copy instead.";
    if (row === "media-move" && scratch && linkState === "linked") return `Linked from ${n} conversation${n === 1 ? "" : "s"}.`;
    if (row === "media-move" && scratch && linkState === "unknown") return "Conversation links can't be checked right now.";
    const prepared = options.get(row)?.media;
    if (!needsText(row) && prepared && prepared.refusals.length > 0) return refusalText(prepared.refusals[0]!, name);
    return null;
  }
  const [row, setRow] = useState<Row | null>(null);
  const [texts, setTexts] = useState<Partial<Record<Row, string>>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const latest = useRef<string | null>(null);
  const aborter = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const viaKey = useRef(false);
  const seq = useRef(0);
  const card = useRef<HTMLDivElement>(null);
  const frameButton = useRef<HTMLButtonElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const recoveryRef = useRef<HTMLButtonElement>(null);
  const showFiles = useRef<HTMLButtonElement>(null);
  const inputId = useId(), statusId = useId(), groupLabel = useId();
  const text = row ? texts[row] ?? "" : "";
  useEffect(() => () => {
    clearTimeout(timer.current);
    aborter.current?.abort();
  }, []);
  useEffect(() => {
    if (c.focus > 0 && !isEditableTarget(document.activeElement)) card.current?.querySelector<HTMLElement>("[data-hygiene-title]")?.focus();
  }, [c.focus]);

  /** Resolves true once the replicated Action is newer than `version`, false after `ms`. */
  function newerThan(version: number, ms: number) {
    return new Promise<boolean>((resolve) => {
      const check = () => (root.stores.inbox.getState().items[item.id]?.version ?? 0) > version;
      if (check()) return resolve(true);
      const stop = root.stores.inbox.subscribe(() => { if (check()) { stop(); clearTimeout(t); resolve(true); } });
      const t = setTimeout(() => { stop(); resolve(false); }, ms);
    });
  }
  async function run(target: Row, input: string, retried = false) {
    clearTimeout(timer.current);
    aborter.current?.abort();
    const option = options.get(target);
    if (!option || unavailable(target) || (needsText(target) && !input.trim())) {
      latest.current = null;
      setPreview(null);
      return;
    }
    const requestId = `media-${++seq.current}-${Math.random().toString(36).slice(2, 10)}`;
    latest.current = requestId;
    const abort = new AbortController();
    aborter.current = abort;
    setPreview({ state: "checking", requestId, row: target, text: input });
    const sentVersion = root.stores.inbox.getState().items[item.id]?.version ?? item.version;
    try {
      const response = await root.api.hygienePreview(
        { itemId: item.id, optionId: option.id, expectedVersion: sentVersion, input: needsText(target) ? input : null, requestId },
        abort.signal
      );
      // Only the latest request renders or can enable the commit (rev 3.1 §2).
      if (latest.current !== requestId || (response.requestId !== undefined && response.requestId !== requestId)) return;
      const refusals = (response.refusals ?? []).filter((r) => r.code !== "preview-superseded");
      const plan = planFor(response.options.find((o) => o.id === option.id), target, input);
      setPreview({ state: "done", requestId, row: target, text: input, refusals, plan, probe: response.media });
    } catch (error) {
      if (abort.signal.aborted || latest.current !== requestId) return;
      // An earlier choice's preview may have stored a newer Action while this one was on its way.
      // Re-send once against that version; any other refusal is stated, never retried.
      if (!retried && error instanceof ApiRequestError && error.status === 409 && await newerThan(sentVersion, 1000)) {
        if (latest.current === requestId) void run(target, input, true);
        return;
      }
      setPreview({
        state: "failed", requestId, row: target, text: input,
        message: error instanceof ApiRequestError && (error.status === 401 || error.status === 403)
          ? "You're signed out or this device can't review. Nothing was changed."
          : "Couldn't prepare a preview. Nothing was changed.",
      });
    }
  }
  function schedule(target: Row, input: string, delay: number) {
    clearTimeout(timer.current);
    aborter.current?.abort();
    latest.current = null;
    if (delay === 0) void run(target, input);
    else {
      setPreview(null);
      timer.current = setTimeout(() => void run(target, input), delay);
    }
  }
  function choose(target: Row) {
    setRow(target);
    setBanner(null);
    const delay = viaKey.current ? 250 : 0;
    viaKey.current = false;
    schedule(target, texts[target] ?? "", needsText(target) && !(texts[target] ?? "").trim() ? 0 : delay);
  }

  const outcome = outcomeOf(item);
  const receipt: HygieneMediaReceipt | undefined = outcome?.media;
  // A stale apply re-previews at once; the commit stays disabled until that preview is current (rev 3.1 §2).
  const handled = useRef<number>(item.version);
  useEffect(() => {
    if (handled.current === item.version || !outcome) return;
    handled.current = item.version;
    if (outcome.status === "stale" && row) {
      setBanner(outcome.reason === "stale-approval" ? refusalText({ code: "stale-approval" }) : "Changed since the preview. Updated below. Check it before applying.");
      void run(row, texts[row] ?? "");
      requestAnimationFrame(() => bannerRef.current?.focus());
    } else if (receipt?.outcome === "partial") requestAnimationFrame(() => showFiles.current?.focus());
    else requestAnimationFrame(() => recoveryRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.version]);

  const current = preview?.state === "done" && row !== null && preview.row === row && preview.text === text ? preview : null;
  const replicatedPlan = row ? planFor(options.get(row), row, text) : null;
  // The stored plan must be the one this preview returned: same premise, no refusals.
  const applicable = !!current && current.refusals.length === 0 && !!current.plan && current.plan.refusals.length === 0 &&
    replicatedPlan?.premiseDigest === current.plan.premiseDigest && !!(options.get(row!)?.effect as { premiseDigest?: string } | undefined)?.premiseDigest;
  const rowBlocked = row ? unavailable(row) : null;
  const locked = !online || !ready || !!flight || item.status !== "pending" || item.hygiene?.outcome?.status === "applying";
  const checking = preview?.state === "checking" && preview.row === row;
  const refused = current && (current.refusals.length > 0 || (current.plan?.refusals.length ?? 0) > 0)
    ? [...current.refusals, ...(current.plan?.refusals ?? [])] : [];
  const status = !row ? "Choose what should happen to this file."
    : rowBlocked ? rowBlocked
    : needsText(row) && !text.trim() ? (row === "media-persist-rule" ? "Enter a rule to see every file it matches." : "Enter a destination to see what changes.")
    : checking ? "Preview in progress. You can change your choice."
    : preview?.state === "failed" && preview.row === row ? preview.message
    : refused.length ? refusalText(refused[0]!, name)
    : applicable ? (current?.plan?.approvalDigest ? "Approval is tied to the config version you saw." : "Preview ready")
    : !online ? "Reconnect before answering." : !ready ? "Waiting for the current finding…" : "";
  const alerting = !!row && !checking && (!!rowBlocked || refused.length > 0 || (preview?.state === "failed" && preview.row === row));

  function send(optionId: string, receiptLabel: string) {
    const opt = options.get(optionId);
    const state = root.stores.inbox.getState();
    if (locked || !opt || state.inFlight[item.id]) return;
    if (optionId !== "leave-pending" && !applicable) return;
    // Leave pending is a nonterminal `snoozed` transition (#2780), which only a `later` flight confirms.
    if (!state.beginDecision(item.id, { kind: optionId === "leave-pending" ? "later" : "commit", optionId, label: opt.label, receipt: receiptLabel, ambiguous: true })) return;
    if (!root.connection.send({ type: "inbox_resolve", itemId: item.id, optionId })) {
      root.stores.inbox.getState().decisionRefused();
      return;
    }
    c.onSent(item.id);
  }
  const leave = () => send("leave-pending", "Left pending");
  const apply = () => { if (row) send(row, row === "media-delete" ? "Deleted" : row === "media-move" ? "Moved" : row === "media-keep-copy" ? "Kept a permanent copy" : "Persisted"); };
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key.startsWith("Arrow") && (e.target as HTMLElement).getAttribute("type") === "radio") viaKey.current = true;
    if (!keys) return;
    const radio = (e.target as HTMLElement).getAttribute?.("type") === "radio";
    const key = singleKey({ ...e, target: radio ? null : e.target });
    if (key !== "a" && key !== "l") return;
    e.preventDefault();
    // `a` applies only a current preview; while checking it repeats the status (rev 3.1 §3).
    if (key === "a") apply();
    else leave();
  }

  const fieldStyle: CSSProperties = {
    minHeight: 44, width: "100%", boxSizing: "border-box", border: `1px solid ${color.edge}`, borderRadius: 8,
    padding: "10px 12px", background: color.canvas, color: color.ink, font: `400 13px/1.5 ${font.mono}`,
  };
  const probe = (current?.probe !== undefined ? current.probe : undefined) ??
    item.options.map((o) => o.media?.media).find((m) => m !== undefined && m !== null) ?? null;
  const dims = probeLine(probe);
  const refs = (options.get("media-delete") ?? options.get("media-persist"))?.media?.references;
  const facts: Array<[string, string]> = [
    ["type", `${typeLabel(f.path)} · ${detail ? mediaSize(detail.bytes) : "size unknown"}${large ? " · LARGE" : ""}`],
    ["git", scratch ? "scratch · not persisted" : shared ? "share staging · not persisted" : "untracked · not persisted"],
    ...(scratch ? [["linked", linkState === "unknown" ? "can't be checked right now" : `${n} conversation${n === 1 ? "" : "s"} (scratch pins)`] as [string, string]] : []),
    ["used by", refs ? (!refs.complete ? "not fully checked" : refs.count === 0 ? "no notes" : `${refs.count} reference${refs.count === 1 ? "" : "s"}`) : "unknown"],
  ];
  const inv = "invalidation" in f ? f.invalidation : null;
  const keptGone = inv?.disposition === "kept"
    ? inv.changed.includes("copy-missing")
      ? `Your permanent copy is gone (kept on ${inv.dispositionOn ?? "an unknown date"}). This file is awaiting review again.`
      : inv.changed.includes("copy-untracked")
      ? `Your permanent copy is no longer tracked (kept on ${inv.dispositionOn ?? "an unknown date"}). This file is awaiting review again.`
      : inv.changed.includes("kept-incomplete")
      ? "The record of a kept copy is incomplete, so this file is awaiting review again."
      : `This file changed since you kept a copy on ${inv.dispositionOn ?? "an unknown date"} (${inv.changed.join(", ")}). It is awaiting review again.`
    : inv
    ? `Evidence changed since you ${inv.disposition === "dismissed" ? "dismissed" : "snoozed"} it on ${inv.dispositionOn ?? "an unknown date"}: ${inv.changed.join(", ")} changed.`
    : null;

  const receiptRow = receipt ? (["media-persist", "media-persist-rule", "media-move", "media-keep-copy", "media-delete"] as Row[]).find((r) => r.endsWith(receipt.action)) ?? "media-persist" : null;
  const problems = receipt?.files.filter((x) => x.state === "conflict" || x.state === "left-changed") ?? [];
  const outcomeBlock = outcome && outcome.status !== "stale" ? (
    <div data-media-outcome={receipt?.outcome ?? outcome.code ?? outcome.status} className="flex flex-col gap-2" role="alert">
      {receipt?.outcome === "partial" ? (
        <Callout tone="gold" variant="boxed">
          <span className="block">
            {receipt.action === "keep-copy" ? "Copy kept with problems" : receipt.action === "move" ? "Moved with problems" : receipt.action === "delete" ? "Deleted with problems" : "Persisted with problems"}: {problems.length} item{problems.length === 1 ? "" : "s"} couldn't be put back.
          </span>
          <TextButton ref={showFiles} label={filesOpen ? "Hide files ▴" : "Show files ▾"} expanded={filesOpen} onClick={() => setFilesOpen(!filesOpen)} />
          {filesOpen ? problems.map((p) => (
            <span key={p.path} className="block" style={mono(11)}>{p.path} · {p.state === "conflict" ? "conflict, edited after the change, left as is" : "changed, left as is"}</span>
          )) : null}
        </Callout>
      ) : receipt?.outcome === "compensated" ? (
        <>
          <div className="rounded-[10px] p-3" style={{ border: `1px solid ${color.edge}`, background: color.canvas }}>
            <div style={{ ...mono(10), textTransform: "uppercase", letterSpacing: "0.06em" }}>{ACTION[receiptRow!]} · NOT DONE</div>
            {receipt.reason ? <div style={mono(11)}>{receipt.reason}</div> : null}
            {receipt.files.map((x) => <div key={x.path} style={mono(11)}>{x.path} · {x.state === "removed" ? "partial copy removed" : x.state === "restored" ? "put back" : x.state === "unchanged" ? "not changed" : x.state}</div>)}
          </div>
          <Callout tone="gold" variant="boxed" text={`The ${receipt.action === "keep-copy" ? "copy" : receipt.action} didn't finish, so nothing was ${receipt.action === "keep-copy" ? "kept" : "changed"}. This file is still awaiting review. Check again to start over.`} />
        </>
      ) : outcome.code === "receipt-unknown" || receipt?.outcome === "pending" ? (
        <Callout tone="gold" variant="boxed" text="The outcome wasn't confirmed. Check again." />
      ) : (
        <Callout tone="red" variant="boxed" text={receipt?.refusals?.[0] ? refusalText(receipt.refusals[0], name) : outcome.reason ? refusalText({ code: outcome.reason }, name) : "The host refused this change. Nothing was changed."} />
      )}
    </div>
  ) : null;

  const canCheckAgain = !!row && !rowBlocked && (!needsText(row) || !!text.trim());
  return (
    <div ref={card} data-hygiene-id={item.id} data-hygiene-media="" onKeyDown={onKey}
      className="flex flex-wrap items-start gap-4 rounded-[14px] p-4" style={{ border: `1px solid ${color.edge}`, background: color.surface }}>
      <div className="flex min-w-0 flex-col gap-2" style={{ flex: "1 1 280px" }}>
        <div style={{ ...mono(10), letterSpacing: "0.04em" }}>
          <span style={{ color: "var(--bk-amber-ink)" }}>REVIEW</span> · media · {f.severity === "warning" ? "warning" : "info"}
        </div>
        <h3 data-hygiene-title="" tabIndex={-1} title={name} className="m-0 outline-none" style={{ font: `600 16px/1.3 ${font.body}`, color: color.ink, overflowWrap: "anywhere" }}>{name}</h3>
        <div style={mono(11)}>{f.path}</div>
        {keptGone ? <Callout tone="gold" variant="boxed" text={keptGone} /> : null}
        <MediaFrame key={f.path} path={f.path} bytes={detail?.bytes ?? 0} large={large} scratch={scratch} probe={probe} name={name} frameButton={frameButton} />
        {dims ? <div data-media-dims="" style={mono(11)}>{dims}</div> : null}
        <dl className="m-0 grid gap-x-3 gap-y-0.5" style={{ gridTemplateColumns: "auto 1fr", ...mono(11) }}>
          {facts.map(([k, v]) => [<dt key={`${k}-k`}>{k}</dt>, <dd key={`${k}-v`} className="m-0" style={{ color: color.inkDim }}>{v}</dd>])}
        </dl>
        <div id={groupLabel} style={{ ...mono(10), textTransform: "uppercase", letterSpacing: "0.06em" }}>WHAT SHOULD HAPPEN TO THIS FILE?</div>
        <div role="radiogroup" aria-labelledby={groupLabel} className="flex flex-col gap-2">
          {rows.map((r) => {
            const reason = unavailable(r);
            const label = options.get(r)!.label;
            return (
              <label key={r} data-media-row={r} data-unavailable={reason ? "" : undefined}
                style={{ ...fieldStyle, font: `400 13px/1.4 ${font.body}`, display: "flex", alignItems: "center", gap: 10, cursor: reason ? "default" : "pointer",
                  borderColor: row === r && !reason ? "var(--bk-teal-ink)" : color.edge, background: color.surface }}>
                <input type="radio" name={`${inputId}-media`} value={r} checked={row === r} aria-disabled={reason ? "true" : undefined}
                  aria-label={reason ? `${SHORT[r]}, unavailable: ${reason.replace(/\.$/, "").replace(/^./, (s) => s.toLowerCase())}` : SHORT[r]}
                  onChange={() => choose(r)} style={{ accentColor: "var(--bk-teal-ink)", flex: "none" }} />
                <span className="flex min-w-0 flex-col">
                  <span style={{ color: reason ? color.inkMute : color.ink }}>{label}</span>
                  {reason ? <span aria-hidden="true" style={{ fontSize: 11.5, color: color.inkMute }}>Unavailable: {reason.replace(/^./, (s) => s.toLowerCase())}</span> : null}
                </span>
              </label>
            );
          })}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-2" style={{ flex: "1 1 300px" }}>
        {row && needsText(row) && !rowBlocked ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={inputId} style={{ ...mono(10), textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {row === "media-persist-rule" ? "Rule (media.track pattern)" : "Destination (contained path)"}
            </label>
            <input id={inputId} type="text" value={text} spellCheck={false} autoComplete="off" aria-describedby={statusId}
              placeholder={row === "media-persist-rule" ? options.get(row)?.input?.example : undefined} style={fieldStyle}
              onChange={(e) => {
                const value = e.target.value;
                setTexts((t) => ({ ...t, [row]: value }));
                schedule(row, value, value.trim() ? 400 : 0);
              }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); schedule(row, text, 0); } }}
              onBlur={() => { if (text.trim() && !(preview && preview.row === row && preview.text === text)) schedule(row, text, 0); }} />
          </div>
        ) : null}
        {banner ? (
          <div ref={bannerRef} tabIndex={-1} role="alert" data-media-banner="" className="outline-none">
            <Callout tone="gold" variant="boxed" text={banner} />
          </div>
        ) : null}
        {row && !rowBlocked && (checking || current) ? (
          <section role="region" aria-label="Preview" aria-busy={checking} data-media-preview-region={checking ? "checking" : refused.length ? "refused" : "ready"}
            className="flex flex-col gap-1 rounded-[10px] p-3" style={{ border: `1px solid ${color.edge}`, background: color.canvas }}>
            <div className="flex flex-wrap justify-between gap-2" style={{ ...mono(10), textTransform: "uppercase", letterSpacing: "0.06em" }}>
              <span>{ACTION[row]} · {checking ? "CHECKING…" : refused.length ? "CAN'T DO THIS" : "PREVIEW"}</span>
              {!checking && current?.plan?.approvalDigest && !refused.length ? <span style={{ color: "var(--bk-amber-ink)" }}>needs your approval</span> : null}
            </div>
            {checking ? (
              <>
                <div style={mono(11)}>Reading brain.config.ts…</div>
                <div style={mono(11)}>Checking references and Git size…</div>
              </>
            ) : current?.plan && !refused.length ? <PlanLines row={row} plan={current.plan} name={name} source={f.path} /> : (
              <div style={mono(11)}>No file, link or rule was changed.</div>
            )}
          </section>
        ) : null}
        {outcomeBlock}
        <div className="flex flex-wrap gap-2 any-pointer-coarse:gap-y-4">
          <Button tone="affirm" size="md" block={false} reach label={commitLabel(row, current?.plan ?? null, name, !!rowBlocked || refused.length > 0)}
            disabled={locked || !applicable} ariaDescribedBy={statusId} onClick={apply} />
          <Button tone="ghost" size="md" block={false} reach label="Leave pending" disabled={locked} onClick={leave} />
          {(outcome && outcome.status !== "stale" && receipt?.outcome !== "partial") || (preview?.state === "failed" && preview.row === row) || refused.some((r) => r.code === "preview-busy") ? (
            <TextButton ref={recoveryRef} label={refused.some((r) => r.code === "preview-busy") || preview?.state === "failed" ? "Try again" : "Check again"}
              disabled={!canCheckAgain && !(outcome && (outcome.code === "receipt-unknown"))}
              onClick={() => {
                if (outcome?.code === "receipt-unknown" || receipt?.outcome === "pending") {
                  if (!online || !ready) return;
                  c.onSent(item.id);
                  root.connection.send({ type: "inbox_resolve", itemId: item.id, optionId: "check" });
                  void c.refresh();
                } else if (row) schedule(row, text, 0);
              }} />
          ) : null}
          {refused.some((r) => ["plan-unavailable", "stale", "not-detected"].includes(r.code)) ? (
            <TextButton label="Refresh finding" onClick={() => void c.command("refresh")} />
          ) : null}
        </div>
        {/* Two standing live regions: `status` for progress and ready, `alert` for refusals (rev 4 §8.4). */}
        <p id={statusId} data-media-status="" role="status" className="m-0" style={{ font: `400 12px/1.5 ${font.body}`, color: color.inkMute }}>
          {alerting ? "" : status}
        </p>
        <p data-media-alert="" role="alert" className="m-0" style={{ font: `400 12px/1.5 ${font.body}`, color: "var(--bk-red-ink)" }}>
          {alerting ? status : ""}
        </p>
      </div>
    </div>
  );
}

/**
 * The pass's media count line (rev 6 §2): `N` always, set-aside and kept
 * parts only when non-zero; omitted when the pass detected no media at all.
 */
export function mediaCountLine(media: { awaitingReview: number; setAside: number; kept: number } | undefined): string | null {
  if (!media || media.awaitingReview + media.setAside + media.kept === 0) return null;
  return [`Media awaiting review: ${media.awaitingReview}`, media.setAside ? `${media.setAside} set aside` : null, media.kept ? `${media.kept} kept as a copy` : null]
    .filter(Boolean).join(" · ");
}

const VERB: Record<HygieneMediaReceipt["action"], string> = { delete: "deleted", move: "moved", persist: "persisted", "keep-copy": "kept" };
function undoRefusal(reason: string | undefined, name: string, action: HygieneMediaReceipt["action"]) {
  if (reason === "rollback-evicted") return "Undo isn't available: rollback data was cleared to make room.";
  if (reason === "changed-since") return `${name} changed since it was ${VERB[action]}. Undo would delete your edits.`;
  return `Undo isn't available${reason ? `: ${reason.replace(/-/g, " ")}` : "."}`;
}

/**
 * This device's own applied media effect, kept above the next finding with
 * its Undo (rev 4 K3, rev 6 §5). Undo runs the host's preflights; a refusal
 * is a result, shown with its reason, and nothing is written.
 */
export function MediaReceipt({ item, controller: c }: { item: InboxActionItem; controller: HygieneController }) {
  const root = useBrainUiRoot();
  const online = useInboxStore((s) => s.online);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const outcome = item.hygiene?.outcome;
  const receipt = outcome?.media;
  if (!outcome || !receipt) return null;
  const path = String((item.hygiene?.finding as { path?: unknown } | undefined)?.path ?? item.payload.detail);
  const name = baseName(path);
  const plan = item.options.find((o) => o.media?.action === receipt.action && (o.effect as { premiseDigest?: string }).premiseDigest)?.media;
  const journal = `journal ${receipt.journalId.slice(-4)}`;
  const config = plan?.configDiff
    ? `media.track + ${plan.scope === "pattern" ? `"${plan.pattern}"` : "exact file"}`
    : plan && receipt.action !== "delete" ? "already tracked" : null;
  const linked = plan?.links.state === "linked";
  let title: string, detail: string;
  if (outcome.status === "undone") {
    title = `Undone · ${name} is awaiting review again`;
    detail = journal;
  } else if (receipt.action === "keep-copy") {
    title = `Kept a permanent copy at ${plan?.destination ?? "its destination"} · the original stays ${linked ? "linked to its conversation" : "in scratch"}`;
    detail = [receipt.copySha256 ? `verified sha ${receipt.copySha256.slice(0, 7)}` : null, config, `original unchanged in scratch${linked ? ", still linked" : ""}`, journal].filter(Boolean).join(" · ");
  } else if (receipt.action === "move") {
    const n = plan?.rewrites.length ?? 0;
    title = `Moved · ${plan?.destination ?? name}${n ? ` · ${n} link${n === 1 ? "" : "s"} updated` : ""}`;
    detail = [config, journal].filter(Boolean).join(" · ");
  } else if (receipt.action === "persist") {
    title = `Persisted · ${path}`;
    detail = [config, journal].filter(Boolean).join(" · ");
  } else {
    title = `Deleted · ${path}`;
    detail = [linked ? `Those ${plan!.links.conversations} conversation${plan!.links.conversations === 1 ? "" : "s"} will show a missing file` : null, journal].filter(Boolean).join(" · ");
  }
  // Apply records `available: false` without a reason: availability is read when asked. Only a recorded reason refuses.
  const unavailable = outcome.status !== "undone" && !receipt.undo.available && receipt.undo.reason ? undoRefusal(receipt.undo.reason, name, receipt.action) : null;
  async function undo() {
    setBusy(true);
    setRefusal(null);
    try {
      const read = await root.api.hygieneMediaUndo(receipt!.journalId);
      c.setRead(read);
      const result = read.mediaUndo;
      if (result && result.outcome !== "undone" && result.outcome !== "partial") setRefusal(undoRefusal(result.reason, name, receipt!.action));
      setConfirming(false);
      void c.refresh();
    } catch {
      setRefusal("Couldn't undo. Check the connection and try again. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div data-media-receipt={outcome.status} role="status" className="flex flex-col gap-1 rounded-[14px] p-4" style={{ border: `1px solid ${color.edge}`, background: color.surface }}>
      <span style={{ font: `600 14px/1.35 ${font.body}`, color: color.ink, overflowWrap: "anywhere" }}>{title}</span>
      <span style={mono(11)}>{detail}</span>
      {unavailable || refusal ? <span role="alert" style={{ font: `400 12px/1.5 ${font.body}`, color: color.inkMute }}>{refusal ?? unavailable}</span> : null}
      {outcome.status !== "undone" && !unavailable ? (
        confirming ? (
          <div className="flex flex-wrap gap-2 any-pointer-coarse:gap-y-4">
            <Button tone="danger" size="md" block={false} reach label={busy ? "Undoing…" : "Confirm undo"} disabled={busy || !online} onClick={() => void undo()} />
            <Button tone="ghost" size="md" block={false} reach label="Cancel" disabled={busy} onClick={() => { setConfirming(false); requestAnimationFrame(() => undoButton.current?.focus()); }} />
          </div>
        ) : (
          <TextButton ref={undoButton} label="Undo…" ariaLabel={`Undo: ${title}`} disabled={!online} onClick={() => setConfirming(true)} />
        )
      ) : null}
    </div>
  );
}
