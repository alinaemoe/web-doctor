import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expectedManifest } from "../src/expected";

export const EXPECTED_JSON_PATH = fileURLToPath(
  new URL("../expected-issues.json", import.meta.url),
);

export function serializeManifest(): string {
  return JSON.stringify(expectedManifest, null, 2) + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(EXPECTED_JSON_PATH, serializeManifest());
  console.log(`wrote ${EXPECTED_JSON_PATH}`);
}
