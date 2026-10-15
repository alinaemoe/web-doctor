import { describe, expect, it } from "vitest";
import {
  computeFingerprint,
  evidenceKeyForRequest,
  normalizeEvidenceText,
  stableElementKey,
} from "./fingerprint";

describe("computeFingerprint", () => {
  const base = {
    ruleId: "a11y.axe.label",
    pageUrl: "https://a.com/checkout",
    elementKey: "id:email",
  };

  it("is stable for equivalent page URLs and hosts", () => {
    const a = computeFingerprint(base);
    const b = computeFingerprint({
      ...base,
      pageUrl: "https://staging.a.com/checkout/?utm_source=x#f",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes with rule, page or element", () => {
    const a = computeFingerprint(base);
    expect(computeFingerprint({ ...base, ruleId: "a11y.axe.button-name" })).not.toBe(a);
    expect(computeFingerprint({ ...base, pageUrl: "https://a.com/cart" })).not.toBe(a);
    expect(computeFingerprint({ ...base, elementKey: "id:name" })).not.toBe(a);
  });
});

describe("stableElementKey", () => {
  it("prefers id, then role+name, then path, then context", () => {
    expect(stableElementKey({ id: "email", role: "textbox" })).toBe("id:email");
    expect(stableElementKey({ role: "button", accessibleName: " Buy Now " })).toBe(
      "rn:button:buy now",
    );
    expect(stableElementKey({ domPath: "main > form > input" })).toBe("path:main > form > input");
    expect(stableElementKey({ contextHash: "abc" })).toBe("ctx:abc");
    expect(stableElementKey({})).toBe("");
  });
});

describe("evidence normalization", () => {
  it("strips tracking from request URLs", () => {
    expect(evidenceKeyForRequest("https://a.com/img/x.jpg?utm_medium=y#z")).toBe(
      "https://a.com/img/x.jpg",
    );
  });

  it("removes volatile numbers, hashes and query strings from console text", () => {
    expect(normalizeEvidenceText("Failed at 12:34 for item 987 (/api/x?id=5)")).toBe(
      normalizeEvidenceText("Failed at 99:01 for item 1 (/api/x?id=77)"),
    );
    expect(normalizeEvidenceText("chunk deadbeef1234 failed")).toBe("chunk # failed");
  });
});
