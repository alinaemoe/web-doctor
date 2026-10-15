export type Route = { name: "runs" } | { name: "run"; id: string; issue?: string };

/** `#/` -> runs list, `#/runs/<id>?issue=<issueId>` -> inspector. */
export function parseHash(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  const match = /^\/runs\/([^/]+)$/.exec(path);
  if (!match) return { name: "runs" };
  const issue = new URLSearchParams(query).get("issue") ?? undefined;
  return { name: "run", id: decodeURIComponent(match[1]!), issue };
}

export function runHash(id: string, issue?: string): string {
  const base = `#/runs/${encodeURIComponent(id)}`;
  return issue ? `${base}?issue=${encodeURIComponent(issue)}` : base;
}
