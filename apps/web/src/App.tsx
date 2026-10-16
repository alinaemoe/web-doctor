import { useCallback, useEffect, useState } from "react";
import type { Report } from "@webdoctor/core/shared";
import { Inspector } from "./components/Inspector";
import { RunsPage } from "./components/RunsPage";
import { fetchReport, fetchRuns, initToken } from "./lib/api";
import type { RunListItem } from "./lib/api";
import { parseHash, runHash } from "./lib/route";
import type { Route } from "./lib/route";
import { t } from "./lib/strings";

type Theme = "system" | "light" | "dark";
const THEME_KEY = "webdoctor.theme";

function readTheme(): Theme {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // storage can be unavailable (private mode); the theme just won't persist
    }
  }, [theme]);
  const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
  return { theme, cycle: () => setTheme(next[theme]) };
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

type Load<T> =
  { state: "loading" } | { state: "error"; message: string } | { state: "ok"; data: T };

function useLoad<T>(load: () => Promise<T>, key: string): Load<T> {
  const [result, setResult] = useState<Load<T>>({ state: "loading" });
  useEffect(() => {
    let alive = true;
    setResult({ state: "loading" });
    load().then(
      (data) => alive && setResult({ state: "ok", data }),
      (error: Error) => alive && setResult({ state: "error", message: error.message }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return result;
}

function RunView({ id, issue }: { id: string; issue?: string }) {
  const report = useLoad<Report>(() => fetchReport(id), id);
  const onIssueChange = useCallback(
    (issueId: string | undefined) => {
      // keep the address bar shareable without adding history entries
      const hash = runHash(id, issueId);
      if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
    },
    [id],
  );
  if (report.state === "loading") return <p className="empty page-pad">{t.loading}</p>;
  if (report.state === "error")
    return (
      <p className="empty page-pad" role="alert">
        {report.message}
      </p>
    );
  return <Inspector report={report.data} initialIssueId={issue} onIssueChange={onIssueChange} />;
}

export function App() {
  const route = useRoute();
  const { theme, cycle } = useTheme();
  const [hasToken] = useState(() => initToken() !== null);
  const runs = useLoad<RunListItem[]>(fetchRuns, route.name === "runs" ? "runs" : "-");

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          {t.appName}
        </a>
        {route.name === "run" && (
          <a className="crumb" href="#/">
            ← {t.back}
          </a>
        )}
        <span className="spacer" />
        <span className="muted small kbd-hint">j / k — next / previous issue</span>
        <button type="button" className="btn" onClick={cycle} aria-label={`${t.theme}: ${theme}`}>
          {t.theme}: {theme}
        </button>
      </header>
      {!hasToken ? (
        <p className="empty page-pad" role="alert">
          Open the link printed by `webdoctor ui` (it contains the access token).
        </p>
      ) : route.name === "runs" ? (
        runs.state === "ok" ? (
          <RunsPage runs={runs.data} />
        ) : runs.state === "error" ? (
          <p className="empty page-pad" role="alert">
            {runs.message}
          </p>
        ) : (
          <p className="empty page-pad">{t.loading}</p>
        )
      ) : (
        <RunView id={route.id} issue={route.issue} />
      )}
    </div>
  );
}
