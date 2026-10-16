import { useEffect, useMemo, useRef, useState } from "react";
import type { Report } from "@webdoctor/core/shared";
import { applyFilters, buildList, defaultFilters } from "../lib/filters";
import type { Filters, ListItem } from "../lib/filters";
import { buildModel } from "../lib/model";
import { GroupDetails, IssueDetails } from "./Details";
import { FilterBar } from "./FilterBar";
import { IssueList } from "./IssueList";
import { Viewer } from "./Viewer";
import type { ViewportName } from "./Viewer";

interface Selection {
  /** Highlighted row in the list. */
  key: string | null;
  /** Issue shown in the details panel (set when drilling into a group member). */
  issueId?: string;
}

interface Props {
  report: Report;
  initialIssueId?: string;
  /** Called with the issue currently in focus (for the address bar). */
  onIssueChange?: (issueId: string | undefined) => void;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(
    el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA"),
  );
}

export function Inspector({ report, initialIssueId, onIssueChange }: Props) {
  const model = useMemo(() => buildModel(report), [report]);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [filters, setFilters] = useState<Filters>(() => {
    const target = initialIssueId ? model.issuesById.get(initialIssueId) : undefined;
    return target?.verdict === "unverified"
      ? { ...defaultFilters, verdict: "all" }
      : defaultFilters;
  });
  const [sel, setSel] = useState<Selection>(() => {
    const target = initialIssueId ? model.issuesById.get(initialIssueId) : undefined;
    if (!target) return { key: null };
    const items = buildList(
      applyFilters(
        model.issues,
        target.verdict === "unverified" ? { ...defaultFilters, verdict: "all" } : defaultFilters,
      ),
      model,
      true,
    );
    const container = items.find((i) =>
      i.kind === "issue" ? i.issue.id === target.id : i.members.some((m) => m.id === target.id),
    );
    return { key: container?.key ?? null, issueId: target.id };
  });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<ViewportName>("desktop");
  const [pageOverride, setPageOverride] = useState<string | null>(null);

  const filtered = useMemo(() => applyFilters(model.issues, filters), [model, filters]);
  const items = useMemo(
    () => buildList(filtered, model, filters.grouped),
    [filtered, model, filters.grouped],
  );

  const counts = {
    fail: model.issues.filter((i) => i.verdict === "fail").length,
    unverified: model.issues.filter((i) => i.verdict === "unverified").length,
  };

  // Keep the selection valid when filters remove the selected row.
  const selectedItem: ListItem | undefined =
    items.find((i) => i.key === sel.key) ?? (sel.key === null ? items[0] : undefined);
  const effectiveKey = selectedItem?.key ?? null;
  const focusIssue =
    (sel.issueId ? model.issuesById.get(sel.issueId) : undefined) ??
    (selectedItem?.kind === "issue" ? selectedItem.issue : selectedItem?.representative);
  const showGroup = selectedItem?.kind === "group" && !sel.issueId;

  // A new selection resets manual page browsing and follows the issue's viewport.
  useEffect(() => {
    setPageOverride(null);
    if (focusIssue && focusIssue.viewport !== "all") setViewport(focusIssue.viewport);
    onIssueChange?.(focusIssue?.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIssue?.id]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [effectiveKey]);

  const viewPage = pageOverride ?? focusIssue?.pageUrl ?? model.pageUrls[0] ?? null;
  const pageIssues = filtered.filter(
    (i) => i.pageUrl === viewPage && (i.viewport === "all" || i.viewport === viewport),
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "/" && !isTyping(e.target)) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (isTyping(e.target)) return;
      const index = items.findIndex((i) => i.key === effectiveKey);
      if (e.key === "j" || e.key === "k") {
        const next =
          items[Math.min(items.length - 1, Math.max(0, index + (e.key === "j" ? 1 : -1)))];
        if (next) setSel({ key: next.key });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, effectiveKey]);

  return (
    <div className="inspector">
      <aside className="panel panel-list" ref={listRef}>
        <FilterBar
          filters={filters}
          onChange={setFilters}
          pageUrls={model.pageUrls}
          shown={items.length}
          searchRef={searchRef}
          counts={counts}
        />
        <IssueList
          items={items}
          selectedKey={effectiveKey}
          onSelect={(key) => setSel({ key })}
          onHover={setHoverId}
        />
      </aside>

      <main className="panel panel-viewer">
        <Viewer
          model={model}
          runId={report.run.id}
          pageUrl={viewPage}
          viewport={viewport}
          onViewport={setViewport}
          onPage={setPageOverride}
          pageIssues={pageIssues}
          selectedIssueId={focusIssue?.id ?? null}
          hoverIssueId={hoverId}
          onSelectIssue={(id) => {
            const container = items.find((i) =>
              i.kind === "issue" ? i.issue.id === id : i.members.some((m) => m.id === id),
            );
            setSel({ key: container?.key ?? null, issueId: id });
          }}
        />
      </main>

      <section className="panel panel-details">
        {showGroup && selectedItem?.kind === "group" ? (
          <GroupDetails
            item={selectedItem}
            model={model}
            onSelectIssue={(id) => setSel({ key: selectedItem.key, issueId: id })}
          />
        ) : focusIssue ? (
          <>
            {sel.issueId && selectedItem?.kind === "group" && (
              <button
                type="button"
                className="link-btn"
                onClick={() => setSel({ key: selectedItem.key })}
              >
                ← Back to group
              </button>
            )}
            <IssueDetails issue={focusIssue} model={model} />
          </>
        ) : (
          <p className="empty">Select an issue from the list.</p>
        )}
      </section>
    </div>
  );
}
