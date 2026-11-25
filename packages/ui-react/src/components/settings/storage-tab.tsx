import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Button,
  Callout,
  StorageSummaryRow,
  Sparkline,
  TextButton,
  VolumeGroup,
} from "@schlessera/brain-ui-kit";
import type { StorageFileEntry } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import type { BrainUiRoot } from "../../root.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import { WIDE_CONTENT } from "./prose.js";
import { StorageDialogs } from "./storage/storage-dialogs.js";
import { useStorageGuidance } from "./storage/use-storage-guidance.js";
import { useStorage } from "./storage/use-storage.js";
import {
  STORAGE_GAUGE_THRESHOLDS,
  latestInventory,
  storageFormat,
  storageVolumes,
} from "./storage/storage-volumes.js";
import {
  appUsage,
  storageBanner,
  storageStatusLine,
} from "./storage/storage-pane-model.js";
import { StorageAlertsRow } from "./storage/storage-alerts.js";
import { StorageHistorySection } from "./storage/storage-history-section.js";
import { StorageBreakdown } from "./storage/storage-breakdown.js";
import { StorageLargeFiles } from "./storage/storage-large-files.js";
import { StorageFreeUp } from "./storage/storage-free-up.js";
import { StorageAbout } from "./storage/storage-about.js";
/** Account and root changes discard pending selections and local response ownership synchronously. */
export function StorageTab({ active }: { active: boolean }) {
  const root = useBrainUiRoot(),
    rootKey = useMemo(() => crypto.randomUUID(), [root]);
  const epoch = useSyncExternalStore(
    root.authLock.state.subscribe,
    () => `${root.authLock.epoch()}:${root.authLock.state.getState().phase}`,
    () => `${root.authLock.epoch()}:${root.authLock.state.getState().phase}`
  );
  return active && root.authLock.state.getState().phase === "active" ? (
    <StorageSession key={`${rootKey}:${epoch}`} root={root} />
  ) : null;
}
/**
 * The Storage pane (#4549), in the approved order: header with status line
 * and Alerts, the Low / Very low banner, volume cards, available space over
 * time, what's using space (overview or Find large files mode), Free up
 * space, and About these numbers. Storage is a wide Settings pane (#4538), so
 * the pane has no width cap of its own beyond the wide pane's content cap.
 */
function StorageSession({ root }: { root: BrainUiRoot }) {
  const guidance = useStorageGuidance(root, true);
  const view = useStorage(root),
    phone = useMediaQuery("(max-width: 599px)"),
    id = useId();
  const format = useMemo(() => storageFormat(), []);
  const heading = useRef<HTMLHeadingElement>(null),
    findHeading = useRef<HTMLHeadingElement>(null),
    findButton = useRef<HTMLDivElement>(null),
    backButton = useRef<HTMLDivElement>(null),
    keepButton = useRef<HTMLDivElement>(null),
    freeUp = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLElement | null>(null),
    entering = useRef(false),
    leaving = useRef(false);
  const [now, setNow] = useState(Date.now()),
    [chosenVolume, setChosenVolume] = useState<string | null>(null),
    [confirmBack, setConfirmBack] = useState(false),
    [said, setSaid] = useState("");
  useEffect(() => {
    if (!view.snapshot) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(1, view.snapshot.staleAfter - Date.now())
    );
    return () => clearTimeout(timer);
  }, [view.snapshot]);
  const refreshGuidance = guidance.refresh;
  const observed = Math.max(view.status?.snapshot?.observedAt ?? 0, view.status?.previous?.observedAt ?? 0, view.status?.lastFailure?.at ?? 0);
  useEffect(() => { if (observed) void refreshGuidance(); }, [observed, refreshGuidance]);
  // The hook's own announcement replaces the pane's.
  useEffect(() => setSaid(""), [view.announcement]);

  const snapshot = view.snapshot;
  const inventory = guidance.inventory ?? latestInventory(view.status);
  const volumes = useMemo(
    () => storageVolumes({ guidance: guidance.guidance, inventory, history: guidance.history, format }),
    [guidance.guidance, inventory, guidance.history, format]
  );
  const volume = volumes.find((value) => value.id === chosenVolume) ?? volumes[0] ?? null;
  const banner = storageBanner(volumes, guidance.guidance, format);
  const status = storageStatusLine({ status: view.status, snapshot, now, format, unavailable: !!view.error });
  const pressure = volume ? guidance.guidance?.capacities.find((value) => value.identity === volume.id) ?? null : null;
  const usage = useMemo(
    () =>
      volume
        ? appUsage({ pressure, history: guidance.history, identity: volume.id, metric: view.metric, now, format })
        : null,
    [volume, pressure, guidance.history, view.metric, now, format]
  );

  // Find large files: focus the mode's heading on entry, announce its count once loaded.
  useEffect(() => {
    if (view.filtering && entering.current) findHeading.current?.focus();
    if (!view.filtering && leaving.current) {
      leaving.current = false;
      findButton.current?.querySelector<HTMLElement>('[role="button"]')?.focus();
    }
  }, [view.filtering]);
  useEffect(() => {
    if (!view.filtering || view.loading || !view.files) return;
    const count = `${view.files.matched} matching PDFs`;
    setSaid(entering.current ? `Find large files. ${count}.` : count);
    entering.current = false;
  }, [view.filtering, view.loading, view.files]);
  useEffect(() => {
    if (confirmBack) keepButton.current?.querySelector<HTMLElement>('[role="button"]')?.focus();
  }, [confirmBack]);

  function enterFind() {
    entering.current = true;
    view.setFiltering(true);
    view.setSearch("");
    view.setCursor(undefined);
  }
  function leaveFind() {
    setConfirmBack(false);
    leaving.current = true;
    view.setFiltering(false);
    view.setSearch("");
    view.setCursor(undefined);
    // The owner switch and breadcrumb keep their state through the mode, so
    // the overview returns where it was left; only search is cleared.
    setSaid(`Overview. ${view.tree?.name ?? "All stores"}.`);
  }
  function requestBack() {
    if (view.selection.length) setConfirmBack(true);
    else leaveFind();
  }
  function open(entry: StorageFileEntry) {
    trigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    void view.inspect(entry);
  }
  const returning = () =>
    trigger.current?.isConnected ? trigger.current : heading.current;
  function toFreeUp() {
    const target = freeUp.current?.querySelector<HTMLElement>("h3");
    if (!target) return;
    target.tabIndex = -1;
    target.scrollIntoView?.({ block: "start" });
    target.focus();
  }

  const headerAction =
    status.action === "cancel" ? (
      <Button
        label="Cancel"
        ariaLabel="Cancel measurement"
        tone="quiet"
        size="sm"
        reach
        block={false}
        disabled={view.busy}
        onClick={() => void view.cancelScan()}
      />
    ) : status.action ? (
      <Button
        label={status.action === "measure" ? "Measure" : "Measure again"}
        tone={status.action === "measure" ? "primary" : "quiet"}
        size="sm"
        reach
        block={false}
        disabled={view.busy}
        onClick={() => void view.refresh()}
      />
    ) : null;

  return (
    <div className="@container/storage min-h-0 flex-1 overflow-y-auto" data-storage-pane="">
      <span role="status" aria-live="polite" className="sr-only">
        {said || view.announcement}
      </span>
      <div
        className={`grid w-full min-w-0 gap-6 p-3 text-sm @[560px]/storage:p-5 ${WIDE_CONTENT}`}
        style={{ overflowWrap: "anywhere" }}
      >
        <header className="grid min-w-0 gap-2">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
              Storage
            </h2>
            {headerAction}
          </div>
          {/* A div, not a p: the Show button is a block element. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 font-mono text-xs text-muted-foreground" data-storage-status={status.state}>
            <span aria-hidden="true">{status.glyph}</span>
            <span className="min-w-0">{status.text}</span>
            {snapshot && view.newest && view.newest.id !== snapshot.id && (
              <>
                <span aria-hidden="true">·</span>
                <span>New measurement ready</span>
                <Button
                  label="Show"
                  ariaLabel="Show new measurement"
                  subtitle={view.selection.length ? "Clears selections from the previous observation" : undefined}
                  tone="quiet"
                  size="sm"
                  reach
                  block={false}
                  onClick={view.adopt}
                />
              </>
            )}
          </div>
          <StorageAlertsRow
            notifications={guidance.guidance?.notifications ?? null}
            onDevices={() => root.stores.ui.getState().setSettingsTab("devices")}
          />
          {view.error && (
            <div role="alert" className="grid justify-items-start gap-2">
              <p>{view.error}</p>
              <Button
                label="Check measurement status"
                tone="quiet"
                size="sm"
                reach
                block={false}
                disabled={view.busy}
                onClick={() => void view.checkStatus()}
              />
            </div>
          )}
        </header>
        {banner && (
          <div data-storage-banner={banner.severity}>
            <Callout variant="boxed" tone={banner.severity === "critical" ? "red" : "gold"} icon={banner.severity === "critical" ? "failed" : "fyi"}>
              <span className="grid max-w-[68ch] gap-1">
                <strong className="font-semibold text-foreground">{banner.title}</strong>
                <span>{banner.text}</span>
                <span>
                  <TextButton inline label="Free up space ↓" ariaLabel="Free up space" onClick={toFreeUp} />
                </span>
              </span>
            </Callout>
          </div>
        )}
        {volumes.length > 0 && (
          <section aria-label="Volumes" className="grid min-w-0 gap-2" data-storage-volumes="">
            <VolumeGroup
              volumes={volumes}
              selected={volume?.id}
              onSelect={setChosenVolume}
              thresholds={STORAGE_GAUGE_THRESHOLDS}
              format={format.bytes}
              label="Volumes"
            />
            {volumes.length > 1 && (
              <p className="font-mono text-xs text-muted-foreground">Each volume is measured on its own · never added together</p>
            )}
          </section>
        )}
        <StorageHistorySection
          volume={volume}
          guidance={guidance.guidance}
          history={guidance.history}
          maintenance={view.maintenance}
          unavailable={guidance.error !== null}
          now={now}
          format={format}
        />
        {snapshot && (
          <section aria-labelledby={`${id}-breakdown`} className="grid min-w-0 gap-3" data-storage-breakdown-section="">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              {view.filtering ? (
                <h3 id={`${id}-breakdown`} ref={findHeading} tabIndex={-1} className="font-semibold">
                  Find large files
                </h3>
              ) : (
                <h3 id={`${id}-breakdown`} className="font-semibold">
                  What's using space
                </h3>
              )}
              {view.filtering ? (
                confirmBack ? (
                  <div role="group" aria-label="Discard selection" className="flex flex-wrap items-center gap-3 text-xs">
                    <span>Discard {view.selection.length} selected {view.selection.length === 1 ? "file" : "files"}?</span>
                    <div ref={keepButton}>
                      <Button label="Keep selection" tone="quiet" size="sm" reach block={false} onClick={() => {
                        setConfirmBack(false);
                        requestAnimationFrame(() => backButton.current?.querySelector<HTMLElement>('[role="button"]')?.focus());
                      }} />
                    </div>
                    <Button label="Discard" tone="danger" size="sm" reach block={false} onClick={() => {
                      view.clearSelection();
                      leaveFind();
                    }} />
                  </div>
                ) : (
                  <div ref={backButton}>
                    <Button label="Back to overview" tone="quiet" size="sm" reach block={false} onClick={requestBack} />
                  </div>
                )
              ) : (
                <div ref={findButton}>
                  <Button label="Find large files" size="sm" reach block={false} onClick={enterFind} />
                </div>
              )}
            </div>
            {view.filtering ? (
              <StorageLargeFiles
                view={view}
                onInspect={open}
                onReview={() => {
                  trigger.current = document.activeElement as HTMLElement;
                  void view.reviewSelection();
                }}
                onReceipt={() => {
                  trigger.current = document.activeElement as HTMLElement;
                  view.setReviewOpen(true);
                }}
              />
            ) : (
              <StorageBreakdown
                view={view}
                snapshot={snapshot}
                onInspect={open}
                summary={
                  volume && usage ? (
                    <StorageSummaryRow
                      chart={<Sparkline points={usage.points} label={`${usage.spoken} on ${volume.name}`} showValue={false} />}
                      value={usage.value}
                      window={usage.window}
                    />
                  ) : undefined
                }
              />
            )}
          </section>
        )}
        <div ref={freeUp} data-storage-free-up="">
          <StorageFreeUp
            view={view}
            guidance={guidance.guidance}
            format={format}
            inventory={inventory}
            volumes={volumes}
            selected={volume?.id ?? null}
          />
        </div>
        <StorageAbout
          snapshot={snapshot}
          files={view.filtering ? view.files : null}
          larger={view.larger}
          validThreshold={view.validThreshold}
          guidance={guidance.guidance}
        />
      </div>
      <StorageDialogs
        view={view}
        root={root}
        phone={phone}
        returnFocus={returning}
      />
    </div>
  );
}
