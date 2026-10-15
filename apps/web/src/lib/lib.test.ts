import { describe, expect, it } from "vitest";
import { applyFilters, buildList, defaultFilters, toggle } from "./filters";
import { toOverlay, issueBoxes } from "./geometry";
import { buildModel } from "./model";
import { parseHash, runHash } from "./route";
import { fixtureReport } from "../../test/fixture";

const model = buildModel(fixtureReport());

describe("applyFilters", () => {
  it("shows only failing issues by default", () => {
    const shown = applyFilters(model.issues, defaultFilters);
    expect(shown.every((i) => i.verdict === "fail")).toBe(true);
    expect(shown.length).toBe(model.issues.filter((i) => i.verdict === "fail").length);
  });

  it("filters by severity and category (empty selection = no restriction)", () => {
    const high = applyFilters(model.issues, { ...defaultFilters, severities: ["high"] });
    expect(high.map((i) => i.ruleId)).toEqual(["runtime.console.error"]);
    const seo = applyFilters(model.issues, { ...defaultFilters, categories: ["seo"] });
    expect(seo.every((i) => i.category === "seo")).toBe(true);
  });

  it("treats viewport 'all' issues as matching either viewport", () => {
    const mobile = applyFilters(model.issues, { ...defaultFilters, viewport: "mobile" });
    expect(mobile.length).toBe(model.issues.filter((i) => i.verdict === "fail").length);
  });

  it("searches title, rule, URL and selector", () => {
    expect(applyFilters(model.issues, { ...defaultFilters, query: "console" })).toHaveLength(1);
    expect(applyFilters(model.issues, { ...defaultFilters, query: "BODY > MAIN" }).length).toBe(4);
    expect(applyFilters(model.issues, { ...defaultFilters, query: "zzz" })).toEqual([]);
  });

  it("filters by page and result", () => {
    const page = applyFilters(model.issues, { ...defaultFilters, page: "http://site.test/a" });
    expect(page.every((i) => i.pageUrl === "http://site.test/a")).toBe(true);
    const unverified = applyFilters(model.issues, { ...defaultFilters, verdict: "unverified" });
    expect(unverified.map((i) => i.verdict)).toEqual(["unverified"]);
  });
});

describe("buildList", () => {
  it("collapses issues of a root-cause group into one row, ordered by priority", () => {
    const items = buildList(applyFilters(model.issues, defaultFilters), model, true);
    const group = items.find((i) => i.kind === "group");
    expect(group).toMatchObject({ kind: "group", pages: 3 });
    expect(items.map((i) => i.score)).toEqual([...items.map((i) => i.score)].sort((a, b) => b - a));
  });

  it("lists every issue when grouping is off", () => {
    const filtered = applyFilters(model.issues, defaultFilters);
    const items = buildList(filtered, model, false);
    expect(items).toHaveLength(filtered.length);
    expect(items.every((i) => i.kind === "issue")).toBe(true);
  });

  it("shows a lone remaining group member as a plain issue", () => {
    const filtered = applyFilters(model.issues, { ...defaultFilters, page: "http://site.test/a" });
    const items = buildList(filtered, model, true);
    expect(items.some((i) => i.kind === "group")).toBe(false);
  });
});

describe("toggle", () => {
  it("adds and removes values", () => {
    expect(toggle(["a"], "b")).toEqual(["a", "b"]);
    expect(toggle(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("geometry", () => {
  const natural = { width: 1000, height: 2000 };

  it("converts page boxes to percentages of the screenshot", () => {
    expect(toOverlay({ x: 100, y: 200, width: 500, height: 100 }, natural)).toEqual({
      left: 10,
      top: 10,
      width: 50,
      height: 5,
    });
  });

  it("clamps boxes that stick out and drops boxes outside the screenshot", () => {
    expect(toOverlay({ x: 900, y: 1900, width: 500, height: 500 }, natural)).toEqual({
      left: 90,
      top: 95,
      width: 10,
      height: 5,
    });
    expect(toOverlay({ x: 0, y: 2500, width: 10, height: 10 }, natural)).toBeNull();
    expect(toOverlay({ x: 0, y: 0, width: 0, height: 0 }, natural)).toBeNull();
    expect(toOverlay({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 })).toBeNull();
  });

  it("collects only DOM boxes from an issue", () => {
    const issue = model.issues.find((i) => i.ruleId === "runtime.console.error")!;
    expect(issueBoxes(issue)).toHaveLength(1);
    const noBox = model.issues.find((i) => i.ruleId === "link.external.broken")!;
    expect(issueBoxes(noBox)).toEqual([]);
  });
});

describe("route", () => {
  it("round-trips run and issue ids", () => {
    expect(parseHash(runHash("run-1", "abc"))).toEqual({ name: "run", id: "run-1", issue: "abc" });
    expect(parseHash(runHash("run-1"))).toEqual({ name: "run", id: "run-1", issue: undefined });
  });

  it("falls back to the runs list", () => {
    expect(parseHash("")).toEqual({ name: "runs" });
    expect(parseHash("#/nonsense")).toEqual({ name: "runs" });
  });
});
