import type { Status } from "./types";

/**
 * What a new run observed for an already-known issue:
 * - `found`: the problem is present;
 * - `absent_verified`: the page was checked successfully and the problem is gone;
 * - `absent_unverified`: the page could not be checked (down, timeout, blocked) — says nothing.
 */
export type Observation = "found" | "absent_verified" | "absent_unverified";

export interface Transition {
  status: Status;
  /** True when the run could not confirm the state, so the status was carried over. */
  carriedOver: boolean;
}

/**
 * Issue lifecycle (TZ 6.11, Appendix B).
 * `prev === null` means the issue was never seen before.
 * An unreachable page must never turn an issue into `fixed`.
 */
export function nextStatus(prev: Status | null, observation: Observation): Transition {
  if (prev === "ignored") return { status: "ignored", carriedOver: false };

  if (observation === "absent_unverified") {
    return { status: prev ?? "unverified", carriedOver: true };
  }

  if (observation === "found") {
    switch (prev) {
      case null:
        return { status: "new", carriedOver: false };
      case "fixed":
        return { status: "reopened", carriedOver: false };
      default:
        return { status: "open", carriedOver: false };
    }
  }

  // absent_verified: the issue is gone (callers only pass known issues here)
  return { status: "fixed", carriedOver: false };
}
