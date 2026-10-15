import type { Box, Issue } from "@webdoctor/core/shared";

export interface PercentBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Page-coordinate boxes recorded as DOM evidence of an issue. */
export function issueBoxes(issue: Issue): Box[] {
  return issue.evidence.flatMap((e) => (e.type === "dom" && e.boundingBox ? [e.boundingBox] : []));
}

/**
 * Converts a document-space box into percentages of the screenshot. The screenshot is clipped to
 * the viewport width and to a maximum height, so boxes are clamped and boxes outside it are dropped.
 */
export function toOverlay(box: Box, natural: { width: number; height: number }): PercentBox | null {
  if (natural.width <= 0 || natural.height <= 0) return null;
  const x1 = Math.max(0, box.x);
  const y1 = Math.max(0, box.y);
  const x2 = Math.min(natural.width, box.x + box.width);
  const y2 = Math.min(natural.height, box.y + box.height);
  if (x2 <= x1 || y2 <= y1) return null;
  return {
    left: (x1 / natural.width) * 100,
    top: (y1 / natural.height) * 100,
    width: ((x2 - x1) / natural.width) * 100,
    height: ((y2 - y1) / natural.height) * 100,
  };
}
