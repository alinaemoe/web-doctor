import { useCallback, useEffect, useState } from "react";
import type { Report, Verification } from "@webdoctor/core/shared";
import { FixPromptButtons } from "./components/FixPromptButtons";
import { NewScanPage } from "./components/NewScanPage";
import { RunWorkspace } from "./components/RunWorkspace";
import { RunsPage } from "./components/RunsPage";
import { fetchReport, fetchRuns, fetchVerifications, loadApp } from "./lib/api";
import type { AppConfig, RunListItem } from "./lib/api";
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
  const loaded = useLoad<[Report, Verification[]]>(
    () => Promise.all([fetchReport(id), fetchVerifications(id)]),
    id,
  );
  const onIssueChange = useCallback(
    (issueId: string | undefined) => {
      // keep the address bar shareable without adding history entries
      const hash = runHash(id, issueId);
      if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
    },
    [id],
  );
  if (loaded.state === "loading") return <p className="empty page-pad">{t.loading}</p>;
  if (loaded.state === "error")
    return (
      <p className="empty page-pad" role="alert">
        {loaded.message}
      </p>
    );
  const [report, verifications] = loaded.data;
  return (
    <RunWorkspace
      key={id}
      initialReport={report}
      initialVerifications={verifications}
      initialIssueId={issue}
      onIssueChange={onIssueChange}
    />
  );
}

export function App() {
  const route = useRoute();
  const { theme, cycle } = useTheme();
  const app = useLoad<{ config: AppConfig; authorized: boolean }>(loadApp, "app");
  const runs = useLoad<RunListItem[]>(
    () => (app.state === "ok" && app.data.authorized ? fetchRuns() : Promise.resolve([])),
    route.name === "runs" && app.state === "ok" ? "runs" : "-",
  );
  const config = app.state === "ok" ? app.data.config : undefined;
  const hasToken = app.state === "ok" && app.data.authorized;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          {t.appName}
        </a>
        {route.name !== "runs" && (
          <a className="crumb" href="#/">
            ← {t.back}
          </a>
        )}
        {route.name === "runs" || route.name === "run" ? (
          <a className="btn" href="#/new">
            {t.newScan}
          </a>
        ) : null}
        {route.name === "run" && <FixPromptButtons runId={route.id} />}
        <span className="spacer" />
        {config?.mode === "public" && <span className="muted small">Public demo</span>}
        <span className="muted small kbd-hint">j / k — next / previous issue</span>
        <button type="button" className="btn" onClick={cycle} aria-label={`${t.theme}: ${theme}`}>
          {t.theme}: {theme}
        </button>
      </header>
      {app.state === "loading" ? (
        <p className="empty page-pad">{t.loading}</p>
      ) : app.state === "error" ? (
        <p className="empty page-pad" role="alert">
          {app.message}
        </p>
      ) : !hasToken ? (
        <p className="empty page-pad" role="alert">
          Open the link printed by `webdoctor ui` (it contains the access token).
        </p>
      ) : route.name === "new" ? (
        <NewScanPage config={config} />
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
      {config?.mode === "public" && config.disclaimer && (
        <footer className="muted small page-pad" role="note">
          {config.disclaimer} Runs are deleted after {config.limits?.retentionHours ?? 24} hours.
        </footer>
      )}
    </div>
  );
}
