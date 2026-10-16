import { useEffect, useRef, useState } from "react";
import type { Issue } from "@webdoctor/core/shared";
import { artifactUrl } from "../lib/api";
import { issueBoxes, toOverlay } from "../lib/geometry";
import { findPage, pathOf } from "../lib/model";
import type { Model } from "../lib/model";
import { t } from "../lib/strings";

export type ViewportName = "desktop" | "mobile";

interface Props {
  model: Model;
  runId: string;
  pageUrl: string | null;
  viewport: ViewportName;
  onViewport: (v: ViewportName) => void;
  onPage: (url: string) => void;
  /** Issues listed on this page+viewport, drawn as boxes. */
  pageIssues: Issue[];
  selectedIssueId: string | null;
  hoverIssueId: string | null;
  onSelectIssue: (id: string) => void;
}

export function Viewer(props: Props) {
  const { model, runId, pageUrl, viewport, pageIssues, selectedIssueId, hoverIssueId } = props;
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState<"fit" | "actual">("fit");
  const [shownWidth, setShownWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const page = pageUrl ? findPage(model, pageUrl, viewport) : undefined;
  const shotKey = page?.screenshotKey;
  const selected = pageIssues.find((i) => i.id === selectedIssueId);

  // A new screenshot has an unknown size until it loads.
  useEffect(() => setNatural(null), [shotKey, runId]);

  // Track the on-screen width so we can say how much the screenshot is scaled down.
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !natural) return;
    const measure = () => setShownWidth(img.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(img);
    return () => observer.disconnect();
  }, [natural, zoom, shotKey]);

  // Bring the selected highlight into view.
  useEffect(() => {
    if (!natural || !selectedIssueId) return;
    const el = [
      ...(scrollRef.current?.querySelectorAll<HTMLElement>("[data-issue-id]") ?? []),
    ].find((n) => n.dataset.issueId === selectedIssueId);
    el?.scrollIntoView?.({ block: "center", inline: "nearest" });
  }, [selectedIssueId, natural, shotKey]);

  const boxesFor = (issue: Issue) =>
    natural
      ? issueBoxes(issue)
          .map((b) => toOverlay(b, natural))
          .filter((b): b is NonNullable<typeof b> => b !== null)
      : [];

  const selectedHasBox = selected ? boxesFor(selected).length > 0 : true;
  const onlyOther =
    selected && selected.viewport !== "all" && selected.viewport !== viewport
      ? selected.viewport
      : null;

  return (
    <section className="viewer" aria-label="Page preview">
      <div className="viewer-bar">
        <label className="grow">
          <span className="sr-only">{t.previewedPage}</span>
          <select
            className="input"
            value={pageUrl ?? ""}
            onChange={(e) => props.onPage(e.target.value)}
          >
            {pageUrl && !model.pageUrls.includes(pageUrl) && (
              <option value={pageUrl}>{pathOf(pageUrl)}</option>
            )}
            {model.pageUrls.map((u) => (
              <option key={u} value={u}>
                {pathOf(u)}
              </option>
            ))}
          </select>
        </label>
        <div className="seg" role="group" aria-label={t.viewport}>
          {(["desktop", "mobile"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={viewport === v}
              onClick={() => props.onViewport(v)}
            >
              {v === "desktop" ? t.desktop : t.mobile}
            </button>
          ))}
        </div>
      </div>

      {natural && (
        <div className="viewer-sub">
          <span className="muted small">
            {natural.width} × {natural.height} px
            {shownWidth > 0 && ` · shown at ${Math.round((shownWidth / natural.width) * 100)}%`}
          </span>
          <div className="seg seg-small" role="group" aria-label="Zoom">
            <button type="button" aria-pressed={zoom === "fit"} onClick={() => setZoom("fit")}>
              {t.fit}
            </button>
            <button
              type="button"
              aria-pressed={zoom === "actual"}
              onClick={() => setZoom("actual")}
            >
              {t.actualSize}
            </button>
          </div>
        </div>
      )}

      {onlyOther && <p className="notice">{t.viewportOnlyOther(onlyOther)}</p>}
      {page?.screenshotTruncated && <p className="notice">{t.truncated}</p>}
      {selected && natural && !selectedHasBox && !onlyOther && (
        <p className="notice">{t.noPosition}</p>
      )}

      <div className="shot-scroll" ref={scrollRef}>
        {!shotKey ? (
          <p className="empty">{t.noScreenshot}</p>
        ) : (
          <div
            className="shot"
            data-viewport={viewport}
            data-zoom={zoom}
            style={zoom === "actual" && natural ? { width: natural.width } : undefined}
          >
            <img
              ref={imgRef}
              src={artifactUrl(runId, shotKey)}
              alt={`Screenshot of ${pathOf(page!.url)} (${viewport})`}
              onLoad={(e) =>
                setNatural({
                  width: e.currentTarget.naturalWidth,
                  height: e.currentTarget.naturalHeight,
                })
              }
            />
            {pageIssues.flatMap((issue) =>
              boxesFor(issue).map((b, idx) => {
                const isSelected = issue.id === selectedIssueId;
                const isHover = issue.id === hoverIssueId;
                return (
                  <button
                    key={`${issue.id}-${idx}`}
                    type="button"
                    className={`hl sev-${issue.severity}`}
                    data-issue-id={issue.id}
                    data-state={isSelected ? "selected" : isHover ? "hover" : "idle"}
                    aria-label={`${issue.title} (${issue.severity})`}
                    tabIndex={-1}
                    onClick={() => props.onSelectIssue(issue.id)}
                    style={{
                      left: `${b.left}%`,
                      top: `${b.top}%`,
                      width: `${b.width}%`,
                      height: `${b.height}%`,
                    }}
                  />
                );
              }),
            )}
          </div>
        )}
      </div>
    </section>
  );
}
