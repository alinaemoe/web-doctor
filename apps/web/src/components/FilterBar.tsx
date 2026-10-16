import type { Category, Severity } from "@webdoctor/core/shared";
import { toggle } from "../lib/filters";
import type { Filters } from "../lib/filters";
import { SEVERITY_ORDER } from "../lib/model";
import { t } from "../lib/strings";
import type { RefObject } from "react";

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "links-resources", label: "Links & resources" },
  { id: "accessibility", label: "Accessibility" },
  { id: "seo", label: "SEO" },
  { id: "runtime", label: "Runtime" },
];

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
  pageUrls: string[];
  shown: number;
  counts: { fail: number; unverified: number; fixed: number };
  searchRef: RefObject<HTMLInputElement | null>;
}

export function FilterBar({ filters, onChange, pageUrls, shown, counts, searchRef }: Props) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    onChange({ ...filters, [key]: value });

  const tabs: { id: Filters["verdict"]; label: string; count: number }[] = [
    { id: "fail", label: t.failing, count: counts.fail },
    { id: "unverified", label: t.unverified, count: counts.unverified },
    { id: "fixed", label: t.fixed, count: counts.fixed },
    { id: "all", label: t.all, count: counts.fail + counts.unverified + counts.fixed },
  ];

  return (
    <section className="filters" aria-label={t.filters}>
      <div className="tabs" role="group" aria-label={t.verdict}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={filters.verdict === tab.id}
            onClick={() => set("verdict", tab.id)}
          >
            {tab.label}
            <span className="count">{tab.count}</span>
          </button>
        ))}
      </div>

      <input
        ref={searchRef}
        type="search"
        className="input"
        placeholder={`${t.search} ( / )`}
        aria-label={t.search}
        value={filters.query}
        onChange={(e) => set("query", e.target.value)}
      />

      <div className="chip-row" role="group" aria-label={t.category}>
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            className="chip"
            aria-pressed={filters.categories.includes(c.id)}
            onClick={() => set("categories", toggle(filters.categories, c.id))}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="chip-row" role="group" aria-label={t.severity}>
        {SEVERITY_ORDER.map((s: Severity) => (
          <button
            key={s}
            type="button"
            className={`chip sev-${s}`}
            aria-pressed={filters.severities.includes(s)}
            onClick={() => set("severities", toggle(filters.severities, s))}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="select-row">
        <label>
          <span>{t.viewport}</span>
          <select
            className="input"
            value={filters.viewport}
            onChange={(e) => set("viewport", e.target.value as Filters["viewport"])}
          >
            <option value="all">{t.all}</option>
            <option value="desktop">{t.desktop}</option>
            <option value="mobile">{t.mobile}</option>
          </select>
        </label>
        <label className="grow">
          <span>{t.page}</span>
          <select
            className="input"
            value={filters.page}
            onChange={(e) => set("page", e.target.value)}
          >
            <option value="">{t.allPages}</option>
            {pageUrls.map((u) => (
              <option key={u} value={u}>
                {pathLabel(u)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="filters-foot">
        <label className="check">
          <input
            type="checkbox"
            checked={filters.grouped}
            onChange={(e) => set("grouped", e.target.checked)}
          />
          {t.groupBy}
        </label>
        <span className="muted" aria-live="polite">
          {shown} {shown === 1 ? "item" : "items"}
        </span>
      </div>
    </section>
  );
}

function pathLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
