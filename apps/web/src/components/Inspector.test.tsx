import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fixtureReport } from "../../test/fixture";
import { Inspector } from "./Inspector";

const report = fixtureReport();

/** jsdom never loads images, so report a natural size the way a real load would. */
function loadScreenshot(width = 1000, height = 2000) {
  const img = document.querySelector<HTMLImageElement>(".shot img")!;
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  act(() => {
    fireEvent.load(img);
  });
}

const rows = () => within(screen.getByRole("list", { name: "Issues" })).getAllByRole("button");

describe("Inspector", () => {
  it("lists the root-cause group first-class and shows its details", () => {
    render(<Inspector report={report} />);
    expect(rows()).toHaveLength(2); // group + console error (the unverified link is hidden)
    expect(screen.getByRole("button", { name: /Page has no <h1> — 3 pages/ })).toBeInTheDocument();

    // nothing selected explicitly: the top-priority row is shown
    expect(screen.getAllByRole("heading", { level: 2 })[0]).toHaveTextContent(
      /JavaScript error|no <h1>/,
    );
  });

  it("drills from a group into a member page and back", async () => {
    const user = userEvent.setup();
    render(<Inspector report={report} />);

    await user.click(screen.getByRole("button", { name: /Page has no <h1> — 3 pages/ }));
    const group = screen.getByRole("article", { name: "Group details" });
    expect(within(group).getByText(/Hypothesis, not confirmed/)).toBeInTheDocument();
    expect(within(group).getByText(/fix one page and re-check/)).toBeInTheDocument();

    await user.click(within(group).getByRole("button", { name: "/b" }));
    expect(screen.getByRole("article", { name: "Issue details" })).toHaveTextContent("/b");
    expect(screen.getByRole("combobox", { name: "Previewed page" })).toHaveValue(
      "http://site.test/b",
    );

    await user.click(screen.getByRole("button", { name: /Back to group/ }));
    expect(screen.getByRole("article", { name: "Group details" })).toBeInTheDocument();
  });

  it("draws highlights from the recorded box and marks the selected one", async () => {
    const user = userEvent.setup();
    render(<Inspector report={report} />);
    await user.click(screen.getByRole("button", { name: /JavaScript error on the page/ }));
    loadScreenshot();

    const selected = screen.getByRole("button", { name: "JavaScript error on the page (high)" });
    expect(selected).toHaveAttribute("data-state", "selected");
    // box {x:50,y:400,w:200,h:50} on a 1000x2000 screenshot
    expect(selected.style.left).toBe("5%");
    expect(selected.style.top).toBe("20%");
    expect(selected.style.width).toBe("20%");
    expect(selected.style.height).toBe("2.5%");

    // other issues of the same page are drawn too, as idle boxes
    expect(screen.getByRole("button", { name: "Page has no <h1> (medium)" })).toHaveAttribute(
      "data-state",
      "idle",
    );
  });

  it("clicking a highlight selects that issue", async () => {
    const user = userEvent.setup();
    render(<Inspector report={report} />);
    await user.click(screen.getByRole("button", { name: /JavaScript error on the page/ }));
    loadScreenshot();

    await user.click(screen.getByRole("button", { name: "Page has no <h1> (medium)" }));
    expect(screen.getByRole("article", { name: "Issue details" })).toHaveTextContent(
      "Page has no <h1>",
    );
  });

  it("filters by severity and by search text, and reports the counts", async () => {
    const user = userEvent.setup();
    render(<Inspector report={report} />);

    await user.click(screen.getByRole("button", { name: "high" }));
    expect(rows()).toHaveLength(1);
    expect(screen.getByText("1 item")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "high" }));

    await user.type(screen.getByRole("searchbox", { name: "Search issues" }), "zzz-nothing");
    expect(screen.getByText("No issues match the filters.")).toBeInTheDocument();
  });

  it("shows unverified issues only on request, with an honest explanation", async () => {
    const user = userEvent.setup();
    render(<Inspector report={report} />);
    expect(screen.queryByText(/External link could not be verified/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Couldn't verify/ }));
    await user.click(screen.getByRole("button", { name: /External link could not be verified/ }));
    const details = screen.getByRole("article", { name: "Issue details" });
    expect(details).toHaveTextContent("Couldn't verify");
    expect(details).toHaveTextContent("429");
    expect(details).toHaveTextContent(/not reported as broken/);
  });

  it("says so when an issue has nothing to highlight", async () => {
    const user = userEvent.setup();
    render(<Inspector report={report} initialIssueId="ext-a" />);
    loadScreenshot();
    expect(screen.getByText(/no position on the page/i)).toBeInTheDocument();
    expect(user).toBeDefined();
  });

  it("switches viewport with the buttons", async () => {
    const user = userEvent.setup();
    render(<Inspector report={report} />);
    const desktop = screen.getByRole("button", { name: "Desktop" });
    const mobile = screen.getByRole("button", { name: "Mobile" });
    expect(desktop).toHaveAttribute("aria-pressed", "true");

    await user.click(mobile);
    expect(mobile).toHaveAttribute("aria-pressed", "true");
    await user.click(desktop);
    expect(desktop).toHaveAttribute("aria-pressed", "true");
  });

  it("moves through the list with j and k, but not while typing", async () => {
    const user = userEvent.setup();
    render(<Inspector report={report} />);
    const selectedTitle = () =>
      document.querySelector('.row[data-selected="true"] .row-title')?.textContent;

    const first = selectedTitle();
    await user.keyboard("j");
    const second = selectedTitle();
    expect(second).not.toBe(first);
    await user.keyboard("k");
    expect(selectedTitle()).toBe(first);

    await user.click(screen.getByRole("searchbox", { name: "Search issues" }));
    await user.keyboard("j");
    expect(screen.getByRole("searchbox", { name: "Search issues" })).toHaveValue("j");
  });

  it("opens straight on an issue from the address and reports focus changes", async () => {
    const onIssueChange = vi.fn();
    render(<Inspector report={report} initialIssueId="console-a" onIssueChange={onIssueChange} />);
    expect(screen.getByRole("article", { name: "Issue details" })).toHaveTextContent(
      "JavaScript error on the page",
    );
    expect(onIssueChange).toHaveBeenLastCalledWith("console-a");
  });

  it("explains why an issue has its priority", async () => {
    const user = userEvent.setup();
    render(<Inspector report={report} initialIssueId="console-a" />);
    await user.click(screen.getByText("Why this priority?"));
    expect(screen.getByText(/\(severity\) ×/)).toHaveTextContent("60 (severity) × 1 (confidence)");
  });

  it("renders text from scanned pages as text, never as HTML", () => {
    const evil = fixtureReport();
    evil.issues[3]!.evidence = [
      { type: "console", level: "error", text: "<img src=x onerror=alert(1)>" },
    ];
    render(<Inspector report={evil} initialIssueId="console-a" />);
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });

  it("switches between failing and unverified with visible tabs that show counts", async () => {
    const user = userEvent.setup();
    render(<Inspector report={report} />);
    const failing = screen.getByRole("button", { name: /^Failing/ });
    const unverified = screen.getByRole("button", { name: /^Couldn't verify/ });
    expect(failing).toHaveAttribute("aria-pressed", "true");
    expect(failing).toHaveTextContent("4");
    expect(unverified).toHaveTextContent("1");

    await user.click(unverified);
    expect(unverified).toHaveAttribute("aria-pressed", "true");
    expect(rows()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /^All/ }));
    expect(rows()).toHaveLength(3);
  });

  it("lists the pages of a group as a clear list with a hint", async () => {
    const user = userEvent.setup();
    render(<Inspector report={report} />);
    await user.click(screen.getByRole("button", { name: /Page has no <h1> — 3 pages/ }));
    const group = screen.getByRole("article", { name: "Group details" });
    expect(within(group).getByText(/Click a page to see where the problem is/)).toBeInTheDocument();
    expect(within(group).getAllByRole("button", { name: /^\/[abc]/ })).toHaveLength(3);
    expect(within(group).getByText(/Shared element: body > main/)).toBeInTheDocument();
  });

  it("puts the fix before the explanation and tells the real size of the screenshot", async () => {
    const user = userEvent.setup();
    render(<Inspector report={report} />);
    await user.click(screen.getByRole("button", { name: /JavaScript error on the page/ }));
    loadScreenshot(1366, 2000);
    const details = screen.getByRole("article", { name: "Issue details" });
    const text = details.textContent ?? "";
    expect(text.indexOf("How to fix")).toBeLessThan(text.indexOf("Why it matters"));
    expect(screen.getByText(/1366 × 2000 px/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "100%" }));
    expect(document.querySelector(".shot")).toHaveAttribute("data-zoom", "actual");
    expect((document.querySelector(".shot") as HTMLElement).style.width).toBe("1366px");
  });
});
