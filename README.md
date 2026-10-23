# Web Doctor

**Find a website problem, see it on the real page, fix it, and prove the fix worked.**

Web Doctor crawls a site in a real browser (Playwright, desktop and mobile viewports), reports
accessibility, link, SEO, navigation and runtime problems with annotated screenshots, then lets you
**re-verify** a single issue after you fix it and **track regressions over time**. It also exports a
ready-made Markdown task for an AI coding agent. Use it locally, in CI, or as a public scanner that
strangers can use without being able to touch your private network.

> Status: polished MVP (M6) plus site map and link-structure analysis (M7, in progress).
> Full specification: [TZ.md](TZ.md).

## Highlights

- **Regression Radar.** Every scan is diffed against the previous one by issue fingerprint:
  *New / Open / Fixed / Reopened / Not rechecked*. A smaller sample, a page that is down or a
  different category set can never make problems look "fixed".
- **Verify one fix, not the whole site.** Press *Re-verify* on an issue (or run
  `webdoctor verify <id>`): only that page and rule are re-checked. Outcomes are *Verified fixed*,
  *Still failing* or *Couldn't verify*, and unloadable pages are never reported as fixed.
- **Built to be pointed at the internet safely.** The public mode ships an SSRF guard (IP policy,
  pinned DNS, guarded fetch, browser proxy) so visitors cannot scan loopback, LAN, cloud metadata or
  the Docker network. Threat model: [docs/security.md](docs/security.md).
- **Prompt for your AI agent.** Each scan writes `fix-prompt.md`: root causes first, then single
  problems, each with location, fix, example code and a "done when" check. Text copied from the
  scanned site is fenced and labelled as data, so a hostile page cannot instruct your agent.
- **Site map and link structure.** Pages laid out by clicks from home, coloured by worst problem;
  orphan, too-deep and dead-end pages are detected, and "couldn't verify" is reported instead of a
  false failure when only part of the site was scanned.
- **CI mode.** `webdoctor scan <url> --ci --fail-on high --new-only` fails a build only on new
  problems and writes GitHub Actions annotations and a job summary ([docs/ci.md](docs/ci.md)).
- **Tested like a product.** 44 test files, including a full end-to-end scan of **Broken Shop**, a
  demo site with intentional defects and an `expected-issues.json` the scanner must match. The
  inspector UI audits itself with axe (WCAG A/AA, light and dark, 375 px).

## Tech

TypeScript monorepo (pnpm workspaces) - Node 22, Playwright + axe-core, Fastify API, React 19 + Vite
inspector, SQLite via Drizzle, Zod models, Vitest.

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

## Site map and link structure

Every scan records which page links to which. The inspector's **Site map** (button on a run) lays the
pages out by clicks from the home page, coloured by their worst problem, and lists bottlenecks (pages
that others are reachable only through), the most linked pages and the deepest ones. Big sites are
grouped into sections.

Three rules use it: `nav.page.orphan` (no link path from the home page, e.g. a page that only the
sitemap knows), `nav.page.deep` (5+ clicks from home) and `nav.page.dead-end` (no links to other
pages). When not every page was scanned, "nobody links here" cannot be a fact, so those findings are
reported as _couldn't verify_ instead of as failures. They also cannot be re-verified on one page:
scan again. Problems on pages that many pages link to rank higher ("Why this priority?" shows the
factor).

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
