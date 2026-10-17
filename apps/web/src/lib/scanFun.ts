/** Things to read while a scan runs. Decorative: nothing here is announced to screen readers. */

export const CRAWL_LINES = [
  "Taking the site's temperature…",
  "Listening to the DOM with a stethoscope…",
  "Checking the pulse of every link…",
  "Looking for broken bones (that's 404s, doctor)…",
  "Asking each image politely for its alt text…",
  "Counting <h1>s. Only one is allowed. Mostly.",
  "Teaching the browser to scroll like a human…",
  "Shaking the footer to see what falls out…",
  "Measuring layout shift with a tiny ruler…",
  "Reading robots.txt. Yes, we obey it.",
  "Squinting at low-contrast text…",
  "Opening wide and saying “aaa” to the homepage…",
  "Following every redirect, however long the chain…",
  "Looking under the carousel for hidden bugs…",
  "Writing very small prescriptions in the margin…",
  "Pretending to be a phone for the mobile checks…",
  "Checking that the sitemap tells the truth…",
];

export const LINK_LINES = [
  "Knocking on every link. Most answer.",
  "Some sites hang up on robots, so we try again like a visitor.",
  "Sorting problems by how much they hurt…",
  "Grouping repeated problems into one root cause…",
  "Drafting the fix prompt for your AI agent…",
  "Almost there. Finding who is to blame: the template, usually.",
];

export const TIP_LINES = [
  "Did you know? Images without width and height make pages jump while they load.",
  "Did you know? Automated checks cover only part of accessibility. A human still matters.",
  "Did you know? One broken template can cause the same problem on hundreds of pages. We group those for you.",
  "Tip: after fixing, press Re-verify. It re-checks only that problem, in seconds.",
  "Tip: the fix prompt lists root causes first, so your AI agent fixes the most with the least.",
  "Tip: press j and k in the results to jump between problems.",
  "Tip: “Couldn't verify” never means broken. It means the site would not let us check.",
];

/** Lines for the current phase, with a tip after every few jokes. */
export function linesFor(
  phase: "crawling" | "checking-links" | "queued" | "saving" | "done",
): string[] {
  const base = phase === "checking-links" || phase === "saving" ? LINK_LINES : CRAWL_LINES;
  const mixed: string[] = [];
  base.forEach((line, i) => {
    mixed.push(line);
    if (i % 3 === 2) mixed.push(TIP_LINES[Math.floor(i / 3) % TIP_LINES.length]!);
  });
  return mixed;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const SCAN_PRESETS = [
  { id: "quick", label: "Quick", pages: 10, hint: "10 pages, about a minute" },
  { id: "standard", label: "Standard", pages: 50, hint: "50 pages" },
  { id: "large", label: "Large", pages: 500, hint: "500 pages, may take a while" },
  { id: "everything", label: "Everything", pages: 5000, hint: "up to 5000 pages, can take hours" },
] as const;

/** Above this a scan can take an hour or more and use a lot of memory. */
export const BIG_SCAN_PAGES = 1000;
