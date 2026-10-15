import { createHash } from "node:crypto";
import { normalizeUrl, pageKey } from "./url";
import type { NodeSignature } from "./types";

export interface FingerprintInput {
  ruleId: string;
  pageUrl: string;
  /** From {@link stableElementKey}, for DOM-based issues. */
  elementKey?: string;
  /** From {@link evidenceKeyForRequest} / {@link normalizeEvidenceText}, for network/console issues. */
  evidenceKey?: string;
}

/**
 * Stable issue identity across runs (TZ 6.7):
 * rule + normalized page + stable element key + evidence key.
 * Never include recommendation texts or titles here.
 */
export function computeFingerprint(input: FingerprintInput): string {
  const parts = [
    input.ruleId,
    pageKey(input.pageUrl),
    input.elementKey ?? "",
    input.evidenceKey ?? "",
  ];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

/** Picks the most stable identifier available: id, then role+name, then DOM path, then context. */
export function stableElementKey(signature: NodeSignature): string {
  if (signature.id) return `id:${signature.id}`;
  if (signature.role && signature.accessibleName) {
    return `rn:${signature.role}:${signature.accessibleName.trim().toLowerCase()}`;
  }
  if (signature.domPath) return `path:${signature.domPath}`;
  if (signature.contextHash) return `ctx:${signature.contextHash}`;
  return "";
}

/** Normalized URL of a requested resource, without tracking params and fragment. */
export function evidenceKeyForRequest(requestUrl: string): string {
  return normalizeUrl(requestUrl) ?? requestUrl;
}

/** Strips volatile parts (numbers, hashes, query strings) from console/error text. */
export function normalizeEvidenceText(text: string): string {
  return text
    .replace(/\?[^\s"')]*/g, "")
    .replace(/\b[0-9a-f]{8,}\b/gi, "#")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}
