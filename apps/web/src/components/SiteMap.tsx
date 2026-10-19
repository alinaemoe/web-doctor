import { useMemo, useState } from "react";
import type { Report } from "@webdoctor/core/shared";
import { DEEP_CLICKS } from "@webdoctor/core/shared";
import { buildMapModel, pathLabel, PAGE_MODE_HARD_LIMIT } from "../lib/siteMap";
import type { MapItem } from "../lib/siteMap";
import { runHash } from "../lib/route";

const depthTitle = (depth: number | "unreachable") =>
  depth === "unreachable"
    ? "Not reachable by clicks"
    : depth === 0
      ? "Home"
      : `${depth} click${depth === 1 ? "" : "s"}`;

/**
 * The link structure of the scanned site, laid out by clicks from the home page. Boxes are pages (or
 * sections on big sites), coloured by their worst problem. Plain buttons and lists, so it works with
 * a keyboard and a screen reader.
 */
export function SiteMap({ report }: { report: Report }) {
  const [view, setView] = useState<"auto" | "pages" | "sections">("auto");
  const [selected, setSelected] = useState<string | null>(null);
  const model = useMemo(() => buildMapModel(report, view), [report, view]);

  if (!model) {
    return (
      <div className="page-pad">
        <h1>Site map</h1>
        <p className="empty">
          This run has no link data. Scan the site again to see how its pages link to each other.
        </p>
      </div>
    );
  }

  const graph = report.graph!;
  const { stats } = model;
  const chosen = model.columns.flatMap((c) => c.items).find((i) => i.id === selected);
  const nodeName = (index: number) => pathLabel(graph.nodes[index]!.url);
  const linksOf = (item: MapItem) => {
    const mine = new Set(item.nodes);
    const out = new Set<number>();
    const into = new Set<number>();
    for (const [from, to] of graph.edges) {
      if (mine.has(from) && !mine.has(to)) out.add(to);
      if (mine.has(to) && !mine.has(from)) into.add(from);
    }
    return { out: [...out], into: [...into] };
  };
  const chosenLinks = chosen ? linksOf(chosen) : { out: [], into: [] };

  return (
    <div className="page-pad site-map">
      <h1>Site map</h1>
      <p className="muted">
        {stats.scanned} pages scanned, {stats.nodes} known, up to {stats.maxDepth} clicks deep.
        Boxes are coloured by their most serious problem.
      </p>
      {!stats.complete && (
        <p className="notice" role="note">
          Not every page was scanned, so findings about unreachable or deep pages are tentative: a
          page that was not scanned may link to them.
        </p>
      )}

      <ul className="map-stats" aria-label="Summary">
        <li>
          <strong>{stats.unreachable}</strong> not reachable by clicks
        </li>
        <li>
          <strong>{stats.deep}</strong> deeper than {DEEP_CLICKS - 1} clicks
        </li>
        <li>
          <strong>{stats.deadEnds}</strong> dead ends
        </li>
        <li>
          <strong>{model.bottlenecks.length}</strong> bottlenecks
        </li>
      </ul>

      <div className="chip-row" role="group" aria-label="Show">
        <button
          type="button"
          className="chip"
          aria-pressed={model.mode === "sections"}
          onClick={() => setView("sections")}
        >
          Sections
        </button>
        <button
          type="button"
          className="chip"
          aria-pressed={model.mode === "pages"}
          disabled={stats.nodes > PAGE_MODE_HARD_LIMIT}
          title={
            stats.nodes > PAGE_MODE_HARD_LIMIT ? "Too many pages to draw one by one" : undefined
          }
          onClick={() => setView("pages")}
        >
          Pages
        </button>
      </div>

      <div className="map-columns">
        {model.columns.map((column) => (
          <section
            key={String(column.depth)}
            className="map-column"
            aria-label={depthTitle(column.depth)}
          >
            <h2>
              {depthTitle(column.depth)}{" "}
              <span className="muted small">({column.items.length})</span>
            </h2>
            <ul>
              {column.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`map-box${item.worst ? ` has-${item.worst}` : ""}`}
                    aria-pressed={selected === item.id}
                    onClick={() => setSelected(selected === item.id ? null : item.id)}
                  >
                    <span className="map-label">{item.label}</span>
                    <span className="map-meta">
                      {model.mode === "sections" && `${item.pages} pages · `}
                      {item.failing > 0
                        ? `${item.failing} problems (${item.worst})`
                        : "no problems"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {chosen && (
        <section className="map-detail" aria-label="Selected">
          <h2>{chosen.label}</h2>
          <p className="muted">
            {chosen.pages} page(s), {chosen.inbound} link(s) in
            {chosen.dominates > 0 &&
              `; ${chosen.dominates} other pages are reachable only through it`}
            .
          </p>
          <div className="map-links">
            <div>
              <h3>Linked from</h3>
              <LinkList
                indexes={chosenLinks.into}
                name={nodeName}
                empty="No other page links here."
              />
            </div>
            <div>
              <h3>Links to</h3>
              <LinkList indexes={chosenLinks.out} name={nodeName} empty="Links to no other page." />
            </div>
          </div>
        </section>
      )}

      <div className="map-lists">
        <Ranked
          title="Bottlenecks"
          hint="If this page breaks, these pages become unreachable"
          rows={model.bottlenecks.map((n) => [pathLabel(n.url), `${n.dominates} pages`])}
        />
        <Ranked
          title="Most linked"
          hint="Problems here are seen by the most visitors"
          rows={model.mostLinked.map((n) => [pathLabel(n.url), `${n.inbound} links`])}
        />
        <Ranked
          title="Deepest pages"
          hint={`${DEEP_CLICKS}+ clicks from home`}
          rows={model.deepest.map((n) => [pathLabel(n.url), `${n.depth} clicks`])}
        />
      </div>

      <p>
        <a href={runHash(report.run.id)}>← Back to the problems</a>
      </p>
    </div>
  );
}

function LinkList({
  indexes,
  name,
  empty,
}: {
  indexes: number[];
  name: (i: number) => string;
  empty: string;
}) {
  if (indexes.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <ul className="map-linklist">
      {indexes.slice(0, 12).map((i) => (
        <li key={i} className="mono small">
          {name(i)}
        </li>
      ))}
      {indexes.length > 12 && <li className="muted small">…and {indexes.length - 12} more</li>}
    </ul>
  );
}

function Ranked({ title, hint, rows }: { title: string; hint: string; rows: [string, string][] }) {
  return (
    <section className="map-ranked">
      <h2>{title}</h2>
      <p className="muted small">{hint}</p>
      {rows.length === 0 ? (
        <p className="muted small">None.</p>
      ) : (
        <ol>
          {rows.map(([label, value]) => (
            <li key={label}>
              <span className="mono small">{label}</span>{" "}
              <span className="muted small">{value}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
