# Using Web Doctor in CI

`webdoctor scan --ci` prints no progress, returns an exit code, and, inside GitHub Actions, adds
annotations and a job summary.

| Exit code | Meaning                                                        |
| --------- | -------------------------------------------------------------- |
| `0`       | scan finished, nothing at or above `--fail-on`                 |
| `1`       | a failing problem at or above `--fail-on` (see `--new-only`)   |
| `2`       | wrong arguments                                                |
| `3`       | the scan was cut short (page or time limit) and nothing failed |

## Fail only on regressions

`--new-only` counts only problems that are **new or came back** since the previous scan of the same
site, so an old backlog does not block every pull request. Keep `.webdoctor/webdoctor.db` between
runs (cache or artifact) so there is a previous scan to compare with.

## GitHub Actions example

```yaml
name: Site health
on:
  schedule: [{ cron: "0 6 * * 1" }]
  workflow_dispatch:

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps chromium
      - uses: actions/cache@v4
        with:
          path: .webdoctor
          key: webdoctor-${{ github.run_id }}
          restore-keys: webdoctor-
      - run: pnpm webdoctor scan https://your-site.com --max-pages 100 --ci --fail-on high --new-only
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: webdoctor-report
          path: .webdoctor/runs/*/{report.html,report.json,fix-prompt.md}
```

What you get:

- **Annotations:** one `::error`/`::warning` line per problem that breaks the build (first 10).
  Text from the scanned site is escaped, so a hostile page cannot inject workflow commands.
- **Job summary:** pass/fail, pages scanned, what changed since the last scan, and a table of the
  worst problems.
- **Artifacts:** the self-contained `report.html` (screenshots inline), `report.json` (validated by
  the schema) and `fix-prompt.md` for an AI agent.

## Scanning a preview server

Start your app in the workflow, then scan `http://127.0.0.1:PORT`. Local mode allows private
addresses; the public server (`webdoctor serve`) never does.
