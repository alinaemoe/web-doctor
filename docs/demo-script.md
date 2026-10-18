# Demo video script (about 3 minutes)

Setup: `pnpm demo` (Broken Shop), `pnpm webdoctor ui`, a clean `.webdoctor`.

1. **Hook (0:00).** "Every site breaks quietly. This one has 17 problems you cannot see from the
   homepage." Open the inspector's empty runs page.
2. **Scan (0:15).** New scan → paste `http://127.0.0.1:4000` → watch the live screen (pages, jokes).
3. **Find → show (0:45).** Open the run. Click a broken-image issue: the element is outlined on the
   real screenshot. Flip Desktop/Mobile; show the mobile-only overflow.
4. **Explain (1:15).** Details panel: what / where / why / how to fix. Open a root-cause group
   ("no H1 in the template: 6 pages").
5. **Fix + re-verify (1:40).** `curl -X POST :4000/__demo/mode/fixed`, press **Re-verify** on the
   group: "Verified fixed" for most, one "Still failing". Show that an unreachable page says
   "Couldn't verify", never "fixed".
6. **Track (2:15).** Scan again: the strip shows +0 new, −N fixed. Break one thing again → "came
   back". Show `webdoctor history`.
7. **AI hand-off (2:35).** Copy fix prompt → paste into an agent. One sentence about the guardrails
   (site text is fenced as data).
8. **CI + public server (2:50).** Show the GitHub summary, then the SSRF test matrix: "strangers can
   scan, they cannot reach your network."
