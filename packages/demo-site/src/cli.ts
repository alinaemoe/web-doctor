import { startDemoSite } from "./server";
import type { Mode } from "./pages";

const mode = (process.env.DEMO_MODE ?? "broken") as Mode;
if (mode !== "broken" && mode !== "fixed") {
  console.error(`DEMO_MODE must be "broken" or "fixed", got "${mode}"`);
  process.exit(2);
}
const port = Number(process.env.PORT ?? 4000);

const site = await startDemoSite({ mode, port, extPort: port + 1 });
console.log(`Broken Shop (${mode}) at ${site.url}  |  external 429 site at ${site.extUrl}`);
console.log(`Switch mode:  curl -X POST ${site.url}/__demo/mode/fixed`);
console.log(`Flaky page:   curl -X POST ${site.url}/__demo/flaky/down   (or /up)`);

process.on("SIGINT", () => void site.close().then(() => process.exit(0)));
