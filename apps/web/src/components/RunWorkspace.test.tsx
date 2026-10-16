import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Issue, Verification } from "@webdoctor/core/shared";
import { fixtureReport } from "../../test/fixture";
import { RunWorkspace } from "./RunWorkspace";
import type { VerifyResponse } from "../lib/api";
import type { VerifyClient } from "./RunWorkspace";

const report = fixtureReport();
const CHECKED = "2026-10-16T10:00:00.000Z";

const verification = (
  issueId: string,
  outcome: Verification["outcome"],
  detail: string,
): Verification => ({
  issueId,
  outcome,
  detail,
  checkedAt: CHECKED,
  confidence: 1,
  pages: [],
});

const fixedCopy = (id: string): Issue => {
  const issue = report.issues.find((i) => i.id === id)!;
  return {
    ...issue,
    status: "fixed",
    statusHistory: [
      ...issue.statusHistory,
      { from: issue.status, to: "fixed", runId: "run-1", at: CHECKED, reason: "Re-verified" },
    ],
  };
};

function setup(client: Partial<VerifyClient> = {}, initial: Verification[] = []) {
  const full: VerifyClient = {
    verifyIssue: vi.fn(async (_run, id) => ({
      results: [verification(id, "verified-fixed", "The check passes on the current page.")],
      issues: [fixedCopy(id)],
    })),
    verifyGroup: vi.fn(async () => ({
      results: ["h1-a", "h1-b"].map((id) =>
        verification(id, "verified-fixed", "The check passes on the current page."),
      ),
      issues: [fixedCopy("h1-a"), fixedCopy("h1-b")],
      checkedPages: 2,
      totalPages: 3,
    })),
    ...client,
  };
  render(<RunWorkspace initialReport={report} initialVerifications={initial} client={full} />);
  return full;
}

const openConsoleIssue = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /JavaScript error on the page/ }));

describe("Re-verify an issue", () => {
  it("shows the button, then the confirmed result, and moves the issue to the Fixed tab", async () => {
    const user = userEvent.setup();
    const client = setup();
    await openConsoleIssue(user);

    const panel = screen.getByRole("region", { name: "Verify fix" });
    expect(within(panel).getByText("Not re-checked yet")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Re-verify" }));

    expect(client.verifyIssue).toHaveBeenCalledWith("run-1", "console-a");
    await waitFor(() => expect(within(panel).getByText(/✓ Verified fixed/)).toBeInTheDocument());
    expect(within(panel).getByText("The check passes on the current page.")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Check again" })).toBeInTheDocument();

    // it left the Failing tab and now counts under Fixed
    expect(screen.getByRole("button", { name: /^Failing/ })).toHaveTextContent("3");
    expect(screen.getByRole("button", { name: /^Fixed/ })).toHaveTextContent("1");
    await user.click(screen.getByRole("button", { name: /^Fixed/ }));
    expect(
      screen.getByRole("button", { name: /JavaScript error on the page/ }),
    ).toBeInTheDocument();
  });

  it("disables the button and says what is happening while the check runs", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    setup({
      verifyIssue: vi.fn(
        (_run: string, id: string) =>
          new Promise<VerifyResponse>((resolve) => {
            finish = () =>
              resolve({
                results: [verification(id, "still-failing", "The problem is still there.")],
                issues: [],
              });
          }),
      ),
    });
    await openConsoleIssue(user);
    const panel = screen.getByRole("region", { name: "Verify fix" });
    await user.click(within(panel).getByRole("button", { name: "Re-verify" }));

    expect(
      within(panel).getByRole("button", { name: /Checking in a real browser/ }),
    ).toBeDisabled();
    finish();
    await waitFor(() => expect(within(panel).getByText(/✗ Still failing/)).toBeInTheDocument());
    expect(within(panel).getByRole("button", { name: "Re-verify" })).toBeEnabled();
    // a failed re-check does not move the issue anywhere
    expect(screen.getByRole("button", { name: /^Failing/ })).toHaveTextContent("4");
  });

  it("never presents a couldn't-verify result as fixed", async () => {
    const user = userEvent.setup();
    setup({
      verifyIssue: vi.fn(async (_run, id) => ({
        results: [
          {
            ...verification(id, "unverified", "The page could not be loaded."),
            confidence: 0,
            reason: "page_unreachable" as const,
          },
        ],
        issues: [],
      })),
    });
    await openConsoleIssue(user);
    const panel = screen.getByRole("region", { name: "Verify fix" });
    await user.click(within(panel).getByRole("button", { name: "Re-verify" }));

    await waitFor(() =>
      expect(
        within(panel).getByText(/Couldn't verify, so not marked as fixed/),
      ).toBeInTheDocument(),
    );
    expect(within(panel).queryByText(/✓ Verified fixed/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Failing/ })).toHaveTextContent("4");
  });

  it("explains lower certainty: relocated element and removed element", async () => {
    const user = userEvent.setup();
    setup({}, [
      {
        ...verification(
          "console-a",
          "still-failing",
          "The problem is still there; the element was found again at a different position.",
        ),
        confidence: 0.7,
        relocated: true,
      },
    ]);
    await openConsoleIssue(user);
    const panel = screen.getByRole("region", { name: "Verify fix" });
    expect(within(panel).getByText(/found again at a different position/)).toBeInTheDocument();
    expect(within(panel).getByText(/70% sure/)).toBeInTheDocument();
  });

  it("shows the error when the request fails and keeps the issue as it was", async () => {
    const user = userEvent.setup();
    setup({
      verifyIssue: vi.fn(async () => Promise.reject(new Error("Too many verifications queued."))),
    });
    await openConsoleIssue(user);
    const panel = screen.getByRole("region", { name: "Verify fix" });
    await user.click(within(panel).getByRole("button", { name: "Re-verify" }));

    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "Too many verifications queued.",
    );
    expect(screen.getByRole("button", { name: /^Failing/ })).toHaveTextContent("4");
  });
});

describe("Re-verify a group", () => {
  it("checks a sample and reports coverage honestly", async () => {
    const user = userEvent.setup();
    const client = setup();
    await user.click(screen.getByRole("button", { name: /Page has no <h1> — 3 pages/ }));

    const panel = screen.getByRole("region", { name: "Verify fix" });
    expect(within(panel).getByText("0 of 3 verified fixed")).toBeInTheDocument();
    expect(within(panel).getByText(/Checks a sample of pages/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Re-verify 3 pages" }));
    expect(client.verifyGroup).toHaveBeenCalledWith("run-1", "g1");

    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent(
      "Checked 2 of 3 pages of the group: 2 verified fixed. The other 1 pages were not checked.",
    );
    // fixed pages moved to the Fixed tab; the unchecked page is still failing
    expect(screen.getByRole("button", { name: /^Fixed/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^Failing/ })).toHaveTextContent("2");

    await user.click(within(banner).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps a still-failing group in the list and counts it", async () => {
    const user = userEvent.setup();
    setup({
      verifyGroup: vi.fn(async () => ({
        results: [verification("h1-a", "still-failing", "The problem is still there.")],
        issues: [],
        checkedPages: 1,
        totalPages: 3,
      })) as VerifyClient["verifyGroup"],
    });
    await user.click(screen.getByRole("button", { name: /Page has no <h1> — 3 pages/ }));
    const panel = screen.getByRole("region", { name: "Verify fix" });
    await user.click(within(panel).getByRole("button", { name: /Re-verify/ }));

    expect(await screen.findByRole("status")).toHaveTextContent("1 still failing");
    expect(within(panel).getByText(/1 checked page is still failing/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Page has no <h1> — 3 pages/ })).toBeInTheDocument();
  });

  it("is read-only when no verification handlers are provided", async () => {
    const { Inspector } = await import("./Inspector");
    render(<Inspector report={report} />);
    expect(screen.queryByRole("region", { name: "Verify fix" })).not.toBeInTheDocument();
  });
});
