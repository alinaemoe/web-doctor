import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ScanClient, ScanJob } from "../lib/api";
import { parseHash } from "../lib/route";
import { FixPromptButtons } from "./FixPromptButtons";
import { BIG_SCAN_PAGES, formatElapsed, linesFor } from "../lib/scanFun";
import { NewScanPage, normalizeAddress } from "./NewScanPage";

const job = (overrides: Partial<ScanJob> = {}): ScanJob => ({
  id: "job-1",
  url: "https://example.com/",
  status: "running",
  phase: "crawling",
  pagesDone: 0,
  skipped: 0,
  recent: [],
  queued: 0,
  ...overrides,
});

function makeClient(sequence: ScanJob[], extra: Partial<ScanClient> = {}): ScanClient {
  let i = 0;
  return {
    start: vi.fn(async () => job({ status: "queued", phase: "queued" })),
    get: vi.fn(async () => sequence[Math.min(i++, sequence.length - 1)]!),
    cancel: vi.fn(async () =>
      job({ status: "canceled", phase: "done", runId: "run-9", partial: true }),
    ),
    ...extra,
  };
}

describe("normalizeAddress", () => {
  it("adds https:// when the scheme is missing and keeps an explicit one", () => {
    expect(normalizeAddress("example.com")).toBe("https://example.com");
    expect(normalizeAddress("  example.com/shop ")).toBe("https://example.com/shop");
    expect(normalizeAddress("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeAddress("")).toBe("");
  });
});

describe("NewScanPage", () => {
  it("scans the typed address with the chosen options and shows progress, then the result link", async () => {
    const user = userEvent.setup();
    const client = makeClient([
      job({
        pagesDone: 3,
        lastUrl: "https://example.com/about",
        recent: ["https://example.com/about", "https://example.com/"],
        queued: 9,
        skipped: 1,
      }),
      job({ phase: "checking-links", linkTargets: 12, pagesDone: 5 }),
      job({
        status: "completed",
        phase: "done",
        pagesDone: 5,
        runId: "run-9",
        failCount: 7,
        partial: false,
      }),
    ]);
    render(<NewScanPage client={client} pollMs={5} />);

    await user.type(screen.getByLabelText(/Website address/), "example.com");
    await user.click(screen.getByText("Options"));
    await user.clear(screen.getByLabelText("Max pages"));
    await user.type(screen.getByLabelText("Max pages"), "20");
    await user.click(screen.getByRole("checkbox", { name: "Mobile" }));
    await user.click(screen.getByRole("button", { name: "Scan site" }));

    expect(client.start).toHaveBeenCalledWith({
      url: "https://example.com",
      maxPages: 20,
      maxDepth: 3,
      viewports: ["desktop"],
      respectRobots: true,
    });

    await screen.findByText(/Scanning… 3 pages done/);
    // live feed of the latest pages and the stat cards
    expect(screen.getByText("https://example.com/about")).toBeInTheDocument();
    expect(screen.getByText("found, waiting").previousSibling).toHaveTextContent("9");
    expect(screen.getByText("skipped").previousSibling).toHaveTextContent("1");
    await screen.findByText(/Checking 12 links/);

    const done = await screen.findByText(/Done\. 5 pages scanned, 7 problems found\./);
    expect(done).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open results" })).toHaveAttribute(
      "href",
      "#/runs/run-9",
    );
  });

  it("stops a running scan and offers the partial result", async () => {
    const user = userEvent.setup();
    const client = makeClient([job({ pagesDone: 2 })]);
    render(<NewScanPage client={client} pollMs={1000} />);
    await user.type(screen.getByLabelText(/Website address/), "https://example.com");
    await user.click(screen.getByRole("button", { name: "Scan site" }));

    await user.click(await screen.findByRole("button", { name: "Stop" }));
    expect(client.cancel).toHaveBeenCalledWith("job-1");
    expect(await screen.findByText(/Stopped\./)).toBeInTheDocument();
    expect(screen.getByText(/partial/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open results" })).toHaveAttribute(
      "href",
      "#/runs/run-9",
    );
  });

  it("shows why a scan failed and lets the user try again", async () => {
    const user = userEvent.setup();
    const client = makeClient([
      job({ status: "failed", phase: "done", error: "Invalid start URL" }),
    ]);
    render(<NewScanPage client={client} pollMs={5} />);
    await user.type(screen.getByLabelText(/Website address/), "https://example.com");
    await user.click(screen.getByRole("button", { name: "Scan site" }));

    expect(await screen.findByText("Invalid start URL")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Scan another site" }));
    expect(screen.getByRole("button", { name: "Scan site" })).toBeInTheDocument();
  });

  it("shows a server rejection next to the form and does not start polling", async () => {
    const user = userEvent.setup();
    const client = makeClient([], {
      start: vi.fn(async () => Promise.reject(new Error("Too many scans waiting."))),
    });
    render(<NewScanPage client={client} pollMs={5} />);
    await user.type(screen.getByLabelText(/Website address/), "https://example.com");
    await user.click(screen.getByRole("button", { name: "Scan site" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Too many scans waiting.");
    expect(client.get).not.toHaveBeenCalled();
  });

  it("needs at least one viewport", async () => {
    const user = userEvent.setup();
    const client = makeClient([]);
    render(<NewScanPage client={client} />);
    await user.type(screen.getByLabelText(/Website address/), "https://example.com");
    await user.click(screen.getByText("Options"));
    await user.click(screen.getByRole("checkbox", { name: "Desktop" }));
    await user.click(screen.getByRole("checkbox", { name: "Mobile" }));
    await user.click(screen.getByRole("button", { name: "Scan site" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose at least one viewport.");
    expect(client.start).not.toHaveBeenCalled();
  });
});

describe("live scan screen", () => {
  it("shows a rotating line while scanning and keeps it out of the accessibility tree", async () => {
    const user = userEvent.setup();
    const client = makeClient([job({ pagesDone: 1 })]);
    render(<NewScanPage client={client} pollMs={1000} funMs={30} />);
    await user.type(screen.getByLabelText(/Website address/), "example.com");
    await user.click(screen.getByRole("button", { name: "Scan site" }));

    const line = await screen.findByTestId("fun-line");
    expect(line).toHaveAttribute("aria-hidden", "true");
    const seen = new Set<string>();
    for (let i = 0; i < 40 && seen.size < 3; i++) {
      seen.add(screen.getByTestId("fun-line").textContent ?? "");
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
    for (const text of seen) expect(linesFor("crawling")).toContain(text);
  });

  it("puts the progress in the tab title and restores it afterwards", async () => {
    const user = userEvent.setup();
    document.title = "Web Doctor";
    const client = makeClient([
      job({ pagesDone: 4 }),
      job({ status: "completed", phase: "done", pagesDone: 4, runId: "r", failCount: 2 }),
    ]);
    render(<NewScanPage client={client} pollMs={20} />);
    await user.type(screen.getByLabelText(/Website address/), "example.com");
    await user.click(screen.getByRole("button", { name: "Scan site" }));

    await waitFor(() => expect(document.title).toBe("Done · 2 problems · Web Doctor"));
  });
});

describe("scan presets and limits", () => {
  it("offers presets up to 5000 pages and warns before a huge scan", async () => {
    const user = userEvent.setup();
    const client = makeClient([job()]);
    render(<NewScanPage client={client} />);

    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Quick · 10" }));
    expect(screen.getByRole("button", { name: "Quick · 10" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Everything · 5000" }));
    expect(screen.getByRole("note")).toHaveTextContent(/hour or more/);
    await user.type(screen.getByLabelText(/Website address/), "example.com");
    await user.click(screen.getByRole("button", { name: "Scan site" }));
    expect(client.start).toHaveBeenCalledWith(expect.objectContaining({ maxPages: 5000 }));
    expect(BIG_SCAN_PAGES).toBeLessThan(5000);
  });

  it("remembers the last scanned address", async () => {
    window.localStorage.removeItem("webdoctor.lastAddress");
    const user = userEvent.setup();
    const first = render(<NewScanPage client={makeClient([job()])} />);
    await user.type(screen.getByLabelText(/Website address/), "my-site.example");
    await user.click(screen.getByRole("button", { name: "Scan site" }));
    first.unmount();

    render(<NewScanPage client={makeClient([job()])} />);
    expect(screen.getByLabelText(/Website address/)).toHaveValue("my-site.example");
  });
});

describe("scanFun helpers", () => {
  it("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
    expect(formatElapsed(-5)).toBe("0:00");
  });

  it("has phase-specific lines, with a tip after every few jokes", () => {
    expect(
      linesFor("crawling").some((l) => l.startsWith("Tip:") || l.startsWith("Did you know")),
    ).toBe(true);
    expect(linesFor("checking-links")[0]).toMatch(/link/i);
    expect(new Set(linesFor("crawling")).size).toBe(linesFor("crawling").length);
  });
});

describe("routes", () => {
  it("knows the new-scan page", () => {
    expect(parseHash("#/new")).toEqual({ name: "new" });
  });
});

describe("FixPromptButtons", () => {
  it("copies the prompt to the clipboard", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async () => "# Fix it\n");
    render(<FixPromptButtons runId="run-1" load={load} />);
    const write = vi.spyOn(navigator.clipboard, "writeText");

    await user.click(screen.getByRole("button", { name: "Copy fix prompt" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
    expect(load).toHaveBeenCalledWith("run-1");
    expect(write).toHaveBeenCalledWith("# Fix it\n");
  });

  it("downloads the prompt as a .md file", async () => {
    const user = userEvent.setup();
    const created: string[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(`${blob.type}:${blob.size}`);
      return "blob:x";
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(<FixPromptButtons runId="run-1" load={async () => "# Fix it\n"} />);
    await user.click(screen.getByRole("button", { name: "Download .md" }));

    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(created[0]).toMatch(/^text\/markdown/);
    click.mockRestore();
  });

  it("shows an error when the prompt cannot be created", async () => {
    const user = userEvent.setup();
    render(<FixPromptButtons runId="run-1" load={async () => Promise.reject(new Error("nope"))} />);
    await user.click(screen.getByRole("button", { name: "Copy fix prompt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("nope");
  });
});
