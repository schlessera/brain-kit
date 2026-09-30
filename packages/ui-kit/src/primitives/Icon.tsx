/**
 * The ONLY place in the kit an icon set is referenced.
 *
 * The design's own note on this file: "keep the semantic keys in SET, repoint
 * the values to the new set's names... Nothing else in the kit names an icon —
 * components only pass semantic keys like `approval`." That property is what
 * makes an icon-set swap a one-file change, so it is preserved exactly.
 *
 * WHAT WAS DELIBERATELY NOT PORTED. The source emits `<i data-lucide="…">` and
 * calls `window.lucide.createIcons()` on mount, on a 300 ms timer and on every
 * update; Lucide then REPLACES that `<i>` with an `<svg>` behind React's back.
 * That is the one component in the kit whose output does not follow from its
 * props, and the React version is strictly better: `lucide-react` renders the
 * glyph directly, so swapping `icon` swaps the glyph, with no imperative
 * escape hatch and no timer.
 *
 * 78 keys, 76 distinct glyphs. Two pairs are aliases — `deny`/`dismiss` both
 * render an x, `settings`/`filter` both render sliders — and all 78 are kept.
 * They render identically today but mean different things, and collapsing them
 * would leave a future icon set unable to tell them apart.
 *
 * Two glyphs resolve in lucide 0.460 only through DEPRECATED aliases
 * (`more-horizontal`, `bar-chart-3`). They are mapped to the canonical exports
 * so a lucide major that drops the aliases cannot silently blank two icons.
 * The semantic keys `more` and `health` are unchanged: only the right-hand
 * side is an implementation detail.
 *
 * `tests/icon-map.test.ts` asserts every key resolves to a real `lucide-react`
 * export — which turns a whole class of silent blank-icon failures into a red
 * build.
 */

import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  GripVertical,
  AlarmClock,
  ArrowUp,
  ArrowUpRight,
  BatteryFull,
  Bell,
  Bookmark,
  Bot,
  Brain,
  CalendarCheck,
  CalendarDays,
  ChartColumn,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  Clock,
  Copy,
  CopyCheck,
  Cpu,
  Download,
  Ellipsis,
  EllipsisVertical,
  FileImage,
  FileLock2,
  FilePenLine,
  FileText,
  Fingerprint,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderTree,
  GitPullRequestClosed,
  Hand,
  History,
  Inbox,
  Info,
  KeyRound,
  Layers,
  ListChecks,
  Lock,
  MessageCircleQuestion,
  MessageSquare,
  Mic,
  Newspaper,
  Paperclip,
  Pause,
  Play,
  Plus,
  Receipt,
  RefreshCw,
  Repeat,
  RotateCcw,
  Rss,
  Search,
  Share2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  Sunrise,
  Telescope,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  Wallet,
  Waypoints,
  Wifi,
  X,
} from "lucide-react";

import { warnOnce } from "../internal/dev.js";

/**
 * Semantic key -> Lucide glyph. Order follows the source, so the two files
 * stay comparable line by line.
 */
export const ICONS = {
  reorder: GripVertical,
  brain: Brain,
  approval: ShieldQuestion,
  choose: ListChecks,
  fyi: Info,
  failed: TriangleAlert,
  quarantined: FileLock2,
  unverified: CircleHelp,
  resolved: CheckCheck,
  confirm: Check,
  deny: X,
  later: Clock,
  dismiss: X,
  revert: RotateCcw,
  cancel: GitPullRequestClosed,
  capability: KeyRound,
  scope: Lock,
  policy: ShieldAlert,
  trust: Shield,
  thread: FolderGit2,
  file: FileText,
  image: FileImage,
  folder: Folder,
  "folder-open": FolderOpen,
  edit: FilePenLine,
  search: Search,
  graph: Waypoints,
  history: History,
  files: FolderTree,
  activity: Activity,
  settings: SlidersHorizontal,
  compose: SquarePen,
  more: Ellipsis,  // lucide renames `more-horizontal`; the semantic key is the kit's vocabulary
  menu: EllipsisVertical,
  attach: Paperclip,
  mic: Mic,
  send: ArrowUp,
  add: Plus,
  share: Share2,
  bookmark: Bookmark,
  copy: Copy,
  retry: RefreshCw,
  up: ThumbsUp,
  down: ThumbsDown,
  steps: Layers,
  agent: Bot,
  researcher: Telescope,
  filer: Inbox,
  watcher: Rss,
  ledger: Receipt,
  model: Cpu,
  wallet: Wallet,
  bell: Bell,
  passkey: Fingerprint,
  secure: ShieldCheck,
  install: Download,
  pause: Pause,
  hand: Hand,
  next: ChevronRight,
  back: ChevronLeft,
  expand: ChevronUp,
  collapse: ChevronDown,
  ask: MessageCircleQuestion,
  deadline: AlarmClock,
  suggestion: Sparkles,
  sunrise: Sunrise,
  calendar: CalendarDays,
  "calendar-ok": CalendarCheck,
  repeat: Repeat,
  dedupe: CopyCheck,
  digest: Newspaper,
  health: ChartColumn,  // lucide renames `bar-chart-3`; the semantic key is the kit's vocabulary
  link: ArrowUpRight,
  chat: MessageSquare,
  wifi: Wifi,
  battery: BatteryFull,
  run: Play,
  filter: SlidersHorizontal,
} as const satisfies Record<string, LucideIcon>;

/** Every semantic name the kit knows. The kit's icon vocabulary. */
export type IconName = keyof typeof ICONS;

export interface IconProps {
  /** Semantic key, not a glyph name. */
  icon?: IconName;
  /** Box edge in px; the glyph is drawn at the same size. */
  size?: number;
  /** Any CSS colour. Defaults to `currentColor`, so an icon inside a Chip or a
   * Button takes that component's colour without being told. */
  color?: string;
  strokeWidth?: number;
}

export function Icon({ icon = "brain", size = 16, color, strokeWidth = 2 }: IconProps) {
  // Ported verbatim from renderVals(): the box is an inline-flex square that
  // centres the glyph and refuses to shrink.
  const box: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
    width: size,
    height: size,
    color: color || "currentColor",
  };

  const Glyph = ICONS[icon] as LucideIcon | undefined;
  if (!Glyph) {
    // DC resolved an unknown key to `SET[key] || key` and handed it to Lucide,
    // which left the element empty. React renders the same empty box — but the
    // DC runtime also warned on an unresolved hole and React is silent, so the
    // warning is re-created here. (runtime-to-react.md §8.5)
    warnOnce(`Icon: unknown semantic key "${icon}". Nothing will render.`);
    return <span style={box} />;
  }

  return (
    <span style={box}>
      <Glyph width={size} height={size} strokeWidth={strokeWidth} />
    </span>
  );
}
