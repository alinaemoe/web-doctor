import { describe, expect, it } from "vitest";
import { nextStatus } from "./status";

describe("nextStatus", () => {
  it("creates new issues and keeps them open", () => {
    expect(nextStatus(null, "found").status).toBe("new");
    expect(nextStatus("new", "found").status).toBe("open");
    expect(nextStatus("open", "found").status).toBe("open");
    expect(nextStatus("reopened", "found").status).toBe("open");
  });

  it("marks verified-absent issues as fixed and reopens them when they return", () => {
    expect(nextStatus("open", "absent_verified").status).toBe("fixed");
    expect(nextStatus("new", "absent_verified").status).toBe("fixed");
    expect(nextStatus("fixed", "absent_verified").status).toBe("fixed");
    expect(nextStatus("fixed", "found").status).toBe("reopened");
  });

  it("never turns an issue into fixed when the page could not be checked", () => {
    for (const prev of ["new", "open", "reopened", "fixed"] as const) {
      expect(nextStatus(prev, "absent_unverified")).toEqual({ status: prev, carriedOver: true });
    }
  });

  it("keeps ignored issues ignored", () => {
    expect(nextStatus("ignored", "found").status).toBe("ignored");
    expect(nextStatus("ignored", "absent_verified").status).toBe("ignored");
  });
});
