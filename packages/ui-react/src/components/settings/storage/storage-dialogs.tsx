import { useEffect, useRef, useState } from "react";
import { Button, Overlay } from "@schlessera/brain-ui-kit";
import type { BrainUiRoot } from "../../../root.js";
import { bytes, exactBytes, humanReason, time } from "./storage-model.js";
import { StorageDelta } from "./storage-observations.js";
import { running, type StorageView } from "./use-storage.js";
const touch = { minHeight: 44 };
export function StorageDialogs({
  view,
  root,
  phone,
  returnFocus,
}: {
  view: StorageView;
  root: BrainUiRoot;
  phone: boolean;
  returnFocus: () => HTMLElement | null;
}) {
  const fileHeading = useRef<HTMLHeadingElement>(null),
    reviewHeading = useRef<HTMLHeadingElement>(null);
  const file = view.inspected,
    receipt = view.receipt,
    review = receipt?.review,
    eligible = review?.files.filter((item) => item.eligible) ?? [];
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!review || receipt?.state !== "review") return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(1, review.expiresAt - Date.now())
    );
    return () => clearTimeout(timer);
  }, [review, receipt?.state]);
  const terminal =
    !!receipt && receipt.state !== "review" && !running(receipt.state);
  useEffect(() => {
    if (view.reviewOpen) reviewHeading.current?.focus();
  }, [view.reviewOpen, receipt?.state]);
  function openFile() {
    if (!file?.path) return;
    view.setInspected(null);
    root.stores.ui.getState().pressDestination("files");
    void root.stores.file.getState().openFile(file.path);
  }
  return (
    <>
      <Overlay
        open={!!file}
        variant={phone ? "fullscreen" : "dialog"}
        size="lg"
        label="Inspect storage file"
        initialFocus={fileHeading}
        returnFocus={returnFocus}
        onClose={() => view.setInspected(null)}
      >
        {file && (
          <div
            className="grid min-w-0 gap-4 p-4 text-sm break-words"
            style={{ overflowWrap: "anywhere" }}
          >
            <h2
              ref={fileHeading}
              tabIndex={-1}
              className="text-lg font-semibold"
            >
              {file.entry.name}
            </h2>
            <p>
              {file.path ?? file.entry.path} · {bytes(file.entry.logical)} file
              size ({exactBytes(file.entry.logical)})
            </p>
            <p>
              On disk: {bytes(file.entry.allocated)} estimate (
              {exactBytes(file.entry.allocated)}).{" "}
              {file.entry.links > 1
                ? `${file.entry.links} known hard links; shared object, counted once in the map.`
                : ""}
            </p>
            <p>
              Git: {file.facts?.git ?? "unknown"}. Removing keeps Git history.
            </p>
            <p>
              Eligibility:{" "}
              {view.busy
                ? "Checking current version…"
                : file.facts?.eligible
                ? "Eligible after review and retention"
                : file.facts
                ? humanReason(file.facts.reason)
                : "Not verified"}
              .
            </p>
            <p>
              Undo:{" "}
              {file.facts?.eligible
                ? "A retained before-version is required; subject to journal retention."
                : "No Undo available for this selection."}
            </p>
            {file.error && <p role="alert">{file.error}</p>}
            <section className="grid gap-2">
              <h3 className="font-semibold">References</h3>
              {file.facts ? (
                <>
                  <p>
                    Current source review:{" "}
                    {file.observedAt ? time(file.observedAt) : "unknown"}.{" "}
                    {file.facts.references.length
                      ? "These links remain after removal and may break."
                      : "No references found in the checked scope."}
                  </p>
                  <ul>
                    {file.facts.references.map((reference) => (
                      <li key={reference.source}>
                        {reference.source} · {reference.certainty}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>Current references unknown.</p>
              )}
              {file.references?.state === "observed" && (
                <p>
                  Indexed evidence: {file.references.sources.length} source(s),
                  observed {time(file.references.observedAt)}. Index freshness
                  is unchecked
                  {file.references.truncated ? "; results truncated" : ""}.
                </p>
              )}
              <p>
                Unchecked:{" "}
                {[
                  ...new Set([
                    ...(file.unchecked.length
                      ? file.unchecked
                      : [
                          "conversations",
                          "other workspaces",
                          "external consumers",
                        ]),
                    ...(file.references?.unchecked ?? []),
                  ]),
                ].join(", ")}
                . An empty result does not prove no references.
              </p>
            </section>
            {!view.capability?.available && (
              <p>
                This host can't remove attachments yet.{" "}
                {humanReason(view.capability?.reason ?? null)}
              </p>
            )}
            {file.path && (
              <div className="flex flex-wrap gap-2">
                <Button
                  label="Preview"
                  block={false}
                  style={touch}
                  onClick={openFile}
                />
                <Button
                  label="Open in Files"
                  block={false}
                  style={touch}
                  onClick={openFile}
                />
              </div>
            )}
            <Button
              label={
                view.selected[file.entry.id] ? "Deselect file" : "Select file"
              }
              ariaLabel={
                view.selected[file.entry.id] ? "Deselect file" : "Select file"
              }
              subtitle={
                !file.facts?.eligible
                  ? file.facts
                    ? humanReason(file.facts.reason)
                    : "Inspect current eligibility before selecting"
                  : undefined
              }
              disabled={
                view.busy ||
                !file.facts?.eligible ||
                running(receipt?.state) ||
                receipt?.state === "unknown"
              }
              style={touch}
              onClick={() => {
                view.toggle(file);
                view.setInspected(null);
              }}
            />
            <Button
              label="Back to results"
              tone="quiet"
              style={touch}
              onClick={() => view.setInspected(null)}
            />
          </div>
        )}
      </Overlay>
      <Overlay
        open={view.reviewOpen && !!receipt}
        variant={phone ? "fullscreen" : "dialog"}
        size="lg"
        label={
          receipt?.state === "review"
            ? "Review attachment operation"
            : "Attachment operation result"
        }
        initialFocus={reviewHeading}
        returnFocus={returnFocus}
        onClose={() => view.setReviewOpen(false)}
      >
        {receipt && review && (
          <div
            className="grid min-w-0 gap-4 p-4 text-sm"
            style={{ overflowWrap: "anywhere" }}
          >
            <h2
              ref={reviewHeading}
              tabIndex={-1}
              className="text-lg font-semibold"
            >
              {receipt.state === "review"
                ? review.action === "undo"
                  ? "Review Undo"
                  : `Remove ${eligible.length} ${
                      eligible.length === 1 ? "file" : "files"
                    }?`
                : running(receipt.state)
                ? "Operation in progress"
                : `Operation ${receipt.state}`}
            </h2>
            {receipt.state === "review" ? (
              <>
                <p>
                  Review measured {time(review.observedAt)}. Exact selected
                  versions: {bytes(review.selectedFileBytes)} file size, not
                  space freed.
                </p>
                <ul className="grid gap-3">
                  {review.files.map((item) => (
                    <li
                      key={item.path}
                      className="rounded border border-border p-3"
                    >
                      <p className="font-semibold">{item.path}</p>
                      <p>
                        {exactBytes(item.bytes)} · {item.git} ·{" "}
                        {item.eligible
                          ? "Eligible; original must be retained"
                          : `Excluded: ${humanReason(item.reason)}`}
                      </p>
                      <p>
                        {item.references.length
                          ? `${
                              item.references.length
                            } link(s) remain and may break: ${item.references
                              .map((reference) => reference.source)
                              .join(", ")}`
                          : "No references found in checked scope; other consumers remain unknown."}
                      </p>
                    </li>
                  ))}
                </ul>
                <p>
                  Unchecked:{" "}
                  {review.unchecked.join(", ") || "external consumers"}. Links
                  are not rewritten. Git history stays. Undo bytes remain in the
                  journal; disk use may not drop.
                </p>
                {view.reviewChanged && (
                  <p role="alert">
                    A selected version changed. Keep files, inspect the current
                    version and review the selection again.
                  </p>
                )}
                {review.expiresAt <= now && (
                  <p role="alert">
                    Review expired. Keep files and make a fresh review.
                  </p>
                )}
                <Button
                  label={
                    review.action === "undo"
                      ? `Restore ${eligible.length} ${
                          eligible.length === 1 ? "file" : "files"
                        }`
                      : `Remove ${eligible.length} ${
                          eligible.length === 1 ? "file" : "files"
                        }`
                  }
                  ariaLabel={`${
                    review.action === "undo" ? "Restore" : "Remove"
                  } ${eligible.length} ${
                    eligible.length === 1 ? "file" : "files"
                  }`}
                  effect={review.action === "undo" ? "restore" : "remove"}
                  style={touch}
                  disabled={
                    view.busy ||
                    view.reviewChanged ||
                    !eligible.length ||
                    review.expiresAt <= now
                  }
                  onClick={() => void view.confirm()}
                />
                <Button
                  label="Keep files"
                  tone="quiet"
                  style={touch}
                  onClick={() => view.setReviewOpen(false)}
                />
              </>
            ) : (
              <>
                <p role="status">
                  {
                    receipt.items.filter((item) => item.state === "removed")
                      .length
                  }{" "}
                  removed ·{" "}
                  {
                    receipt.items.filter((item) => item.state === "restored")
                      .length
                  }{" "}
                  restored ·{" "}
                  {
                    receipt.items.filter((item) =>
                      [
                        "changed",
                        "protected",
                        "failed",
                        "not-started",
                        "unknown",
                      ].includes(item.state)
                    ).length
                  }{" "}
                  other outcomes
                </p>
                {receipt.reason && <p>{humanReason(receipt.reason)}</p>}
                {receipt.state === "unknown" && (
                  <p>
                    The outcome is unconfirmed. Check this original receipt; do
                    not repeat the removal.
                  </p>
                )}
                <ul className="grid gap-3">
                  {receipt.items.map((item) => (
                    <li
                      key={item.path}
                      className="rounded border border-border p-3"
                    >
                      <p>
                        {item.path}: {humanReason(item.state)}
                        {item.reason ? ` · ${humanReason(item.reason)}` : ""}
                      </p>
                      {item.undoAvailable ? (
                        <Button
                          label="Undo removal"
                          ariaLabel={`Undo removal of ${item.path}`}
                          style={touch}
                          disabled={view.busy || running(receipt.state)}
                          onClick={() => void view.undo(item.path)}
                        />
                      ) : (
                        item.state === "removed" && (
                          <p>
                            Undo unavailable: {humanReason(item.undoReason)}
                          </p>
                        )
                      )}
                    </li>
                  ))}
                </ul>
                {running(receipt.state) && (
                  <Button
                    label="Cancel remaining files"
                    tone="quiet"
                    style={touch}
                    disabled={view.busy}
                    onClick={() => void view.cancelRemoval()}
                  />
                )}
                <Button
                  label="Check original receipt"
                  tone="quiet"
                  style={touch}
                  disabled={view.busy}
                  onClick={() => void view.checkReceipt()}
                />
                {terminal && (
                  <>
                    <StorageDelta
                      before={receipt.before}
                      after={receipt.after}
                    />
                    <p>
                      Index refresh: {humanReason(receipt.index)}. Deletion
                      commit: not requested. Remote sync: not requested. Git
                      history unchanged; backups not measured.
                    </p>
                  </>
                )}
                <Button
                  label="Return to filtered list"
                  tone="quiet"
                  style={touch}
                  onClick={() => view.setReviewOpen(false)}
                />
              </>
            )}
            {view.error && <p role="alert">{view.error}</p>}
          </div>
        )}
      </Overlay>
    </>
  );
}
