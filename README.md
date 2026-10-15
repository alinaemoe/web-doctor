# Web Doctor

A visual debugging workspace for websites: find a problem, see it on the real page, understand it,
fix it, **re-verify** it, and track it over time. See [TZ.md](TZ.md) for the full specification.

> Status: **M2 — visual inspector.** CLI scan plus a local web inspector (3 panels, highlights on the
> screenshot, filters, issue details). Verify Fix (M3) and run history (M4) are next.

## Layout

| Path                 | What                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `packages/core`      | Issue model (zod), scanner snapshot types, URL normalization, fingerprints   |
| `packages/scanner`   | Playwright crawler: pages x viewports, screenshots (WebP), axe, link checks  |
| `packages/rules`     | Rules, explanation catalog, merging across viewports, root-cause groups      |
| `packages/storage`   | Drizzle schema + SQLite store (`better-sqlite3`), hand-written migrations    |
| `packages/demo-site` | **Broken Shop**: demo site with intentional defects + `expected-issues.json` |
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

## Inspect the results

```bash
pnpm --filter @webdoctor/web build      # once (and after UI changes)
pnpm webdoctor ui                       # prints http://127.0.0.1:7777/?token=...
```

The API listens on `127.0.0.1` only, requires the printed access token and rejects non-loopback
`Host` headers. Keys: `j`/`k` move through issues, `1`/`2` switch Desktop/Mobile, `/` searches.
For UI development: `pnpm webdoctor ui --token dev` and `pnpm --filter @webdoctor/web dev`, then open
`http://localhost:5173/?token=dev`.

Not in M1/M2 yet: sitemap-based discovery, interactive DOM snapshots, page states, Lighthouse.

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
