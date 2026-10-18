# Web Doctor

A visual debugging workspace for websites: find a problem, see it on the real page, understand it,
fix it, **re-verify** it, and track it over time. See [TZ.md](TZ.md) for the full specification.

> Status: **M6 — polished MVP.** Paste an address, get a crawled report,
> re-verify fixes, track history, export a Markdown task for an AI coding agent — locally, or on a
> public server where strangers can scan without being able to reach private networks
> ([docs/security.md](docs/security.md), [docs/deploy.md](docs/deploy.md)).

## Quick start

```bash
pnpm install
pnpm --filter @webdoctor/scanner exec playwright install chromium
pnpm --filter @webdoctor/web build
pnpm webdoctor ui          # open the printed link, press "New scan", paste your site's address
```

## Layout

| Path                 | What                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `packages/core`      | Issue model (zod), scanner snapshot types, URL normalization, fingerprints   |
| `packages/scanner`   | Playwright crawler: pages x viewports, screenshots (WebP), axe, link checks  |
| `packages/rules`     | Rules, explanation catalog, merging across viewports, root-cause groups      |
| `packages/storage`   | Drizzle schema + SQLite store (`better-sqlite3`), hand-written migrations    |
| `packages/demo-site` | **Broken Shop**: demo site with intentional defects + `expected-issues.json` |
| `packages/netguard`  | SSRF guard: IP policy, pinned DNS, guarded fetch, browser proxy              |
| `apps/cli`           | `webdoctor scan`, JSON / CSV / HTML reports                                  |

## Develop

Requires Node >= 22 and pnpm.

```bash
pnpm install
pnpm --filter @webdoctor/scanner exec playwright install chromium   # once
pnpm check          # format:check + lint + typecheck + test (incl. a full e2e scan, ~1 min)
```

## Scan a site

```bash
pnpm demo &                                   # Broken Shop on :4000 (optional)
pnpm webdoctor scan http://127.0.0.1:4000 --max-pages 30 --fail-on high
```

Results go to `.webdoctor/`: `webdoctor.db` (SQLite) and `runs/<runId>/` with `report.json`,
`issues.csv`, `report.html`, `scan.json` (raw snapshots) and WebP screenshots.
Exit codes: `0` ok, `1` issues at/above `--fail-on`, `2` usage error, `3` partial result.
Options: `--max-pages --depth --viewport --categories --format --out --timeout --ignore-robots --ci`.

## Scan a real site

Give the main address only. Pages are found from links **and** from `sitemap.xml` (sitemap indexes are
expanded; robots.txt is obeyed). External links that fail for a script are re-checked in a real browser
before they are reported.

```bash
pnpm webdoctor scan https://your-site.com --max-pages 100
```

or press **New scan** in the inspector (`pnpm webdoctor ui`) and paste the address.

## History and Regression Radar

Scans of the same site (same origin) form a history. Every new scan is compared with the one before it
by issue fingerprint:

| What happened                                        | Status                                     |
| ---------------------------------------------------- | ------------------------------------------ |
| found now, not before                                | **New**                                    |
| found before and now                                 | **Open**                                   |
| found before, gone, and its page was scanned again   | **Fixed**                                  |
| fixed earlier and found again                        | **Reopened** ("back")                      |
| known before, but this scan did not look at its page | **Not rechecked** (never counted as fixed) |

"Looked at again" means the same page in every viewport where the problem was seen, the same
category, and (for external links) link checks that were not cut short. A smaller sample, a page that
is down, or a different set of categories can therefore never make problems look fixed.

```bash
pnpm webdoctor history                         # runs per site with new / fixed / back / not rechecked
pnpm webdoctor scan <url> --fail-on high --new-only   # CI: fail only on regressions
```

In the inspector, the run page shows a strip with the changes, a **Changes** tab, a **Not rechecked**
tab and per-problem history; the runs page draws a trend per site.

## Fix prompt for an AI agent

Every scan writes `fix-prompt.md`: a Markdown task for an AI coding agent listing root causes first,
then single problems, each with where it is, how to fix it, example code, a "done when" condition and
the `verify` command. Text copied from the scanned site is fenced and labelled as data, so a hostile
page cannot talk to your agent.

```bash
pnpm webdoctor export > task.md      # newest run (also: --out task.md --max-findings 20)
```

In the inspector use **Copy fix prompt** / **Download .md** at the top.

## Inspect the results

```bash
pnpm --filter @webdoctor/web build      # once (and after UI changes)
pnpm webdoctor ui                       # prints http://127.0.0.1:7777/?token=...
```

The API listens on `127.0.0.1` only, requires the printed access token and rejects non-loopback
`Host` headers. Keys: `j`/`k` move through issues, `1`/`2` switch Desktop/Mobile, `/` searches.
For UI development: `pnpm webdoctor ui --token dev` and `pnpm --filter @webdoctor/web dev`, then open
`http://localhost:5173/?token=dev`.

## Verify a fix

In the inspector press **Re-verify** on an issue (or on a root-cause group: it checks up to 5 pages),
or from the terminal:

```bash
pnpm webdoctor verify <issueId>      # exit 0 fixed, 1 still failing, 3 couldn't verify
```

Only the page and rule behind the issue are re-checked (no crawl, no screenshots). Outcomes:
**Verified fixed**, **Still failing**, **Couldn't verify**. A page that cannot be loaded, or a link
target that cannot be re-checked, is never reported as fixed. When the original element is gone the
result is marked less certain. Statuses and results are saved in the run's database.

Not built yet: interactive DOM snapshots, page states, Lighthouse (see the roadmap in TZ.md).

## CI

`webdoctor scan <url> --ci --fail-on high --new-only` fails a build only on **new** problems and, in
GitHub Actions, writes annotations and a job summary. Example workflow: [docs/ci.md](docs/ci.md).

## Accessibility of the inspector

The inspector audits itself: `apps/cli/test/ui-a11y.e2e.test.ts` runs axe (WCAG 2.0/2.1 A and AA) on
the runs list, new scan, run workspace and issue details, in light and dark themes and at 375 px, and
fails on any critical or serious finding. Automated checks cover only part of WCAG; keyboard
navigation (`j`/`k`, `/`) and focus rings are tested by hand.

Demo video storyboard: [docs/demo-script.md](docs/demo-script.md).

## Public server

`webdoctor serve` runs the same inspector for strangers: anonymous sessions, every visitor sees only
their own runs, and the scanner **cannot be pointed at private addresses** (loopback, LAN, cloud
metadata, the Docker network). Limits (20 pages, 5 minutes, one scan at a time per visitor, 24 h
retention) and the full threat model are in [docs/security.md](docs/security.md).

```bash
pnpm --filter @webdoctor/web build
WEBDOCTOR_SECRET=dev pnpm webdoctor serve --demo --port 8080     # http://127.0.0.1:8080/
```

`--demo` also starts Broken Shop and allow-lists exactly its two origins so visitors have something
to scan. For a VPS: `docker compose up -d --build` behind a TLS proxy, plus an egress firewall as
a second line of defence ([docs/deploy.md](docs/deploy.md)). Postgres / Redis / S3 scale-out is not
built; one container with SQLite is the supported setup.

## Broken Shop

```bash
pnpm demo                     # broken mode on http://127.0.0.1:4000 (external 429 site on :4001)
DEMO_MODE=fixed pnpm demo     # start already fixed
curl -X POST http://127.0.0.1:4000/__demo/mode/fixed    # switch at runtime
curl -X POST http://127.0.0.1:4000/__demo/flaky/down    # make /flaky answer 503
```

The defects the scanner must find (and how fixed mode differs) are listed in
[`packages/demo-site/expected-issues.json`](packages/demo-site/expected-issues.json), generated from
`src/expected.ts`:

```bash
pnpm --filter @webdoctor/demo-site gen:expected
```

## License

MIT
