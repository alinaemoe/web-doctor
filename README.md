# Web Doctor

A visual debugging workspace for websites: find a problem, see it on the real page, understand it,
fix it, **re-verify** it, and track it over time. See [TZ.md](TZ.md) for the full specification.

> Status: **M0 — foundation.** No scanner yet.

## Layout

| Path                 | What                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `packages/core`      | Issue model (zod), URL normalization, fingerprints, status machine, priority |
| `packages/demo-site` | **Broken Shop**: demo site with intentional defects + `expected-issues.json` |
| `.github/workflows`  | CI: format, lint, typecheck, test                                            |

Planned (see TZ §8): `scanner`, `rules`, `storage`, `apps/cli`, `apps/api`, `apps/web`.

## Develop

Requires Node >= 22 and pnpm.

```bash
pnpm install
pnpm check          # format:check + lint + typecheck + test
```

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
