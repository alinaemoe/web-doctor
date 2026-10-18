import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { RunListItem } from "../lib/api";
import { applyFilters, defaultFilters, isChange, isStale, wasFixedNow } from "../lib/filters";
import { fixtureReport } from "../../test/fixture";
import { historyReport, historySummary } from "../../test/historyFixture";
import { HistoryStrip } from "./HistoryStrip";
import { Inspector } from "./Inspector";
import { RunsPage } from "./RunsPage";
import { Sparkline } from "./Sparkline";

const history = historyReport();
const ids = (issues: { id: string }[]) => issues.map((i) => i.id).sort();

describe("filters with run history", () => {
  const find = (id: string) => history.issues.find((i) => i.id === id)!;

  it("tells what changed in this run from what was known before", () => {
    expect(isChange(find("fresh"), "run-2")).toBe(true);
    expect(isChange(find("back"), "run-2")).toBe(true);
    expect(isChange(find("gone"), "run-2")).toBe(true);
    expect(isChange(find("still"), "run-2")).toBe(false);
    expect(isChange(find("old-fix"), "run-2")).toBe(false);
    expect(isChange(find("unseen"), "run-2")).toBe(false);
    expect(wasFixedNow(find("gone"), "run-2")).toBe(true);
    expect(wasFixedNow(find("old-fix"), "run-2")).toBe(false);
  });

  it("does not count a problem from a page nobody looked at as failing now", () => {
    expect(isStale(find("unseen"), "run-2")).toBe(true);
    expect(isStale(find("still"), "run-2")).toBe(false);
    expect(isStale(find("gone"), "run-2")).toBe(false); // fixed is never "not rechecked"
    const tab = (verdict: typeof defaultFilters.verdict) =>
      ids(applyFilters(history.issues, { ...defaultFilters, verdict }, "run-2"));
    expect(tab("fail")).toEqual(["back", "fresh", "still"]);
    expect(tab("stale")).toEqual(["unseen"]);
    expect(tab("changes")).toEqual(["back", "fresh", "gone"]);
    expect(tab("fixed")).toEqual(["gone", "old-fix"]);
  });

  it("keeps working for runs that have no history (no run id: nothing is stale)", () => {
    expect(applyFilters(fixtureReport().issues, defaultFilters)).toHaveLength(4);
  });
});

describe("Inspector on a compared run", () => {
  it("shows a Changes tab and a Not rechecked tab with their counts", async () => {
    const user = userEvent.setup();
    render(<Inspector report={history} />);

    expect(screen.getByRole("button", { name: /^Failing/ })).toHaveTextContent("3");
    expect(screen.getByRole("button", { name: /^Changes/ })).toHaveTextContent("3");
    expect(screen.getByRole("button", { name: /^Fixed/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^Not rechecked/ })).toHaveTextContent("1");

    await user.click(screen.getByRole("button", { name: /^Changes/ }));
    const list = screen.getByRole("list", { name: "Issues" });
    expect(within(list).getByText("Fresh problem")).toBeInTheDocument();
    expect(within(list).getByText("Problem that came back")).toBeInTheDocument();
    expect(within(list).getByText("Problem fixed since last run")).toBeInTheDocument();
    expect(within(list).queryByText("Still open problem")).not.toBeInTheDocument();
  });

  it("labels rows: new, back, fixed and not rechecked", async () => {
    const user = userEvent.setup();
    render(<Inspector report={history} />);
    const row = (title: string) => screen.getByRole("button", { name: new RegExp(title) });

    expect(within(row("Fresh problem")).getByText("new")).toBeInTheDocument();
    expect(within(row("Problem that came back")).getByText("back")).toBeInTheDocument();
    expect(within(row("Still open problem")).queryByText(/^(new|back|fixed)$/)).toBeNull();

    await user.click(screen.getByRole("button", { name: /^Fixed/ }));
    expect(within(row("Problem fixed since last run")).getByText("fixed")).toBeInTheDocument();
    expect(within(row("Problem fixed long ago")).queryByText("fixed")).toBeNull();

    await user.click(screen.getByRole("button", { name: /^Not rechecked/ }));
    expect(
      within(row("Problem on a page nobody looked at")).getByText("not rechecked"),
    ).toBeInTheDocument();
  });

  it("explains that an unseen problem may already be fixed and offers no false comfort", async () => {
    const user = userEvent.setup();
    render(<Inspector report={history} initialIssueId="unseen" />);
    // linked straight to it: the right tab is chosen
    expect(screen.getByRole("button", { name: /^Not rechecked/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const details = screen.getByRole("article", { name: "Issue details" });
    expect(within(details).getByRole("note")).toHaveTextContent(/did not look at its page again/);
    expect(within(details).getByRole("note")).toHaveTextContent(/may already be fixed/);
    expect(user).toBeDefined();
  });

  it("shows the life of a problem: first seen, fixed, back", async () => {
    const user = userEvent.setup();
    render(<Inspector report={history} initialIssueId="back" />);
    const details = screen.getByRole("article", { name: "Issue details" });
    await user.click(within(details).getByText("History (3)"));
    const entries = within(details).getAllByRole("listitem");
    expect(entries).toHaveLength(3);
    expect(entries[0]).toHaveTextContent("First seen: New");
    expect(entries[1]).toHaveTextContent("New → Fixed");
    expect(entries[1]).toHaveTextContent("Not found when the page was scanned again");
    expect(entries[2]).toHaveTextContent("Fixed → Back again");
  });

  it("has no Changes tab on a first run", () => {
    render(<Inspector report={fixtureReport()} />);
    expect(screen.queryByRole("button", { name: /^Changes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Not rechecked/ })).not.toBeInTheDocument();
  });
});

describe("HistoryStrip", () => {
  it("summarizes the comparison and links to the previous run", () => {
    render(<HistoryStrip run={history.run} />);
    const strip = screen.getByLabelText("Changes since the previous run");
    expect(strip).toHaveTextContent("+1 new");
    expect(strip).toHaveTextContent("−1 fixed");
    expect(strip).toHaveTextContent("↺ 1 back");
    expect(strip).toHaveTextContent("1 not rechecked");
    expect(within(strip).getByRole("link")).toHaveAttribute("href", "#/runs/run-1");
  });

  it("renders nothing for a first run", () => {
    const { container } = render(<HistoryStrip run={fixtureReport().run} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("RunsPage history", () => {
  const item = (
    id: string,
    startedAt: string,
    failing: number,
    previous?: string,
    site = "http://site.test",
  ): RunListItem => ({
    id,
    startUrl: `${site}/`,
    status: "completed",
    startedAt,
    partial: false,
    failCount: failing,
    unverifiedCount: 0,
    site,
    previousRunId: previous,
    summary: {
      ...historySummary,
      failing,
      new: previous ? 2 : failing,
      fixedSinceLast: previous ? 5 : 0,
      reopened: 0,
      notRechecked: 0,
    },
  });

  it("groups runs by site with a trend and what changed between runs", () => {
    render(
      <RunsPage
        runs={[
          item("r3", "2026-10-23T10:00:00.000Z", 4, "r2"),
          item("r2", "2026-10-22T10:00:00.000Z", 9, "r1"),
          item("r1", "2026-10-21T10:00:00.000Z", 12),
          item("x1", "2026-10-22T11:00:00.000Z", 1, undefined, "http://other.test"),
        ]}
      />,
    );
    const sites = screen.getAllByRole("region");
    expect(sites).toHaveLength(2);

    const site = screen.getByRole("region", { name: "History of http://site.test" });
    expect(within(site).getByRole("img")).toHaveAccessibleName(
      "Open problems over 3 runs: from 12 to 4",
    );
    expect(within(site).getByText(/12 → 4 open problems/)).toBeInTheDocument();
    expect(within(site).getByText("first run")).toBeInTheDocument();
    expect(within(site).getAllByText("−5 fixed")).toHaveLength(2);
    expect(within(site).getAllByRole("link")).toHaveLength(3);
  });

  it("offers to start a scan when there are no runs", () => {
    render(<RunsPage runs={[]} />);
    expect(screen.getByRole("link", { name: "start a scan here" })).toHaveAttribute(
      "href",
      "#/new",
    );
  });
});

describe("Sparkline", () => {
  it("is described for screen readers and handles a single value", () => {
    const { container, rerender } = render(<Sparkline values={[3, 5, 2]} label="Trend 3 to 2" />);
    expect(screen.getByRole("img")).toHaveAccessibleName("Trend 3 to 2");
    expect(container.querySelectorAll("circle")).toHaveLength(3);
    expect(container.querySelector("polyline")).not.toBeNull();

    rerender(<Sparkline values={[7]} label="One run" />);
    expect(container.querySelector("polyline")).toBeNull();
    expect(container.querySelectorAll("circle")).toHaveLength(1);

    rerender(<Sparkline values={[]} label="none" />);
    expect(container).toBeEmptyDOMElement();
  });
});
